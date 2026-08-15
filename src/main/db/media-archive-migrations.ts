// WMB-5244：情报媒体资产化持久层（设计 §6 持久对象与身份、§12.3 绑定兼容、§10.3 视频运行）。
// 版本 64-66 全部新表/重建；历史迁移（1-63）不做任何修改。
// 本文件是渠道媒体冻结的单一权威迁移（MediaSchema 独占 >=64；ArchiveWorker/MediaDerivations
// 的下载/派生逻辑一律经 src/main/db/media-archive-store.ts / video-understanding-store.ts 读写，
// 不再各自建迁移）。
//
// - 64：source_media_candidates（七态生命周期 + alternate_urls_json 下载回退链）+ 
//   media_archive_attempts（复合主键，设计 §6.2 字段集无 id）+ source_media_bindings。
//   preserved 的定义是：同事务中已存在对应 source_media_bindings 行；失败 Candidate 不创建 Binding。
// - 65：asset_provenance kind 扩展（derived_annotation/keyframe/clip/transcode）+ 核心/平台绑定
//   视频列（media_kind/poster_asset_id/clip_range_json/duration_ms，存量默认 image 语义不变）。
//   jobs 表 kind 无 CHECK 约束，media_archive/media_discover 天然兼容，无需重建。
// - 66：video_understanding_runs（身份 + attempt 唯一；completed 行由 DB 触发器禁止更新）。
//
// 确定性 ID 契约（store 同源实现，幂等基础）：
//   candidate `smc:<sourceRevisionKey>:<ordinal>:<kind>`；attempt 无独立 id（复合主键）；
//   binding `sbm:<candidateId>`；provenance `smp:<candidateId>`；
//   video run `vur:<sourceRevisionKey>:<assetId>:<schemaVersion>:<attempt>`。
// 候选幂等锚 = UNIQUE(source_revision_key, ordinal, kind)：同 revision 重放复用既有行；
// 同 URL 出现在不同 ordinal（主帖图 + 引用帖图）保留为独立候选，字节级去重由 Asset sha256 承担。

