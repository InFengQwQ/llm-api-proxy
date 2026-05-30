// Provider 相关类型

export type ProviderType = 'openai' | 'anthropic' | 'deepseek' | 'gemini' | 'ollama';

export type ProviderCapability = 'chat' | 'streaming' | 'tools';

export interface Provider {
  name: string; // 用户自定义的别名
  type: ProviderType;
  api_key?: string;
  base_url?: string; // 自定义端点（如 OpenAI 兼容接口）
  models: string[]; // 该 Provider 下可用模型 ID 列表
  enabled: boolean;
  circuit_breaker: CircuitBreakerConfig;
  rate_limit?: RateLimitConfig;
}

export interface CircuitBreakerConfig {
  failure_threshold: number; // 连续失败多少次后打开断路器
  recovery_timeout: number; // 秒，恢复探测间隔
}

export interface RateLimitConfig {
  rpm?: number; // 每分钟请求数
  tpm?: number; // 每分钟 token 数
}

export interface RouterTarget {
  provider_name: string;
  model_id: string;
}

// 路由决策结果
export interface RouteResult {
  provider: Provider;
  model_id: string; // provider 端的实际模型名
}