import { mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Request, Response, NextFunction } from 'express';

// ---------- 日志条目结构 ----------

interface LogEntry {
  timestamp: string;
  request_id: string;
  method: string;
  path: string;
  model: string;
  provider: string;
  status: number;
  latency_ms: number;
  ip: string;
  user_agent: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  error?: string;
}

/** 保存到 bodies/ 目录的完整请求-响应对 */
interface BodyCapture {
  request_id: string;
  timestamp: string;
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    latency_ms: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

// ── Constants ────────────────────────────────────────────────────────────

/** Maximum raw body length to preserve before truncating (characters) */
const MAX_RAW_BODY_LENGTH = 5000;

// ── Utility Functions ────────────────────────────────────────────────────

/** 生成 "YYYY-MM-DDTHH-mm-ss" 格式的时间戳目录名 */
function startupDirName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** 追加一行 JSON 到指定日志文件（立即刷盘） */
function appendLog(filePath: string, entry: LogEntry): void {
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

/** 需要捕获请求/响应体的端点 */
const BODY_CAPTURE_PATHS = ['/v1/chat/completions', '/v1/messages'];

/** 需要从 headers 中脱敏的 key */
const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie'];

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.includes(k.toLowerCase())) {
      out[k] = v.slice(0, 8) + '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 将 Express 请求头转为普通对象 */
function reqHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    h[req.rawHeaders[i]] = req.rawHeaders[i + 1];
  }
  return sanitizeHeaders(h);
}

/** 将 Express 响应头转为普通对象（res.getHeaders() 返回的是 outgoing headers） */
function resHeaders(res: Response): Record<string, string> {
  const raw = res.getHeaders();
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    h[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return sanitizeHeaders(h);
}

/**
 * 从流式累积 chunk 中提取响应体 JSON
 * - 优先取 res.json() 捕获的对象
 * - 其次尝试从 SSE 流中解析最后一行 data
 * - 兜底保存原始文本
 */
function extractResponseBody(chunks: Buffer[], jsonBody: unknown): unknown {
  if (jsonBody !== undefined) return jsonBody;
  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString('utf-8');

  // SSE 格式
  if (raw.startsWith('data:') || raw.includes('\ndata:')) {
    const dataLines = raw.split('\n')
      .map(l => {
        const trimmed = l.trimStart();
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim();
          if (payload && payload !== '[DONE]') return payload;
        }
        return '';
      })
      .filter(Boolean);

    if (dataLines.length > 0) {
      // 策略1: 取最后一行 data（流式结束时的汇总 JSON，含 usage）
      const lastLine = dataLines[dataLines.length - 1];
      try { return JSON.parse(lastLine); } catch { /* fall through */ }

      // 策略2: 拼接所有 data 行
      try { return JSON.parse(dataLines.join('')); } catch { /* fall through */ }

      // 策略3: 保存原始 SSE 文本
      return { _raw_sse: raw, _data_lines: dataLines.length };
    }
    return { _raw_sse: raw, _note: 'no valid data lines' };
  }

  // 非 SSE 流式内容，截断避免过大
  const truncated = raw.length > MAX_RAW_BODY_LENGTH ? raw.slice(0, MAX_RAW_BODY_LENGTH) + '...(truncated)' : raw;
  try { return JSON.parse(truncated); } catch { return { _raw_body: truncated }; }
}

// ---------- Logger 类 ----------

export class RequestLogger {
  private baseDir: string;
  private bodiesDir: string;
  private requestsPath: string;
  private errorsPath: string;
  private chatPath: string;

  constructor(logRoot: string = 'logs') {
    const dirName = startupDirName();
    this.baseDir = join(logRoot, dirName);
    mkdirSync(this.baseDir, { recursive: true });

    this.bodiesDir    = join(this.baseDir, 'bodies');
    this.requestsPath = join(this.baseDir, 'requests.log');
    this.errorsPath   = join(this.baseDir, 'errors.log');
    this.chatPath     = join(this.baseDir, 'chat.log');

    mkdirSync(this.bodiesDir, { recursive: true });

    console.log(`[RequestLogger] Log directory: ${this.baseDir}`);
    console.log(`[RequestLogger] Body capture  : ${this.bodiesDir}`);
  }

  /** 获取某个 Provider 的专属日志文件路径 */
  private providerPath(provider: string): string {
    const safe = provider.replace(/[^a-zA-Z0-9_\-\. ]/g, '_');
    return join(this.baseDir, `provider-${safe}.log`);
  }

