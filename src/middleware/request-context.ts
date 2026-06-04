import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Request, Response, NextFunction } from 'express';
import type { RequestContext } from '../types/log.js';

// ── Body Capture 结构 ───────────────────────────────────────────────────

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
    error_payload?: unknown;
  };
}

// ── 常量 ────────────────────────────────────────────────────────────────

/** 最大原始 body 截断长度 */
const MAX_RAW_BODY_LENGTH = 5000;

/** 需要捕获请求/响应体的路径（所有 LLM 端点） */
const BODY_CAPTURE_PATHS = [
  '/v1/chat/completions',
  '/v1/messages',
  '/v1/responses',
  '/api/chat',
];

/** Google Gemini 路径前缀 */
const BODY_CAPTURE_PREFIX = '/v1beta/models/';

/** 需要脱敏的 header key */
const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie'];

// ── 工具函数 ────────────────────────────────────────────────────────────

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? v.slice(0, 8) + '***' : v;
  }
  return out;
}

function reqHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    h[req.rawHeaders[i]] = req.rawHeaders[i + 1];
  }
  return sanitizeHeaders(h);
}

function resHeaders(res: Response): Record<string, string> {
  const raw = res.getHeaders();
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    h[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return sanitizeHeaders(h);
}

/** 统一处理各种可能的 chunk 类型，转为 Buffer */
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
    target.push(Buffer.from((chunk as ArrayBufferView).buffer, (chunk as ArrayBufferView).byteOffset, (chunk as ArrayBufferView).byteLength));
  }
}

/** 从流式累积 chunk 中提取响应体 JSON */
function extractResponseBody(chunks: Buffer[], jsonBody: unknown): unknown {
  if (jsonBody !== undefined) return jsonBody;
  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString('utf-8');

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
      const lastLine = dataLines[dataLines.length - 1];
      try { return JSON.parse(lastLine); } catch { /* fall through */ }
      try { return JSON.parse(dataLines.join('')); } catch { /* fall through */ }
      return { _raw_sse: raw, _data_lines: dataLines.length };
    }
    return { _raw_sse: raw, _note: 'no valid data lines' };
  }

  const truncated = raw.length > MAX_RAW_BODY_LENGTH ? raw.slice(0, MAX_RAW_BODY_LENGTH) + '...(truncated)' : raw;
  try { return JSON.parse(truncated); } catch { return { _raw_body: truncated }; }
}

/** 判断路径是否需要 body capture */
function shouldCaptureBody(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  if (BODY_CAPTURE_PATHS.includes(path)) return true;
  if (path.startsWith(BODY_CAPTURE_PREFIX)) return true;
  return false;
}

// ── RequestContextMiddleware ─────────────────────────────────────────────

export class RequestContextMiddleware {
  private bodiesDir: string;

  constructor(logRoot: string = 'logs') {
    const dirName = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const baseDir = join(logRoot, dirName);
    this.bodiesDir = join(baseDir, 'bodies');
    mkdirSync(this.bodiesDir, { recursive: true });
    console.log(`[RequestContextMiddleware] Body capture dir: ${this.bodiesDir}`);
  }

  /**
   * Express 中间件：创建 RequestContext 并挂载到 res.locals.ctx，
   * 捕获响应体用于 body dump。
   */
  middleware() {
    const self = this;
    return (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      const requestId = (req.headers['x-request-id'] as string) ||
        `req_${startTime}_${Math.random().toString(36).slice(2, 8)}`;

      res.setHeader('X-Request-Id', requestId);

      // 创建 RequestContext
      const ctx: RequestContext = {
        requestId,
        startTime,
        method: req.method,
        path: req.originalUrl || req.url,
        model: (req.body as Record<string, unknown> | undefined)?.model as string || '-',
        ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          req.socket.remoteAddress || '-',
        userAgent: (req.headers['user-agent'] as string) || '-',
        entryProtocol: '',
        isStream: !!(req.body as Record<string, unknown> | undefined)?.stream,
        // 由 router 填充
        provider: '-',
        statusCode: 0,
        latencyMs: 0,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        errorMsg: null,
        errorPayload: null,
      };
      (res.locals as Record<string, unknown>).ctx = ctx;

      // 响应体捕获
      const shouldCapture = shouldCaptureBody(req.method, req.path || '');
      let resBodyObj: unknown = undefined;
      const resChunks: Buffer[] = [];

      const originalJson = res.json.bind(res);
      res.json = function (data: unknown) {
        resBodyObj = data;
        return originalJson(data);
      } as typeof res.json;

      const originalWrite = res.write.bind(res);
      res.write = function (chunk: unknown, ...rest: unknown[]): boolean {
        pushChunk(resChunks, chunk);
        return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      };

      const originalEnd = res.end.bind(res);
      res.end = function (...args: Parameters<Response['end']>) {
        if (args.length > 0 && args[0] !== undefined) {
          pushChunk(resChunks, args[0]);
        }

        // 补全 ctx 中可以从响应推断的字段
        if (ctx.statusCode === 0) {
          ctx.statusCode = res.statusCode;
        }
        if (ctx.latencyMs === 0) {
          ctx.latencyMs = Date.now() - startTime;
        }

        // 写 body dump
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
              latency_ms: Date.now() - startTime,
              headers: resHeaders(res),
              body: resBody,
              ...(ctx.errorPayload ? { error_payload: ctx.errorPayload } : {}),
            },
          };

          try {
            writeFileSync(
              join(self.bodiesDir, `${requestId}.json`),
              JSON.stringify(capture, null, 2),
              'utf-8',
            );
          } catch (err) {
            console.error(`[RequestContextMiddleware] Failed to write body file: ${(err as Error).message}`);
          }
        }

        return originalEnd(...args);
      } as typeof res.end;

      next();
    };
  }
}