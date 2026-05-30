import type { ChatCompletionRequest, StreamChunk } from '../types/api.js';
import type { ProviderConfig } from '../config/index.js';
import type { ProviderAdapter } from '../providers/base.js';
import { createAdapter, parseModelId } from '../providers/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logRequest } from '../db/index.js';

// 管理所有 Provider adapter 和熔断器
type ProviderEntry = {
  config: ProviderConfig;
  adapter: ProviderAdapter;
  breaker: CircuitBreaker;
};

export class Router {
  private providers = new Map<string, ProviderEntry>();

  register(configs: ProviderConfig[]): void {
    for (const config of configs) {
      if (!config.enabled) continue;
      this.providers.set(config.name, {
        config,
        adapter: createAdapter(config),
        breaker: new CircuitBreaker(config.circuit_breaker),
      });
    }
  }

  /** 路由到指定 Provider */
  async route(
    fullModelId: string,
    request: ChatCompletionRequest,
    requestId: string
  ): Promise<Response> {
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
      let response: Response;

      if (request.stream) {
        // 流式：转为 SSE
        const stream = this.streamingWrapper(entry, modifiedRequest, requestId);
        response = new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Provider': provider_name,
          },
        });
      } else {
        const result = await entry.adapter.send(modifiedRequest);
        response = Response.json(result, {
          headers: { 'X-Provider': provider_name },
        });
      }

      entry.breaker.recordSuccess();
      const latency = Date.now() - startTime;

      // 异步记录日志（不阻塞响应）
      logRequestAsync(requestId, fullModelId, provider_name, latency, 200);

      return response;
    } catch (err) {
      entry.breaker.recordFailure();
      const latency = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status = errorMsg.includes('429') ? 429 : 502;

      logRequestAsync(requestId, fullModelId, provider_name, latency, status, errorMsg);

      return Response.json(
        { error: { message: errorMsg, type: 'upstream_error' } },
        { status }
      );
    }
  }

  private async *streamingWrapper(
    entry: ProviderEntry,
    request: ChatCompletionRequest,
    requestId: string
  ): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    try {
      for await (const chunk of entry.adapter.sendStreaming(request)) {
        yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      yield encoder.encode('data: [DONE]\n\n');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      yield encoder.encode(`data: ${JSON.stringify({ error: { message: errorMsg } })}\n\n`);
    }
  }

  getProviderHealth(providerName: string) {
    const entry = this.providers.get(providerName);
    if (!entry) return null;
    return {
      provider: providerName,
      state: entry.breaker.getState(),
      model_count: entry.config.models.length,
    };
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
    const models: Array<{
      id: string;
      object: 'model';
      created: number;
      owned_by: string;
      provider: string;
      provider_type: string;
    }> = [];

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
}

let pendingLogs: Array<{
  requestId: string;
  model: string;
  provider: string;
  latency: number;
  status: number;
  error?: string;
}> = [];

function logRequestAsync(
  requestId: string,
  model: string,
  provider: string,
  latency: number,
  status: number,
  error?: string
): void {
  pendingLogs.push({ requestId, model, provider, latency, status, error });

  // 每 10 条或 5 秒后批量写入
  if (pendingLogs.length >= 10) flushLogs();
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function flushLogs(): void {
  if (!pendingLogs.length) return;
  const logs = pendingLogs.splice(0);
  for (const l of logs) {
    logRequest({
      request_id: l.requestId,
      model: l.model,
      provider: l.provider,
      latency_ms: l.latency,
      status_code: l.status,
      error_msg: l.error,
    });
  }
}

// 每 5 秒强制刷新
setInterval(flushLogs, 5000);