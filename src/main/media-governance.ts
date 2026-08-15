// WMB-5247：情报媒体治理 —— 引用集 / 删除门 / staging 清理 / 派生缓存 GC / 容量投影。
// 只读计算 + 幂等清理；除 GC 的 DB 删除外，写面全部经既有 dispatcher 授权命令。
// 引用类别即设计 §14 完整引用集：任何一类存在引用，Asset 都不可清理；删除 Source 前必须
// 先读取本模块的引用摘要，有外部引用则阻止普通删除并要求显式确认。
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MEDIA_LIMITS_DEFAULT } from '../shared/media-limits.ts';
import { recordOperation } from './operations.ts';

// ---------------------------------------------------------------------------
// 分类与路径常量
// ---------------------------------------------------------------------------

/** 派生 asset 的 provenance kind（设计 §6.5）：GC 只候选这一类；原始/生成永不自动清理。 */
export const MEDIA_DERIVED_KINDS = [
  'derived_crop', 'derived_annotation', 'derived_keyframe', 'derived_clip', 'derived_transcode'
] as const;
export type MediaDerivedKind = (typeof MEDIA_DERIVED_KINDS)[number];

/** 下载 staging 相对 dataRoot 目录（ArchiveWorker 契约：<dataRoot>/staging/media/）。 */
export const MEDIA_STAGING_RELATIVE_DIR = 'staging/media';
/** staging 临时文件后缀（下载完成前一律 .part；只有此形态可安全清理）。 */
export const MEDIA_STAGING_PART_SUFFIX = '.part';
/** assets 目录崩溃遗留临时文件后缀（persistAssetBytes 的 .tmp 中间文件）。 */
export const MEDIA_TEMP_SUFFIX = '.tmp';
/** staging/临时文件保留窗口（默认 24h；进行中的下载远小于此）。 */
export const MEDIA_STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/** 引用类别（设计 §14 完整引用集；每类都阻止清理/删除）。 */
export type AssetReferenceClass =
  | 'source_binding'
  | 'content_binding'
  | 'platform_binding'
  | 'publication_snapshot'
  | 'project_link'
  | 'provenance'
  | 'video_run'
  | 'image_run'
  | 'evidence_locator';

export type AssetReference = Readonly<{
  class: AssetReferenceClass;
  table: string;
  rowId: string;
  detail?: string;
}>;

export const ASSET_REFERENCE_CLASSES: readonly AssetReferenceClass[] = [
  'source_binding', 'content_binding', 'platform_binding', 'publication_snapshot',
  'project_link', 'provenance', 'video_run', 'image_run', 'evidence_locator'
];

const DERIVED_KIND_PLACEHOLDERS = MEDIA_DERIVED_KINDS.map(() => '?').join(',');

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

// ---------------------------------------------------------------------------
// locator / 运行 JSON 解析（fail-open：解析不了则不贡献该行引用，列引用仍然有效）
// ---------------------------------------------------------------------------

/**
 * 从证据 locator 提取 assetId：`asset:<assetId>|sourceRevision:<rev>`（图片整图/区域）
 * 与 `asset:<assetId>|sourceRevision:<rev>|timeRange:<s>-<e>`（视频时间段）均兼容；
 * 首段必须是 `asset:` 且 id 非空；格式非法返回 null（严格，绝不猜测）。
 */
export function assetIdFromEvidenceLocator(locator: string): string | null {
  if (!locator || typeof locator !== 'string') return null;
  const first = locator.split('|')[0] ?? '';
  if (!first.startsWith('asset:')) return null;
  const assetId = first.slice('asset:'.length);
  return assetId && !assetId.includes('|') ? assetId : null;
}

/** 递归收集运行 JSON 中的 Asset id 字段（keyframes_json.frames[].assetId / segments[].keyframeAssetId 等）。 */
function collectRunAssetIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRunAssetIds(item, ids);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if ((key === 'assetId' || key === 'keyframeAssetId' || key === 'posterAssetId') && typeof entry === 'string' && entry) {
      ids.add(entry);
    } else {
      collectRunAssetIds(entry, ids);
    }
  }
}

