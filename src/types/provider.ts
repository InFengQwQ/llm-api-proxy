// =============================================================================
// Provider 相关类型
// =============================================================================

export type ProviderType = 'openai' | 'anthropic' | 'google' | 'ollama' | 'openai_responses';

// 多协议提供商的 type 可以是数组或 'auto'
export type ProviderTypeConfig = ProviderType | ProviderType[] | 'auto';