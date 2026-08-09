import { broadcastDataChanged } from './data-changed.ts';
import { isMultiDayTimeliness, mergeSimilarCarryItems, upsertCarryFromPlanItem } from './ferment.ts';
import { normalizeTitle } from './ferment-read.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type PlanItemInput = { title: string; priority: number; whyNow: string; timeliness: string; targetAudience: string; angle: string; pointOfView: string; platforms: string[]; formats: string[]; titleGuidance: string; openingGuidance: string; structureGuidance: string; effortEstimate: string; sourceIds: string[]; availableMaterials?: string[]; missingMaterials?: string[]; reviewIds?: string[]; methodFindingIds?: string[]; topicId?: string };

export function createTopic(database: DatabaseSync, title: string): { id: string; revision: number } {
  const id = randomUUID();
  const now = new Date().toISOString();
  const trimmed = title.trim().slice(0, 80) || '未命名主题';
  const canonicalKey = normalizeTitle(trimmed) || id;
  database.prepare(`INSERT INTO topics
    (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 1, ?, 'theme', NULL, 'active', ?, ?)`).run(id, trimmed, now, now, canonicalKey, now, now);
  return { id, revision: 1 };
}

function linkTopicSources(database: DatabaseSync, topicId: string, sourceIds: string[], now: string): void {
  const insert = database.prepare(`INSERT INTO topic_source_links(topic_id, source_id, relation, created_at, updated_at)
    VALUES (?, ?, 'primary', ?, ?)
    ON CONFLICT(topic_id, source_id, relation) DO UPDATE SET updated_at = excluded.updated_at`);
  for (const sourceId of [...new Set(sourceIds.filter(Boolean))]) {
    const exists = database.prepare('SELECT id FROM source_items WHERE id = ?').get(sourceId);
    if (!exists) continue;
    insert.run(topicId, sourceId, now, now);
  }
  database.prepare(`UPDATE topics SET last_seen_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
    .run(now, now, topicId);
}

export function saveCurrentPlan(database: DatabaseSync, input: { planDate: string; timezone: string; summary: string; items: PlanItemInput[] }, transaction = true): { id: string; revision: number } {
  for (const item of input.items) {
    if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 7) throw new Error('机会等级必须是 0–7 的整数。');
    if (!item.sourceIds.length) throw new Error('计划条目必须引用资料。');
  }
  const items = input.items.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index)
    .map(({ item }) => item);
  const sourceIds = input.items.flatMap((item) => item.sourceIds);
  if (sourceIds.length) {
    const sourceCount = Number((database.prepare(`SELECT COUNT(*) AS count FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')})`).get(...sourceIds) as { count: number }).count);
    if (sourceCount !== new Set(sourceIds).size) throw new Error('计划引用了不存在的资料。');
    const withoutUrl = Number((database.prepare(`SELECT COUNT(*) AS count FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')}) AND (canonical_url IS NULL OR canonical_url = '')`).get(...sourceIds) as { count: number }).count);
    // 深挖约束：机会只能引用带可追溯链接的入库资料；搜索发现的材料必须带原始 URL 入库。
    if (withoutUrl > 0) throw new Error('计划引用的资料缺少可追溯链接；深挖发现的材料必须带原始 URL 入库后才能引用。');
  }
  validateReferences(database, 'topics', input.items.flatMap((item) => item.topicId ? [item.topicId] : []), '计划引用了不存在的主题。');
  validateReferences(database, 'reviews', input.items.flatMap((item) => item.reviewIds ?? []), '计划引用了不存在的复盘。', "status='final'");
  const now = new Date().toISOString(); const id = randomUUID();
  const inserted: Array<{ planItemId: string; item: PlanItemInput }> = [];
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    // WMB-4931 topic 绑定率：多日/持续/余波跟进项无 topic 时在事务内 find-or-create 主题并绑定。
    // 同规范标题复用既有主题（跨日同一故事落在同一 topic，story_key 稳定）；事务回滚则主题一并回滚。
    const topicIndex = new Map(
      (database.prepare('SELECT id, title FROM topics').all() as Array<{ id: string; title: string }>)
        .map((row) => [normalizeTitle(row.title), row.id])
    );
    for (const item of items) {
      if (item.topicId || !isMultiDayTimeliness(item.timeliness)) continue;
      const normalized = normalizeTitle(item.title);
      const found = topicIndex.get(normalized);
      if (found) {
        item.topicId = found;
        continue;
      }
      item.topicId = createTopic(database, item.title.trim().slice(0, 80)).id;
      topicIndex.set(normalized, item.topicId);
    }
    database.prepare('UPDATE plans SET is_current = 0, updated_at = ?, revision = revision + 1 WHERE plan_date = ? AND is_current = 1').run(now, input.planDate);
    database.prepare('INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(id, input.planDate, input.timezone, input.summary, now, now);
    items.forEach((item, sortOrder) => {
      const planItemId = randomUUID();
      database.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(planItemId, id, item.topicId ?? null, item.title, item.priority, item.whyNow, item.timeliness, item.targetAudience, item.angle, item.pointOfView, JSON.stringify(item.platforms), JSON.stringify(item.formats), item.titleGuidance, item.openingGuidance, item.structureGuidance, item.effortEstimate, JSON.stringify(item.sourceIds), JSON.stringify(item.availableMaterials ?? []), JSON.stringify(item.missingMaterials ?? []), JSON.stringify(item.reviewIds ?? []), JSON.stringify(item.methodFindingIds ?? []), sortOrder, now, now);
      inserted.push({ planItemId, item });
    });
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  for (const row of inserted) {
    const multiDay = /持续|多日|本周|这周|一周|7\s*天|长期|余波|跟踪|跟进|发酵|week|ongoing|multi/i.test(row.item.timeliness || '');
    if (row.item.topicId) {
      linkTopicSources(database, row.item.topicId, row.item.sourceIds, new Date().toISOString());
    }
    upsertCarryFromPlanItem(database, {
      planItemId: row.planItemId,
      title: row.item.title,
      priority: row.item.priority,
      timeliness: row.item.timeliness,
      topicId: row.item.topicId,
      sourceIds: row.item.sourceIds,
      originPlanDate: input.planDate,
      reason: multiDay ? `未完结影响：${row.item.timeliness}` : (row.item.priority <= 1 ? '高优先级机会，持续关注' : '待处理机会')
    });
  }
  mergeSimilarCarryItems(database);
  broadcastDataChanged({ scopes: ['today'], reason: 'plan.save' });
  return { id, revision: 1 };
}

function validateReferences(database: DatabaseSync, table: 'topics' | 'reviews' | 'method_findings', ids: string[], message: string, extra = '1=1') {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const count = Number((database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${extra} AND id IN (${unique.map(() => '?').join(',')})`).get(...unique) as { count: number }).count);
  if (count !== unique.length) throw new Error(message);
}
