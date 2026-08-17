export const piImageBatchMigrations = [
  {
    version: 73,
    sql: `
      -- ===== WMB-5307：Pi 批量图片提交、持久导入与自动排图批次 =====
      CREATE TABLE pi_image_batches (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        baseline_version_id TEXT REFERENCES content_versions(id),
        expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
        input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
        user_message TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'importing', 'analyzing', 'saving', 'completed', 'failed_import', 'failed_analysis', 'conflicted', 'failed_save', 'canceled')),
        failure_stage TEXT CHECK (failure_stage IN ('validation', 'import', 'analysis', 'save', 'readback', 'conflict')),
        failure_code TEXT,
        failure_message TEXT,
        target_version_id TEXT REFERENCES content_versions(id),
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        unused_count INTEGER NOT NULL DEFAULT 0 CHECK (unused_count >= 0),
        placement_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX pi_image_batches_project_request ON pi_image_batches(project_id, request_id);
      CREATE INDEX pi_image_batches_project_updated ON pi_image_batches(project_id, updated_at DESC);

      CREATE TABLE pi_image_batch_attachments (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES pi_image_batches(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 10),
        source_file_name TEXT NOT NULL,
        source_mime_type TEXT NOT NULL CHECK (source_mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
        byte_count INTEGER NOT NULL CHECK (byte_count > 0),
        width INTEGER,
        height INTEGER,
        source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
        asset_id TEXT REFERENCES assets(id),
        state TEXT NOT NULL CHECK (state IN ('pending', 'importing', 'imported', 'used', 'unused', 'failed')),
        decision_reason TEXT,
        alt TEXT,
        caption TEXT,
        width_preset TEXT CHECK (width_preset IN ('small', 'medium', 'large', 'full')),
        align TEXT CHECK (align IN ('left', 'center', 'right')),
        core_version_id TEXT REFERENCES content_versions(id),
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(batch_id, ordinal),
        UNIQUE(batch_id, source_sha256)
      );
      CREATE INDEX pi_image_batch_attachments_batch_state ON pi_image_batch_attachments(batch_id, state, ordinal);
      CREATE INDEX pi_image_batch_attachments_asset ON pi_image_batch_attachments(asset_id);
    `
  }
] as const;
