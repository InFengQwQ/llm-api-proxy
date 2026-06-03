import type {
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  ProviderHealth,
} from '../types/api.js';

// ═══════════════════════════════════════════════
// 接口定义
// ═══════════════════════════════════════════════

/** 上游 Provider 适配器：UnifiedRequest → 上游协议 */
export interface ProviderAdapter {
  name: string;
  type: string;

  send(request: UnifiedRequest): Promise<UnifiedResponse>;
  sendStreaming(request: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent>;
  health(): Promise<ProviderHealth>;
  /** 从 Provider 的 /models（或等价）端点拉取模型 ID 列表 */
  fetchModels(): Promise<string[]>;
}

/** 入口协议双向转换器：原生协议 ↔ Unified 格式 */
export interface EntryConverter {
  readonly protocol: string;
  /** 原生 JSON body → UnifiedRequest */
  toInternal(body: Record<string, unknown>): UnifiedRequest;
  /** UnifiedResponse → 原生 JSON（非流式） */
  fromInternal(resp: UnifiedResponse): unknown;
  /** UnifiedStreamEvent 流 → 原生 SSE ReadableStream */
  transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}

// ═══════════════════════════════════════════════
// 共享工具：各 Adapter 复用的 health / fetchModels
// ═══════════════════════════════════════════════

/**
 * 通用健康检查：向 url 发送 GET 请求，5s 超时。
 * 返回标准 ProviderHealth。
 */
export async function createHealthCheck(
  providerName: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return {
      provider: providerName,
      status: response.ok ? 'healthy' : 'degraded',
      latency_ms: Date.now() - start,
      error_rate: response.ok ? 0 : 1,
    };
  } catch {
    return {
      provider: providerName,
      status: 'unavailable',
      latency_ms: Date.now() - start,
      error_rate: 1,
    };
  }
}

/**
 * 通用模型列表获取（OpenAI 兼容格式：响应含 { data: [{ id }] }）。
 * 10s 超时，非 ok 抛出 Error。
 */
export async function fetchModelsOpenAIFormat(
  url: string,
  headers: Record<string, string> = {},
): Promise<string[]> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map(m => m.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * 通用模型列表获取（Google 兼容格式：响应含 { models: [{ name }] }）。
 */
export async function fetchModelsGoogleFormat(
  url: string,
): Promise<string[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as { models?: Array<{ name?: string }> };
  return (data.models ?? [])
    .map(m => m.name)
    .filter((id): id is string => typeof id === 'string');
}

