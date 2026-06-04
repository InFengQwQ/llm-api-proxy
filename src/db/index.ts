import { appendFileSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import type { RequestContext } from '../types/log.js';

// ── Log file path ───────────────────────────────────────────────────────

const DEFAULT_LOG_DIR = 'logs';
const DEFAULT_LOG_FILE = 'requests.ndjson';

let logDir: string = DEFAULT_LOG_DIR;
let logFilePath: string = join(DEFAULT_LOG_DIR, DEFAULT_LOG_FILE);

export function initLogger(dir?: string, file?: string): void {
  logDir = dir ?? DEFAULT_LOG_DIR;
  logFilePath = join(logDir, file ?? DEFAULT_LOG_FILE);
  mkdirSync(logDir, { recursive: true });
}

// ── 日志写入类型 ─────────────────────────────────────────────────────────

interface FullLogParams {
  request_id: string;
  method: string;
  path: string;
  model: string;
  provider: string;
  entry_protocol: string;
  is_stream: number;
  status_code: number;
  latency_ms: number;
  ip: string;
  user_agent: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  error_msg: string | null;
}

function logRequest(params: FullLogParams): void {
  const record = {
    ...params,
    created_at: new Date().toISOString(),
  };
  appendFileSync(logFilePath, JSON.stringify(record) + '\n', 'utf-8');
}

// ── 批量日志缓冲 ─────────────────────────────────────────────────────────

type PendingLog = FullLogParams;

const pendingLogs: PendingLog[] = [];
const FLUSH_THRESHOLD = 10;
const FLUSH_INTERVAL_MS = 5_000;

function flushLogs(): void {
  if (!pendingLogs.length) return;
  const batch = pendingLogs.splice(0);
  for (const l of batch) {
    logRequest(l);
  }
}

/** 缓冲写入日志（攒 FLUSH_THRESHOLD 条刷盘一次） */
export function logRequestAsync(params: FullLogParams): void {
  pendingLogs.push(params);
  if (pendingLogs.length >= FLUSH_THRESHOLD) flushLogs();
}

/** 从 RequestContext 写入日志的便捷函数 */
export function logComplete(ctx: RequestContext): void {
  logRequestAsync({
    request_id: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    model: ctx.model,
    provider: ctx.provider || '-',
    entry_protocol: ctx.entryProtocol,
    is_stream: ctx.isStream ? 1 : 0,
    status_code: ctx.statusCode,
    latency_ms: ctx.latencyMs,
    ip: ctx.ip,
    user_agent: ctx.userAgent,
    prompt_tokens: ctx.promptTokens,
    completion_tokens: ctx.completionTokens,
    total_tokens: ctx.totalTokens,
    error_msg: ctx.errorMsg,
  });
}

let flushIntervalId: ReturnType<typeof setInterval> | null = null;

/** 启动日志缓冲定时器 */
export function startLogBuffer(): void {
  if (flushIntervalId) return;
  flushIntervalId = setInterval(() => {
    flushLogs();
  }, FLUSH_INTERVAL_MS);
}

/** 停止缓冲定时器并刷盘（优雅关闭） */
export function stopLogBuffer(): void {
  if (flushIntervalId !== null) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }
  flushLogs();
}

// ── 日志读取（用于 /admin/logs 端点） ────────────────────────────────────

export interface LogQuery {
  limit: number;
  provider?: string;
  protocol?: string;
  status?: string;
  method?: string;
}

export function readLogs(query: LogQuery): unknown[] {
  // 日志文件不存在时返回空数组
  try {
    if (!statSync(logFilePath).isFile()) return [];
  } catch {
    return [];
  }

  const raw = readFileSync(logFilePath, 'utf-8');
  const lines = raw.trim().split('\n');
  const results: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      // 过滤
      if (query.provider && entry.provider !== query.provider) continue;
      if (query.protocol && entry.entry_protocol !== query.protocol) continue;
      if (query.status && String(entry.status_code) !== query.status) continue;
      if (query.method && entry.method !== query.method) continue;
      results.push(entry);
    } catch {
      // 跳过损坏的行
      continue;
    }
  }

  // 按 created_at 降序排列
  results.sort((a, b) => {
    const ta = String(a.created_at ?? '');
    const tb = String(b.created_at ?? '');
    return tb.localeCompare(ta);
  });

  return results.slice(0, query.limit);
}
