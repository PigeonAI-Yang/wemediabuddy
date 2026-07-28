import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type PlanItemInput = { title: string; priority: number; whyNow: string; timeliness: string; targetAudience: string; angle: string; pointOfView: string; platforms: string[]; formats: string[]; titleGuidance: string; openingGuidance: string; structureGuidance: string; effortEstimate: string; sourceIds: string[]; availableMaterials?: string[]; missingMaterials?: string[]; reviewIds?: string[]; methodFindingIds?: string[]; topicId?: string };

export function createTopic(database: DatabaseSync, title: string): { id: string; revision: number } {
  const id = randomUUID(); const now = new Date().toISOString();
  database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run(id, title, now, now);
  return { id, revision: 1 };
}

export function saveCurrentPlan(database: DatabaseSync, input: { planDate: string; timezone: string; summary: string; items: PlanItemInput[] }, transaction = true): { id: string; revision: number } {
  if (!input.items.length) throw new Error('计划至少需要一项。');
  for (const item of input.items) if (!item.sourceIds.length) throw new Error('计划条目必须引用资料。');
  const sourceCount = Number((database.prepare(`SELECT COUNT(*) AS count FROM source_items WHERE id IN (${input.items.flatMap((item) => item.sourceIds).map(() => '?').join(',')})`).get(...input.items.flatMap((item) => item.sourceIds)) as { count: number }).count);
  if (sourceCount !== new Set(input.items.flatMap((item) => item.sourceIds)).size) throw new Error('计划引用了不存在的资料。');
  const reviewsTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reviews'").get();
  if (reviewsTable && Number((database.prepare("SELECT COUNT(*) AS count FROM reviews WHERE status = 'final'").get() as { count: number }).count) > 0 && !input.items.some((item) => item.reviewIds?.length || item.methodFindingIds?.length)) throw new Error('存在最终复盘时，当前计划必须引用历史复盘或方法结论。');
  const now = new Date().toISOString(); const id = randomUUID();
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE plans SET is_current = 0, updated_at = ?, revision = revision + 1 WHERE plan_date = ? AND is_current = 1').run(now, input.planDate);
    database.prepare('INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(id, input.planDate, input.timezone, input.summary, now, now);
    input.items.forEach((item, sortOrder) => database.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(randomUUID(), id, item.topicId ?? null, item.title, item.priority, item.whyNow, item.timeliness, item.targetAudience, item.angle, item.pointOfView, JSON.stringify(item.platforms), JSON.stringify(item.formats), item.titleGuidance, item.openingGuidance, item.structureGuidance, item.effortEstimate, JSON.stringify(item.sourceIds), JSON.stringify(item.availableMaterials ?? []), JSON.stringify(item.missingMaterials ?? []), JSON.stringify(item.reviewIds ?? []), JSON.stringify(item.methodFindingIds ?? []), sortOrder, now, now));
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  return { id, revision: 1 };
}
