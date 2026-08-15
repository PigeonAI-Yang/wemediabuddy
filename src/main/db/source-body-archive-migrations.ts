import type { DatabaseSync } from 'node:sqlite';

// WMB-5269：Source 正文自动归档持久任务（设计 §8/§9/§11）。
// - source_body_capture_jobs：正文任务（幂等键 job_key = `source:<sourceId>:r<revision>`）；
//   状态机 pending → running → ready / retry_wait → running / needs_review / unavailable。
// - source_body_capture_attempts：每次实际尝试的结构化诊断（设计 §11 字段子集；三次尝试时间线）。
// - 历史补抓水位：app_meta key `source_body_backfill_cursor`（JSON {collectedAt, id} 或 'done'）。
// - 版本号 71：70 已被 zhihu 一等平台重建占用（migrations.ts 内联）。
// 写授权：本表与既有表一样受 write-guard 保护（installWorkspaceWriteGuard 按连接安装
// TEMP 触发器时枚举全部表）；Worker claim/finish 必须经 dispatchBusinessCommand 授权执行。
export const sourceBodyArchiveMigrations = [
  {
    version: 71,
    sql: `
      CREATE TABLE source_body_capture_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        source_revision INTEGER NOT NULL,
        job_key TEXT NOT NULL UNIQUE,
        priority TEXT NOT NULL CHECK (priority IN ('new_source', 'historical_backfill')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'ready', 'needs_review', 'unavailable')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at TEXT NOT NULL,
        body_candidate TEXT,
        url TEXT,
        channel TEXT,
        domain TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_http_status INTEGER,
        reason_category TEXT,
        retryable INTEGER NOT NULL DEFAULT 1,
        fetch_method TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX source_body_capture_jobs_queue ON source_body_capture_jobs(status, priority, next_attempt_at);
      CREATE INDEX source_body_capture_jobs_source ON source_body_capture_jobs(source_id, source_revision);
      CREATE INDEX source_body_capture_jobs_failures ON source_body_capture_jobs(workspace_id, status, finished_at DESC) WHERE status IN ('needs_review', 'unavailable');
      CREATE TABLE source_body_capture_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES source_body_capture_jobs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        fetch_method TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        http_status INTEGER,
        content_type TEXT,
        requested_url TEXT,
        final_url TEXT,
        redirect_chain TEXT,
        extracted_chars INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (job_id, attempt_number)
      );
      CREATE INDEX source_body_capture_attempts_job ON source_body_capture_attempts(job_id, attempt_number);
    `,
    run: (database: DatabaseSync): void => {
      // 历史补抓水位缺省：不存在 → 尚未开始（worker 首 tick 从全量扫描起点开始）。
      const existing = database.prepare("SELECT value FROM app_meta WHERE key = 'source_body_backfill_cursor'").get() as { value?: string } | undefined;
      if (!existing) {
        const now = new Date().toISOString();
        database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?)')
          .run('source_body_backfill_cursor', 'not_started', now, now, 1);
      }
    }
  }
] as const;
