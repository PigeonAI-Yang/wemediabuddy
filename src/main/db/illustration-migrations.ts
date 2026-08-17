export const illustrationMigrations = [
  {
    version: 74,
    sql: `
      CREATE TABLE illustration_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        source_version_id TEXT NOT NULL REFERENCES content_versions(id),
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        source_body_hash TEXT NOT NULL CHECK (length(source_body_hash) = 64),
        source_body TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        source_revision_keys_json TEXT NOT NULL,
        image_profile_id TEXT,
        image_model TEXT,
        default_ratio TEXT NOT NULL DEFAULT '16:9' CHECK (default_ratio IN ('1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21')),
        max_generated INTEGER NOT NULL DEFAULT 6 CHECK (max_generated >= 0 AND max_generated <= 6),
        plan_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'planning', 'running', 'partial', 'completed', 'failed', 'conflicted')),
        target_version_id TEXT REFERENCES content_versions(id),
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX illustration_runs_project_request ON illustration_runs(project_id, request_id);
      CREATE INDEX illustration_runs_project_updated ON illustration_runs(project_id, updated_at DESC);

      CREATE TABLE illustration_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES illustration_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        item_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('source', 'generated')),
        claim_key TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('direct_evidence', 'demonstration', 'comparison', 'background', 'cover', 'decoration')),
        ratio TEXT NOT NULL CHECK (ratio IN ('1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21')),
        request_text TEXT NOT NULL DEFAULT '',
        context_json TEXT NOT NULL DEFAULT '{}',
        source_revision_key TEXT,
        source_binding_id TEXT,
        source_asset_id TEXT,
        asset_id TEXT,
        previous_asset_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'generating', 'completed', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        error_code TEXT,
        error_message TEXT,
        content_version_id TEXT REFERENCES content_versions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(run_id, item_key),
        UNIQUE(run_id, ordinal)
      );
      CREATE INDEX illustration_items_run_state ON illustration_items(run_id, state, ordinal);
      CREATE INDEX illustration_items_asset ON illustration_items(asset_id);
    `
  }
] as const;
