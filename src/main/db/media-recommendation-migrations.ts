// WMB-5246: 创作媒体建议审计持久层（MediaRecommendations 所有，版本 68）。
// 设计 §11：固定内容/Source/Knowledge 版本 + completed 理解 → 按观点生成 0..N 条建议；
// 状态 proposed → accepted/rejected（用户决定）；新提案替换旧提案 → superseded（审计保留）。
// 版本分配（Main 已确认）：64-66 MediaSchema、67 MediaGovernance、68 MediaRecommendations、69 ImageUnderstanding。
// 本表只存建议审计状态与字段快照；Content/Platform Binding 的写入仍是独立的 Studio 保存流程（§12.3）。
// 与候选/绑定/视频运行 schema 的引用关系见 src/shared/media-candidates.ts + db/media-archive-store.ts + db/video-understanding-store.ts。

export const mediaRecommendationMigrations = [
  {
    version: 68,
    sql: `
      CREATE TABLE media_recommendations (
        id TEXT PRIMARY KEY,
        content_version_id TEXT NOT NULL REFERENCES content_versions(id),
        project_id TEXT NOT NULL REFERENCES content_projects(id),
        claim_key TEXT NOT NULL,
        claim_excerpt TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES source_items(id),
        source_revision_key TEXT NOT NULL,
        binding_id TEXT NOT NULL REFERENCES source_media_bindings(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),
        media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'video_poster')),
        purpose TEXT NOT NULL CHECK (purpose IN ('direct_evidence', 'demonstration', 'comparison', 'background', 'cover', 'decoration')),
        priority INTEGER NOT NULL,
        rationale TEXT NOT NULL,
        caption TEXT NOT NULL,
        transform_json TEXT NOT NULL,
        provenance TEXT NOT NULL,
        rights_status TEXT NOT NULL CHECK (rights_status IN ('unknown', 'likely_reusable', 'permission_required', 'restricted')),
        risk_flags_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'rejected', 'superseded')),
        revision INTEGER NOT NULL DEFAULT 1,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        superseded_at TEXT,
        superseded_by TEXT,
        UNIQUE (content_version_id, claim_key, asset_id, purpose)
      );
      CREATE INDEX media_recommendations_content ON media_recommendations(content_version_id, state);
      CREATE INDEX media_recommendations_asset ON media_recommendations(asset_id);
      CREATE INDEX media_recommendations_binding ON media_recommendations(binding_id);
    `
  }
] as const;
