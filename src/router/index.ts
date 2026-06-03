import type { UnifiedRequest, UnifiedStreamEvent } from '../types/api.js';
import { ProviderApiError } from '../types/api.js';
import type { ProviderConfig, AutoRoutingConfig, AutoRoutingGroup } from '../config/index.js';
import type { ProviderAdapter } from '../providers/base.js';
import { createAdapter, parseModelId } from '../providers/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logRequestAsync } from '../db/index.js';

// ── Constants ────────────────────────────────────────────────────────────

/** How long a model stays "hot" after rate-limiting (ms) */
const MODEL_HEAT_COOLDOWN_MS = 60_000;
/** Models are marked "warm" (partially recovered) after 2× cooldown */
const MODEL_HEAT_WARM_FACTOR = 2;
/** Number of consecutive 429s before a model is considered overheated */
const MODEL_HEAT_OVERHEATED_THRESHOLD = 3;
/** A model enters cooling when it has at least this many failures within cooldown */
const MODEL_HEAT_COOLING_THRESHOLD = 2;

/** Session stickiness TTL: how long a session stays bound to a target (ms) */
const SESSION_TTL_MS = 10 * 60 * 1000;
/** Model list cache TTL: how long fetched model lists are considered fresh (ms) */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────

type ProviderEntry = {
  config: ProviderConfig;
  adapter: ProviderAdapter;
  breaker: CircuitBreaker;
};

/** Per-model heat tracking: (group, sub-model) → consecutive failure count */
type ModelHeatMap = Map<string, { failures: number; lastFailure: number }>;
/** Session stickiness: (group, sessionId) → { target, boundAt } */
type SessionMap = Map<string, { target: string; boundAt: number }>;

export class Router {
  private providers = new Map<string, ProviderEntry>();
  private autoRouting: AutoRoutingConfig = [];
  /** auto 路由组查找表：group.name → group */
  private autoRoutingMap = new Map<string, AutoRoutingGroup>();
  private modelHeat: ModelHeatMap = new Map();
  private sessionMap: SessionMap = new Map();
  private pruneIntervalId: ReturnType<typeof setInterval> | null = null;

