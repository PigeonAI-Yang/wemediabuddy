import { markCarryDoneForPlanItem } from './ferment.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { migrateAnnotationsForCoreSave, migrateAnnotationsForPlatformSave } from './studio-annotations.ts';
import { recordCoreDraftUsage, recordPlatformUsage } from './knowledge-usage-integration.ts';
import {
  buildAssetIdsFromPlatformBindings,
  normalizeContentMediaBindings,
  normalizePlatformMediaBindings,
  type ContentMediaBinding,
  type ContentMediaBindingDraft,
  type PlatformMediaBinding,
  type PlatformMediaBindingDraft
} from '../shared/media-bindings.ts';
import {
  insertDerivedCropProvenance,
  readContentMediaBindings,
  readPlatformMediaBindings,
  readProjectContentMediaBindings,
  readProjectPlatformMediaBindings,
  reconcileCoreBindingDrafts,
  reconcilePlatformBindingDrafts,
  replaceContentMediaBindings,
  replacePlatformMediaBindings,
  cropRegionKey,
  type StagedCrop
} from './media-bindings.ts';
import { registerStagedAsset } from './assets.ts';
import { readStudioMediaProjection, type StudioSourceMedia } from './studio-media-projection.ts';
import { clipKey, commitClipDerivation, type ClipDerivationResult, type StagedClip } from './media-derivations.ts';

/** 保存路径的 Clip 载荷：stageClipAsset 结果 + 源与时间范围（血缘与绑定回填必需；见 ipc-today-studio-business）。 */
export type StagedClipSave = StagedClip & {
  sourceAssetId: string;
  startMs: number;
  endMs: number;
};

export type ContentProjectStatus = 'idea' | 'drafting' | 'review' | 'ready' | 'completed';
export type ContentProjectOrder = 'recent' | 'oldest' | 'versions';
export type ContentProjectPlatform = 'x' | 'xiaohongshu' | 'wechat' | 'zhihu';
export type SavedCoreVersion = {
  id: string;
  versionNumber: number;
  createdAt: string;
  author: 'user' | 'ai';
  projectRevision: number;
  project: { id: string; title: string; revision: number };
};
export type SavedPlatformVersion = { id: string; revision: number };

export type ContentProjectSummary = {
  id: string;
  title: string;
  status: ContentProjectStatus;
  archivedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  /** 来自关联 plan_items.priority：0=SSS … 与今日选题评分标一致；无关联则为 null */
  planItemPriority: number | null;
  latestVersion: { id: string; number: number; createdAt: string; author: 'user' | 'ai' } | null;
  platforms: { x: number; xiaohongshu: number; wechat: number; zhihu: number };
};

export type ContentProjectDetail = ContentProjectSummary & {
  topicId: string | null;
  planItemId: string | null;
  sourceIds: string[];
  sources: Array<{
    id: string; title: string; canonicalUrl: string | null; author: string | null;
    publishedAt: string | null; summary: string | null;
  }>;
  notes: Array<{ id: string; body: string; createdAt: string; updatedAt: string; revision: number }>;
  decisions: Array<{ id: string; body: string; createdAt: string; updatedAt: string; revision: number }>;
  revisions: Array<{ id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai'; bindings: ContentMediaBinding[] }>;
  platformVersions: Record<string, Array<{ id: string; contentVersionId: string; format: string; title: string | null; body: string; revision: number; assets: string[]; mediaBindings: PlatformMediaBinding[]; createdAt: string; updatedAt: string }>>;
  assets: Array<{
    id: string; relativePath: string; mimeType: string; byteCount: number; sha256: string; origin: string;
    width: number | null; height: number | null; durationMs: number | null; createdAt: string;
  }>;
  creativeBrief: { id: string; title: string; revision: number; status: 'draft'|'confirmed'; canvasId: string | null; contextNodeIds: string[] } | null;
  /** WMB-5246：项目关联 Source 的已保存媒体（来源图/原视频/关键帧/Segment；迁移未落地时为空数组）。 */
  sourceMedia: StudioSourceMedia[];
};

type ProjectListRow = {
  id: string; title: string; status: ContentProjectStatus; archivedAt: string | null; revision: number;
  createdAt: string; updatedAt: string; versionCount: number; latestVersionId: string | null;
  latestVersionNumber: number | null; latestVersionCreatedAt: string | null; latestVersionAuthor: 'user' | 'ai' | null;
  xCount: number; xiaohongshuCount: number; wechatCount: number; zhihuCount: number;
  planItemPriority: number | null;
};

function summaryFromRow(row: ProjectListRow): ContentProjectSummary {
  const priorityRaw = row.planItemPriority;
  const planItemPriority = priorityRaw == null ? null : Number(priorityRaw);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    archivedAt: row.archivedAt,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    versionCount: Number(row.versionCount),
    planItemPriority: Number.isFinite(planItemPriority as number) ? (planItemPriority as number) : null,
    latestVersion: row.latestVersionId ? {
      id: row.latestVersionId,
      number: Number(row.latestVersionNumber),
      createdAt: row.latestVersionCreatedAt!,
      author: row.latestVersionAuthor ?? 'ai'
    } : null,
    platforms: {
      x: Number(row.xCount),
      xiaohongshu: Number(row.xiaohongshuCount),
      wechat: Number(row.wechatCount),
      zhihu: Number(row.zhihuCount)
    }
  };
}

