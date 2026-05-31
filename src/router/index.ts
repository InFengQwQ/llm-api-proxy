import type { ChatCompletionRequest, StreamChunk } from '../types/api.js';
import type { ProviderConfig, AutoRoutingConfig } from '../config/index.js';
import type { ProviderAdapter } from '../providers/base.js';
import { createAdapter, parseModelId } from '../providers/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logRequest } from '../db/index.js';

type ProviderEntry = {
  config: ProviderConfig;
  adapter: ProviderAdapter;
  breaker: CircuitBreaker;
};

// 存储每对 (group, sub-model) 的连续失败次数（用于 429 动态降权）
type ModelHeatMap = Map<string, { failures: number; lastFailure: number }>;
// 存储 (group, sessionId) -> { target, boundAt }（会话粘性）
type SessionMap = Map<string, { target: string; boundAt: number }>;

export class Router {
  private providers = new Map<string, ProviderEntry>();
  private autoRouting: AutoRoutingConfig = {};
  private modelHeat: ModelHeatMap = new Map();
  private sessionMap: SessionMap = new Map();
  private sessionTtl = 10 * 60 * 1000; // 10 分钟会话粘性 TTL

  register(configs: ProviderConfig[]): void {
    for (const config of configs) {
      if (!config.enabled) continue;
      this.providers.set(config.name, {
        config,
        adapter: createAdapter(config),
        breaker: new CircuitBreaker(config.circuit_breaker),
      });
    }
    // 启动 session TTL 清理
    setInterval(() => this.pruneExpiredSessions(), this.sessionTtl);
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [key, { boundAt }] of this.sessionMap) {
      if (now - boundAt > this.sessionTtl) {
        this.sessionMap.delete(key);
      }
    }
  }

  registerAutoRouting(config: AutoRoutingConfig): void {
    this.autoRouting = config;
  }

  /** 解析 auto 模型名：auto:<group> 或 auto:<group>/<sessionId> */
  private parseAutoModel(model: string): { group: string; sessionId: string | null } | null {
    if (!model.startsWith('auto:')) return null;
    const rest = model.slice(5);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return { group: rest, sessionId: null };
    return { group: rest.slice(0, slashIdx), sessionId: rest.slice(slashIdx + 1) };
  }

  /** 从候选列表中选出一个可用的 sub-model */
  private selectSubModel(
    targets: string[],
    group: string,
    sessionId: string | null
  ): string | null {
    // 1. 会话粘性：同 session 尽量复用上次模型（保证上下文连贯）
    const sessionKey = `${group}:${sessionId ?? ''}`;
    if (sessionId) {
      const session = this.sessionMap.get(sessionKey);
      if (session && targets.includes(session.target)) {
        const entry = this.getEntryByFullModel(session.target);
        if (entry && entry.breaker.canExecute() && !this.isModelOverheated(session.target)) {
          return session.target;
        }
      }
    }

    // 2. 尝试所有候选，找第一个熔断闭合且不热的
    for (const target of targets) {
      const entry = this.getEntryByFullModel(target);
      if (!entry) continue;
      if (!entry.breaker.canExecute()) continue;
      if (this.isModelOverheated(target)) continue;
      return target;
    }

    // 3. 兜底：返回第一个熔断器在 half_open 的（允许探测）
    for (const target of targets) {
      const entry = this.getEntryByFullModel(target);
      if (entry && entry.breaker.getState() === 'half_open') return target;
    }

    return null;
  }

  private getEntryByFullModel(fullModel: string): ProviderEntry | null {
    try {
      const { provider_name, model_id } = parseModelId(fullModel);
      // 只校验 provider 存在，model_id 不在这里检查
      return this.providers.get(provider_name) ?? null;
    } catch {
      return null;
    }
  }

  private isModelOverheated(target: string): boolean {
    const heat = this.modelHeat.get(target);
    if (!heat) return false;
    const cooldown = 60_000; // 1 分钟冷却
    if (Date.now() - heat.lastFailure < cooldown && heat.failures >= 2) return true;
    // 热度随时间衰减
    if (heat.failures > 0 && Date.now() - heat.lastFailure >= cooldown * 2) {
      heat.failures = Math.floor(heat.failures / 2);
      heat.lastFailure = Date.now();
    }
    return heat.failures >= 3;
  }

  private markModelHeat(target: string): void {
    const existing = this.modelHeat.get(target);
    if (existing) {
      existing.failures++;
      existing.lastFailure = Date.now();
    } else {
      this.modelHeat.set(target, { failures: 1, lastFailure: Date.now() });
    }
  }

  private bindSession(group: string, sessionId: string | null, target: string): void {
    if (!sessionId) return;
    const key = `${group}:${sessionId}`;
    this.sessionMap.set(key, { target, boundAt: Date.now() });
  }

  async route(
    fullModelId: string,
    request: ChatCompletionRequest,
    requestId: string,
    sessionId?: string
  ): Promise<Response> {
    // 检查 auto 路由
    const autoMeta = this.parseAutoModel(fullModelId);
    if (autoMeta) {
      return this.routeAuto(autoMeta.group, request, requestId, autoMeta.sessionId ?? sessionId);
    }

    // 原有直接路由逻辑
    const { provider_name, model_id } = parseModelId(fullModelId);

    const entry = this.providers.get(provider_name);
    if (!entry) {
      return Response.json(
        { error: { message: `Provider "${provider_name}" not found`, type: 'invalid_request_error' } },
        { status: 400 }
      );
    }

    if (!entry.breaker.canExecute()) {
      return Response.json(
        { error: { message: `Provider "${provider_name}" is currently unavailable (circuit open)`, type: 'service_unavailable' } },
        { status: 503 }
      );
    }

    const modifiedRequest = { ...request, model: model_id };
    const startTime = Date.now();

    try {
      if (request.stream) {
        const body = this.streamToReadableStream(entry, modifiedRequest, fullModelId, provider_name, requestId);
        return new Response(body, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Provider': provider_name,
          },
        });
      }

      const result = await entry.adapter.send(modifiedRequest);
      entry.breaker.recordSuccess();
      logRequestAsync(requestId, fullModelId, provider_name, Date.now() - startTime, 200);
      return Response.json(result, { headers: { 'X-Provider': provider_name } });
    } catch (err) {
      entry.breaker.recordFailure();
      const latency = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status = errorMsg.includes('429') ? 429 : 502;
      logRequestAsync(requestId, fullModelId, provider_name, latency, status, errorMsg);
      return Response.json({ error: { message: errorMsg, type: 'upstream_error' } }, { status });
    }
  }

  private async routeAuto(
    group: string,
    request: ChatCompletionRequest,
    requestId: string,
    sessionId?: string
  ): Promise<Response> {
    const groupConfig = this.autoRouting[group];
    if (!groupConfig) {
      return Response.json(
        { error: { message: `Auto routing group "${group}" not found`, type: 'invalid_request_error' } },
        { status: 400 }
      );
    }

    const { targets } = groupConfig;
    const tried = new Set<string>();

    // 重试循环：每个 target 最多试一次，遇到 429 标记过热后切下一个
    while (tried.size < targets.length) {
      const target = this.selectSubModel(targets, group, sessionId ?? null);
      if (!target || tried.has(target)) break;
      tried.add(target);

      if (sessionId) this.bindSession(group, sessionId, target);

      // 直接执行，不走递归 route()，以便在这里处理 429 重试
      const response = await this.executeTarget(target, request, requestId);
      const status = response.status;

      if (status === 200 || status === 400 || status === 401 || status === 403) {
        // 非重试性错误，直接返回
        return response;
      }

      if (status === 429) {
        this.markModelHeat(target);
        continue; // 切到下一个候选
      }

      // 其他错误（502 等），也尝试下一个
      continue;
    }

    return Response.json(
      { error: { message: `All models in auto group "${group}" are unavailable or rate-limited`, type: 'service_unavailable' } },
      { status: 503 }
    );
  }

  private async executeTarget(
    target: string,
    request: ChatCompletionRequest,
    requestId: string
  ): Promise<Response> {
    const { provider_name, model_id } = parseModelId(target);
    const entry = this.providers.get(provider_name);
    if (!entry) {
      return Response.json(
        { error: { message: `Provider "${provider_name}" not found`, type: 'invalid_request_error' } },
        { status: 400 }
      );
    }

    if (!entry.breaker.canExecute()) {
      return Response.json(
        { error: { message: `Provider "${provider_name}" circuit open`, type: 'service_unavailable' } },
        { status: 503 }
      );
    }

    const modifiedRequest = { ...request, model: model_id };
    const startTime = Date.now();

    try {
      if (request.stream) {
        // 先取第一个 chunk 验证上游健康；失败则返回错误状态码让 auto 路由层重试
        const iterator = entry.adapter.sendStreaming(modifiedRequest);
        try {
          const firstResult = await iterator.next();
          if (firstResult.done) {
            entry.breaker.recordFailure();
            logRequestAsync(requestId, target, provider_name, Date.now() - startTime, 502, 'Empty stream');
            return Response.json({ error: { message: 'Empty upstream stream', type: 'upstream_error' } }, { status: 502 });
          }
          const body = this.streamToReadableStream(entry, modifiedRequest, target, provider_name, requestId, iterator, firstResult.value);
          return new Response(body, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'X-Provider': provider_name,
              'X-Auto-Target': target,
            },
          });
        } catch (err) {
          entry.breaker.recordFailure();
          const latency = Date.now() - startTime;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const status = errorMsg.includes('429') ? 429 : 502;
          logRequestAsync(requestId, target, provider_name, latency, status, errorMsg);
          return Response.json({ error: { message: errorMsg, type: 'upstream_error' } }, { status });
        }
      }

      const result = await entry.adapter.send(modifiedRequest);
      entry.breaker.recordSuccess();
      logRequestAsync(requestId, target, provider_name, Date.now() - startTime, 200);
      return Response.json(result, { headers: { 'X-Provider': provider_name, 'X-Auto-Target': target } });
    } catch (err) {
      entry.breaker.recordFailure();
      const latency = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status = errorMsg.includes('429') ? 429 : 502;
      logRequestAsync(requestId, target, provider_name, latency, status, errorMsg);
      return Response.json({ error: { message: errorMsg, type: 'upstream_error' } }, { status });
    }
  }

  private streamToReadableStream(
    entry: ProviderEntry,
    request: ChatCompletionRequest,
    modelId: string,
    providerName: string,
    requestId: string,
    iterator?: AsyncGenerator<StreamChunk>,
    headChunk?: StreamChunk
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iter = iterator ?? entry.adapter.sendStreaming(request);
    let finished = false;
    let headEmitted = headChunk === undefined;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // 先发送预取的首个 chunk
          if (!headEmitted && headChunk !== undefined) {
            headEmitted = true;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(headChunk)}\n\n`));
            return;
          }

          const { value, done } = await iter.next();
          if (done) {
            if (!finished) {
              finished = true;
              entry.breaker.recordSuccess();
              logRequestAsync(requestId, modelId, providerName, 0, 200);
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        } catch (err) {
          // 流中途失败：记录故障、发送 SSE error 事件并正常关闭
          if (!finished) {
            finished = true;
            const errorMsg = err instanceof Error ? err.message : String(err);
            entry.breaker.recordFailure();
            logRequestAsync(requestId, modelId, providerName, 0, 502, errorMsg);
          }
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'upstream stream failed' })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
      async cancel(err: unknown) {
        if (!finished) {
          finished = true;
          const errorMsg = err instanceof Error ? err.message : String(err);
          entry.breaker.recordFailure();
          logRequestAsync(requestId, modelId, providerName, 0, 499, errorMsg);
        }
        void iter.return(undefined);
      },
    });
  }

  getProviderHealth(providerName: string) {
    const entry = this.providers.get(providerName);
    if (!entry) return null;
    return { provider: providerName, state: entry.breaker.getState(), model_count: entry.config.models.length };
  }

  listProviders() {
    return [...this.providers.entries()].map(([name, entry]) => ({
      name,
      type: entry.config.type,
      enabled: entry.config.enabled,
      model_count: entry.config.models.length,
      breaker_state: entry.breaker.getState(),
    }));
  }

  getAllModels() {
    const models: Array<{ id: string; object: string; created: number; owned_by: string; provider: string; provider_type: string }> = [];
    for (const [providerName, entry] of this.providers) {
      for (const modelId of entry.config.models) {
        models.push({
          id: `${providerName}/${modelId}`,
          object: 'model',
          created: 1700000000,
          owned_by: entry.config.type,
          provider: providerName,
          provider_type: entry.config.type,
        });
      }
    }
    return models;
  }

  listAutoRoutingGroups(): Array<{ name: string; target_count: number; targets: string[] }> {
    return Object.entries(this.autoRouting).map(([name, group]) => ({
      name,
      target_count: group.targets.length,
      targets: group.targets,
    }));
  }

  getModelHeatInfo(): Array<{ target: string; failures: number; lastFailure: number }> {
    return [...this.modelHeat.entries()].map(([target, heat]) => ({
      target,
      failures: heat.failures,
      lastFailure: heat.lastFailure,
    }));
  }
}

// ---------------------------------------------------------------------------
// 批量日志写入（模块级缓冲，减少 SQLite 写入频率）
// ---------------------------------------------------------------------------

interface PendingLog {
  requestId: string;
  model: string;
  provider: string;
  latency: number;
  status: number;
  error?: string;
}

const pendingLogs: PendingLog[] = [];

function logRequestAsync(
  requestId: string,
  model: string,
  provider: string,
  latency: number,
  status: number,
  error?: string
): void {
  pendingLogs.push({ requestId, model, provider, latency, status, error });
  if (pendingLogs.length >= 10) flushLogs();
}

function flushLogs(): void {
  if (!pendingLogs.length) return;
  const batch = pendingLogs.splice(0);
  for (const log of batch) {
    logRequest({
      request_id: log.requestId,
      model: log.model,
      provider: log.provider,
      latency_ms: log.latency,
      status_code: log.status,
      error_msg: log.error,
    });
  }
}

// 每 5 秒定时刷盘，防止尾部日志丢失
setInterval(flushLogs, 5_000);