import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';

export function createContentProject(database: DatabaseSync, input: { title: string; topicId?: string; planItemId?: string; sourceIds?: string[] }, transaction = true): { id: string; revision: number } {
  const id = randomUUID(); const now = new Date().toISOString();
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, input.topicId ?? null, input.planItemId ?? null, input.title, now, now);
    for (const sourceId of input.sourceIds ?? []) database.prepare('INSERT INTO content_project_sources (project_id, source_id) VALUES (?, ?)').run(id, sourceId);
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  return { id, revision: 1 };
}

export function createProjectFromPlanItem(database: DatabaseSync, planItemId: string): { id: string; revision: number; created: boolean } {
  const existing = database.prepare('SELECT id, revision FROM content_projects WHERE plan_item_id = ?').get(planItemId) as { id: string; revision: number } | undefined;
  if (existing) return { ...existing, created: false };
  const item = database.prepare(`SELECT topic_id AS topicId, title, point_of_view AS pointOfView,
    title_guidance AS titleGuidance, opening_guidance AS openingGuidance, structure_guidance AS structureGuidance,
    source_ids_json AS sourceIds FROM plan_items WHERE id = ?`).get(planItemId) as {
      topicId: string | null; title: string; pointOfView: string; titleGuidance: string;
      openingGuidance: string; structureGuidance: string; sourceIds: string;
    } | undefined;
  if (!item) throw new Error('内容机会不存在。');
  database.exec('BEGIN IMMEDIATE');
  try {
    const project = createContentProject(database, {
      title: item.title,
      topicId: item.topicId ?? undefined,
      planItemId,
      sourceIds: JSON.parse(item.sourceIds) as string[]
    }, false);
    saveCoreVersion(database, project.id, `# ${item.title}\n\n## 核心观点\n${item.pointOfView}\n\n## 标题建议\n${item.titleGuidance}\n\n## 开头建议\n${item.openingGuidance}\n\n## 内容结构\n${item.structureGuidance}`);
    database.exec('COMMIT');
    return { ...project, created: true };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function addProjectNote(database: DatabaseSync, projectId: string, body: string, kind: 'note' | 'decision'): { id: string; revision: number } {
  const id = randomUUID(); const now = new Date().toISOString();
  const table = kind === 'note' ? 'content_notes' : 'content_decisions';
  database.prepare(`INSERT INTO ${table} (id, project_id, body, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 1)`).run(id, projectId, body, now, now);
  return { id, revision: 1 };
}

export function saveCoreVersion(
  database: DatabaseSync,
  projectId: string,
  body: string,
  author: 'user' | 'ai' = 'ai'
): { id: string; versionNumber: number; createdAt: string; author: 'user' | 'ai' } {
  const versionNumber = Number((database.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS number FROM content_versions WHERE project_id = ?').get(projectId) as { number: number }).number);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at, author) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, body, versionNumber, createdAt, author);
  database.prepare('UPDATE content_projects SET updated_at = ? WHERE id = ?').run(createdAt, projectId);
  return { id, versionNumber, createdAt, author };
}

export function updateProjectTitle(database: DatabaseSync, projectId: string, title: string): CommandResult<{ id: string; title: string; revision: number }> {
  const current = database.prepare('SELECT id, revision FROM content_projects WHERE id = ?').get(projectId) as { id: string; revision: number } | undefined;
  if (!current) return failure('NOT_FOUND', '内容项目不存在。');
  const nextTitle = title.trim();
  if (!nextTitle) return failure('VALIDATION_ERROR', '标题不能为空。');
  const now = new Date().toISOString();
  const revision = current.revision + 1;
  database.prepare('UPDATE content_projects SET title = ?, updated_at = ?, revision = ? WHERE id = ?')
    .run(nextTitle, now, revision, projectId);
  return success({ id: projectId, title: nextTitle, revision });
}

export function savePlatformVersion(database: DatabaseSync, input: { projectId: string; contentVersionId: string; platform: 'x' | 'xiaohongshu' | 'wechat'; format: string; title?: string; body: string; assetIds?: string[]; expectedRevision?: number; id?: string }): CommandResult<{ id: string; revision: number }> {
  const now = new Date().toISOString();
  if (!input.id) {
    const id = randomUUID(); database.prepare('INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(id, input.projectId, input.contentVersionId, input.platform, input.format, input.title ?? null, input.body, JSON.stringify(input.assetIds ?? []), now, now);
    return success({ id, revision: 1 });
  }
  const current = database.prepare('SELECT revision FROM platform_versions WHERE id = ?').get(input.id) as { revision: number } | undefined;
  if (!current) return failure('NOT_FOUND', '平台版本不存在。');
  if (input.expectedRevision !== current.revision) return failure('REVISION_CONFLICT', '平台版本已更新，请重新加载。', { currentRevision: current.revision });
  database.prepare('UPDATE platform_versions SET content_version_id=?, platform=?, format=?, title=?, body=?, asset_ids_json=?, updated_at=?, revision=? WHERE id=?').run(input.contentVersionId, input.platform, input.format, input.title ?? null, input.body, JSON.stringify(input.assetIds ?? []), now, current.revision + 1, input.id);
  return success({ id: input.id, revision: current.revision + 1 });
}

export function getStudio(database: DatabaseSync): Array<{
  id: string;
  title: string;
  revisions: Array<{ id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai' }>;
  platforms: Record<string, Array<{ id: string; title: string | null; body: string; revision: number; assets: string[] }>>;
}> {
  const projects = database.prepare('SELECT id, title FROM content_projects ORDER BY updated_at DESC').all() as Array<{ id: string; title: string }>;
  return projects.map((project) => {
    const revisions = database.prepare(`SELECT id, version_number AS number, body, created_at AS createdAt, COALESCE(author, 'ai') AS author
      FROM content_versions WHERE project_id = ? ORDER BY version_number DESC`).all(project.id) as Array<{ id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai' }>;
    const versions = database.prepare('SELECT id, platform, title, body, revision, asset_ids_json AS assets FROM platform_versions WHERE project_id = ? ORDER BY updated_at DESC').all(project.id) as Array<{ id: string; platform: string; title: string | null; body: string; revision: number; assets: string }>;
    const platforms: Record<string, Array<{ id: string; title: string | null; body: string; revision: number; assets: string[] }>> = { x: [], xiaohongshu: [], wechat: [] };
    for (const version of versions) platforms[version.platform]?.push({ ...version, assets: JSON.parse(version.assets) });
    return { ...project, revisions, platforms };
  });
}
