import { DatabaseSync } from 'node:sqlite';
import { lateMigrations } from './late-migrations.ts'; import { topicMaintenanceMigrations } from './topic-maintenance-migrations.ts';
import { knowledgeMigrations } from './knowledge-migrations.ts';
import { knowledgeFlywheelMigrations } from './knowledge-flywheel-migrations.ts';
import { sourceBodyRevisionMigrations } from './source-body-revision-migrations.ts';
import { mediaBindingMigrations } from './media-binding-migrations.ts';
import { mediaArchiveMigrations } from './media-archive-migrations.ts';
import { mediaRecommendationMigrations } from './media-recommendation-migrations.ts';
import { visualUnderstandingMigrations } from './visual-understanding-migrations.ts';
import { mediaGovernanceMigrations } from './media-governance-migrations.ts';
import { sourceBodyArchiveMigrations } from './source-body-archive-migrations.ts';
import { wikiIndexMigrations } from './wiki-index-migrations.ts';
import { piImageBatchMigrations } from './pi-image-batch-migrations.ts';
import { illustrationMigrations } from './illustration-migrations.ts';
import { zhihuHotContentLoopMigrations } from './zhihu-hot-content-loop-migrations.ts';
import { planningStageMigrations } from './planning-stage-migrations.ts';
import { workspaceOrchestratorMigrations } from './workspace-orchestrator-migrations.ts';
import { registerSourceBodyRevisionPurgeGate } from '../source-body-cache.ts';