export const mediaArchiveMigrations = [
  {
    version: 64,
    sql: `
      -- ===== WMB-5244：渠道媒体候选 / 归档尝试 / 已保存绑定（设计 §6.1-§6.3）=====
      CREATE TABLE source_media_candidates (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        source_revision_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'video_poster')),
        original_url TEXT NOT NULL,
        stable_remote_identity TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('x_lists', 'official_web', 'research')),
        post_kind TEXT CHECK (post_kind IN ('tweet', 'repost', 'quote', 'web') OR post_kind IS NULL),
        parent_candidate_id TEXT REFERENCES source_media_candidates(id),
        post_ordinal INTEGER,
        ordinal_in_post INTEGER,
        ordinal INTEGER NOT NULL,
        caption_hint TEXT,
        surrounding_text TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'downloading', 'preserved', 'failed', 'unsupported', 'needs_user', 'skipped_limit')),
        error_code TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
        retry_after TEXT,
        request_id TEXT,
        discovered_at TEXT NOT NULL,
        archived_at TEXT,
        -- WMB-5244 扩展（设计 §7.2）：下载回退链（图片 orig→medium→thumb 等），首元素不重复 original_url。
        alternate_urls_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE (source_revision_key, ordinal, kind)
      );
      CREATE INDEX source_media_candidates_source_rev ON source_media_candidates(source_id, source_revision_key, ordinal);
      CREATE INDEX source_media_candidates_status ON source_media_candidates(status);

      CREATE TABLE media_archive_attempts (
        candidate_id TEXT NOT NULL REFERENCES source_media_candidates(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'needs_user', 'unsupported')),
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        runtime_name TEXT,
        runtime_version TEXT,
        parameter_hash TEXT,
        PRIMARY KEY (candidate_id, attempt)
      );
      CREATE INDEX media_archive_attempts_candidate ON media_archive_attempts(candidate_id, attempt);

      CREATE TABLE source_media_bindings (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        source_revision_key TEXT NOT NULL,
        candidate_id TEXT NOT NULL REFERENCES source_media_candidates(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'video_poster')),
        ordinal INTEGER NOT NULL,
        original_url TEXT NOT NULL,
        caption TEXT,
        sha256 TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        rights_status TEXT NOT NULL DEFAULT 'unknown' CHECK (rights_status IN ('unknown', 'likely_reusable', 'permission_required', 'restricted')),
        risk_flags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        archived_at TEXT,
        archived_reason TEXT,
        UNIQUE (source_revision_key, asset_id),
        UNIQUE (source_revision_key, ordinal, kind)
      );
      CREATE INDEX source_media_bindings_source_rev ON source_media_bindings(source_id, source_revision_key, ordinal);
      CREATE INDEX source_media_bindings_asset ON source_media_bindings(asset_id);
    `
  },
  {
    version: 65,
    sql: `
      -- ===== asset_provenance kind 扩展（设计 §6.5）+ 核心/平台绑定视频兼容（设计 §12.3）=====
      -- 重建表只为扩展 CHECK 取值（同 v58/v60 模式）；存量行原样复制，索引原样重建。
      ALTER TABLE asset_provenance RENAME TO asset_provenance_v64;
      CREATE TABLE asset_provenance (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        kind TEXT NOT NULL CHECK (kind IN ('imported', 'generated', 'derived_crop', 'derived_annotation', 'derived_keyframe', 'derived_clip', 'derived_transcode')),
        origin TEXT NOT NULL,
        source_asset_id TEXT REFERENCES assets(id),
        derived_asset_id TEXT REFERENCES assets(id),
        transform_json TEXT,
        source_url TEXT,
        source_revision_id TEXT,
        generator TEXT,
        generation_prompt TEXT,
        generation_model TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        -- 设计 §10.9：Clip/转码等派生记录固定运行时身份（与 media_archive_attempts 同名字段一致）。
        runtime_name TEXT,
        runtime_version TEXT,
        CHECK (kind NOT LIKE 'derived_%' OR (source_asset_id IS NOT NULL AND derived_asset_id IS NOT NULL AND transform_json IS NOT NULL)),
        UNIQUE (kind, source_asset_id, derived_asset_id)
      );
      INSERT INTO asset_provenance (
        id, asset_id, kind, origin, source_asset_id, derived_asset_id, transform_json,
        source_url, source_revision_id, generator, generation_prompt, generation_model, request_id, created_at,
        runtime_name, runtime_version
      )
      SELECT id, asset_id, kind, origin, source_asset_id, derived_asset_id, transform_json,
        source_url, source_revision_id, generator, generation_prompt, generation_model, request_id, created_at,
        NULL, NULL
      FROM asset_provenance_v64;
      DROP TABLE asset_provenance_v64;
      CREATE INDEX asset_provenance_asset ON asset_provenance(asset_id);
      CREATE INDEX asset_provenance_source ON asset_provenance(source_asset_id);
      CREATE INDEX asset_provenance_derived ON asset_provenance(derived_asset_id);

      -- 存量绑定行默认 media_kind='image'，图片语义不变（WMB-5237 回填/投影零影响）。
      ALTER TABLE content_media_bindings ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'image'
        CHECK (media_kind IN ('image', 'video', 'video_poster'));
      ALTER TABLE platform_media_bindings ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'image'
        CHECK (media_kind IN ('image', 'video', 'video_poster'));
      ALTER TABLE platform_media_bindings ADD COLUMN poster_asset_id TEXT REFERENCES assets(id);
      ALTER TABLE platform_media_bindings ADD COLUMN clip_range_json TEXT;
      ALTER TABLE platform_media_bindings ADD COLUMN duration_ms INTEGER;
    `
  },
  {
    version: 66,
    sql: `
      -- ===== 视频理解运行（设计 §10.3）：身份 + attempt 唯一；completed 行由触发器禁止更新 =====
      CREATE TABLE video_understanding_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_items(id),
        source_revision_key TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
        attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        stage TEXT NOT NULL DEFAULT 'probe' CHECK (stage IN ('probe', 'transcript', 'keyframes', 'ocr', 'align', 'summarize')),
        probe_json TEXT,
        transcript_json TEXT,
        keyframes_json TEXT,
        segments_json TEXT,
        model TEXT,
        provider TEXT,
        prompt_version INTEGER NOT NULL DEFAULT 1 CHECK (prompt_version >= 1),
        runtime_manifest_hash TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (source_id, source_revision_key, asset_id, schema_version, attempt)
      );
      CREATE INDEX video_understanding_runs_status ON video_understanding_runs(status, created_at DESC);
      CREATE INDEX video_understanding_runs_source ON video_understanding_runs(source_id, source_revision_key, created_at DESC);
      CREATE TRIGGER video_understanding_runs_completed_immutable
        BEFORE UPDATE ON video_understanding_runs
        WHEN OLD.completed_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'VIDEO_RUN_COMPLETED_IMMUTABLE'); END;
    `
  }
] as const;