  /** 模型列表缓存：provider_name -> { models, fetchedAt } */
  private modelCache = new Map<string, { models: string[]; fetchedAt: number }>();

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
    this.pruneIntervalId = setInterval(() => this.pruneExpiredSessions(), SESSION_TTL_MS);
  }

  /** 清理定时器（用于优雅关闭） */
  destroy(): void {
    if (this.pruneIntervalId !== null) {
      clearInterval(this.pruneIntervalId);
      this.pruneIntervalId = null;
    }
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [key, { boundAt }] of this.sessionMap) {
      if (now - boundAt > SESSION_TTL_MS) {
        this.sessionMap.delete(key);
      }
    }
  }

  registerAutoRouting(config: AutoRoutingConfig): void {
    this.autoRouting = config;
    this.autoRoutingMap.clear();
    for (const group of config) {
      this.autoRoutingMap.set(group.name, group);
    }
  }

  /** 从 Provider 的 /models 端点拉取模型列表，结果写入缓存 */
  async fetchProviderModels(providerName: string): Promise<string[]> {
    const entry = this.providers.get(providerName);
    if (!entry) return [];

    // 如果配置明确关闭了动态拉取，只返回静态列表
    if (entry.config.fetch_models === false) {
      return entry.config.models ?? [];
    }

    const cached = this.modelCache.get(providerName);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
      return cached.models;
    }

    try {
      const models = await entry.adapter.fetchModels();
      if (models.length > 0) {
        this.modelCache.set(providerName, { models, fetchedAt: Date.now() });
      }
      return models;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[router] Failed to fetch models from ${providerName}: ${errMsg}`);
      return [];
    }
  }

  /** 刷新所有 Provider 的模型列表（启动时调用，不阻塞） */
  refreshAllModels(): void {
    for (const [name] of this.providers) {
      this.fetchProviderModels(name).then(models => {
        console.log(`[router] ${name}: ${models.length} models fetched`);
      }).catch(() => {
        // fetchProviderModels 内部已处理错误
      });
    }
  }

  /** Helper: build a JSON error Response with the standard error shape */
  private errorResponse(message: string, type: string, status: number): Response {
    return Response.json({ error: { message, type } }, { status });
  }

  /**
   * Look up a provider entry by full model ID (e.g. "openai/gpt-4o").
   * Returns the entry or an error Response if the provider is missing or its circuit is open.
   */
  private resolveProvider(
    fullModelId: string,
  ): { entry: ProviderEntry; modelId: string } | { error: Response } {
    const { provider_name, model_id } = parseModelId(fullModelId);
    const entry = this.providers.get(provider_name);
    if (!entry) {
      return {
        error: this.errorResponse(
          `Provider "${provider_name}" not found`,
          'invalid_request_error',
          400,
        ),
      };
    }
    if (!entry.breaker.canExecute()) {
      return {
        error: this.errorResponse(
          `Provider "${provider_name}" is currently unavailable (circuit open)`,
          'service_unavailable',
          503,
        ),
      };
    }
    return { entry, modelId: model_id };
  }

  /**
   * Execute a non-streaming request against a provider target.
   * Returns a Response (success or error), records circuit breaker state and logs.
   */
  private async executeNonStreaming(
    entry: ProviderEntry,
    request: UnifiedRequest,
    modelId: string,
    providerName: string,
    requestId: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const startTime = Date.now();
    try {
      const result = await entry.adapter.send(request);
      entry.breaker.recordSuccess();
      logRequestAsync(requestId, modelId, providerName, Date.now() - startTime, 200);
      return Response.json(result, { headers: { 'X-Provider': providerName, ...extraHeaders } });
    } catch (err) {
      entry.breaker.recordFailure();
      const latency = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status = this.errorStatus(err);
      logRequestAsync(requestId, modelId, providerName, latency, status, errorMsg);
      return this.errorResponse(errorMsg, 'upstream_error', status);
    }
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

  /** Extract appropriate HTTP status from an error, defaulting to 502 */
  private errorStatus(err: unknown): number {
    if (err instanceof ProviderApiError) return err.status;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429')) return 429;
    return 502;
  }

  private isModelOverheated(target: string): boolean {
    const heat = this.modelHeat.get(target);
    if (!heat) return false;
    // Model is cooling: has recent failures, should be skipped temporarily
    if (Date.now() - heat.lastFailure < MODEL_HEAT_COOLDOWN_MS && heat.failures >= MODEL_HEAT_COOLING_THRESHOLD) return true;
    // Heat naturally decays after 2× cooldown period
    if (heat.failures > 0 && Date.now() - heat.lastFailure >= MODEL_HEAT_COOLDOWN_MS * MODEL_HEAT_WARM_FACTOR) {
      heat.failures = Math.floor(heat.failures / 2);
      heat.lastFailure = Date.now();
    }
    return heat.failures >= MODEL_HEAT_OVERHEATED_THRESHOLD;
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
    request: UnifiedRequest,
    requestId: string,
    sessionId?: string
  ): Promise<Response> {
    // 检查 auto 路由
    const autoMeta = this.parseAutoModel(fullModelId);
    if (autoMeta) {
      return this.routeAuto(autoMeta.group, request, requestId, autoMeta.sessionId ?? sessionId);
    }

    // 直接路由
    const resolved = this.resolveProvider(fullModelId);
    if ('error' in resolved) return resolved.error;

    const { entry, modelId } = resolved;
    const providerName = entry.config.name;
    const modifiedRequest = { ...request, model: modelId };

    if (request.stream) {
      const body = this.streamToReadableStream(entry, modifiedRequest, fullModelId, providerName, requestId);
      return new Response(body, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Provider': providerName,
        },
      });
    }

    return this.executeNonStreaming(entry, modifiedRequest, fullModelId, providerName, requestId);
  }

  private async routeAuto(
    group: string,
    request: UnifiedRequest,
    requestId: string,
    sessionId?: string
  ): Promise<Response> {
    const groupConfig = this.autoRoutingMap.get(group);
    if (!groupConfig) {
      return this.errorResponse(
        `Auto routing group "${group}" not found`,
        'invalid_request_error',
        400,
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

    return this.errorResponse(
      `All models in auto group "${group}" are unavailable or rate-limited`,
      'service_unavailable',
      503,
    );
  }

  private async executeTarget(
    target: string,
    request: UnifiedRequest,
    requestId: string
  ): Promise<Response> {
    const resolved = this.resolveProvider(target);
    if ('error' in resolved) return resolved.error;

    const { entry, modelId } = resolved;
    const providerName = entry.config.name;
    const modifiedRequest = { ...request, model: modelId };

    if (request.stream) {
      return this.executeStreamingTarget(entry, modifiedRequest, target, providerName, requestId);
    }

    return this.executeNonStreaming(entry, modifiedRequest, target, providerName, requestId, { 'X-Auto-Target': target });
  }

  /**
   * Execute a streaming request for an auto-routing target.
   * Probes the first chunk to validate upstream health before creating the stream.
   */
  private async executeStreamingTarget(
    entry: ProviderEntry,
    request: UnifiedRequest,
    target: string,
    providerName: string,
    requestId: string,
  ): Promise<Response> {
    const startTime = Date.now();

    try {
      const iterator = entry.adapter.sendStreaming(request);
      try {
        const firstResult = await iterator.next();
        if (firstResult.done) {
          entry.breaker.recordFailure();
          logRequestAsync(requestId, target, providerName, Date.now() - startTime, 502, 'Empty stream');
          return this.errorResponse('Empty upstream stream', 'upstream_error', 502);
        }
        const body = this.streamToReadableStream(entry, request, target, providerName, requestId, iterator, firstResult.value);
        return new Response(body, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Provider': providerName,
            'X-Auto-Target': target,
          },
        });
      } catch (err) {
        // Streaming probe failed (e.g., connection error) — record and return error
        entry.breaker.recordFailure();
        const latency = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        const status = this.errorStatus(err);
        logRequestAsync(requestId, target, providerName, latency, status, errorMsg);
        return this.errorResponse(errorMsg, 'upstream_error', status);
      }
    } catch (err) {
      // Outer catch for sendStreaming() itself failing
      entry.breaker.recordFailure();
      const latency = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status = this.errorStatus(err);
      logRequestAsync(requestId, target, providerName, latency, status, errorMsg);
      return this.errorResponse(errorMsg, 'upstream_error', status);
    }
  }

  private streamToReadableStream(
    entry: ProviderEntry,
    request: UnifiedRequest,
    modelId: string,
    providerName: string,
    requestId: string,
    iterator?: AsyncGenerator<UnifiedStreamEvent>,
    headChunk?: UnifiedStreamEvent
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iter = iterator ?? entry.adapter.sendStreaming(request);
    let finished = false;
    let headEmitted = headChunk === undefined;
    let chunksSent = 0; // 追踪是否实际发送了内容 chunk

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // 先发送预取的首个 chunk
          if (!headEmitted && headChunk !== undefined) {
            headEmitted = true;
            chunksSent++;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(headChunk)}\n\n`));
            return;
          }

          const { value, done } = await iter.next();
          if (done) {
            if (!finished) {
              finished = true;
              if (chunksSent === 0) {
                // 流未产生任何内容 chunk：视为上游异常，记录失败
                entry.breaker.recordFailure();
                logRequestAsync(requestId, modelId, providerName, 0, 502, 'Empty stream (no chunks)');
              } else {
                entry.breaker.recordSuccess();
                logRequestAsync(requestId, modelId, providerName, 0, 200);
              }
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          chunksSent++;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        } catch (err) {
          // 流中途失败：记录故障、发送 SSE error 事件并正常关闭
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (!finished) {
            finished = true;
            entry.breaker.recordFailure();
            logRequestAsync(requestId, modelId, providerName, 0, 502, errorMsg);
          }
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`));
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

  /** 获取某 Provider 当前有效的模型数量（优先缓存，其次 config） */
  private getModelCount(providerName: string): number {
    const entry = this.providers.get(providerName);
    if (!entry) return 0;
    if (entry.config.fetch_models === false) {
      return entry.config.models?.length ?? 0;
    }
    return this.modelCache.get(providerName)?.models.length ?? 0;
  }

  getProviderHealth(providerName: string) {
    const entry = this.providers.get(providerName);
    if (!entry) return null;
    return { provider: providerName, state: entry.breaker.getState(), model_count: this.getModelCount(providerName) };
  }

  listProviders() {
    return [...this.providers.entries()].map(([name, entry]) => ({
      name,
      type: entry.config.type,
      enabled: entry.config.enabled,
      model_count: this.getModelCount(name),
      breaker_state: entry.breaker.getState(),
    }));
  }

  getAllModels() {
    const models: Array<{ id: string; object: string; created: number; owned_by: string; provider: string; provider_type: string }> = [];
    for (const [providerName, entry] of this.providers) {
      let modelIds: string[];
      if (entry.config.fetch_models === false) {
        // 用户明确关闭了动态拉取，使用 config 中静态指定的列表
        modelIds = entry.config.models ?? [];
      } else {
        // 仅从缓存读取（启动时异步预热，失败则空）
        modelIds = this.modelCache.get(providerName)?.models ?? [];
      }
      // normalize type for display: arrays get joined, 'auto' stays as-is
      const typeDisplay = Array.isArray(entry.config.type)
        ? entry.config.type.join(',')
        : entry.config.type;
      for (const modelId of modelIds) {
        models.push({
          id: `${providerName}/${modelId}`,
          object: 'model',
          created: 1700000000,
          owned_by: typeDisplay,
          provider: providerName,
          provider_type: typeDisplay,
        });
      }
    }
    // 追加 auto: 路由组
    for (const group of this.autoRouting) {
      models.push({
        id: `auto:${group.name}`,
        object: 'model',
        created: 1700000000,
        owned_by: 'auto',
        provider: 'auto',
        provider_type: 'auto',
      });
    }
    return models;
  }

  listAutoRoutingGroups(): Array<{ name: string; target_count: number; targets: string[] }> {
    return this.autoRouting.map(group => ({
      name: group.name,
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

