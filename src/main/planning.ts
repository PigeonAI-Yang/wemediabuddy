import { broadcastDataChanged } from './data-changed.ts';
import { upsertCarryFromPlanItem } from './ferment.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type PlanItemInput = { title: string; priority: number; whyNow: string; timeliness: string; targetAudience: string; angle: string; pointOfView: string; platforms: string[]; formats: string[]; titleGuidance: string; openingGuidance: string; structureGuidance: string; effortEstimate: string; sourceIds: string[]; availableMaterials?: string[]; missingMaterials?: string[]; reviewIds?: string[]; methodFindingIds?: string[]; topicId?: string };

export function createTopic(database: DatabaseSync, title: string): { id: string; revision: number } {
  const id = randomUUID(); const now = new Date().toISOString();
  database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run(id, title, now, now);
  return { id, revision: 1 };
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
    upsertCarryFromPlanItem(database, {
      planItemId: row.planItemId,
      title: row.item.title,
      priority: row.item.priority,
      timeliness: row.item.timeliness,
      topicId: row.item.topicId,
      sourceIds: row.item.sourceIds,
      originPlanDate: input.planDate,
      reason: '写入今日方案时进入续命池'
    });
  }
  broadcastDataChanged({ scopes: ['today'], reason: 'plan.save' });
  return { id, revision: 1 };
}

function validateReferences(database: DatabaseSync, table: 'topics' | 'reviews' | 'method_findings', ids: string[], message: string, extra = '1=1') {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const count = Number((database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${extra} AND id IN (${unique.map(() => '?').join(',')})`).get(...unique) as { count: number }).count);
  if (count !== unique.length) throw new Error(message);
}
