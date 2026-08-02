export const lateMigrations = [
  {
    version: 31,
    sql: `
      CREATE TABLE source_body_cache (
        source_id TEXT PRIMARY KEY REFERENCES source_items(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'failed', 'empty')),
        content_type TEXT,
        extracted_text TEXT NOT NULL DEFAULT '',
        extracted_chars INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        fetched_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX source_body_cache_fetched ON source_body_cache(fetched_at DESC);
    `
  },
  {
    version: 32,
    sql: `
      CREATE TABLE work_carry_items (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL CHECK (object_type IN ('plan_item', 'source', 'topic')),
        object_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'watching', 'done', 'dismissed', 'expired')),
        priority INTEGER,
        topic_id TEXT REFERENCES topics(id),
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        origin_plan_date TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decay_score REAL NOT NULL DEFAULT 1,
        reason TEXT,
        aftershock_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        UNIQUE (object_type, fingerprint)
      );
      CREATE INDEX work_carry_items_state_expires ON work_carry_items(state, expires_at);
      CREATE INDEX work_carry_items_topic ON work_carry_items(topic_id, state);
      CREATE INDEX work_carry_items_last_seen ON work_carry_items(last_seen_at DESC);
    `
  },
  {
    version: 33,
    sql: `
      CREATE TABLE content_project_assets (
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, asset_id)
      );
      CREATE INDEX content_project_assets_asset ON content_project_assets(asset_id);
    `
  },
  {
    version: 34,
    sql: `
      ALTER TABLE source_feeds ADD COLUMN registry_id TEXT;
      CREATE UNIQUE INDEX source_feeds_registry_id
        ON source_feeds(registry_id)
        WHERE registry_id IS NOT NULL;
    `
  },
  {
    version: 35,
    sql: `
      CREATE TABLE workspace_profiles (
        id TEXT PRIMARY KEY CHECK (id = 'effective'),
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        official_template_id TEXT,
        official_template_version INTEGER,
        display_name TEXT NOT NULL,
        audience TEXT NOT NULL,
        content_goal TEXT NOT NULL,
        editorial_brief TEXT NOT NULL,
        intelligence_pack_id TEXT NOT NULL,
        intelligence_pack_version INTEGER NOT NULL,
        creation_pack_id TEXT NOT NULL,
        creation_pack_version INTEGER NOT NULL,
        platforms_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 36,
    sql: `
      ALTER TABLE agent_tasks RENAME TO agent_tasks_v35;
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL CHECK (intent IN ('daily_intelligence', 'studio_draft', 'results_review')),
        business_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted', 'needs_user')),
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
      INSERT INTO agent_tasks SELECT * FROM agent_tasks_v35;
      DROP TABLE agent_tasks_v35;
      CREATE INDEX agent_tasks_intent_date_status ON agent_tasks(intent, business_date, status);
    `
  }
] as const;