function assetIdsFromJsonText(jsonText: string | null): Set<string> {
  const ids = new Set<string>();
  if (!jsonText) return ids;
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    return ids;
  }
  collectRunAssetIds(value, ids);
  return ids;
}

// ---------------------------------------------------------------------------
// 证据 locator 引用（knowledge_evidence_links.locator → assetId）
// ---------------------------------------------------------------------------

function evidenceLocatorAssetIds(database: DatabaseSync): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!tableExists(database, 'knowledge_evidence_links')) return map;
  const rows = database.prepare("SELECT id, locator FROM knowledge_evidence_links WHERE locator IS NOT NULL AND locator LIKE 'asset:%'").all() as Array<{
    id: string; locator: string;
  }>;
  for (const row of rows) {
    const assetId = assetIdFromEvidenceLocator(row.locator);
    if (!assetId) continue;
    const list = map.get(assetId);
    if (list) list.push(row.id);
    else map.set(assetId, [row.id]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 视频理解运行引用（video_understanding_runs.asset_id + 关键帧/段 JSON）
// ---------------------------------------------------------------------------

function videoRunAssetIds(database: DatabaseSync): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!tableExists(database, 'video_understanding_runs')) return map;
  const rows = database.prepare('SELECT id, asset_id AS assetId, keyframes_json AS keyframesJson, segments_json AS segmentsJson FROM video_understanding_runs').all() as Array<{
    id: string; assetId: string; keyframesJson: string | null; segmentsJson: string | null;
  }>;
  const add = (assetId: string, runId: string) => {
    if (!assetId) return;
    const list = map.get(assetId);
    if (list) list.push(runId);
    else map.set(assetId, [runId]);
  };
  for (const row of rows) {
    add(row.assetId, row.id);
    for (const id of assetIdsFromJsonText(row.keyframesJson)) add(id, row.id);
    for (const id of assetIdsFromJsonText(row.segmentsJson)) add(id, row.id);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 单 Asset 完整引用清单（设计 §14：每类引用都保护 Asset）
// ---------------------------------------------------------------------------

/**
 * 计算单个 asset 的完整引用清单。`excludeSourceId`：删除门用——排除该 Source 自身的
 * source_media_bindings 行（它们随 Source 关系删除而消亡，不构成外部引用）。
 */
export function assetReferences(database: DatabaseSync, assetId: string, options: { excludeSourceId?: string } = {}): AssetReference[] {
  const refs: AssetReference[] = [];
  const exclude = options.excludeSourceId;

  if (tableExists(database, 'source_media_bindings')) {
    const rows = (exclude
      ? database.prepare('SELECT id, source_id AS sourceId FROM source_media_bindings WHERE asset_id=? AND source_id<>?').all(assetId, exclude)
      : database.prepare('SELECT id FROM source_media_bindings WHERE asset_id=?').all(assetId)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      refs.push({ class: 'source_binding', table: 'source_media_bindings', rowId: String(row.id), detail: exclude ? `source=${String(row.sourceId)}` : undefined });
    }
  }
  if (tableExists(database, 'content_media_bindings')) {
    for (const row of database.prepare('SELECT id FROM content_media_bindings WHERE asset_id=?').all(assetId) as Array<{ id: string }>) {
      refs.push({ class: 'content_binding', table: 'content_media_bindings', rowId: row.id });
    }
  }
  if (tableExists(database, 'platform_media_bindings')) {
    const rows = database.prepare(
      'SELECT id, asset_id AS assetId, derived_asset_id AS derivedAssetId, poster_asset_id AS posterAssetId FROM platform_media_bindings WHERE asset_id=? OR derived_asset_id=? OR poster_asset_id=?'
    ).all(assetId, assetId, assetId) as Array<{ id: string; assetId: string | null; derivedAssetId: string | null; posterAssetId: string | null }>;
    for (const row of rows) {
      const where = row.assetId === assetId ? 'asset_id' : row.derivedAssetId === assetId ? 'derived_asset_id' : 'poster_asset_id';
      refs.push({ class: 'platform_binding', table: 'platform_media_bindings', rowId: row.id, detail: where });
    }
  }
  if (tableExists(database, 'publication_snapshots')) {
    const rows = database.prepare('SELECT DISTINCT ps.id FROM publication_snapshots ps, json_each(ps.assets_json) AS j WHERE j.value=?').all(assetId) as Array<{ id: string }>;
    for (const row of rows) refs.push({ class: 'publication_snapshot', table: 'publication_snapshots', rowId: row.id });
  }
  if (tableExists(database, 'content_project_assets')) {
    for (const row of database.prepare('SELECT project_id AS projectId FROM content_project_assets WHERE asset_id=?').all(assetId) as Array<{ projectId: string }>) {
      refs.push({ class: 'project_link', table: 'content_project_assets', rowId: row.projectId });
    }
  }
  if (tableExists(database, 'asset_provenance')) {
    // 派生血缘：作为其他行的 source 端（被派生）或非自身身份行的 derived 端。自身 identity 行不保护自己。
    const rows = database.prepare(
      'SELECT id, source_asset_id AS sourceAssetId, derived_asset_id AS derivedAssetId FROM asset_provenance WHERE source_asset_id=? OR (derived_asset_id=? AND asset_id<>?)'
    ).all(assetId, assetId, assetId) as Array<{ id: string; sourceAssetId: string | null; derivedAssetId: string | null }>;
    for (const row of rows) {
      const end = row.sourceAssetId === assetId ? 'source' : 'derived';
      refs.push({ class: 'provenance', table: 'asset_provenance', rowId: row.id, detail: end });
    }
  }
  if (tableExists(database, 'knowledge_visual_runs')) {
    for (const row of database.prepare('SELECT id FROM knowledge_visual_runs WHERE asset_id=?').all(assetId) as Array<{ id: string }>) {
      refs.push({ class: 'image_run', table: 'knowledge_visual_runs', rowId: row.id });
    }
  }
  const videoMap = videoRunAssetIds(database);
  for (const runId of videoMap.get(assetId) ?? []) {
    refs.push({ class: 'video_run', table: 'video_understanding_runs', rowId: runId });
  }
  const evidenceMap = evidenceLocatorAssetIds(database);
  for (const linkId of evidenceMap.get(assetId) ?? []) {
    refs.push({ class: 'evidence_locator', table: 'knowledge_evidence_links', rowId: linkId });
  }
  return refs;
}

/**
 * 完整受保护集合（所有引用类别并集）：GC 判定“无任何引用”的唯一依据。
 * 派生资产自身的 provenance identity 行不保护自己（它只是分类记录）。
 */
export function collectProtectedAssetIds(database: DatabaseSync): Set<string> {
  const protectedIds = new Set<string>();
  const addAll = (ids: Iterable<string>) => {
    for (const id of ids) if (id) protectedIds.add(id);
  };
  if (tableExists(database, 'source_media_bindings')) {
    addAll((database.prepare('SELECT asset_id AS id FROM source_media_bindings').all() as Array<{ id: string }>).map((r) => r.id));
  }
  if (tableExists(database, 'content_media_bindings')) {
    addAll((database.prepare('SELECT asset_id AS id FROM content_media_bindings').all() as Array<{ id: string }>).map((r) => r.id));
  }
  if (tableExists(database, 'platform_media_bindings')) {
    const rows = database.prepare('SELECT asset_id AS a, derived_asset_id AS d, poster_asset_id AS p FROM platform_media_bindings').all() as Array<{ a: string; d: string | null; p: string | null }>;
    for (const row of rows) {
      addAll([row.a, row.d ?? '', row.p ?? '']);
    }
  }
  if (tableExists(database, 'publication_snapshots')) {
    const rows = database.prepare('SELECT DISTINCT j.value AS id FROM publication_snapshots, json_each(publication_snapshots.assets_json) AS j').all() as Array<{ id: string }>;
    addAll(rows.map((r) => r.id));
  }
  if (tableExists(database, 'content_project_assets')) {
    addAll((database.prepare('SELECT asset_id AS id FROM content_project_assets').all() as Array<{ id: string }>).map((r) => r.id));
  }
  if (tableExists(database, 'asset_provenance')) {
    const rows = database.prepare('SELECT source_asset_id AS s, derived_asset_id AS d, asset_id AS a FROM asset_provenance').all() as Array<{ s: string | null; d: string | null; a: string }>;
    for (const row of rows) {
      if (row.s) protectedIds.add(row.s);
      if (row.d && row.d !== row.a) protectedIds.add(row.d);
    }
  }
  if (tableExists(database, 'knowledge_visual_runs')) {
    addAll((database.prepare('SELECT asset_id AS id FROM knowledge_visual_runs').all() as Array<{ id: string }>).map((r) => r.id));
  }
  addAll(videoRunAssetIds(database).keys());
  addAll(evidenceLocatorAssetIds(database).keys());
  return protectedIds;
}

// ---------------------------------------------------------------------------
// Asset 分类（设置页原始/派生口径；GC 只候选派生）
// ---------------------------------------------------------------------------

export type AssetKind = 'derived' | 'original';

/** 派生 = 存在任一派生 kind 的 provenance 行；其余（含无 provenance 行、imported、generated）一律 original。 */
export function classifyAssetKind(database: DatabaseSync, assetId: string): AssetKind {
  if (!tableExists(database, 'asset_provenance')) return 'original';
  const row = database.prepare(
    `SELECT 1 AS hit FROM asset_provenance WHERE asset_id=? AND kind IN (${DERIVED_KIND_PLACEHOLDERS}) LIMIT 1`
  ).get(assetId, ...MEDIA_DERIVED_KINDS) as { hit: number } | undefined;
  return row ? 'derived' : 'original';
}

export function isDerivedAsset(database: DatabaseSync, assetId: string): boolean {
  return classifyAssetKind(database, assetId) === 'derived';
}

// ---------------------------------------------------------------------------
// Source 删除门：预删除引用摘要 + 阻止普通删除（设计 §13）
// ---------------------------------------------------------------------------

export type SourceAssetReferenceSummary = Readonly<{
  sourceId: string;
  assets: ReadonlyArray<Readonly<{ assetId: string; references: readonly AssetReference[] }>>;
  totalReferences: number;
  byClass: Readonly<Record<AssetReferenceClass, number>>;
}>;

/** 删除 Source 前的引用摘要：Source 自身绑定之外的外部引用清单。 */
export function sourceAssetReferenceSummary(database: DatabaseSync, sourceId: string): SourceAssetReferenceSummary {
  const byClass: Record<AssetReferenceClass, number> = Object.fromEntries(ASSET_REFERENCE_CLASSES.map((c) => [c, 0])) as Record<AssetReferenceClass, number>;
  const assets: Array<{ assetId: string; references: readonly AssetReference[] }> = [];
  let total = 0;
  if (tableExists(database, 'source_media_bindings')) {
    const rows = database.prepare('SELECT DISTINCT asset_id AS assetId FROM source_media_bindings WHERE source_id=?').all(sourceId) as Array<{ assetId: string }>;
    for (const row of rows) {
      const references = assetReferences(database, row.assetId, { excludeSourceId: sourceId });
      for (const ref of references) byClass[ref.class] += 1;
      total += references.length;
      assets.push(Object.freeze({ assetId: row.assetId, references: Object.freeze(references) }));
    }
  }
  return Object.freeze({ sourceId, assets: Object.freeze(assets), totalReferences: total, byClass: Object.freeze(byClass) });
}

export type SourceDeleteGateResult = Readonly<{
  allowed: boolean;
  summary: SourceAssetReferenceSummary;
  blockedReason?: string;
}>;

/**
 * 删除门：有外部 Asset 引用时阻止普通删除；`forceReferencedDelete` 仅表示用户显式确认
 * “仍删除 Source 关系”，绝不删除 Asset 字节（字节由 GC 引用集另行保护）。
 */
export function sourceDeleteGate(
  database: DatabaseSync,
  sourceId: string,
  options: { forceReferencedDelete?: boolean } = {}
): SourceDeleteGateResult {
  const summary = sourceAssetReferenceSummary(database, sourceId);
  if (summary.totalReferences === 0 || options.forceReferencedDelete === true) {
    return { allowed: true, summary };
  }
  return {
    allowed: false,
    summary,
    blockedReason: `SOURCE_DELETE_BLOCKED_REFERENCED_ASSETS:${summary.totalReferences}`
  };
}

// ---------------------------------------------------------------------------
// staging / 临时文件清理（M1；幂等、data-root 隔离）
// ---------------------------------------------------------------------------

export type StagingCleanupResult = Readonly<{
  removedFiles: number;
  removedBytes: number;
  skippedFresh: number;
  errors: readonly string[];
  dryRun: boolean;
}>;

/**
 * M1 staging 清理：删除 <dataRoot>/staging/media/*.part（超保留窗口）与
 * <dataRoot>/assets/*.tmp（崩溃遗留中间文件，超保留窗口）。只删指定目录内、指定后缀的文件；
 * 绝不触碰 assets/ 内容寻址字节。幂等：再次运行无剩余可删项。
 */
export async function runStagingCleanup(
  dataRoot: string,
  options: { now?: Date; maxStaleMs?: number; dryRun?: boolean } = {}
): Promise<StagingCleanupResult> {
  const now = options.now ?? new Date();
  const maxStaleMs = options.maxStaleMs ?? MEDIA_STALE_TEMP_MS;
  const dryRun = options.dryRun === true;
  let removedFiles = 0;
  let removedBytes = 0;
  let skippedFresh = 0;
  const errors: string[] = [];
  const stagingDir = path.join(dataRoot, MEDIA_STAGING_RELATIVE_DIR);
  const assetsDir = path.join(dataRoot, 'assets');

  const cleanDir = async (directory: string, suffix: string) => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const filePath = path.join(directory, entry);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(filePath)).mtimeMs;
      } catch (error) {
        errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (now.getTime() - mtimeMs <= maxStaleMs) {
        skippedFresh += 1;
        continue;
      }
      let byteCount = 0;
      try {
        byteCount = (await stat(filePath)).size;
      } catch {
        // 删除前尽力取字节；取不到按 0 计。
      }
      if (!dryRun) {
        try {
          await rm(filePath, { force: true });
        } catch (error) {
          errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }
      removedFiles += 1;
      removedBytes += byteCount;
    }
  };

  await cleanDir(stagingDir, MEDIA_STAGING_PART_SUFFIX);
  await cleanDir(assetsDir, MEDIA_TEMP_SUFFIX);
  return Object.freeze({ removedFiles, removedBytes, skippedFresh, errors: Object.freeze(errors), dryRun });
}

