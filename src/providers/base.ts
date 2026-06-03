import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
} from '../types/api.js';

// ═══════════════════════════════════════════════
// 接口定义
// ═══════════════════════════════════════════════

export interface ProviderAdapter {
  name: string;
  type: string;

  send(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk>;
  health(): Promise<ProviderHealth>;
  /** 从 Provider 的 /models（或等价）端点拉取模型 ID 列表 */
  fetchModels(): Promise<string[]>;
}

/** 入口协议双向转换器 — 和 ProviderAdapter 同文件，共享字段映射逻辑 */
export interface EntryConverter {
  readonly protocol: string;
  toInternal(body: Record<string, unknown>): ChatCompletionRequest;
  fromInternal(ccResp: ChatCompletionResponse, model: string): unknown;
  transformStream(source: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array>;
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

