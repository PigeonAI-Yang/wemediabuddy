import { DatabaseSync } from 'node:sqlite';
import { lateMigrations } from './late-migrations.ts';
import { knowledgeMigrations } from './knowledge-migrations.ts';

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
      CREATE TABLE platform_versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES content_projects(id), content_version_id TEXT NOT NULL REFERENCES content_versions(id), platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')), format TEXT NOT NULL, title TEXT, body TEXT NOT NULL, asset_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL);
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
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')) UNIQUE,
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
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')),
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
  ...lateMigrations
] as const;

export function migrateDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    // SQLite forbids changing foreign_keys inside a transaction; table rebuilds that touch FK parents need FK off.
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
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
  return database;
}