export function listContentProjects(
  database: DatabaseSync,
  input: { query?: string; status?: ContentProjectStatus; archived?: boolean; order?: ContentProjectOrder; platform?: ContentProjectPlatform; limit?: number; offset?: number } = {}
): { items: ContentProjectSummary[]; limit: number; offset: number; hasMore: boolean } {
  const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const where: string[] = [input.archived === true ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL'];
  const params: Array<string | number> = [];
  if (input.status) { where.push('p.status = ?'); params.push(input.status); }
  if (input.platform) where.push(`COALESCE(pv.${input.platform === 'xiaohongshu' ? 'xiaohongshu' : input.platform}_count, 0) > 0`);
  const query = input.query?.trim();
  if (query) {
    where.push("(p.title LIKE ? ESCAPE '\\' OR COALESCE(v.latest_body, '') LIKE ? ESCAPE '\\')");
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(pattern, pattern);
  }
  const orderBy = input.order === 'oldest' ? 'p.updated_at ASC, p.id ASC'
    : input.order === 'versions' ? 'COALESCE(v.version_count, 0) DESC, p.updated_at DESC, p.id DESC'
      : 'p.updated_at DESC, p.id DESC';
  const rows = database.prepare(`
    WITH ranked_versions AS (
      SELECT id, project_id, body, version_number, created_at, COALESCE(author, 'ai') AS author,
        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY version_number DESC) AS position
      FROM content_versions
    ),
    version_summary AS (
      SELECT project_id, COUNT(*) AS version_count,
        MAX(CASE WHEN position = 1 THEN id END) AS latest_version_id,
        MAX(CASE WHEN position = 1 THEN body END) AS latest_body,
        MAX(CASE WHEN position = 1 THEN version_number END) AS latest_version_number,
        MAX(CASE WHEN position = 1 THEN created_at END) AS latest_version_created_at,
        MAX(CASE WHEN position = 1 THEN author END) AS latest_version_author
      FROM ranked_versions GROUP BY project_id
    ),
    platform_summary AS (
      SELECT project_id,
        SUM(CASE WHEN platform = 'x' THEN 1 ELSE 0 END) AS x_count,
        SUM(CASE WHEN platform = 'xiaohongshu' THEN 1 ELSE 0 END) AS xiaohongshu_count,
        SUM(CASE WHEN platform = 'wechat' THEN 1 ELSE 0 END) AS wechat_count,
        SUM(CASE WHEN platform = 'zhihu' THEN 1 ELSE 0 END) AS zhihu_count
      FROM platform_versions GROUP BY project_id
    )
    SELECT p.id, p.title, p.status, p.archived_at AS archivedAt, p.revision,
      p.created_at AS createdAt, p.updated_at AS updatedAt,
      COALESCE(v.version_count, 0) AS versionCount,
      v.latest_version_id AS latestVersionId, v.latest_version_number AS latestVersionNumber,
      v.latest_version_created_at AS latestVersionCreatedAt, v.latest_version_author AS latestVersionAuthor,
      COALESCE(pv.x_count, 0) AS xCount, COALESCE(pv.xiaohongshu_count, 0) AS xiaohongshuCount,
      COALESCE(pv.wechat_count, 0) AS wechatCount, COALESCE(pv.zhihu_count, 0) AS zhihuCount,
      pi.priority AS planItemPriority
    FROM content_projects p
    LEFT JOIN version_summary v ON v.project_id = p.id
    LEFT JOIN platform_summary pv ON pv.project_id = p.id
    LEFT JOIN plan_items pi ON pi.id = p.plan_item_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit + 1, offset) as ProjectListRow[];
  return { items: rows.slice(0, limit).map(summaryFromRow), limit, offset, hasMore: rows.length > limit };
}

export { getContentProjectStatusSummary, type ContentProjectStatusSummary } from './content-summary.ts';

export function getContentProject(database: DatabaseSync, projectId: string): ContentProjectDetail | null {
  const row = database.prepare(`
    SELECT p.id, p.topic_id AS topicId, p.plan_item_id AS planItemId, p.title, p.status,
      p.archived_at AS archivedAt, p.revision, p.created_at AS createdAt, p.updated_at AS updatedAt,
      pi.priority AS planItemPriority
    FROM content_projects p
    LEFT JOIN plan_items pi ON pi.id = p.plan_item_id
    WHERE p.id = ?
  `).get(projectId) as {
    id: string; topicId: string | null; planItemId: string | null; title: string; status: ContentProjectStatus;
    archivedAt: string | null; revision: number; createdAt: string; updatedAt: string;
    planItemPriority: number | null;
  } | undefined;
  if (!row) return null;
  const revisionRows = database.prepare(`SELECT id, version_number AS number, body, created_at AS createdAt, COALESCE(author, 'ai') AS author
    FROM content_versions WHERE project_id = ? ORDER BY version_number DESC`).all(projectId) as Array<{
      id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai';
    }>;
  const contentBindings = readProjectContentMediaBindings(database, projectId);
  const revisions = revisionRows.map((row) => ({ ...row, bindings: contentBindings.get(row.id) ?? [] }));
  const platformRows = database.prepare(`SELECT id, content_version_id AS contentVersionId, platform, format, title, body,
    revision, asset_ids_json AS assets, created_at AS createdAt, updated_at AS updatedAt
    FROM platform_versions WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId) as Array<{
      id: string; contentVersionId: string; platform: string; format: string; title: string | null; body: string;
      revision: number; assets: string; createdAt: string; updatedAt: string;
    }>;
  const platformBindings = readProjectPlatformMediaBindings(database, projectId);
  const platformVersions: ContentProjectDetail['platformVersions'] = { x: [], xiaohongshu: [], wechat: [], zhihu: [] };
  for (const version of platformRows) platformVersions[version.platform]?.push({
    ...version,
    assets: JSON.parse(version.assets),
    mediaBindings: platformBindings.get(version.id) ?? []
  });
  const sourceIds = (database.prepare('SELECT source_id AS id FROM content_project_sources WHERE project_id = ? ORDER BY source_id').all(projectId) as Array<{ id: string }>).map(({ id }) => id);
  // WMB-5246：Studio 媒体区读模型（来源媒体 + 视频理解 + 基础建议）；只读投影，表缺失时降级为空。
  const mediaProjection = readStudioMediaProjection(database, { sourceIds });
  const sources = database.prepare(`SELECT s.id, s.title, s.canonical_url AS canonicalUrl, s.author,
    s.published_at AS publishedAt, s.summary
    FROM content_project_sources cps JOIN source_items s ON s.id = cps.source_id
    WHERE cps.project_id = ? ORDER BY s.collected_at DESC`).all(projectId) as ContentProjectDetail['sources'];
  const assets = database.prepare(`SELECT a.id, a.relative_path AS relativePath, a.mime_type AS mimeType,
    a.byte_count AS byteCount, a.sha256, a.origin, a.width, a.height, a.duration_ms AS durationMs, a.created_at AS createdAt
    FROM (
      SELECT asset_id AS id, MAX(created_at) AS linked_at FROM (
        SELECT linked.value AS asset_id, pv.updated_at AS created_at
        FROM platform_versions pv JOIN json_each(pv.asset_ids_json) linked
        WHERE pv.project_id = ?
        UNION ALL
        SELECT cpa.asset_id, cpa.created_at
        FROM content_project_assets cpa
        WHERE cpa.project_id = ?
      ) grouped
      GROUP BY asset_id
    ) links
    JOIN assets a ON a.id = links.id
    ORDER BY links.linked_at DESC`).all(projectId, projectId) as ContentProjectDetail['assets'];
  const notes = database.prepare(`SELECT id, body, created_at AS createdAt, updated_at AS updatedAt, revision
    FROM content_notes WHERE project_id = ? ORDER BY created_at`).all(projectId) as ContentProjectDetail['notes'];
  const decisions = database.prepare(`SELECT id, body, created_at AS createdAt, updated_at AS updatedAt, revision
    FROM content_decisions WHERE project_id = ? ORDER BY created_at`).all(projectId) as ContentProjectDetail['decisions'];
  const creativeBriefRow=database.prepare(`SELECT b.id,b.title,b.revision,b.status,b.canvas_id AS canvasId,b.context_node_ids_json AS contextNodeIdsJson
    FROM creative_brief_projects link JOIN creative_briefs b ON b.id=link.brief_id WHERE link.project_id=?`).get(projectId) as any;
  const creativeBrief=creativeBriefRow?{id:creativeBriefRow.id,title:creativeBriefRow.title,revision:creativeBriefRow.revision,status:creativeBriefRow.status,
    canvasId:creativeBriefRow.canvasId,contextNodeIds:JSON.parse(creativeBriefRow.contextNodeIdsJson)}:null;
  const planItemPriority = row.planItemPriority == null ? null : Number(row.planItemPriority);
  return {
    ...row,
    planItemPriority: Number.isFinite(planItemPriority as number) ? (planItemPriority as number) : null,
    sourceIds,
    sources,
    notes,
    decisions,
    revisions,
    platformVersions,
    assets,
    creativeBrief,
    sourceMedia: mediaProjection.sourceMedia,
    versionCount: revisions.length,
    latestVersion: revisions[0] ? {
      id: revisions[0].id,
      number: revisions[0].number,
      createdAt: revisions[0].createdAt,
      author: revisions[0].author
    } : null,
    platforms: {
      x: platformVersions.x.length,
      xiaohongshu: platformVersions.xiaohongshu.length,
      wechat: platformVersions.wechat.length,
      zhihu: platformVersions.zhihu.length
    }
  };
}

export function copyContentVersionToNewProject(
  database: DatabaseSync,
  input: { sourceProjectId: string; contentVersionId: string; title: string },
  transaction = true
): CommandResult<ContentProjectDetail> {
  const title = input.title.trim();
  if (!title) return failure('VALIDATION_ERROR', '新项目标题不能为空。');
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const version = database.prepare(`SELECT body FROM content_versions WHERE id = ? AND project_id = ?`)
      .get(input.contentVersionId, input.sourceProjectId) as { body: string } | undefined;
    if (!version) {
      if (transaction) database.exec('ROLLBACK');
      return failure('NOT_FOUND', '指定历史版本不存在。');
    }
    const sourceIds = (database.prepare('SELECT source_id AS id FROM content_project_sources WHERE project_id = ?')
      .all(input.sourceProjectId) as Array<{ id: string }>).map(({ id }) => id);
    // WMB-5232：副本继承来源项目 Topic 归属，首个核心版本才能冻结同一固定血缘；
    // 否则副本 topic_id 为空 → core/platform/review 全部空 Usage（无知识引用却可保存）。
    const sourceTopic = database.prepare('SELECT topic_id AS topicId FROM content_projects WHERE id = ?')
      .get(input.sourceProjectId) as { topicId: string | null } | undefined;
    // WMB-5237：副本继承来源版本的媒体绑定（恢复语义），与副本首个核心版本同事务写入。
    const sourceBindings = readContentMediaBindings(database, input.contentVersionId);
    const created = createContentProjectWithVersion(database, {
      title,
      body: version.body,
      sourceIds,
      topicId: sourceTopic?.topicId ?? undefined,
      mediaBindings: sourceBindings.map((binding) => ({
        assetId: binding.assetId,
        occurrence: binding.occurrence,
        widthPreset: binding.widthPreset,
        align: binding.align,
        caption: binding.caption,
        linkUrl: binding.linkUrl
      }))
    }, false);
    const detail = getContentProject(database, created.id)!;
    if (transaction) database.exec('COMMIT');
    if (transaction) broadcastDataChanged({ scopes: ['studio'], reason: 'content.copy' });
    return success(detail);
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function createContentProject(database: DatabaseSync, input: { title: string; topicId?: string; planItemId?: string; sourceIds?: string[] }, transaction = true): { id: string; revision: number } {
  const id = randomUUID(); const now = new Date().toISOString();
  const planItem = input.planItemId ? database.prepare('SELECT topic_id AS topicId, source_ids_json AS sourceIds FROM plan_items WHERE id=?')
    .get(input.planItemId) as { topicId: string | null; sourceIds: string } | undefined : null;
  if (input.planItemId && !planItem) throw new Error('内容机会不存在。');
  const topicId = planItem?.topicId ?? input.topicId; const sourceIds = planItem ? JSON.parse(planItem.sourceIds) as string[] : (input.sourceIds ?? []);
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, topicId ?? null, input.planItemId ?? null, input.title, now, now);
    for (const sourceId of sourceIds) database.prepare('INSERT INTO content_project_sources (project_id, source_id) VALUES (?, ?)').run(id, sourceId);
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  return { id, revision: 1 };
}

export function createContentProjectWithVersion(
  database: DatabaseSync,
  input: { title: string; body: string; topicId?: string; planItemId?: string; sourceIds?: string[]; mediaBindings?: ContentMediaBindingDraft[] },
  transaction = true
): { id: string; revision: number; title: string; contentVersionId: string; versionNumber: number; body: string } {
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const project = createContentProject(database, input, false);
    const version = insertCoreVersion(database, project.id, input.body);
    // WMB-5237：核心版本与媒体绑定同事务；绑定校验/写入失败整体回滚。
    replaceContentMediaBindings(
      database,
      version.id,
      reconcileCoreBindingDrafts(input.body, normalizeContentMediaBindings(input.mediaBindings)),
      version.createdAt
    );
    // WMB-5215：首个核心版本与 usage 包同一事务；usage 失败整体回滚（协议 §10）。
    recordCoreDraftUsage(database, { contentVersionId: version.id, projectId: project.id, planItemId: input.planItemId ?? null, author: 'ai', reason: 'content.create' });
    if (transaction) database.exec('COMMIT');
    if (transaction) broadcastDataChanged({ scopes: ['studio'], reason: 'content.create' });
    return {
      ...project,
      title: input.title,
      contentVersionId: version.id,
      versionNumber: version.versionNumber,
      body: input.body
    };
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function createProjectFromPlanItem(database: DatabaseSync, planItemId: string, transaction = true): { id: string; revision: number; created: boolean } {
  const existing = database.prepare('SELECT id, revision FROM content_projects WHERE plan_item_id = ?').get(planItemId) as { id: string; revision: number } | undefined;
  if (existing) return { ...existing, created: false };
  const item = database.prepare(`SELECT topic_id AS topicId, title, point_of_view AS pointOfView,
    title_guidance AS titleGuidance, opening_guidance AS openingGuidance, structure_guidance AS structureGuidance,
    source_ids_json AS sourceIds FROM plan_items WHERE id = ?`).get(planItemId) as {
      topicId: string | null; title: string; pointOfView: string; titleGuidance: string;
      openingGuidance: string; structureGuidance: string; sourceIds: string;
    } | undefined;
  if (!item) throw new Error('内容机会不存在。');
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const project = createContentProject(database, {
      title: item.title,
      topicId: item.topicId ?? undefined,
      planItemId,
      sourceIds: JSON.parse(item.sourceIds) as string[]
    }, false);
    const version = insertCoreVersion(database, project.id, `# ${item.title}\n\n## 核心观点\n${item.pointOfView}\n\n## 标题建议\n${item.titleGuidance}\n\n## 开头建议\n${item.openingGuidance}\n\n## 内容结构\n${item.structureGuidance}`);
    // WMB-5215：选题采纳生成的首个核心版本与 usage 包同一事务（携带 plan_item_id 血缘）。
    recordCoreDraftUsage(database, { contentVersionId: version.id, projectId: project.id, planItemId, author: 'ai', reason: 'plan_item_adopt' });
    markCarryDoneForPlanItem(database, planItemId);
    if (transaction) database.exec('COMMIT');
    return { ...project, created: true };
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function addProjectNote(database: DatabaseSync, projectId: string, body: string, kind: 'note' | 'decision'): { id: string; revision: number } {
  const id = randomUUID(); const now = new Date().toISOString();
  const table = kind === 'note' ? 'content_notes' : 'content_decisions';
  database.prepare(`INSERT INTO ${table} (id, project_id, body, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 1)`).run(id, projectId, body, now, now);
  return { id, revision: 1 };
}

function insertCoreVersion(
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

export function saveCoreVersion(
  database: DatabaseSync,
  input: { projectId: string; body: string; expectedRevision: number; author?: 'user' | 'ai'; title?: string; mediaBindings?: ContentMediaBindingDraft[] },
  transaction = true
): CommandResult<SavedCoreVersion> {
  if (!input.body.trim()) return failure('VALIDATION_ERROR', '正文不能为空。');
  const requestedTitle = input.title?.trim();
  if (input.title !== undefined && !requestedTitle) return failure('VALIDATION_ERROR', '标题不能为空。');
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.prepare('SELECT id, title, revision FROM content_projects WHERE id = ?').get(input.projectId) as {
      id: string; title: string; revision: number;
    } | undefined;
    if (!current) {
      if (transaction) database.exec('ROLLBACK');
      return failure('NOT_FOUND', '内容项目不存在。');
    }
    if (input.expectedRevision !== current.revision) {
      const latest = getContentProject(database, input.projectId);
      if (transaction) database.exec('ROLLBACK');
      return failure('REVISION_CONFLICT', '内容项目已更新，请重新加载。', { current: latest });
    }
    const latest = database.prepare('SELECT id, body FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(input.projectId) as { id: string; body: string } | undefined;
    const version = insertCoreVersion(database, input.projectId, input.body, input.author ?? 'ai');
    // WMB-5237：核心版本与媒体绑定同事务；布局只改 draft，正文 token 保持 `![alt](wmb-asset://assetId)` 纯净。
    replaceContentMediaBindings(
      database,
      version.id,
      reconcileCoreBindingDrafts(input.body, normalizeContentMediaBindings(input.mediaBindings)),
      version.createdAt
    );
    const revision = current.revision + 1;
    const title = requestedTitle ?? current.title;
    database.prepare('UPDATE content_projects SET title = ?, updated_at = ?, revision = ? WHERE id = ?')
      .run(title, version.createdAt, revision, input.projectId);
    // WMB-5207: 批注迁移与正文保存同一事务；迁移异常整体回滚，不产生部分保存。
    migrateAnnotationsForCoreSave(database, {
      projectId: input.projectId,
      previousBody: latest?.body ?? null,
      nextBody: input.body,
      newVersionId: version.id
    });
    // WMB-5215: 核心版本与 usage 包同一事务；usage 失败整体回滚（协议 §10 无血缘版本零提交）。
    recordCoreDraftUsage(database, { contentVersionId: version.id, projectId: input.projectId, author: input.author ?? 'ai', reason: 'core_version_save' });
    if (transaction) database.exec('COMMIT');
    if (transaction) broadcastDataChanged({ scopes: ['studio'], reason: 'content.core_version' });
    return success({
      ...version,
      projectRevision: revision,
      project: { id: input.projectId, title, revision }
    });
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
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

export function updateContentProject(
  database: DatabaseSync,
  input: { projectId: string; expectedRevision: number; status?: ContentProjectStatus; archived?: boolean; topicId?: string|null },
  transaction = true
): CommandResult<ContentProjectDetail> {
  if (input.status === undefined && input.archived === undefined && input.topicId === undefined) return failure('VALIDATION_ERROR', '没有需要更新的项目字段。');
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const current = getContentProject(database, input.projectId);
    if (!current) {
      if (transaction) database.exec('ROLLBACK');
      return failure('NOT_FOUND', '内容项目不存在。');
    }
    if (current.revision !== input.expectedRevision) {
      if (transaction) database.exec('ROLLBACK');
      return failure('REVISION_CONFLICT', '内容项目已更新，请重新加载。', { current });
    }
    if(input.topicId!==undefined&&input.topicId!==null&&!database.prepare("SELECT id FROM topics WHERE id=? AND status!='archived'").get(input.topicId)){
      if(transaction)database.exec('ROLLBACK');
      return failure('NOT_FOUND','长期主题不存在。');
    }
    const now = new Date().toISOString();
    database.prepare('UPDATE content_projects SET status = ?, archived_at = ?, topic_id = ?, updated_at = ?, revision = ? WHERE id = ?')
      .run(
        input.status ?? current.status,
        input.archived === undefined ? current.archivedAt : input.archived ? now : null,
        input.topicId===undefined?current.topicId:input.topicId,
        now,
        current.revision + 1,
        input.projectId
      );
    const updated = getContentProject(database, input.projectId)!;
    if (transaction) database.exec('COMMIT');
    return success(updated);
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

// 受限硬删除:只允许删除从未进入发布/知识链路的工作项目(无平台版本、无发布、无上下文使用、无画布引用)。
// 一旦进入链路,项目被发布记录/指标/复盘回链,只能归档不能删除。
export function deleteContentProject(database: DatabaseSync, input: { projectId: string; expectedRevision: number }, transaction = true): CommandResult<{ id: string }> {
  const current = getContentProject(database, input.projectId);
  if (!current) return failure('NOT_FOUND', '内容项目不存在。');
  if (current.revision !== input.expectedRevision) return failure('REVISION_CONFLICT', '内容项目已更新,请重新加载。', { current });
  const platformVersions = Number((database.prepare('SELECT COUNT(*) AS count FROM platform_versions WHERE project_id = ?').get(input.projectId) as { count: number }).count);
  if (platformVersions > 0) return failure('HAS_PLATFORM_VERSIONS', '项目已有平台版本,不能删除;可以归档。');
  const contextUses = Number((database.prepare('SELECT COUNT(*) AS count FROM knowledge_context_uses WHERE content_project_id = ?').get(input.projectId) as { count: number }).count);
  if (contextUses > 0) return failure('HAS_CONTEXT_USES', '项目已被 Pi 上下文引用,不能删除;可以归档。');
  const canvasRefs = Number((database.prepare("SELECT COUNT(*) AS count FROM knowledge_canvas_nodes WHERE object_type = 'content_project' AND object_id = ?").get(input.projectId) as { count: number }).count);
  if (canvasRefs > 0) return failure('HAS_CANVAS_REFS', '项目已被关系画布引用,不能删除;可以归档。');
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('DELETE FROM content_project_sources WHERE project_id = ?').run(input.projectId);
    database.prepare('DELETE FROM content_notes WHERE project_id = ?').run(input.projectId);
    database.prepare('DELETE FROM content_decisions WHERE project_id = ?').run(input.projectId);
    database.prepare('DELETE FROM content_versions WHERE project_id = ?').run(input.projectId);
    database.prepare('DELETE FROM content_project_context_packages WHERE project_id = ?').run(input.projectId);
    database.prepare('DELETE FROM creative_brief_projects WHERE project_id = ?').run(input.projectId);
    database.prepare('DELETE FROM studio_annotations WHERE project_id = ?').run(input.projectId);
    database.prepare('DELETE FROM content_projects WHERE id = ?').run(input.projectId);
    if (transaction) database.exec('COMMIT');
    return success({ id: input.projectId });
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function savePlatformVersion(
  database: DatabaseSync,
  input: {
    projectId: string; contentVersionId: string; platform: 'x' | 'xiaohongshu' | 'wechat' | 'zhihu'; format: string; title?: string;
    body: string; assetIds?: string[]; expectedRevision?: number; id?: string;
    mediaBindings?: PlatformMediaBindingDraft[];
    /** 裁切载荷（IPC 层在事务前 stage 好的字节）；本函数在事务内原子注册 asset + provenance + 绑定。 */
    stagedCrops?: StagedCrop[];
    /** WMB-5246 视频 Clip 载荷（IPC 层事务前经 stageClipAsset 完成文件工作）；事务内原子注册派生 asset + 血缘 + 绑定回填。 */
    stagedClips?: StagedClipSave[];
    /** 与第三位参数等效的事务开关（调用方可任选其一；dispatcher 路径两者均缺省 → 复用外部事务）。 */
    transaction?: boolean;
  },
  transaction = false
): CommandResult<SavedPlatformVersion> {
  const useOwnTransaction = transaction === true || input.transaction === true;
  const now = new Date().toISOString();
  // 裁剪物化：同事务注册派生 asset（sha256 去重）+ derived_crop provenance（幂等）。
  const materializeCrops = (platformVersionId: string): Map<string, string> => {
    const materialized = new Map<string, string>();
    for (const crop of input.stagedCrops ?? []) {
      const registered = registerStagedAsset(database, crop.staged);
      insertDerivedCropProvenance(database, {
        sourceAssetId: crop.sourceAssetId,
        derivedAssetId: registered.id,
        cropRegion: crop.cropRegion,
        width: crop.staged.width,
        height: crop.staged.height,
        origin: `platform-crop:${platformVersionId}`,
        requestId: null
      });
      materialized.set(cropRegionKey(crop.sourceAssetId, crop.cropRegion), registered.id);
    }
    return materialized;
  };
  // WMB-5246 视频 Clip 物化：同事务注册派生 asset + derived_clip/derived_transcode 血缘（幂等），
  // 键 = clipKey(sourceAssetId, startMs, endMs)；绑定侧据此回填 derivedAssetId（发布投影取派生）。
  const materializeClips = (platformVersionId: string): Map<string, ClipDerivationResult> => {
    const materialized = new Map<string, ClipDerivationResult>();
    for (const clip of input.stagedClips ?? []) {
      const result = commitClipDerivation(database, clip.staged, {
        sourceAssetId: clip.sourceAssetId,
        startMs: clip.startMs,
        endMs: clip.endMs,
        origin: `platform-clip:${platformVersionId}`,
        requestId: null,
        mode: clip.copyOrTranscode,
        codec: clip.codec,
        runtimeName: clip.runtimeName ?? null,
        runtimeVersion: clip.runtimeVersion ?? null
      });
      materialized.set(clipKey(clip.sourceAssetId, clip.startMs, clip.endMs), result);
    }
    return materialized;
  };
  // 平台绑定草稿解析：显式 mediaBindings（规范化）或按 assetIds/现有绑定/正文引用缺省重建（绝不静默清空）。
  const resolveDrafts = (platformVersionId: string | null): PlatformMediaBindingDraft[] => {
    const drafts = input.mediaBindings !== undefined
      ? normalizePlatformMediaBindings(input.mediaBindings)
      : reconcilePlatformBindingDrafts(database, { platformVersionId, platform: input.platform, assetIds: input.assetIds, body: input.body });
    if (drafts.length > 0 && (input.stagedCrops?.length ?? 0) > 0) {
      const materialized = materializeCrops(platformVersionId ?? 'pending');
      for (const draft of drafts) {
        if (draft.cropRegion && !draft.derivedAssetId) {
          const derivedAssetId = materialized.get(cropRegionKey(draft.assetId, draft.cropRegion));
          if (derivedAssetId) draft.derivedAssetId = derivedAssetId;
        }
      }
    }
    // WMB-5246 视频 Clip：用户接受的 clipRange 在保存事务内物化派生 asset（先删后插前完成），
    // 绑定 derivedAssetId 回填为 clip asset，asset_ids_json 投影自然取派生（发布即片段）。
    if (drafts.length > 0 && (input.stagedClips?.length ?? 0) > 0) {
      const materialized = materializeClips(platformVersionId ?? 'pending');
      for (const draft of drafts) {
        if (draft.mediaKind === 'video' && draft.clipRange && !draft.derivedAssetId) {
          const result = materialized.get(clipKey(draft.assetId, draft.clipRange.startMs, draft.clipRange.endMs));
          if (result) {
            draft.derivedAssetId = result.assetId;
            draft.durationMs = result.durationMs;
          }
        }
      }
    }
    // X 平台单图发布边界：封面必须位于 ordinal 0（适配器只携带 assets[0]）。
    if (input.platform === 'x') {
      const coverIndex = drafts.findIndex((draft) => draft.isCover);
      if (coverIndex > 0) throw new Error('X 平台封面必须位于第一张图（ordinal 0）。');
    }
    return drafts;
  };
  if (!input.id) {
    const id = randomUUID();
    if (useOwnTransaction) database.exec('BEGIN IMMEDIATE');
    try {
      const drafts = resolveDrafts(id);
      database.prepare('INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(id, input.projectId, input.contentVersionId, input.platform, input.format, input.title ?? null, input.body,
          JSON.stringify(buildAssetIdsFromPlatformBindings(drafts)), now, now);
      // WMB-5237：平台绑定与版本同事务（replace 语义），asset_ids_json 投影同事务重建。
      replacePlatformMediaBindings(database, id, drafts, now);
      // WMB-5215：平台版本与 usage 包同一事务；换基/usage 失败整体回滚（协议 §10）。
      recordPlatformUsage(database, { platformVersionId: id, projectId: input.projectId, contentVersionId: input.contentVersionId, platform: input.platform, format: input.format, reason: 'platform_version_create' });
      if (useOwnTransaction) database.exec('COMMIT');
    } catch (error) {
      if (useOwnTransaction) database.exec('ROLLBACK');
      throw error;
    }
    return success({ id, revision: 1 });
  }
  if (useOwnTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.prepare('SELECT revision, platform, body, content_version_id AS contentVersionId, project_id AS projectId FROM platform_versions WHERE id = ?').get(input.id) as { revision: number; platform: 'x' | 'xiaohongshu' | 'wechat' | 'zhihu'; body: string; contentVersionId: string; projectId: string } | undefined;
    if (!current) {
      if (useOwnTransaction) database.exec('ROLLBACK');
      return failure('NOT_FOUND', '平台版本不存在。');
    }
    if (input.expectedRevision !== current.revision) {
      if (useOwnTransaction) database.exec('ROLLBACK');
      return failure('REVISION_CONFLICT', '平台版本已更新，请重新加载。', { currentRevision: current.revision });
    }
    const drafts = resolveDrafts(input.id);
    database.prepare('UPDATE platform_versions SET content_version_id=?, platform=?, format=?, title=?, body=?, asset_ids_json=?, updated_at=?, revision=? WHERE id=?')
      .run(input.contentVersionId, input.platform, input.format, input.title ?? null, input.body,
        JSON.stringify(buildAssetIdsFromPlatformBindings(drafts)), now, current.revision + 1, input.id);
    // WMB-5237：平台绑定与 asset_ids_json 投影同事务更新（发布管线继续消费投影）。
    replacePlatformMediaBindings(database, input.id, drafts, now);
    // WMB-5207: 批注迁移与平台正文保存同一事务（IPC/MCP 路径由 dispatcher 提供事务；直接调用可传 transaction=true）。
    migrateAnnotationsForPlatformSave(database, {
      scope: { projectId: current.projectId, documentKind: 'platform', documentId: input.id, platform: input.platform },
      previousBody: current.body,
      nextBody: input.body
    });
    // WMB-5215：更新未换基则血缘已固定；换基（事实变化）由 recordPlatformUsage 拒绝并回滚。
    recordPlatformUsage(database, { platformVersionId: input.id, projectId: input.projectId, contentVersionId: input.contentVersionId, platform: input.platform, format: input.format, existingContentVersionId: current.contentVersionId, reason: 'platform_version_update' });
    if (useOwnTransaction) database.exec('COMMIT');
    return success({ id: input.id, revision: current.revision + 1 });
  } catch (error) {
    if (useOwnTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function getStudio(database: DatabaseSync): Array<{
  id: string;
  title: string;
  revision: number;
  revisions: Array<{ id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai' }>;
  platforms: Record<string, Array<{ id: string; title: string | null; body: string; revision: number; assets: string[] }>>;
}> {
  const projects = database.prepare('SELECT id, title, revision FROM content_projects ORDER BY updated_at DESC').all() as Array<{ id: string; title: string; revision: number }>;
  return projects.map((project) => {
    const revisions = database.prepare(`SELECT id, version_number AS number, body, created_at AS createdAt, COALESCE(author, 'ai') AS author
      FROM content_versions WHERE project_id = ? ORDER BY version_number DESC`).all(project.id) as Array<{ id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai' }>;
    const versions = database.prepare('SELECT id, platform, title, body, revision, asset_ids_json AS assets FROM platform_versions WHERE project_id = ? ORDER BY updated_at DESC').all(project.id) as Array<{ id: string; platform: string; title: string | null; body: string; revision: number; assets: string }>;
    const platforms: Record<string, Array<{ id: string; title: string | null; body: string; revision: number; assets: string[]; mediaBindings: PlatformMediaBinding[] }>> = { x: [], xiaohongshu: [], wechat: [] };
    for (const version of versions) platforms[version.platform]?.push({ ...version, assets: JSON.parse(version.assets), mediaBindings: readPlatformMediaBindings(database, version.id) });
    return { ...project, revisions, platforms };
  });
}
