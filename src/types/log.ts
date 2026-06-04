// ── 统一日志类型 ──────────────────────────────────────────────────────

/** 统一日志条目 — SQLite 写入的结构 */
export interface LogEntry {
  request_id: string;
  method: string;
  path: string;
  model: string;
  provider: string;
  entry_protocol: string;  // openai | anthropic | google | ollama | openai_responses
  is_stream: number;       // 0 或 1（SQLite 没有 boolean）
  status_code: number;
  latency_ms: number;
  ip: string;
  user_agent: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  error_msg: string | null;
  created_at: string;      // ISO 8601
}

/** 请求上下文 — 在 middleware 创建，router 填充，logComplete 消费 */
export interface RequestContext {
  requestId: string;
  startTime: number;        // Date.now()
  method: string;
  path: string;
  model: string;            // 从请求体提取
  ip: string;
  userAgent: string;
  entryProtocol: string;    // 入口协议名
  isStream: boolean;

  // 以下由 router 填充
  provider: string;         // 实际路由到的 provider 名，默认 '-'
  statusCode: number;       // HTTP 状态码，默认 0
  latencyMs: number;        // 请求延迟（ms），默认 0
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  errorMsg: string | null;

  // 错误时的上游原始载荷（用于 body dump）
  errorPayload: unknown;
}