// ---------------------------------------------------------------------------
// 30 天无引用派生缓存 GC（M4；幂等、data-root 隔离；原始/已采用派生永不自动清理）
// ---------------------------------------------------------------------------

export type DerivedGcCandidate = Readonly<{
  assetId: string;
  relativePath: string;
  byteCount: number;
  createdAt: string;
}>;

export type MediaGcPlan = Readonly<{
  dataRoot: string;
  retentionDays: number;
  cutoff: string;
  derivedTotal: number;
  protectedCount: number;
  freshCount: number;
  candidates: readonly DerivedGcCandidate[];
}>;

/**
 * 规划 GC：派生资产 + 无任何引用 + created_at 早于保留窗口 → 候选。
 * 原始 Source Asset、generated、无 provenance 行资产、被任一引用类别的资产一律不是候选。
 */
export function planDerivedCacheGc(
  database: DatabaseSync,
  dataRoot: string,
  options: { now?: Date; retentionDays?: number } = {}
): MediaGcPlan {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? MEDIA_LIMITS_DEFAULT.derivedCacheRetentionDays;
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const protectedIds = collectProtectedAssetIds(database);
  let derivedTotal = 0;
  let freshCount = 0;
  const candidates: DerivedGcCandidate[] = [];
  if (tableExists(database, 'asset_provenance')) {
    const rows = database.prepare(
      `SELECT a.id AS assetId, a.relative_path AS relativePath, a.byte_count AS byteCount, a.created_at AS createdAt
       FROM assets a
       WHERE EXISTS (
         SELECT 1 FROM asset_provenance p WHERE p.asset_id = a.id AND p.kind IN (${DERIVED_KIND_PLACEHOLDERS})
       )
       ORDER BY a.created_at`
    ).all(...MEDIA_DERIVED_KINDS) as Array<{ assetId: string; relativePath: string; byteCount: number; createdAt: string }>;
    for (const row of rows) {
      derivedTotal += 1;
      if (row.createdAt >= cutoff) {
        freshCount += 1;
        continue;
      }
      if (protectedIds.has(row.assetId)) continue;
      candidates.push(Object.freeze({ assetId: row.assetId, relativePath: row.relativePath, byteCount: Number(row.byteCount), createdAt: row.createdAt }));
    }
  }
  return Object.freeze({
    dataRoot,
    retentionDays,
    cutoff,
    derivedTotal,
    protectedCount: protectedIds.size,
    freshCount,
    candidates: Object.freeze(candidates)
  });
}

