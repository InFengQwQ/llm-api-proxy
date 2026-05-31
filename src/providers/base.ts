import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
} from '../types/api.js';
import type { ProviderConfig } from '../config/index.js';

export interface ProviderAdapter {
  name: string;
  type: string;

  send(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk>;
  health(): Promise<ProviderHealth>;
}

// 请求上下文：包含解析后的实际模型名和 Provider 配置
export interface RequestContext {
  provider_name: string;
  model_id: string; // provider 端的实际模型名
  config: ProviderConfig;
  startTime: number;
}