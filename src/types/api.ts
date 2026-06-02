// 请求 / 响应类型（与 OpenAI API 保持一致）

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatCompletionRequest {
  model: string; // 格式: <provider>/<model_id>
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' };
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  /** 协议特有参数透传（入口无法映射到 CCR 的字段暂存于此） */
  provider_options?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Anthropic Messages API 类型

/** Anthropic Messages 入口原生请求体 */
export interface AnthropicRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<AnthropicContentBlock>;
  }>;
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  thinking?: { type: 'enabled'; budget_tokens: number };
  stream?: boolean;
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
  | { type: 'thinking'; thinking: string };

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ===== Google Gemini 原生类型 =====

export interface GoogleRequest {
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text?: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
  safetySettings?: Array<{ category: string; threshold: string }>;
}

export interface GoogleResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ===== Ollama 原生类型 =====

export interface OllamaRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
    stop?: string[];
  };
}

export interface OllamaResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
}

// ===== OpenAI Responses 原生类型 =====

export interface ResponsesRequest {
  model: string;
  input: string | Array<{ role: string; content: string }>;
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  stream?: boolean;
  previous_response_id?: string;
  text?: { format?: { type: 'text' | 'json_object' | 'json_schema'; name?: string; schema?: Record<string, unknown> } };
  tools?: Array<{ type: 'function'; name: string; description?: string; parameters?: Record<string, unknown> }>;
}

// 模型列表
export interface ModelInfo {
  id: string; // <provider>/<model_id>
  object: 'model';
  created: number;
  owned_by: string;
  provider: string; // 配置中的 provider 别名
  provider_type: string; // openai / anthropic / ollama / google
  model_id: string; // provider 端的实际模型名
}

// Provider 健康状态
export interface ProviderHealth {
  provider: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  latency_ms: number;
  error_rate: number;
}

export class ProviderApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload?: unknown
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }
}
