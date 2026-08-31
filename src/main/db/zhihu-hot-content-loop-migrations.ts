export const zhihuHotContentLoopMigrations = [
  {
    version: 75,
    sql: `
      -- SQLite sole truth; active-root dispatcher serializes writes.
      -- No publish changes, no second workbench/service/database/identity.

      CREATE TABLE zhihu_hot_observations (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        business_date TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK (rank >= 1 AND rank <= 100),
        heat_text TEXT,
        question_title_snapshot TEXT NOT NULL,
        question_url_snapshot TEXT NOT NULL,
        excerpt_snapshot TEXT,
        evidence_url TEXT,
        collected_at TEXT NOT NULL,
        scan_task_id TEXT,
        input_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source_item_id, business_date, input_fingerprint)
      );
      CREATE INDEX zhihu_hot_observations_business_date ON zhihu_hot_observations(business_date, rank);
      CREATE INDEX zhihu_hot_observations_source_date ON zhihu_hot_observations(source_item_id, business_date);

      CREATE TABLE daily_content_cycles (
        id TEXT PRIMARY KEY,
        business_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        target_count INTEGER NOT NULL DEFAULT 2 CHECK (target_count >= 1 AND target_count <= 5),
        status TEXT NOT NULL CHECK (status IN ('pending','running','needs_user','completed','partial','paused','failed')),
        plan_id TEXT REFERENCES plans(id),
        started_at TEXT,
        completed_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE (business_date)
      );
      CREATE INDEX daily_content_cycles_status_date ON daily_content_cycles(status, business_date);

      CREATE TABLE daily_content_targets (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES daily_content_cycles(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('new_content','draft_revision','published_revision')),
        counts_toward_goal INTEGER NOT NULL CHECK (counts_toward_goal IN (0,1)),
        source_item_id TEXT REFERENCES source_items(id) ON DELETE SET NULL,
        plan_item_id TEXT REFERENCES plan_items(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES content_projects(id) ON DELETE SET NULL,
        predecessor_content_version_id TEXT REFERENCES content_versions(id) ON DELETE SET NULL,
        predecessor_publication_id TEXT REFERENCES publications(id) ON DELETE SET NULL,
        predecessor_target_id TEXT REFERENCES daily_content_targets(id) ON DELETE SET NULL,
        carry_depth INTEGER NOT NULL DEFAULT 0 CHECK (carry_depth IN (0,1)),
        selection_mode TEXT NOT NULL CHECK (selection_mode IN ('automatic','owner_approved','carried')),
        score_snapshot_json TEXT NOT NULL DEFAULT '{}',
        format_decision_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('proposed','selected','researching','drafting','article_ready','scripting','completed','blocked','skipped','carried')),
        blocked_reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (
          (target_kind = 'new_content' AND counts_toward_goal = 1 AND predecessor_content_version_id IS NULL AND predecessor_publication_id IS NULL)
          OR (target_kind != 'new_content' AND counts_toward_goal = 0)
        ),
        CHECK (
          (predecessor_target_id IS NULL AND carry_depth = 0 AND selection_mode != 'carried')
          OR (predecessor_target_id IS NOT NULL AND carry_depth = 1 AND selection_mode = 'carried')
        )
      );
      CREATE INDEX daily_content_targets_cycle_kind ON daily_content_targets(cycle_id, target_kind);
      CREATE INDEX daily_content_targets_cycle_status ON daily_content_targets(cycle_id, status);
      CREATE INDEX daily_content_targets_project ON daily_content_targets(project_id);
      CREATE UNIQUE INDEX daily_content_targets_cycle_source_unique ON daily_content_targets(cycle_id, source_item_id) WHERE target_kind = 'new_content' AND source_item_id IS NOT NULL;
      CREATE UNIQUE INDEX daily_content_targets_cycle_predecessor_version_unique ON daily_content_targets(cycle_id, predecessor_content_version_id) WHERE predecessor_content_version_id IS NOT NULL;
      CREATE UNIQUE INDEX daily_content_targets_cycle_predecessor_publication_unique ON daily_content_targets(cycle_id, predecessor_publication_id) WHERE predecessor_publication_id IS NOT NULL;

      CREATE TABLE content_derivatives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('video_script')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE (project_id, kind)
      );
      CREATE INDEX content_derivatives_project ON content_derivatives(project_id);

      CREATE TABLE content_derivative_versions (
        id TEXT PRIMARY KEY,
        derivative_id TEXT NOT NULL REFERENCES content_derivatives(id) ON DELETE CASCADE,
        source_content_version_id TEXT NOT NULL REFERENCES content_versions(id),
        version_number INTEGER NOT NULL CHECK (version_number >= 1),
        format_decision_json TEXT NOT NULL DEFAULT '{}',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','ready')),
        author TEXT NOT NULL CHECK (author IN ('ai','user')),
        created_at TEXT NOT NULL,
        UNIQUE (derivative_id, version_number)
      );
      CREATE INDEX content_derivative_versions_derivative ON content_derivative_versions(derivative_id, version_number DESC);
      CREATE INDEX content_derivative_versions_source ON content_derivative_versions(source_content_version_id);
      CREATE TRIGGER content_derivative_versions_immutable_update
        BEFORE UPDATE ON content_derivative_versions
        BEGIN SELECT RAISE(ABORT, 'CONTENT_DERIVATIVE_VERSION_IMMUTABLE'); END;
      CREATE TRIGGER content_derivative_versions_immutable_delete
        BEFORE DELETE ON content_derivative_versions
        BEGIN SELECT RAISE(ABORT, 'CONTENT_DERIVATIVE_VERSION_IMMUTABLE'); END;
    `
  },
  {
    version: 76,
    sql: `
      -- WMB-5331: extend source_scan_receipts.module CHECK to include zhihu_hot (blocking defect for new channel)
      CREATE TABLE source_scan_receipts_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        module TEXT NOT NULL CHECK (module IN ('official_web', 'x_lists', 'zhihu_hot')),
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
      INSERT INTO source_scan_receipts_new SELECT * FROM source_scan_receipts;
      DROP TABLE source_scan_receipts;
      ALTER TABLE source_scan_receipts_new RENAME TO source_scan_receipts;
      CREATE INDEX source_scan_receipts_task ON source_scan_receipts(task_id, checked_at DESC);
      CREATE INDEX source_scan_receipts_workspace ON source_scan_receipts(workspace_id, checked_at DESC);
    `
  }
] as const;
