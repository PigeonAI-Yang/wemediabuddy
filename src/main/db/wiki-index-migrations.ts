import type { DatabaseSync } from 'node:sqlite';
import { rebuildWikiIndex } from './wiki-index-store.ts';

/**
 * WMB-5238：SQLite 内建 Wiki 统一搜索索引 + 持久化有界 hot cache（派生读模型，非第二真源）。
 *
 * 迁移 63 只建两张表：
 * - knowledge_index_entries：统一全文搜索/索引的预压平行（每对象一行当前版本投影；
 *   fixed_version_reference 行为不可变版本的引用行）。searchable_text 有界（store 截断 8000 字符），
 *   LIKE 只打本表（同 searchSources 先例），绝不打源表（body_json/extracted_text 可能很大）。
 * - knowledge_hot_cache：单行（id=1）持久化最近变化摘要；ranking_cache/x_list_index_cache 先例；
 *   有界、可重建、非独立真源。搜索侧的进程内 hot cache 是快层，本表是持久层（WMB-5239 读面）。
 *
 * 为什么不用 FTS5（锁死，勿改）：installWorkspaceWriteGuard 枚举 sqlite_schema 全部 type='table'
 * 并为每张表建 TEMP trigger；FTS5 虚拟表及其影子表也在枚举内，而 SQLite 禁止在虚拟表上建触发器
 * （实测报错 "cannot create triggers on virtual tables"），会让 write guard 安装直接失败。
 * 故统一搜索用普通表 + 预压平 searchable_text + LIKE（与既有 searchSources 行为一致）。
 *
 * 版本锚（version_ref，rebuild 与增量 upsert 必须逐字节一致）：
 * - wiki_page / knowledge_note 当前行 → 不可变版本 id（current_version_id 指向的版本行 id）；
 * - fixed_version_reference 行 → 版本行自身 id（wiki_page_versions / note_versions / source_body_revisions）；
 * - entity / topic → `rev:{revision}`（无版本表，revision 是唯一锚）；
 * - source → 最新 source_body_revisions id；无正文历史时回退 `rev:{revision}`。
 * 同对象新版本不抹除历史固定引用：upsert 只替换当前投影行的版本锚并追加新 fvr 行，绝不
 * 删除/改写不可变版本表（knowledge_*_versions、source_body_revisions）或既有 fvr 行；
 * 引用旧版本 id 的 evidence/usage/receipt/visual_run 永远可经正式表解析。
 *
 * 写入边界：本迁移不建任何触发器（索引维护方式二选一，锁死为「显式 store API」——
 * WireWikiIndexTriggers 在 ChangeSet 提交钩子内以 transaction=false + SAVEPOINT 调用；
 * rebuildWikiIndex 可整表重建）。所有写必须发生在 dispatcher 授权窗口（运行时连接）
 * 或独立无 guard 的连接（后台编译/backfill 先例）内；write guard 会在下一次 dispatch
 * 重装时自动覆盖本迁移新表（sqlite_schema 全表枚举）。
 */
export const wikiIndexMigrations = [
  {
    version: 63,
    sql: `
      -- ===== 统一 Wiki 搜索索引（每对象一行当前投影 + fixed_version_reference 引用行） =====
      CREATE TABLE knowledge_index_entries (
        object_type TEXT NOT NULL CHECK (object_type IN ('wiki_page','knowledge_note','entity','topic','source','fixed_version_reference')),
        object_id TEXT NOT NULL,
        version_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        searchable_text TEXT NOT NULL DEFAULT '',
        topic_ids_json TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT 'global' CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        compile_status TEXT NOT NULL DEFAULT 'current',
        updated_at TEXT NOT NULL,
        nav_object_type TEXT,
        nav_object_id TEXT,
        PRIMARY KEY (object_type, object_id)
      );
      CREATE INDEX knowledge_index_entries_updated ON knowledge_index_entries(updated_at DESC);

      -- ===== 持久化有界 hot cache（单行；可重建；非真源） =====
      CREATE TABLE knowledge_hot_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload_json TEXT NOT NULL,
        rebuilt_at TEXT NOT NULL
      );
    `,
    run: (database: DatabaseSync): void => {
      // 存量工作空间迁移后立即可搜索：在迁移事务内从业务表重建索引（幂等；fresh DB 零行零写）。
      // 精简 fixture / 无知识飞轮表的工作空间（如 WMB-5237 媒体绑定回填的 legacy 模拟库）缺 v56 表时跳过重建，
      // 与 store 既有宽松模式一致（知识版本/实体段各自 try/catch 跳过缺表）。
      const hasWikiPagesTable = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_wiki_pages'")
        .get();
      if (hasWikiPagesTable) rebuildWikiIndex(database, false);
    }
  }
] as const;
