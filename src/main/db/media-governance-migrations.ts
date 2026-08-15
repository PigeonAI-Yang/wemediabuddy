import type { DatabaseSync } from 'node:sqlite';

// WMB-5247：情报媒体治理持久层（设计 §13 权利/权限与删除、§14 存储与清理）。
// - v67：`media_rights_overrides` —— restricted 绑定的**显式所有者确认证据**。
//   restricted 禁止 AI 自动建议；用户强制采用前必须经 `media.rights_override` 命令显式确认，
//   本表落一条证据行（confirmed_by/at/reason/request_id），同时经既有 operation_log + command_receipts
//   审计（同 request_id 可追溯）。UNIQUE(binding_id) 幂等：重复确认返回既有行，不重复写。
// - 迁移幂等：schema_migrations 记录版本；已应用后重复 migrate 不再执行。
// - 删除门、引用集、GC、设置容量投影均为纯 SQL/只读计算，不占用迁移版本。

export const mediaGovernanceMigrations = [
  {
    version: 67,
    sql: `
      -- ===== restricted 绑定显式所有者确认证据（设计 §6.3 / §13）=====
      CREATE TABLE media_rights_overrides (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL UNIQUE REFERENCES source_media_bindings(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),
        source_revision_key TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX media_rights_overrides_asset ON media_rights_overrides(asset_id);
    `,
    run: (database: DatabaseSync): void => {
      // 纯 DDL 迁移；无存量数据需要回填。
      void database;
    }
  }
] as const;