export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE operation_log (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('ui', 'mcp', 'scheduler')),
        client_label TEXT,
        command TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        before_revision INTEGER,
        after_revision INTEGER,
        result TEXT NOT NULL CHECK (result IN ('ok', 'error')),
        error_code TEXT,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE source_feeds (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE source_items (
        id TEXT PRIMARY KEY, feed_id TEXT REFERENCES source_feeds(id), original_url TEXT, canonical_url TEXT UNIQUE, content_fingerprint TEXT UNIQUE,
        title TEXT NOT NULL, author TEXT, published_at TEXT, collected_at TEXT NOT NULL, summary TEXT, categories_json TEXT NOT NULL,
        keywords_json TEXT NOT NULL, value_judgment TEXT, ip_relevance TEXT, creation_angles TEXT, recommended_platforms_json TEXT NOT NULL,
        recommended_formats_json TEXT NOT NULL, timeliness TEXT, priority INTEGER, evidence TEXT, client_label TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
        CHECK (canonical_url IS NOT NULL OR content_fingerprint IS NOT NULL)
      );
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE plans (id TEXT PRIMARY KEY, plan_date TEXT NOT NULL, timezone TEXT NOT NULL, summary TEXT NOT NULL, is_current INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE UNIQUE INDEX one_current_plan_per_day ON plans(plan_date) WHERE is_current = 1;
      CREATE TABLE plan_items (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), topic_id TEXT REFERENCES topics(id), title TEXT NOT NULL, priority INTEGER NOT NULL, why_now TEXT NOT NULL, timeliness TEXT NOT NULL, target_audience TEXT NOT NULL, angle TEXT NOT NULL, point_of_view TEXT NOT NULL, platforms_json TEXT NOT NULL, formats_json TEXT NOT NULL, title_guidance TEXT NOT NULL, opening_guidance TEXT NOT NULL, structure_guidance TEXT NOT NULL, effort_estimate TEXT NOT NULL, source_ids_json TEXT NOT NULL, review_ids_json TEXT NOT NULL, method_finding_ids_json TEXT NOT NULL, sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
    `
  },
  {
    version: 5,
    sql: `
      CREATE TABLE content_projects (id TEXT PRIMARY KEY, topic_id TEXT REFERENCES topics(id), plan_item_id TEXT REFERENCES plan_items(id), title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE content_project_sources (project_id TEXT NOT NULL REFERENCES content_projects(id), source_id TEXT NOT NULL REFERENCES source_items(id), PRIMARY KEY (project_id, source_id));
      CREATE TABLE content_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES content_projects(id), body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE content_decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES content_projects(id), body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE content_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES content_projects(id), body TEXT NOT NULL, version_number INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, version_number));
      CREATE TABLE platform_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES content_projects(id), content_version_id TEXT NOT NULL REFERENCES content_versions(id), platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')), format TEXT NOT NULL, title TEXT, body TEXT NOT NULL, asset_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
    `
  },
  {
    version: 6,
    sql: `
      CREATE TABLE assets (id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, width INTEGER, height INTEGER, duration_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
    `
  }
  ,{
    version: 7,
    sql: `
      CREATE TABLE mcp_request_results (
        tool TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tool, request_id)
      );
    `
  }
  ,{
    version: 8,
    sql: `
      CREATE TABLE platform_accounts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')) UNIQUE,
        account_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        login_state TEXT NOT NULL CHECK (login_state IN ('authenticated', 'unauthenticated', 'challenge', 'unknown')),
        evidence_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
    `
  },
  {
    version: 9,
    sql: `
      CREATE TABLE publications (
        id TEXT PRIMARY KEY,
        platform_version_id TEXT NOT NULL REFERENCES platform_versions(id),
        platform_version_revision INTEGER NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')),
        account_id TEXT NOT NULL REFERENCES platform_accounts(id),
        account_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'prepared', 'awaiting_confirmation', 'publishing', 'published', 'failed', 'needs_user', 'unknown')),
        prepared_title TEXT,
        prepared_body TEXT,
        prepared_assets_json TEXT NOT NULL,
        prepared_evidence_url TEXT,
        external_url TEXT,
        external_id TEXT,
        published_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE publication_attempts (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL REFERENCES publications(id),
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('publishing', 'published', 'failed', 'needs_user', 'unknown')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT,
        evidence_json TEXT NOT NULL,
        UNIQUE (publication_id, attempt_number)
      );
      CREATE TABLE publication_confirmations (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL REFERENCES publications(id),
        attempt_id TEXT REFERENCES publication_attempts(id) UNIQUE,
        platform_version_id TEXT NOT NULL,
        platform_version_revision INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        account_key TEXT NOT NULL,
        assets_json TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        consumed_at TEXT,
        invalidated_at TEXT,
        invalidation_reason TEXT
      );
      CREATE TABLE publication_reconciliations (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL REFERENCES publications(id),
        attempt_id TEXT REFERENCES publication_attempts(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'not_published', 'ambiguous')),
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE publication_events (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL REFERENCES publications(id),
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 10,
    sql: `
      ALTER TABLE plan_items ADD COLUMN available_materials_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE plan_items ADD COLUMN missing_materials_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE plan_items ADD COLUMN score_reasons_json TEXT NOT NULL DEFAULT '{}';
    `
  },
  {
    version: 11,
    sql: `
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL CHECK (intent IN ('daily_intelligence', 'studio_draft', 'results_review')),
        business_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
        phase TEXT NOT NULL,
        pi_session_id TEXT,
        context_refs_json TEXT NOT NULL,
        result_refs_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX agent_tasks_intent_date_status ON agent_tasks(intent, business_date, status);
    `
  },
  {
    version: 12,
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'needs_user')),
        due_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX jobs_status_due ON jobs(status, due_at);
      CREATE TABLE publication_metric_snapshots (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL REFERENCES publications(id),
        scheduled_for TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source_url TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (publication_id, scheduled_for)
      );
      CREATE TABLE account_metric_snapshots (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source_url TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 13,
    sql: `
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL REFERENCES publications(id),
        content_version_id TEXT NOT NULL,
        metric_snapshot_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'final')),
        keep_json TEXT NOT NULL,
        stop_json TEXT NOT NULL,
        change_json TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finalized_at TEXT,
        revision INTEGER NOT NULL
      );
      CREATE INDEX reviews_publication_status ON reviews(publication_id, status);
      CREATE TABLE method_findings (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE INDEX method_findings_review ON method_findings(review_id);
    `
  }
  ,
  {
    version: 14,
    sql: `
      ALTER TABLE content_versions ADD COLUMN author TEXT NOT NULL DEFAULT 'ai';
    `
  },
  {
    version: 15,
    sql: `
      ALTER TABLE content_projects ADD COLUMN status TEXT NOT NULL DEFAULT 'drafting'
        CHECK (status IN ('idea', 'drafting', 'review', 'ready', 'completed'));
      ALTER TABLE content_projects ADD COLUMN archived_at TEXT;
      CREATE INDEX content_projects_archive_updated ON content_projects(archived_at, updated_at DESC, id DESC);
      CREATE INDEX content_projects_status_archive_updated ON content_projects(status, archived_at, updated_at DESC, id DESC);
    `
  },
  {
    version: 16,
    sql: `
      ALTER TABLE agent_tasks RENAME TO agent_tasks_v11;
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL CHECK (intent IN ('daily_intelligence', 'studio_draft', 'results_review')),
        business_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted')),
        phase TEXT NOT NULL,
        pi_session_id TEXT,
        context_refs_json TEXT NOT NULL,
        result_refs_json TEXT NOT NULL,
        progress_json TEXT NOT NULL DEFAULT '{}',
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        events_json TEXT NOT NULL DEFAULT '[]',
        control_action TEXT,
        heartbeat_at TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      INSERT INTO agent_tasks (
        id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
        error_code, error_message, created_at, updated_at, finished_at, heartbeat_at
      )
      SELECT id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
        error_code, error_message, created_at, updated_at, finished_at, updated_at
      FROM agent_tasks_v11;
      DROP TABLE agent_tasks_v11;
      CREATE INDEX agent_tasks_intent_date_status ON agent_tasks(intent, business_date, status);
    `
  },
  ...knowledgeMigrations,
  {
    version: 27,
    sql: `
      CREATE TABLE ranking_cache (id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL, fetched_at TEXT NOT NULL);
    `
  },
  {
    version: 28,
    sql: `
      CREATE TABLE x_list_bindings (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL,
        list_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        owner_handle TEXT NOT NULL,
        name TEXT NOT NULL,
        list_kind TEXT NOT NULL CHECK (list_kind IN ('owned', 'following', 'member')),
        source_feed_id TEXT NOT NULL REFERENCES source_feeds(id),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        last_observed_at TEXT,
        last_observation_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        UNIQUE (account_key, list_id)
      );
      CREATE INDEX x_list_bindings_account_updated ON x_list_bindings(account_key, updated_at DESC);
      CREATE TABLE x_list_operations (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        input_hash TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete', 'members_add', 'members_remove')),
        account_key TEXT NOT NULL,
        list_id TEXT,
        canonical_url TEXT,
        owner_handle TEXT,
        snapshot_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'awaiting_confirmation', 'running', 'succeeded', 'partial', 'needs_user', 'unknown', 'failed')),
        phase TEXT NOT NULL,
        stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
        confirmation_fingerprint TEXT,
        confirmed_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE INDEX x_list_operations_account_updated ON x_list_operations(account_key, updated_at DESC);
      CREATE TABLE x_list_operation_items (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES x_list_operations(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        handle TEXT NOT NULL,
        desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'already_present', 'already_absent', 'succeeded', 'needs_user', 'unknown', 'failed', 'skipped')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        UNIQUE (operation_id, sort_order),
        UNIQUE (operation_id, handle)
      );
      CREATE INDEX x_list_operation_items_operation ON x_list_operation_items(operation_id, sort_order);
    `
  },
  {
    version: 29,
    sql: `
      CREATE TABLE x_list_index_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `
  },
  {
    version: 30,
    sql: `
      CREATE TABLE x_list_timeline_cache (
        account_key TEXT NOT NULL,
        list_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        posts_count INTEGER NOT NULL,
        payload_bytes INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('live', 'collect')),
        schema_version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (account_key, list_id)
      );
      CREATE INDEX x_list_timeline_cache_accessed ON x_list_timeline_cache(last_accessed_at);
      CREATE INDEX x_list_timeline_cache_account_accessed ON x_list_timeline_cache(account_key, last_accessed_at);
    `
  },
  ...lateMigrations, ...topicMaintenanceMigrations, ...knowledgeFlywheelMigrations, ...sourceBodyRevisionMigrations, ...mediaBindingMigrations,
  ...wikiIndexMigrations,
  ...mediaArchiveMigrations,
  ...mediaGovernanceMigrations,
  ...mediaRecommendationMigrations,
  ...visualUnderstandingMigrations,
  {
    version: 70,
    sql: `
      -- ===== WMB-5249：知乎成为一等发布平台 =====
      -- 扩展全部平台 CHECK 约束：platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')。
      -- 与 v44/v47/v48/v50/v54 的"改名→建新→复制→删影子"不同：本次重建的是 FK 父表
      -- （platform_versions/platform_accounts/publications/publication_snapshots 被大量
      -- 未重建的子表引用）。SQLite 的 ALTER TABLE RENAME 会无条件改写其他表中指向被改名表的
      -- FK 子句（PRAGMA foreign_keys=OFF 也拦不住；legacy_alter_table 同样不保护 FK 子句）：
      -- 若先改名旧表、复制后再删影子表，未重建子表（platform_media_bindings、publication_attempts/
      -- confirmations/reconciliations/events/metric_snapshots/reviews、publication_browser_operations）
      -- 的 FK 会悬空指向已删除的 *_v69，导致插入报 "no such table: main.*_v69"。
      -- 因此这里改为：建新表(*_v69) → 原列复制 → 删旧表 → 改名回原名。引用方 FK 文本始终指向
      -- 原名，改名步骤只会改写指向 *_v69 的引用（新表无引用方），原名最终解析到重建后的表。
      -- 数据/列/约束原样保留，索引/触发器在改名后重建。

      -- platform_versions（v5 建表；无索引/触发器；被 publications/publication_snapshots/
      -- platform_media_bindings 引用）。
      CREATE TABLE platform_versions_v69 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id),
        content_version_id TEXT NOT NULL REFERENCES content_versions(id),
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')),
        format TEXT NOT NULL,
        title TEXT,
        body TEXT NOT NULL,
        asset_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      INSERT INTO platform_versions_v69 (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
        SELECT id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision
        FROM platform_versions;
      DROP TABLE platform_versions;
      ALTER TABLE platform_versions_v69 RENAME TO platform_versions;

      -- platform_accounts（v8 建表 + v39 浏览器绑定列）。
      CREATE TABLE platform_accounts_v69 (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')) UNIQUE,
        account_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        login_state TEXT NOT NULL CHECK (login_state IN ('authenticated', 'unauthenticated', 'challenge', 'unknown')),
        evidence_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        browser_profile_id TEXT,
        browser_binding_revision INTEGER,
        verified_at TEXT
      );
      INSERT INTO platform_accounts_v69 (id, platform, account_key, display_name, login_state, evidence_url,
        created_at, updated_at, revision, browser_profile_id, browser_binding_revision, verified_at)
        SELECT id, platform, account_key, display_name, login_state, evidence_url,
          created_at, updated_at, revision, browser_profile_id, browser_binding_revision, verified_at
        FROM platform_accounts;
      DROP TABLE platform_accounts;
      ALTER TABLE platform_accounts_v69 RENAME TO platform_accounts;

      -- publications（v9 建表；被 publication_attempts/confirmations/reconciliations/events/
      -- metric_snapshots/reviews/publication_snapshots 引用）。
      CREATE TABLE publications_v69 (
        id TEXT PRIMARY KEY,
        platform_version_id TEXT NOT NULL REFERENCES platform_versions(id),
        platform_version_revision INTEGER NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')),
        account_id TEXT NOT NULL REFERENCES platform_accounts(id),
        account_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'prepared', 'awaiting_confirmation', 'publishing', 'published', 'failed', 'needs_user', 'unknown')),
        prepared_title TEXT,
        prepared_body TEXT,
        prepared_assets_json TEXT NOT NULL,
        prepared_evidence_url TEXT,
        external_url TEXT,
        external_id TEXT,
        published_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      INSERT INTO publications_v69 (id, platform_version_id, platform_version_revision, platform, account_id, account_key,
        status, prepared_title, prepared_body, prepared_assets_json, prepared_evidence_url, external_url, external_id,
        published_at, last_error_code, last_error_message, created_at, updated_at, revision)
        SELECT id, platform_version_id, platform_version_revision, platform, account_id, account_key,
          status, prepared_title, prepared_body, prepared_assets_json, prepared_evidence_url, external_url, external_id,
          published_at, last_error_code, last_error_message, created_at, updated_at, revision
        FROM publications;
      DROP TABLE publications;
      ALTER TABLE publications_v69 RENAME TO publications;

      -- publication_snapshots（v43 建表；不可变触发器 + 3 索引原样重建）。
      CREATE TABLE publication_snapshots_v69 (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL UNIQUE REFERENCES publications(id),
        workspace_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        platform_version_id TEXT NOT NULL REFERENCES platform_versions(id),
        platform_version_revision INTEGER NOT NULL CHECK (platform_version_revision >= 1),
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')),
        account_id TEXT NOT NULL REFERENCES platform_accounts(id),
        account_key TEXT NOT NULL,
        account_revision INTEGER NOT NULL CHECK (account_revision >= 1),
        browser_binding_id TEXT NOT NULL CHECK (browser_binding_id = 'effective') REFERENCES workspace_browser_bindings(id),
        browser_profile_id TEXT NOT NULL,
        browser_binding_revision INTEGER NOT NULL CHECK (browser_binding_revision >= 1),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        assets_json TEXT NOT NULL,
        assets_hash TEXT NOT NULL CHECK (length(assets_hash) = 64),
        input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
        causation_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO publication_snapshots_v69 (id, publication_id, workspace_id, runtime_epoch, platform_version_id,
        platform_version_revision, platform, account_id, account_key, account_revision, browser_binding_id,
        browser_profile_id, browser_binding_revision, payload_json, payload_hash, assets_json, assets_hash,
        input_hash, causation_json, created_at)
        SELECT id, publication_id, workspace_id, runtime_epoch, platform_version_id,
          platform_version_revision, platform, account_id, account_key, account_revision, browser_binding_id,
          browser_profile_id, browser_binding_revision, payload_json, payload_hash, assets_json, assets_hash,
          input_hash, causation_json, created_at
        FROM publication_snapshots;
      DROP TABLE publication_snapshots;
      ALTER TABLE publication_snapshots_v69 RENAME TO publication_snapshots;
      CREATE INDEX publication_snapshots_input_hash ON publication_snapshots(input_hash);
      CREATE INDEX publication_snapshots_workspace_created ON publication_snapshots(workspace_id, created_at DESC);
      CREATE INDEX publication_snapshots_frozen_identity ON publication_snapshots(platform_version_id, account_id, browser_profile_id, browser_binding_revision);
      CREATE TRIGGER publication_snapshots_immutable_update
        BEFORE UPDATE ON publication_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'PUBLICATION_SNAPSHOT_IMMUTABLE');
        END;
      CREATE TRIGGER publication_snapshots_immutable_delete
        BEFORE DELETE ON publication_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'PUBLICATION_SNAPSHOT_IMMUTABLE');
        END;

      -- studio_annotations（v55 建表；作用域 CHECK + 索引原样重建）。
      CREATE TABLE studio_annotations_v69 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        document_kind TEXT NOT NULL CHECK (document_kind IN ('core', 'platform')),
        document_id TEXT,
        platform TEXT CHECK (platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')),
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset >= 0),
        quoted_text TEXT NOT NULL,
        prefix_context TEXT NOT NULL DEFAULT '',
        suffix_context TEXT NOT NULL DEFAULT '',
        body_fingerprint TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        resolved_reason TEXT CHECK (resolved_reason IN ('edited', 'deleted', 'ambiguous', 'user_removed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        CHECK (start_offset < end_offset),
        CHECK (
          (document_kind = 'core' AND platform IS NULL)
          OR (document_kind = 'platform' AND platform IS NOT NULL AND document_id IS NOT NULL)
        )
      );
      INSERT INTO studio_annotations_v69 (id, project_id, document_kind, document_id, platform, start_offset, end_offset,
        quoted_text, prefix_context, suffix_context, body_fingerprint, note, status, resolved_reason,
        created_at, updated_at, resolved_at, revision)
        SELECT id, project_id, document_kind, document_id, platform, start_offset, end_offset,
          quoted_text, prefix_context, suffix_context, body_fingerprint, note, status, resolved_reason,
          created_at, updated_at, resolved_at, revision
        FROM studio_annotations;
      DROP TABLE studio_annotations;
      ALTER TABLE studio_annotations_v69 RENAME TO studio_annotations;
      CREATE INDEX studio_annotations_scope ON studio_annotations(project_id, document_kind, document_id, status);
    `
  },
  ...sourceBodyArchiveMigrations, ...piImageBatchMigrations, ...illustrationMigrations, ...zhihuHotContentLoopMigrations, ...planningStageMigrations,
  ...workspaceOrchestratorMigrations
] as const;

export function migrateDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
    const allMigrations = migrations as readonly { version: number; sql: string; run?: (database: DatabaseSync) => void }[];
    for (const migration of allMigrations) {
      if (applied.has(migration.version)) continue;
      // SQLite forbids changing foreign_keys inside a transaction; table rebuilds that touch FK parents need FK off.
      database.exec('PRAGMA foreign_keys = OFF');
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(migration.sql);
        migration.run?.(database);
        database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        database.exec('PRAGMA foreign_keys = ON');
        throw error;
      }
      database.exec('PRAGMA foreign_keys = ON');
    }
    database.exec('PRAGMA foreign_keys = ON');
    // WMB-5237：source_body_revisions 删除闸门 UDF 每次连接注册（schema_migrations 跳过已应用迁移时
    // 不会再走 migration 61 的 run hook，但 DELETE 触发器 WHEN 仍引用该函数）。
    registerSourceBodyRevisionPurgeGate(database);
    return database;
  } catch (error) {
    // 迁移失败必须释放连接：否则数据库文件句柄残留（Windows 上 unlink 得 EBUSY），
    // 并掩盖真正的迁移错误。成功路径由调用方负责 close()。
    database.close();
    throw error;
  }
}
