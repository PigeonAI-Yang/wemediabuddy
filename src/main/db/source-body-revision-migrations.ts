import type { DatabaseSync } from 'node:sqlite';
import { backfillSourceBodyRevisionBaselines, registerSourceBodyRevisionPurgeGate } from '../source-body-cache.ts';

// WMB-5237：Source 正文不可变 revision 历史。
// - source_body_revisions 是 append-only 正文历史；source_body_cache 继续作为 latest 投影（migration 31）。
// - 删除闸门 UDF wmb_source_body_revision_purge_enabled()：DELETE 触发器仅在 purge 授权窗口内放行
//   （source 删除生命周期用 purgeSourceBodyHistory 清史；其余一切 UPDATE/DELETE 均 RAISE(ABORT)）。
// - run hook 在迁移事务内完成两件事：注册删除闸门 UDF（触发器引用，须随连接存在）+ 为存量
//   source_body_cache 行回填可追溯基线 revision（body_hash 需 JS sha256，纯 SQL 无法计算）。
// - 版本号 61：59/60 已被并行切片占用（knowledge_visual_runs / knowledge_health_issues data_gap）。
export const sourceBodyRevisionMigrations = [
  {
    version: 61,
    sql: `
      CREATE TABLE source_body_revisions (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'failed', 'empty')),
        content_type TEXT,
        extracted_text TEXT NOT NULL DEFAULT '',
        extracted_chars INTEGER NOT NULL DEFAULT 0,
        body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
        error_message TEXT,
        fetched_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        previous_revision_id TEXT REFERENCES source_body_revisions(id)
      );
      CREATE INDEX source_body_revisions_source_created ON source_body_revisions(source_id, created_at DESC, id DESC);
      CREATE INDEX source_body_revisions_source_ready ON source_body_revisions(source_id, status) WHERE status = 'ready';
      CREATE TRIGGER source_body_revisions_immutable_update
        BEFORE UPDATE ON source_body_revisions
        BEGIN
          SELECT RAISE(ABORT, 'SOURCE_BODY_REVISION_IMMUTABLE');
        END;
      CREATE TRIGGER source_body_revisions_immutable_delete
        BEFORE DELETE ON source_body_revisions
        WHEN wmb_source_body_revision_purge_enabled() = 0
        BEGIN
          SELECT RAISE(ABORT, 'SOURCE_BODY_REVISION_IMMUTABLE');
        END;
    `,
    run: (database: DatabaseSync): void => {
      registerSourceBodyRevisionPurgeGate(database);
      backfillSourceBodyRevisionBaselines(database);
    }
  }
] as const;
