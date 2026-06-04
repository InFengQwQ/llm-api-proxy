import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { RequestContext } from '../types/log.js';

let db: Database.Database | null = null;

// ── Schema ──────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS request_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id        TEXT NOT NULL,
    method            TEXT NOT NULL DEFAULT 'POST',
    path              TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL,
    provider          TEXT NOT NULL,
    entry_protocol    TEXT NOT NULL DEFAULT '',
    is_stream         INTEGER NOT NULL DEFAULT 0,
    status_code       INTEGER NOT NULL,
    latency_ms        INTEGER NOT NULL,
    ip                TEXT NOT NULL DEFAULT '',
    user_agent        TEXT NOT NULL DEFAULT '',
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    error_msg         TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

const CREATE_INDEXES_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model)',
  'CREATE INDEX IF NOT EXISTS idx_logs_provider ON request_logs(provider)',
  'CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_logs_status ON request_logs(status_code)',
  'CREATE INDEX IF NOT EXISTS idx_logs_entry_protocol ON request_logs(entry_protocol)',
];

/** 增量迁移：为已有数据库添加新列 */
const MIGRATIONS: Array<{ column: string; sql: string }> = [
  { column: 'method', sql: "ALTER TABLE request_logs ADD COLUMN method TEXT NOT NULL DEFAULT 'POST'" },
  { column: 'path', sql: "ALTER TABLE request_logs ADD COLUMN path TEXT NOT NULL DEFAULT ''" },
  { column: 'entry_protocol', sql: "ALTER TABLE request_logs ADD COLUMN entry_protocol TEXT NOT NULL DEFAULT ''" },
  { column: 'is_stream', sql: "ALTER TABLE request_logs ADD COLUMN is_stream INTEGER NOT NULL DEFAULT 0" },
  { column: 'ip', sql: "ALTER TABLE request_logs ADD COLUMN ip TEXT NOT NULL DEFAULT ''" },
  { column: 'user_agent', sql: "ALTER TABLE request_logs ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''" },
];

const PURGE_RETENTION_DAYS = 30;

/** 真正执行 new Database + 迁移 + 索引 */
function buildDatabase(dbPath: string): Database.Database {
  const conn = new Database(dbPath);
  conn.exec('PRAGMA journal_mode=DELETE');
  conn.exec('PRAGMA synchronous=NORMAL');
  conn.exec(CREATE_TABLE_SQL);

  // 增量迁移：必须在建索引之前（索引引用新列）
  const existingColumns = new Set(
    (conn.prepare("PRAGMA table_info(request_logs)").all() as Array<{ name: string }>)
      .map(col => col.name),
  );
  for (const migration of MIGRATIONS) {
    if (!existingColumns.has(migration.column)) {
      conn.exec(migration.sql);
    }
  }

  for (const sql of CREATE_INDEXES_SQL) {
    conn.exec(sql);
  }
  return conn;
}

export function initDatabase(path: string): Database.Database {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = buildDatabase(path);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── 日志写入 ───────────────────────────────────────────────────────────

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
  const stmt = getDb().prepare(`
    INSERT INTO request_logs (
      request_id, method, path, model, provider, entry_protocol, is_stream,
      status_code, latency_ms, ip, user_agent,
      prompt_tokens, completion_tokens, total_tokens, error_msg
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.request_id,
    params.method,
    params.path,
    params.model,
    params.provider,
    params.entry_protocol,
    params.is_stream,
    params.status_code,
    params.latency_ms,
    params.ip,
    params.user_agent,
    params.prompt_tokens,
    params.completion_tokens,
    params.total_tokens,
    params.error_msg,
  );
}

// ── 批量日志缓冲 ───────────────────────────────────────────────────────

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
let lastPurgeTime = 0;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

function maybePurgeOldLogs(): void {
  const now = Date.now();
  if (now - lastPurgeTime < PURGE_INTERVAL_MS) return;
  lastPurgeTime = now;
  try {
    getDb().prepare(
      `DELETE FROM request_logs WHERE created_at < datetime('now', '-${PURGE_RETENTION_DAYS} days')`,
    ).run();
  } catch {
    // 日志轮转失败不应影响主流程
  }
}

/** 启动日志缓冲定时器 */
export function startLogBuffer(): void {
  if (flushIntervalId) return;
  flushIntervalId = setInterval(() => {
    flushLogs();
    if (db) maybePurgeOldLogs();
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