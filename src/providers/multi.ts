import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
  ProviderApiError
} from '../types/api.js';
import type { ProviderConfig } from '../config/index.js';
import type { ProviderAdapter } from './base.js';
import { createAdapter, getAdapterKeys } from './index.js';

/**
 * 多协议 Adapter — 同一个 Provider 下不同模型走不同协议。
 *
 * 运行时行为：
 * - 为每个 model_id 维护一个 model_id → adapter 的内存缓存
 * - 首次请求某 model 时，依次用各 adapter 尝试；第一个返回成功的缓存复用
 * - 协议不匹配（404 / "model not found"）继续尝试下一个 adapter
 * - 网络/认证错误直接抛出（不重试）
 */
export class MultiProtocolAdapter implements ProviderAdapter {
  name: string;
  type = 'multi';

  /** sub-adapters in priority order */
  private adapters: ProviderAdapter[];
  /** model_id → adapter cache */
  private modelCache = new Map<string, ProviderAdapter>();

  constructor(
    private config: ProviderConfig,
    typeNames: string[],
  ) {
    this.name = config.name;
    // resolve 'auto' → all registered adapter keys (excluding 'multi' to avoid recursion)
    const hasAuto = typeNames.includes('auto');
    const resolved = hasAuto
      ? getAdapterKeys().filter(k => k !== 'multi')
      : typeNames;

    // deduplicate
    const unique = [...new Set(resolved)];
    if (unique.length === 0) {
      throw new Error(`[multi] No adapter types configured for provider "${config.name}"`);
    }

    this.adapters = unique.map(t => {
      const subConfig = { ...config, type: t } as ProviderConfig;
      return createAdapter(subConfig);
    });

    console.log(
      `[multi] Provider "${config.name}" initialized with ${this.adapters.length} protocols: ${unique.join(', ')}`,
    );
  }

  // ---- error classification ----

  /** Returns true if the error indicates the model doesn't exist at this endpoint.
   *  Uses ProviderApiError.status for reliable detection, falling back to string matching. */
  private isModelNotFound(err: unknown): boolean {
    if (err instanceof ProviderApiError) {
      return err.status === 404;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(msg)) return true;
    if (/not\s*found/i.test(msg)) return true;
    if (/model.*not.*supported/i.test(msg)) return true;
    if (/model.*not.*found/i.test(msg)) return true;
    return false;
  }

  /** Returns true if the error is a client error (4xx except 404) that should NOT trigger fallback */
  private shouldThrowImmediately(err: unknown): boolean {
    if (err instanceof ProviderApiError) {
      return err.status >= 400 && err.status < 500 && err.status !== 404;
    }
    return false;
  }

  // ---- model cache helpers ----

  private getCachedAdapter(model: string): ProviderAdapter | undefined {
    return this.modelCache.get(model);
  }

  private setCachedAdapter(model: string, adapter: ProviderAdapter): void {
    this.modelCache.set(model, adapter);
    console.log(`[multi] model "${model}" → ${adapter.type}`);
  }

  // ---- ProviderAdapter implementation ----

  /**
   * Core fallback engine: try cached adapter first, then probe all adapters.
   * Returns the result of the first successful operation.
   * Throws if all adapters fail or an immediate-throw error occurs.
   */
  private async executeWithFallback<T>(
    model: string,
    operation: (adapter: ProviderAdapter) => Promise<T>,
  ): Promise<T> {
    // 1. Try cache
    const cached = this.getCachedAdapter(model);
    if (cached) {
      try {
        return await operation(cached);
      } catch (err) {
        if (this.shouldThrowImmediately(err)) throw err;
        if (this.isModelNotFound(err)) {
          this.modelCache.delete(model);
          console.log(`[multi] cached adapter for "${model}" returned 404; re-probing`);
        } else {
          throw err;
        }
      }
    }

    // 2. Cache miss — probe all adapters
    let lastError: unknown;
    for (const adapter of this.adapters) {
      try {
        const result = await operation(adapter);
        this.setCachedAdapter(model, adapter);
        return result;
      } catch (err) {
        lastError = err;
        if (this.shouldThrowImmediately(err)) throw err;
        if (this.isModelNotFound(err)) continue;
        throw err;
      }
    }

    throw lastError ?? new Error(`[multi] No adapter succeeded for model "${model}"`);
  }

  async send(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.executeWithFallback(request.model, (adapter) => adapter.send(request));
  }

  async *sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const model = request.model;

    // 1. Check cache
    const cached = this.getCachedAdapter(model);
    if (cached) {
      try {
        const iterator = cached.sendStreaming(request);
        const first = await iterator.next();
        if (first.done) return;
        yield first.value;
        yield* iterator;
        return;
      } catch (err) {
        if (this.shouldThrowImmediately(err)) throw err;
        if (this.isModelNotFound(err)) {
          this.modelCache.delete(model);
          console.log(`[multi] cached adapter for "${model}" returned 404; re-probing`);
        } else {
          throw err;
        }
      }
    }

    // 2. Cache miss — probe all adapters
    let lastError: unknown;
    for (const adapter of this.adapters) {
      try {
        const iterator = adapter.sendStreaming(request);
        // Probe: consume first chunk to validate the adapter
        const first = await iterator.next();
        if (first.done) {
          // Empty stream — treat as model-not-found
          lastError = new Error('Empty stream');
          continue;
        }
        // First chunk succeeded → cache and yield
        this.setCachedAdapter(model, adapter);
        yield first.value;
        yield* iterator;
        return;
      } catch (err) {
        lastError = err;
        if (this.shouldThrowImmediately(err)) throw err;
        if (this.isModelNotFound(err)) {
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error(`[multi] No streaming adapter succeeded for model "${model}"`);
  }

  async health(): Promise<ProviderHealth> {
    const results = await Promise.allSettled(
      this.adapters.map(a => a.health()),
    );

    let healthy = 0;
    let degraded = 0;
    let unavailable = 0;
    let totalLatency = 0;
    let count = 0;

    for (const r of results) {
      if (r.status === 'fulfilled') {
        totalLatency += r.value.latency_ms;
        count++;
        if (r.value.status === 'healthy') healthy++;
        else if (r.value.status === 'degraded') degraded++;
        else unavailable++;
      } else {
        unavailable++;
      }
    }

    return {
      provider: this.name,
      status: healthy > 0 ? 'healthy' : degraded > 0 ? 'degraded' : 'unavailable',
      latency_ms: count > 0 ? Math.round(totalLatency / count) : 0,
      error_rate: results.length > 0 ? unavailable / results.length : 1,
    };
  }

  async fetchModels(): Promise<string[]> {
    const allModels = new Set<string>();
    for (const adapter of this.adapters) {
      try {
        const models = await adapter.fetchModels();
        for (const m of models) allModels.add(m);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[multi] ${this.name}/${adapter.type} fetchModels failed: ${errMsg}`);
      }
    }
    return [...allModels];
  }
}