export type MediaGcResult = MediaGcPlan & Readonly<{
  dryRun: boolean;
  collected: readonly DerivedGcCandidate[];
  errors: ReadonlyArray<Readonly<{ assetId: string; message: string }>>;
  removedBytes: number;
}>;

/**
 * 同步 DB 删除（dispatcher 命令 execute 内调用；SAVEPOINT 可嵌套）。
 * 先删 provenance identity 行，再删 asset 行；每资产独立 SAVEPOINT，失败只记错不中断。
 */
export function executeDerivedCacheGc(
  database: DatabaseSync,
  plan: MediaGcPlan,
  requestId: string
): { deleted: DerivedGcCandidate[]; errors: Array<{ assetId: string; message: string }> } {
  const deleted: DerivedGcCandidate[] = [];
  const errors: Array<{ assetId: string; message: string }> = [];
  const deleteProvenance = database.prepare('DELETE FROM asset_provenance WHERE asset_id=?');
  const deleteAsset = database.prepare('DELETE FROM assets WHERE id=?');
  for (const candidate of plan.candidates) {
    database.exec('SAVEPOINT media_gc_asset');
    try {
      deleteProvenance.run(candidate.assetId);
      const removed = deleteAsset.run(candidate.assetId);
      if (!removed.changes) throw new Error('ASSET_NOT_FOUND');
      database.exec('RELEASE media_gc_asset');
      recordOperation(database, {
        actorType: 'scheduler',
        clientLabel: 'derived-cache-gc',
        command: 'media.gc',
        entityType: 'asset',
        entityId: candidate.assetId,
        result: 'ok'
      });
      deleted.push(candidate);
    } catch (error) {
      try {
        database.exec('ROLLBACK TO media_gc_asset');
        database.exec('RELEASE media_gc_asset');
      } catch {
        // 回滚窗口已失效（外层事务终止）→ 保留原始错误继续抛出
      }
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ assetId: candidate.assetId, message });
      recordOperation(database, {
        actorType: 'scheduler',
        clientLabel: 'derived-cache-gc',
        command: 'media.gc',
        entityType: 'asset',
        entityId: candidate.assetId,
        result: 'error',
        errorCode: message
      });
    }
  }
  return { deleted, errors };
}

