export const planningStageMigrations = [
  {
    version: 77,
    sql: `
      -- v77: planning stage 一等状态（仅两列 + 一索引 + 精确 backfill）
      ALTER TABLE plan_items ADD COLUMN planning_status TEXT NOT NULL
        CHECK (planning_status IN ('draft','ready_for_review','approved','rejected'))
        DEFAULT 'draft';

      ALTER TABLE plan_items ADD COLUMN planning_provenance_json TEXT NOT NULL
        DEFAULT '{"origin":"system","transitions":[]}';

      CREATE INDEX IF NOT EXISTS idx_plan_items_planning_status
        ON plan_items(planning_status, plan_id, sort_order);

      -- 精确模板指纹：与 daily-content-article.ts:99-108 的九个硬编码字段逐项相等；
      -- 不使用正则，也不写入 Yann 用户数据 UUID。
      UPDATE plan_items
      SET planning_status='draft',
          planning_provenance_json = json_patch(
            planning_provenance_json,
            json_object(
              'origin','migration',
              'legacy','legacy_zhihu_fallback',
              'backfilled_at',strftime('%Y-%m-%dT%H:%M:%SZ','now'),
              'reason','exact_fallback_fingerprint_9fields'
            )
          )
      WHERE planning_status='draft'
        AND json_extract(planning_provenance_json,'$.legacy') IS NULL
        AND why_now='基于知乎热题的每日内容目标'
        AND timeliness='today'
        AND target_audience='泛科技受众'
        AND angle='深度解读该问题的核心争议与证据'
        AND point_of_view='提供独立判断与可操作建议'
        AND platforms_json='["x","xiaohongshu","wechat"]'
        AND formats_json='["article"]'
        AND opening_guidance='以问题为引，快速建立共识再展开分析'
        AND structure_guidance='背景→拆解→证据→观点→行动';

      -- 其余既有项保持可用，标记为已审批遗产；只处理尚未分类的 v77 默认行。
      UPDATE plan_items
      SET planning_status='approved',
          planning_provenance_json = json_patch(
            planning_provenance_json,
            json_object(
              'origin','migration',
              'legacy','legacy_approved',
              'backfilled_at',strftime('%Y-%m-%dT%H:%M:%SZ','now')
            )
          )
      WHERE planning_status='draft'
        AND json_extract(planning_provenance_json,'$.legacy') IS NULL;
    `
  },
  {
    version: 78,
    sql: `
      CREATE TABLE plan_source_decisions (
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES source_items(id),
        source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
        decision TEXT NOT NULL CHECK (decision IN ('selected','excluded','unresolved','blocked')),
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        plan_item_id TEXT REFERENCES plan_items(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, source_id, source_revision)
      );
      CREATE INDEX idx_plan_source_decisions_source
        ON plan_source_decisions(source_id, source_revision, created_at DESC);
    `
  }
] as const;
