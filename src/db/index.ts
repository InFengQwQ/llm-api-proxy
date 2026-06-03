import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let db: Database.Database | null = null;

export function initDatabase(path: string): Database.Database {
  if (db) return db;

  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id  TEXT NOT NULL,
      model       TEXT NOT NULL,
      provider    TEXT NOT NULL,
      latency_ms  INTEGER NOT NULL,
      status_code INTEGER NOT NULL,
      prompt_tokens  INTEGER,
      completion_tokens INTEGER,
      total_tokens   INTEGER,
      error_msg   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_logs_model    ON request_logs(model);
    CREATE INDEX IF NOT EXISTS idx_logs_provider ON request_logs(provider);
    CREATE INDEX IF NOT EXISTS idx_logs_created  ON request_logs(created_at);
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}

export function logRequest(params: {
  request_id: string;
  model: string;
  provider: string;
  latency_ms: number;
  status_code: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  error_msg?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO request_logs (request_id, model, provider, latency_ms, status_code,
                              prompt_tokens, completion_tokens, total_tokens, error_msg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.request_id,
    params.model,
    params.provider,
    params.latency_ms,
    params.status_code,
    params.prompt_tokens ?? null,
    params.completion_tokens ?? null,
    params.total_tokens ?? null,
    params.error_msg ?? null
  );
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// 批量日志缓冲（模块级缓冲，减少 SQLite 写入频率）
// ---------------------------------------------------------------------------

interface PendingLog {
  requestId: string;
  model: string;
  provider: string;
  latency: number;
  status: number;
  error?: string;
}

const pendingLogs: PendingLog[] = [];

function flushLogs(): void {
  if (!pendingLogs.length) return;
  const batch = pendingLogs.splice(0);
  for (const l of batch) {
    logRequest({
      request_id: l.requestId,
      model: l.model,
      provider: l.provider,
      latency_ms: l.latency,
      status_code: l.status,
      error_msg: l.error,
    });
  }
}

/** 异步记录请求日志（缓冲写入，攒 10 条刷盘一次） */
export function logRequestAsync(
  requestId: string,
  model: string,
  provider: string,
  latency: number,
  status: number,
  error?: string,
): void {
  pendingLogs.push({ requestId, model, provider, latency, status, error });
  if (pendingLogs.length >= 10) flushLogs();
}

// 每 5 秒定时刷盘，防止尾部日志丢失
const flushIntervalId = setInterval(flushLogs, 5_000);

/** 停止批量日志刷盘定时器并刷盘（用于优雅关闭） */
export function stopLogBuffer(): void {
  clearInterval(flushIntervalId);
  flushLogs();
}