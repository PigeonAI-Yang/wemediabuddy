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
  },
  {
    version: 37,
    sql: `
      CREATE TABLE website_sources (
        id TEXT PRIMARY KEY,
        source_feed_id TEXT NOT NULL REFERENCES source_feeds(id),
        input_text TEXT NOT NULL,
        canonical_url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        resolution_status TEXT NOT NULL CHECK (resolution_status IN ('ready', 'unresolved', 'unreadable', 'needs_user', 'failed')),
        resolution_json TEXT NOT NULL DEFAULT '{}',
        last_error_code TEXT,
        last_error_message TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE INDEX website_sources_enabled_status ON website_sources(enabled, resolution_status, updated_at DESC);
      CREATE TABLE source_scan_receipts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        module TEXT NOT NULL CHECK (module IN ('official_web', 'x_lists')),
        source_id TEXT NOT NULL,
        source_feed_id TEXT NOT NULL REFERENCES source_feeds(id),
        checked_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'needs_user')),
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
        saved_count INTEGER NOT NULL DEFAULT 0 CHECK (saved_count >= 0),
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        UNIQUE (task_id, module, source_id)
      );
      CREATE INDEX source_scan_receipts_task ON source_scan_receipts(task_id, checked_at DESC);
      CREATE INDEX source_scan_receipts_workspace ON source_scan_receipts(workspace_id, checked_at DESC);
    `
  },
  {
    version: 38,
    sql: `
      CREATE TABLE x_post_metric_snapshots (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        account_key TEXT NOT NULL,
        list_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL,
        observation_key TEXT NOT NULL,
        scheduled_for TEXT,
        captured_at TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (observation_key, source_item_id)
      );
      CREATE INDEX x_post_metric_snapshots_source_captured ON x_post_metric_snapshots(source_item_id, captured_at);
      CREATE INDEX x_post_metric_snapshots_binding_captured ON x_post_metric_snapshots(binding_id, captured_at);
    `
  },
  {
    version: 39,
    sql: `
      CREATE TABLE workspace_browser_bindings (
        id TEXT PRIMARY KEY CHECK (id = 'effective'),
        profile_id TEXT,
        binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
        state TEXT NOT NULL CHECK (state IN ('unverified', 'verified', 'needs_user')),
        expected_account_snapshot_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE platform_accounts ADD COLUMN browser_profile_id TEXT;
      ALTER TABLE platform_accounts ADD COLUMN browser_binding_revision INTEGER;
      ALTER TABLE platform_accounts ADD COLUMN verified_at TEXT;
    `
  },
  {
    version: 40,
    sql: `
      CREATE TABLE command_receipts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        request_id TEXT NOT NULL,
        command TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('owner_ui', 'pi', 'external_agent', 'scheduler', 'browser_adapter')),
        actor_id TEXT NOT NULL,
        task_id TEXT,
        worker_lease_id TEXT,
        grant_id TEXT,
        envelope_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
        result_json TEXT,
        error_json TEXT,
        readback_json TEXT,
        before_revision INTEGER,
        after_revision INTEGER,
        side_effect_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, request_id)
      );
      CREATE INDEX command_receipts_command_created ON command_receipts(command, created_at DESC);
      CREATE INDEX command_receipts_task_created ON command_receipts(task_id, created_at DESC);
    `
  },
  {
    version: 41,
    sql: `
      CREATE TABLE task_grants (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id),
        owner_goal TEXT NOT NULL,
        allowed_commands_json TEXT NOT NULL,
        workers_json TEXT NOT NULL,
        relevant_context_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revision INTEGER NOT NULL,
        UNIQUE (workspace_id, id)
      );
      CREATE INDEX task_grants_task_status ON task_grants(task_id, status, expires_at);
      CREATE INDEX task_grants_runtime_status ON task_grants(runtime_epoch, status, expires_at);
    `
  },
  {
    version: 42,
    sql: `
      CREATE TABLE execution_grants (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        task_id TEXT REFERENCES agent_tasks(id),
        task_grant_id TEXT REFERENCES task_grants(id),
        command TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        bound_identity_json TEXT NOT NULL,
        target_actor_type TEXT NOT NULL CHECK (target_actor_type IN ('owner_ui', 'pi', 'external_agent', 'scheduler', 'browser_adapter')),
        target_actor_id TEXT NOT NULL,
        browser_profile_id TEXT,
        binding_revision INTEGER,
        expected_account TEXT,
        allowed_transition TEXT NOT NULL,
        required_readback_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'revoked')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        revision INTEGER NOT NULL,
        CHECK ((task_id IS NULL) = (task_grant_id IS NULL)),
        UNIQUE (workspace_id, id)
      );
      CREATE INDEX execution_grants_task_status ON execution_grants(task_id, status, expires_at);
      CREATE INDEX execution_grants_runtime_status ON execution_grants(runtime_epoch, status, expires_at);
      ALTER TABLE command_receipts ADD COLUMN execution_grant_id TEXT;
      ALTER TABLE x_list_operations ADD COLUMN task_id TEXT;
      ALTER TABLE x_list_operations ADD COLUMN task_grant_id TEXT;
      ALTER TABLE x_list_operations ADD COLUMN prepared_actor_type TEXT;
      ALTER TABLE x_list_operations ADD COLUMN prepared_actor_id TEXT;
    `
  },
  {
    version: 43,
    sql: `
      CREATE TABLE publication_snapshots (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL UNIQUE REFERENCES publications(id),
        workspace_id TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        platform_version_id TEXT NOT NULL REFERENCES platform_versions(id),
        platform_version_revision INTEGER NOT NULL CHECK (platform_version_revision >= 1),
        platform TEXT NOT NULL CHECK (platform IN ('x', 'xiaohongshu', 'wechat')),
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

      CREATE TABLE publication_browser_operations (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL UNIQUE REFERENCES publications(id),
        snapshot_id TEXT NOT NULL UNIQUE REFERENCES publication_snapshots(id),
        state TEXT NOT NULL CHECK (state IN ('prepared', 'execution_granted', 'browser_leased', 'executing', 'readback_pending', 'succeeded', 'needs_user', 'unknown', 'failed')),
        phase TEXT NOT NULL,
        execution_grant_id TEXT REFERENCES execution_grants(id),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        readback_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (state IN ('prepared', 'needs_user', 'failed') OR execution_grant_id IS NOT NULL)
      );
      CREATE INDEX publication_browser_operations_state_updated ON publication_browser_operations(state, updated_at, id);
      CREATE INDEX publication_browser_operations_grant ON publication_browser_operations(execution_grant_id);
    `
  },
  {
    version: 44,
    sql: `
      ALTER TABLE x_list_operation_items RENAME TO x_list_operation_items_v43;
      ALTER TABLE x_list_operations RENAME TO x_list_operations_v43;

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
        state TEXT NOT NULL CHECK (state IN ('prepared', 'awaiting_confirmation', 'execution_granted', 'browser_leased', 'running', 'succeeded', 'partial', 'needs_user', 'unknown', 'failed')),
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
        revision INTEGER NOT NULL,
        task_id TEXT,
        task_grant_id TEXT,
        prepared_actor_type TEXT,
        prepared_actor_id TEXT,
        execution_grant_id TEXT REFERENCES execution_grants(id)
      );
      INSERT INTO x_list_operations (
        id, request_id, input_hash, kind, account_key, list_id, canonical_url, owner_handle, snapshot_json, payload_json,
        state, phase, stop_requested, confirmation_fingerprint, confirmed_at, started_at, finished_at, evidence_json,
        error_code, error_message, created_at, updated_at, revision, task_id, task_grant_id, prepared_actor_type, prepared_actor_id,
        execution_grant_id
      )
      SELECT
        id, request_id, input_hash, kind, account_key, list_id, canonical_url, owner_handle, snapshot_json, payload_json,
        state, phase, stop_requested, confirmation_fingerprint, confirmed_at, started_at, finished_at, evidence_json,
        error_code, error_message, created_at, updated_at, revision, task_id, task_grant_id, prepared_actor_type, prepared_actor_id,
        NULL
      FROM x_list_operations_v43;

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
      INSERT INTO x_list_operation_items
        (id, operation_id, sort_order, handle, desired_state, state, evidence_json, updated_at)
      SELECT id, operation_id, sort_order, handle, desired_state, state, evidence_json, updated_at
      FROM x_list_operation_items_v43;

      DROP TABLE x_list_operation_items_v43;
      DROP TABLE x_list_operations_v43;
      CREATE INDEX x_list_operations_account_updated ON x_list_operations(account_key, updated_at DESC);
      CREATE INDEX x_list_operation_items_operation ON x_list_operation_items(operation_id, sort_order);
    `
  },
  {
    version: 45,
    sql: `
      -- WMB-4931 完整版：故事身份列（story_key）+ 派生阶段列（stage）。
      -- 不加 UNIQUE 索引：dismissed 泊车/合并历史行与活跃行同属一个 story 是常态（合并语义），
      -- 唯一约束会违反「否决/合并行保留可查证历史」的既有语义；身份收敛由 mergeSimilarCarryItems 负责。
      ALTER TABLE work_carry_items ADD COLUMN story_key TEXT;
      ALTER TABLE work_carry_items ADD COLUMN stage TEXT;
      CREATE INDEX work_carry_items_story_key ON work_carry_items(story_key) WHERE story_key IS NOT NULL;
      CREATE INDEX work_carry_items_stage ON work_carry_items(stage);
    `
  },
  {
    version: 46,
    sql: `
      CREATE TABLE source_lane_judgments (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        workspace_lane TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('relevant', 'irrelevant')),
        reason_code TEXT NOT NULL,
        reason TEXT,
        judged_by TEXT NOT NULL CHECK (judged_by IN ('system', 'agent', 'editor')),
        confidence REAL,
        source_revision INTEGER NOT NULL,
        judged_at TEXT NOT NULL
      );
      CREATE INDEX source_lane_judgments_source_judged ON source_lane_judgments(source_id, judged_at DESC);
      CREATE INDEX source_lane_judgments_lane_judged ON source_lane_judgments(workspace_lane, judged_at DESC);
    `
  },
  {
    version: 47,
    sql: `
      -- M-4980: expand agent_tasks.intent CHECK for page_* dock copilot intents.
      -- Recreate via _new table (FK off in migrateDatabase) so task_grants/execution_grants keep valid REFERENCES agent_tasks.
      CREATE TABLE agent_tasks_new (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL CHECK (intent IN (
          'daily_intelligence', 'studio_draft', 'results_review',
          'page_today', 'page_discover', 'page_proposals', 'page_topic',
          'page_library', 'page_canvas', 'page_studio', 'page_publish', 'page_results'
        )),
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
      INSERT INTO agent_tasks_new SELECT * FROM agent_tasks;
      DROP TABLE agent_tasks;
      ALTER TABLE agent_tasks_new RENAME TO agent_tasks;
      CREATE INDEX agent_tasks_intent_date_status ON agent_tasks(intent, business_date, status);
    `
  },
  {
    version: 48,
    sql: `
      -- M-5100: daily_scan / daily_judge intents (scan=reporter, judge=planner).
      CREATE TABLE agent_tasks_new (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL CHECK (intent IN (
          'daily_intelligence', 'daily_scan', 'daily_judge', 'studio_draft', 'results_review',
          'page_today', 'page_discover', 'page_proposals', 'page_topic',
          'page_library', 'page_canvas', 'page_studio', 'page_publish', 'page_results'
        )),
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
      INSERT INTO agent_tasks_new SELECT * FROM agent_tasks;
      DROP TABLE agent_tasks;
      ALTER TABLE agent_tasks_new RENAME TO agent_tasks;
      CREATE INDEX agent_tasks_intent_date_status ON agent_tasks(intent, business_date, status);
    `
  },
  {
    version: 49,
    sql: `
      CREATE TABLE IF NOT EXISTS capability_overlays (
        workspace_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, role_id, capability_id)
      );
    `
  },
  {
    version: 50,
    sql: `
      -- M-5120: page_agents dock intent (agents roster limited write scope).
      CREATE TABLE agent_tasks_new (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL CHECK (intent IN (
          'daily_intelligence', 'daily_scan', 'daily_judge', 'studio_draft', 'results_review',
          'page_today', 'page_agents', 'page_discover', 'page_proposals', 'page_topic',
          'page_library', 'page_canvas', 'page_studio', 'page_publish', 'page_results'
        )),
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
      INSERT INTO agent_tasks_new SELECT * FROM agent_tasks;
      DROP TABLE agent_tasks;
      ALTER TABLE agent_tasks_new RENAME TO agent_tasks;
      CREATE INDEX agent_tasks_intent_date_status ON agent_tasks(intent, business_date, status);
    `
  },
  {
    version: 51,
    sql: `
      CREATE TABLE topic_maintenance_proposals (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES agent_tasks(id),
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        expected_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','stale')),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX topic_maintenance_proposals_status ON topic_maintenance_proposals(status,created_at DESC,id DESC);
    `
  },
  {
    version: 54,
    sql: `
      -- WMB-5171 / CAP-028: research intent (reporter evidence-supplement jobs).
      -- Recreate via _new table (FK off in migrateDatabase) so task_grants/execution_grants keep valid REFERENCES agent_tasks.
      CREATE TABLE agent_tasks_new (
        id TEXT PRIMARY KEY,
        intent TEXT NOT NULL CHECK (intent IN (
          'daily_intelligence', 'daily_scan', 'daily_judge', 'studio_draft', 'results_review', 'research',
          'page_today', 'page_agents', 'page_discover', 'page_proposals', 'page_topic',
          'page_library', 'page_canvas', 'page_studio', 'page_publish', 'page_results'
        )),
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
      INSERT INTO agent_tasks_new SELECT * FROM agent_tasks;
      DROP TABLE agent_tasks;
      ALTER TABLE agent_tasks_new RENAME TO agent_tasks;
      CREATE INDEX agent_tasks_intent_date_status ON agent_tasks(intent, business_date, status);
      CREATE TABLE research_claims (
        id                        TEXT PRIMARY KEY,
        task_id                   TEXT NOT NULL,          -- agent_tasks.id (research task)
        claim_key                 TEXT NOT NULL,
        claim_text                TEXT NOT NULL,          -- frozen claim text, copied at spawn
        claim_type                TEXT NOT NULL CHECK (claim_type IN ('fact','price','policy')),
        status                    TEXT NOT NULL CHECK (status IN ('pending','supported','contradicted','unresolved','source_unavailable')),
        verdict_reason            TEXT,
        evidence_source_ids_json  TEXT NOT NULL DEFAULT '[]',
        needs_time_excerpt        INTEGER NOT NULL DEFAULT 0,   -- price/policy ⇒ 1
        verified_at               TEXT,
        created_at                TEXT NOT NULL,
        updated_at                TEXT NOT NULL,
        UNIQUE (task_id, claim_key)
      );
      CREATE INDEX research_claims_task_status ON research_claims(task_id, status);
    `
  },
  {
    version: 55,
    sql: `
      -- WMB-5207: Studio 正文批注独立层（不进入正文/平台正文/发布载荷）。
      -- scope 隔离：core 批注 platform 必须为 NULL；platform 批注必须有平台与平台版本 ID。
      -- 重叠约束（开放批注区间不重叠）由应用层在事务内校验，SQL 仅保证区间基本合法。
      CREATE TABLE studio_annotations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        document_kind TEXT NOT NULL CHECK (document_kind IN ('core', 'platform')),
        document_id TEXT,
        platform TEXT CHECK (platform IN ('x', 'xiaohongshu', 'wechat')),
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
      CREATE INDEX studio_annotations_scope ON studio_annotations(project_id, document_kind, document_id, status);
    `
  }
] as const;