/**
 * data-root 隔离的物理文件定位：只允许删除 <dataRoot>/assets/ 下的内容寻址文件；
 * relative_path 解析后越界（../、绝对路径、其他目录）一律返回 null，绝不删除。
 */
export function resolveAssetFileWithinDataRoot(dataRoot: string, relativePath: string): string | null {
  const assetsRoot = path.resolve(dataRoot, 'assets') + path.sep;
  const resolved = path.resolve(dataRoot, relativePath);
  return resolved.startsWith(assetsRoot) ? resolved : null;
}

/** 独立 GC 入口（测试 / 启动 / 设置页）：plan → DB 删除 → 物理文件删除，幂等且 data-root 隔离。 */
export async function runDerivedCacheGc(
  database: DatabaseSync,
  dataRoot: string,
  options: { now?: Date; retentionDays?: number; dryRun?: boolean; requestId?: string } = {}
): Promise<MediaGcResult> {
  const dryRun = options.dryRun === true;
  const plan = planDerivedCacheGc(database, dataRoot, { now: options.now, retentionDays: options.retentionDays });
  const errors: Array<{ assetId: string; message: string }> = [];
  const collected: DerivedGcCandidate[] = [];
  let removedBytes = 0;
  if (!dryRun) {
    const executed = executeDerivedCacheGc(database, plan, options.requestId ?? `media-gc:${new Date().toISOString()}`);
    collected.push(...executed.deleted);
    errors.push(...executed.errors);
    for (const candidate of executed.deleted) {
      const filePath = resolveAssetFileWithinDataRoot(dataRoot, candidate.relativePath);
      if (!filePath) {
        errors.push({ assetId: candidate.assetId, message: 'relative_path 越界，文件未删除' });
        continue;
      }
      try {
        await rm(filePath, { force: true });
        removedBytes += candidate.byteCount;
      } catch (error) {
        errors.push({ assetId: candidate.assetId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return Object.freeze({
    ...plan,
    dryRun,
    collected: Object.freeze(collected.map((c) => Object.freeze(c))),
    errors: Object.freeze(errors.map((e) => Object.freeze(e))),
    removedBytes
  });
}

// ---------------------------------------------------------------------------
// 容量投影（设置页：数量/字节按原始/派生/staging 如实报告；设计 §14）
// ---------------------------------------------------------------------------

export type MediaAssetStorageReport = Readonly<{
  assets: {
    total: { count: number; bytes: number };
    original: { count: number; bytes: number };
    derived: { count: number; bytes: number };
  };
}>;

/** 资产数量/字节（SQLite 为真源：byte_count 与不可变字节一致）。 */
export function mediaAssetStorageReport(database: DatabaseSync): MediaAssetStorageReport {
  const totalRow = database.prepare('SELECT count(*) AS count, coalesce(sum(byte_count), 0) AS bytes FROM assets').get() as { count: number; bytes: number };
  let derived = { count: 0, bytes: 0 };
  if (tableExists(database, 'asset_provenance')) {
    derived = database.prepare(
      `SELECT count(*) AS count, coalesce(sum(a.byte_count), 0) AS bytes
       FROM assets a
       WHERE EXISTS (SELECT 1 FROM asset_provenance p WHERE p.asset_id = a.id AND p.kind IN (${DERIVED_KIND_PLACEHOLDERS}))`
    ).get(...MEDIA_DERIVED_KINDS) as { count: number; bytes: number };
  }
  const total = { count: Number(totalRow.count), bytes: Number(totalRow.bytes) };
  return Object.freeze({
    assets: Object.freeze({
      total: Object.freeze(total),
      original: Object.freeze({ count: total.count - Number(derived.count), bytes: total.bytes - Number(derived.bytes) }),
      derived: Object.freeze({ count: Number(derived.count), bytes: Number(derived.bytes) })
    })
  });
}

export type MediaStagingStorageReport = Readonly<{ count: number; bytes: number }>;

/** staging 数量/字节（文件系统实测；目录不存在按 0 如实报告）。 */
export async function mediaStagingStorageReport(dataRoot: string): Promise<MediaStagingStorageReport> {
  const directory = path.join(dataRoot, MEDIA_STAGING_RELATIVE_DIR);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ count: 0, bytes: 0 });
    throw error;
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.endsWith(MEDIA_STAGING_PART_SUFFIX)) continue;
    count += 1;
    try {
      bytes += (await stat(path.join(directory, entry))).size;
    } catch {
      // 竞态删除按 0 字节计入（数量仍如实）。
    }
  }
  return Object.freeze({ count, bytes });
}