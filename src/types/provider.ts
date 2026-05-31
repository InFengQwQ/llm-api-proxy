// =============================================================================
// Provider 相关类型
// =============================================================================

export type ProviderType = 'openai' | 'anthropic' | 'deepseek' | 'gemini' | 'ollama';

export type ProviderCapability = 'chat' | 'streaming' | 'tools';

// 路由决策结果
export interface RouteResult {
  provider_name: string;
  model_id: string;
}