  /**
   * Express 中间件：记录每个 HTTP 请求 & 响应
   * - 元数据日志：requests.log / errors.log / chat.log / provider-*.log
   * - 请求/响应体：bodies/<request_id>.json（仅 LLM 端点）
   */
  middleware() {
    const self = this;
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      const requestId = (req.headers['x-request-id'] as string) ||
                        `req_${start}_${Math.random().toString(36).slice(2, 8)}`;

      // 将 request_id 绑定到 req 上，方便下游使用
      (req as unknown as Record<string, unknown>)['requestId'] = requestId;
      res.setHeader('X-Request-Id', requestId);

      // ---- 捕获响应体 ----
      let resBodyObj: unknown = undefined;       // res.json() 传入的原始对象
      const resChunks: Buffer[] = [];             // res.write() 累积的流式数据

      /** 统一处理各种可能的 chunk 类型，统一转为 Buffer */
      function pushChunk(target: Buffer[], chunk: unknown): void {
        if (!chunk) return;

        if (typeof chunk === 'string') {
          target.push(Buffer.from(chunk, 'utf-8'));
        } else if (Buffer.isBuffer(chunk)) {
          target.push(chunk);
        } else if (chunk instanceof Uint8Array) {
          target.push(Buffer.from(chunk));
        } else if (chunk instanceof ArrayBuffer) {
          target.push(Buffer.from(chunk));
        } else if (ArrayBuffer.isView(chunk)) {
          target.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        // 非二进制/字符串类型，忽略
      }

      // 是否应捕获请求/响应体
      const shouldCapture = req.method === 'POST' &&
        BODY_CAPTURE_PATHS.some(p => req.originalUrl === p || req.path === p);

      // 拦截 res.json — 捕获非流式 JSON 响应体
      const originalJson = res.json.bind(res);
      res.json = function (data: unknown) {
        resBodyObj = data;
        return originalJson(data);
      } as typeof res.json;

      // 拦截 res.write — 累积流式响应块
      const originalWrite = res.write.bind(res);
      res.write = function (chunk: unknown, ...rest: unknown[]): boolean {
        pushChunk(resChunks, chunk);
        // TypeScript overloads for res.write are complex; safely cast through unknown
        return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      };

      // 拦截 res.end — 也捕获可能的尾部 chunk + 写日志
      const originalEnd = res.end.bind(res);
      res.end = function (...args: Parameters<Response['end']>) {
        // res.end 可能携带最后一个 chunk（第一个参数）
        if (args.length > 0 && args[0] !== undefined) {
          pushChunk(resChunks, args[0]);
        }

        const latency = Date.now() - start;

        // 提取 body 中的 model
        const model = (req.body as Record<string, unknown> | undefined)?.model as string || '-';
        const provider = (res.getHeader('X-Provider') as string) || '-';

        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          request_id: requestId,
          method: req.method,
          path: req.originalUrl || req.url,
          model,
          provider,
          status: res.statusCode,
          latency_ms: latency,
          ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
              req.socket.remoteAddress ||
              '-',
          user_agent: (req.headers['user-agent'] as string) || '-',
        };

        // 从响应中提取 token 用量
        const locals = res.locals as Record<string, unknown> | undefined;
        if (locals?.prompt_tokens     !== undefined) entry.prompt_tokens     = Number(locals.prompt_tokens);
        if (locals?.completion_tokens !== undefined) entry.completion_tokens = Number(locals.completion_tokens);
        if (locals?.total_tokens      !== undefined) entry.total_tokens      = Number(locals.total_tokens);
        if (locals?.error_msg)        entry.error = String(locals.error_msg);

        // === 写入元数据日志 ===
        appendLog(self.requestsPath, entry);

        if (res.statusCode >= 400) {
          appendLog(self.errorsPath, entry);
        }

        if (req.originalUrl === '/v1/chat/completions' || req.path === '/v1/chat/completions') {
          appendLog(self.chatPath, entry);
        }

        if (provider !== '-') {
          appendLog(self.providerPath(provider), entry);
        }

        // === 写入请求/响应体文件 ===
        if (shouldCapture) {
          const resBody = extractResponseBody(resChunks, resBodyObj);
          const capture: BodyCapture = {
            request_id: requestId,
            timestamp: new Date().toISOString(),
            request: {
              method: req.method,
              path: req.originalUrl || req.url,
              headers: reqHeaders(req),
              body: req.body ?? null,
            },
            response: {
              status: res.statusCode,
              latency_ms: latency,
              headers: resHeaders(res),
              body: resBody,
            },
          };

          try {
            writeFileSync(
              join(self.bodiesDir, `${requestId}.json`),
              JSON.stringify(capture, null, 2),
              'utf-8'
            );
          } catch (err) {
            console.error(`[RequestLogger] Failed to write body file: ${(err as Error).message}`);
          }
        }

        return originalEnd(...args);
      } as typeof res.end;

      next();
    };
  }

  /** 优雅关闭（appendFileSync 无需清理，保留接口兼容） */
  close(): void {
    // appendFileSync / writeFileSync 是同步写入，无需 flush
  }
}
