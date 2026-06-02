import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
} from '../types/api.js';


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

