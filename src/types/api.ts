// ═══════════════════════════════════════════════════════════════════════
// 协议无关的统一中间表示（Unified Intermediate Representation）
// 所有入口协议先转为此格式，所有上游适配器从此格式转出。
// Content block 数组模型 — 不偏向任何一方协议。
// ═══════════════════════════════════════════════════════════════════════

// ── Content Blocks ──

export type UnifiedContentBlock =
  | UnifiedTextBlock
  | UnifiedToolUseBlock
  | UnifiedToolResultBlock
  | UnifiedThinkingBlock;

export interface UnifiedTextBlock {
  type: 'text';
  text: string;
}

export interface UnifiedToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UnifiedToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: UnifiedContentBlock[];
  is_error?: boolean;
}

export interface UnifiedThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

// ── Messages ──

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: UnifiedContentBlock[];
  /** tool 角色消息的关联 ID */
  tool_call_id?: string;
  /** tool 角色消息的函数名（Google/Ollama 需要） */
  name?: string;
}

// ── Tools ──

export interface UnifiedTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>; // JSON Schema
}

export type UnifiedToolChoice =
  | 'auto'
  | 'any'
  | 'none'
  | { type: 'tool'; name: string };

// ── Request ──

export interface UnifiedRequest {
  model: string;
  messages: UnifiedMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: UnifiedTool[];
  tool_choice?: UnifiedToolChoice;
  /** 扩展思考/推理（Anthropic / OpenAI reasoning）。开启时传入 budget_tokens */
  extended_thinking?: { budget_tokens: number };
}

// ── Response ──

export interface UnifiedResponse {
  id: string;
  model: string;
  content: UnifiedContentBlock[];
  stop_reason: 'max_tokens' | 'stop_sequence' | 'tool_use' | 'stop';
  usage: { input_tokens: number; output_tokens: number };
}

// ── Streaming ──

export type UnifiedStreamEvent =
  | { type: 'text_delta'; text: string; index: number }
  | { type: 'thinking_delta'; thinking: string; index: number }
  | { type: 'tool_use_start'; id: string; name: string; index: number }
  | { type: 'tool_use_delta'; id: string; partial_json: string; index: number }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_start'; id: string; model: string }
  | { type: 'message_stop'; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } };

// ═══════════════════════════════════════════════════════════════════════
// 以下为各协议原生类型（入口/出口转换用）
// ═══════════════════════════════════════════════════════════════════════

// OpenAI 原生类型（兼容旧有 ChatCompletionRequest/Response，逐步迁移）

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
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
  model: string;
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
  provider_options?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
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
    type: 'text' | 'tool_use' | 'thinking';
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    thinking?: string;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ===== Google Gemini 原生类型 =====

export interface GoogleResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thinking?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
      }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
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
