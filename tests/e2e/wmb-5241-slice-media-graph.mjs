// WMB-5241 切片（AcceptMediaGraphCreation）：图片来源/视觉结论、Studio 媒体绑定、知识图谱/关系画布、
// 创作血缘与人工发布边界 —— 同一真实工作空间（unified data-root）的最终验收断言。
//
// 交付契约（由 unified 场景文件挂接；本文件不写统一场景，避免双写冲突）：
//   1) runVisualSourceLineage(dataRoot, workspaceId) —— 写侧挂接函数：在窗口 A（应用已关闭）内用
//      生产视觉管线（ensureSourceImageAsset → enqueueVisualRun → executeVisualRun → compileVisualRunKnowledge）
//      对同一 data-root 跑真实全链路；确定性模型缝（与 WMB-5228 候选计划同哲学），编译走生产事务。
//   2) registerMediaGraphSliceHooks(register) —— 只读断言钩子（经 unified 的 registerWmb5241SliceHook）：
//      afterIngestQueryWriteback / final 两阶段。
//
// 断言主题（逐项可证伪；抛错即切片失败）：
//   - Studio 媒体绑定：正文 wmb-asset token 是排版投影、绑定为权威（布局只在 binding，绝不入 token）；
//     平台 asset_ids_json 投影 = derivedAssetId || assetId 按 ordinal，无任何内部 token；
//     compilePlatformBody 编译产物零内部 token、附件顺序与绑定一致。
//   - 原图不可变 / 派生可追溯：assets.sha256 与磁盘字节一致（内容寻址）；derived_crop 血缘行
//     source+derived+transform 齐备。
//   - 视觉结论绑定：knowledge_visual_runs 携带 sourceId + sourceRevisionId + assetId；
//     编译后的 Evidence locator 逐字节等于 asset:<assetId>|sourceRevision:<sourceRevisionId>。
//   - 图谱关系：knowledge_formal_relations 活动行端点类型全部 ∈ 网络可见类型；
//     getKnowledgeNetworkProjection 的每条关系 from/to 均落在投影节点集合（可定位）；
//     正式边必须来自 formal_relations，WMB-5255 派生采纳边（derived:about:*）为只读派生；深链可解析。
//   - 创作血缘：usage 包存在；任何带固定版本引用的 usage record 的版本 id 必须存在于版本表
//     （引用固定版本）；零知识包如实空血缘（不冒充）。
//   - 人工发布边界：publications / snapshots / attempts / confirmations / 度量快照全流程零自动写。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseAssetImages } from '../../src/shared/media-token.ts';
import {
  compilePlatformBody,
  containsInternalMediaToken
} from '../../src/main/platform-body-compile.ts';
import {
  getKnowledgeNetworkNodeDetail,
  getKnowledgeNetworkProjection
} from '../../src/main/knowledge-canvas.ts';
import {
  compileVisualRunKnowledge,
  enqueueVisualRun,
  ensureSourceImageAsset,
  executeVisualRun,
  visualEvidenceLocator
} from '../../src/main/visual-source-lineage.ts';

const PROJECT_TITLE = 'WMB-5241 图片编辑项目';
const TOPIC_TITLE = 'AI Agent 工具链';
const NETWORK_VISIBLE_ENDPOINT_TYPES = new Set(['topic', 'knowledge_note', 'knowledge_note_version', 'knowledge_entity']);

function openReadOnly(dataRoot) {
  return new DatabaseSync(path.join(dataRoot, 'wmb.db'), { readOnly: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rows(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}

function row(db, sql, ...args) {
  return db.prepare(sql).get(...args);
}

function count(db, sql, ...args) {
  return Number(row(db, sql, ...args)?.c ?? 0);
}

/** 视觉模型确定性缝：返回固定 wmb_visual_observation manifest（生产解析器校验）。 */
function stubVisionModel() {
  const manifest = {
    wmb_visual_observation: {
      reason: 'E2E 视觉观察：验证图片理解结论绑定 asset + source revision。',
      items: [
        { kind: 'claim', canonicalKey: 'wmb5241-visual-asset-count', statement: '种子图 A 与图 B 均入库。', excerpt: '图片菜单显示 2 张卡片。', valueRationale: '可经素材库独立验证。' },
        { kind: 'insight', canonicalKey: 'wmb5241-visual-layout', statement: '布局以绑定为准，不进正文 token。', excerpt: '图注 A/B 与布局分离。', valueRationale: '规范要求。' }
      ]
    }
  };
  return async () => `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
}

/**
 * 写侧挂接：在窗口 A（同一 data-root，应用已关闭）执行生产视觉理解全链路。
 * 返回 { runId, assetId, sourceRevisionId, sourceId, topicId, changeSetId, status }。
 * 幂等：同 (source, revision, asset, schemaVersion) 三元组重复执行复用现有 run；同 requestId 重放零增量。
 */
export async function runVisualSourceLineage(dataRoot, workspaceId) {
  const db = new DatabaseSync(path.join(dataRoot, 'wmb.db'));
  try {
    const source = row(db, 'SELECT id, revision FROM source_items ORDER BY created_at LIMIT 1');
    assert(source, '视觉管线需要已存在的 Source');
    // 固定版本锚：优先真实 source_body_revisions.id；无正文历史时回退 source 行 revision。
    let sourceRevisionId = null;
    try {
      const rev = row(db, 'SELECT id FROM source_body_revisions WHERE source_id = ? ORDER BY created_at DESC LIMIT 1', source.id);
      sourceRevisionId = rev?.id ?? null;
    } catch {
      // 精简 schema 无 revisions 表 → 回退
    }
    sourceRevisionId = sourceRevisionId ?? `rev:${source.revision}`;
    const topic = row(db, "SELECT id FROM topics WHERE title = ? AND status != 'archived' LIMIT 1", TOPIC_TITLE);
    assert(topic, `视觉管线需要已编译主题「${TOPIC_TITLE}」`);
    // 复用种子素材文件（sha256 内容寻址 → 与 Studio 项目同一 asset，绝不重复落盘）。
    const seedAsset = row(db, "SELECT id, relative_path AS relativePath FROM assets WHERE origin = 'e2e:wmb5241:source' ORDER BY created_at LIMIT 1");
    assert(seedAsset, '视觉管线需要种子素材');
    const localPath = path.join(dataRoot, ...seedAsset.relativePath.split('/'));
    const { asset } = await ensureSourceImageAsset(db, dataRoot, {
      sourceId: source.id,
      image: { kind: 'local', localPath, mimeType: 'image/png' }
    });
    const { run } = enqueueVisualRun(db, {
      sourceId: source.id,
      sourceRevisionId,
      assetId: asset.id
    });
    // 幂等重放：同三元组已 completed（不可变行）→ 直接复用，绝不重跑；queued/failed 才执行。
    let completed = run;
    if (run.status !== 'completed') {
      completed = await executeVisualRun(db, run.id, { dataRoot, modelCall: stubVisionModel() });
    }
    assert(completed.status === 'completed', `视觉 run 应 completed，实际 ${completed.status}`);
    const compile = compileVisualRunKnowledge(db, run.id, { workspaceId, topicId: topic.id });
    return {
      runId: run.id,
      assetId: asset.id,
      sourceRevisionId,
      sourceId: source.id,
      topicId: topic.id,
      changeSetId: compile.changeSetId,
      status: completed.status
    };
  } finally {
    db.close();
  }
}

// ============================================================
// 只读断言钩子
// ============================================================

async function afterIngestQueryWriteback({ dataRoot }) {
  const db = openReadOnly(dataRoot);
  try {
    assertStudioMediaBinding(db, dataRoot);
    assertAssetImmutability(db, dataRoot);
    assertVisualLineageBinding(db);
    assertGraphLocatable(db);
    assertCreationUsageFixedVersions(db);
    assertPublicationZeroWrite(db);
  } finally {
    db.close();
  }
}

async function finalHook({ dataRoot, versionRestore }) {
  const db = openReadOnly(dataRoot);
  try {
    // 重启 + 版本回退后发布边界仍然零自动写。
    assertPublicationZeroWrite(db);
    // 图谱在重启/回退后仍然可定位（正式关系 + 投影解析）。
    assertGraphLocatable(db);
    // Studio 媒体绑定在重启后仍权威：核心绑定行与素材存在性保持。
    const project = row(db, 'SELECT id FROM content_projects WHERE title = ?', PROJECT_TITLE);
    assert(project, '图片项目应仍在（重启恢复）');
    const latest = row(db, 'SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1', project.id);
    assert(latest, '图片项目应有最新核心版本');
    const bindings = rows(db, 'SELECT asset_id AS assetId FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal', latest.id);
    assert(bindings.length >= 2, `重启后核心绑定应 ≥2，实际 ${bindings.length}`);
    for (const binding of bindings) {
      assert(row(db, 'SELECT id FROM assets WHERE id = ?', binding.assetId), `绑定素材应存在：${binding.assetId}`);
    }
    // 版本回退（topic 侧）新增了 Wiki 版本；回退版本行仍可解析（历史保留）。
    if (versionRestore?.afterVersions != null) {
      assert(Number(versionRestore.afterVersions) > 0, '版本回退应产生版本记录');
    }
  } finally {
    db.close();
  }
}

/** 注册只读断言钩子（unified 文件 import 后调用一次）。 */
export function registerMediaGraphSliceHooks(register) {
  register('afterIngestQueryWriteback', afterIngestQueryWriteback);
  register('final', finalHook);
}

// ============================================================
// 断言实现
// ============================================================

function assertStudioMediaBinding(db, dataRoot) {
  const project = row(db, 'SELECT id FROM content_projects WHERE title = ?', PROJECT_TITLE);
  assert(project, `Studio 种子项目「${PROJECT_TITLE}」应存在`);
  // 当前核心版本：正文 token 保持纯净（布局绝不入 token）。
  const latest = row(db, 'SELECT id, body FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1', project.id);
  assert(latest, '图片项目应有最新核心版本');
  const refs = parseAssetImages(latest.body);
  assert(refs.length === 2, `当前正文应含 2 个 wmb-asset token（排版投影），实际 ${refs.length}`);
  assert(!/wmb-asset:\/\/[^)]+\s+(small|medium|large|full|left|center|right)\s*\)/.test(latest.body), '布局绝不进入正文 token');

  const coreBindings = rows(db, `SELECT asset_id AS assetId, occurrence, ordinal, width_preset AS widthPreset, align, caption
    FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal`, latest.id);
  assert(coreBindings.length === 2, `核心绑定应 2 行（绑定为权威），实际 ${coreBindings.length}`);
  assert(coreBindings[0].ordinal === 0 && coreBindings[1].ordinal === 1, '核心绑定 ordinal 应连续 0..1');
  for (const binding of coreBindings) {
    assert(['small', 'medium', 'large', 'full'].includes(binding.widthPreset), `widthPreset 非法：${binding.widthPreset}`);
    assert(['left', 'center', 'right'].includes(binding.align), `align 非法：${binding.align}`);
    assert(row(db, 'SELECT id FROM assets WHERE id = ?', binding.assetId), `绑定素材必须存在：${binding.assetId}`);
  }

  // X 平台版本：平台绑定 + asset_ids_json 投影无内部 token。
  const xVersion = row(db, `SELECT id, body, asset_ids_json AS assetIdsJson
    FROM platform_versions WHERE project_id = ? AND platform = 'x' ORDER BY revision DESC LIMIT 1`, project.id);
  assert(xVersion, 'X 平台版本应存在');
  const platformBindings = rows(db, `SELECT asset_id AS assetId, ordinal, is_cover AS isCover, derived_asset_id AS derivedAssetId
    FROM platform_media_bindings WHERE platform_version_id = ? ORDER BY ordinal`, xVersion.id);
  assert(platformBindings.length === 2, `平台绑定应 2 行，实际 ${platformBindings.length}`);
  const covers = platformBindings.filter((b) => b.isCover === 1);
  assert(covers.length <= 1, '平台封面至多一个（schema 唯一索引）');
  if (covers.length === 1) assert(covers[0].ordinal === 0, 'X 平台封面必须位于 ordinal 0（保存面校验契约）');
  const assetIdsJson = JSON.parse(xVersion.assetIdsJson);
  assert(Array.isArray(assetIdsJson) && assetIdsJson.length === 2, 'asset_ids_json 应为平台图序数组');
  assert(!xVersion.assetIdsJson.includes('wmb-asset') && !xVersion.assetIdsJson.includes('!['), '平台投影不得含内部 token');
  for (const id of assetIdsJson) {
    assert(typeof id === 'string' && row(db, 'SELECT id FROM assets WHERE id = ?', id), `投影素材必须存在：${String(id)}`);
  }
  const projected = platformBindings.map((b) => b.derivedAssetId ?? b.assetId);
  assert(JSON.stringify(projected) === JSON.stringify(assetIdsJson), 'asset_ids_json 投影 = derivedAssetId || assetId 按 ordinal');
  // X 发布投影边界：assets[0] 即封面（适配器只携带 assets[0]）——投影顺序即发布顺序。
  assert(assetIdsJson[0] === projected[0], 'X 投影首图必须与绑定 ordinal 0 一致');

  // 发布正文编译：零内部 token + 附件顺序与绑定一致。
  const compiled = compilePlatformBody({
    platform: 'x',
    body: xVersion.body,
    bindings: platformBindings.map((b) => ({
      id: `${xVersion.id}:${b.ordinal}`,
      platformVersionId: xVersion.id,
      assetId: b.assetId,
      ordinal: b.ordinal,
      caption: null,
      isCover: b.isCover === 1,
      cropRegion: null,
      derivedAssetId: b.derivedAssetId,
      createdAt: '',
      updatedAt: ''
    }))
  });
  assert(!containsInternalMediaToken(compiled.body), '发布编译产物不得残留内部 token');
  assert(!compiled.body.includes('!['), '发布编译产物不得残留 markdown 图片语法');
  assert(compiled.imageTokens === 2, `编译应消费 2 个图片 token，实际 ${compiled.imageTokens}`);
  assert(JSON.stringify(compiled.assetIds) === JSON.stringify(assetIdsJson), '编译附件顺序应与平台投影一致');
}

function assertAssetImmutability(db, dataRoot) {
  // 原图不可变：sha256 内容寻址，磁盘字节必须与记录一致。
  const assets = rows(db, 'SELECT id, relative_path AS relativePath, sha256, byte_count AS byteCount FROM assets');
  assert(assets.length >= 2, '素材应 ≥2');
  for (const asset of assets) {
    const bytes = readFileSync(path.join(dataRoot, ...asset.relativePath.split('/')));
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert(actual === asset.sha256, `素材 ${asset.id} 磁盘字节与 sha256 不一致（原图被改写）`);
    assert(bytes.byteLength === Number(asset.byteCount), `素材 ${asset.id} 字节数与记录不一致`);
  }
  // 派生血缘：derived_crop 行必须 source + derived + transform 齐备（schema CHECK 之外再断言零残缺）。
  const derived = rows(db, `SELECT source_asset_id AS sourceAssetId, derived_asset_id AS derivedAssetId, transform_json AS transformJson
    FROM asset_provenance WHERE kind = 'derived_crop'`);
  for (const item of derived) {
    assert(item.sourceAssetId && item.derivedAssetId && item.transformJson, 'derived_crop 血缘行必须三字段齐备');
  }
  // imported 血缘（种子素材经生产 assets 管线导入）。
  assert(count(db, "SELECT COUNT(*) AS c FROM asset_provenance WHERE kind = 'imported'") >= 2, '种子素材应有 imported 血缘记录');
}

function assertVisualLineageBinding(db) {
  const runs = rows(db, `SELECT id, source_id AS sourceId, source_revision_id AS sourceRevisionId, asset_id AS assetId, status
    FROM knowledge_visual_runs ORDER BY created_at`);
  if (runs.length === 0) return; // 未挂接视觉 run 时跳过（聚焦测试覆盖全链路）；挂接后必须满足下面断言。
  for (const run of runs) {
    assert(run.sourceRevisionId, `视觉 run ${run.id} 必须携带 sourceRevisionId`);
    assert(row(db, 'SELECT id FROM assets WHERE id = ?', run.assetId), `视觉 run ${run.id} 的 asset 必须存在`);
  }
  for (const run of runs.filter((r) => r.status === 'completed')) {
    const locator = visualEvidenceLocator(run.assetId, run.sourceRevisionId);
    const hits = count(db, 'SELECT COUNT(*) AS c FROM knowledge_evidence_links WHERE locator = ?', locator);
    assert(hits >= 1, `视觉结论 Evidence locator 必须逐字节绑定 asset+sourceRevision：${locator}`);
  }
}

function assertGraphLocatable(db) {
  const relations = rows(db, `SELECT id, relation_key AS relationKey, from_object_type AS fromType, from_object_id AS fromId,
    to_object_type AS toType, to_object_id AS toId
    FROM knowledge_formal_relations WHERE ended_change_set_id IS NULL`);
  assert(relations.length >= 3, `活动正式关系应 ≥3，实际 ${relations.length}`);
  for (const relation of relations) {
    assert(NETWORK_VISIBLE_ENDPOINT_TYPES.has(relation.fromType), `关系端点类型越界：${relation.fromType}`);
    assert(NETWORK_VISIBLE_ENDPOINT_TYPES.has(relation.toType), `关系端点类型越界：${relation.toType}`);
  }
  const projection = getKnowledgeNetworkProjection(db, { limit: 2000 });
  assert(projection.nodes.length >= 8, `网络投影节点应 ≥8，实际 ${projection.nodes.length}`);
  assert(projection.relations.length >= 3, `网络投影关系应 ≥3，实际 ${projection.relations.length}`);
  const nodeIds = new Set(projection.nodes.map((node) => node.id));
  const formalById = new Map(relations.map((r) => [r.id, r]));
  for (const edge of projection.relations) {
    assert(nodeIds.has(edge.from), `关系 from 不可定位：${edge.from}`);
    assert(nodeIds.has(edge.to), `关系 to 不可定位：${edge.to}`);
    if (edge.id.startsWith('derived:about:')) {
      // WMB-5255：当前版本派生采纳边（只读派生；note -> topic/entity about；无正式关系行，ID 为稳定确定命名空间）
      assert(edge.relationType === 'about' && edge.from.startsWith('knowledge_note:')
        && (edge.to.startsWith('topic:') || edge.to.startsWith('knowledge_entity:')), `派生边契约越界：${edge.id}`);
    } else {
      assert(formalById.has(edge.id), `投影关系 ${edge.id} 必须来自 knowledge_formal_relations`);
    }
  }
  // 深链可定位：主题节点 → 正式 Wiki 页（固定版本引用可解析）。
  const topicRow = row(db, "SELECT id FROM topics WHERE title = ? AND status != 'archived' LIMIT 1", TOPIC_TITLE);
  if (topicRow) {
    const topicNodeId = `topic:${topicRow.id}`;
    const detail = getKnowledgeNetworkNodeDetail(db, { nodeId: topicNodeId });
    assert(detail.deepLink.route === 'topic', `主题节点深链应指向主题路由：${detail.deepLink.route}`);
    assert(detail.versionRef?.versionKind === 'wiki_page_version' && detail.versionRef.versionId,
      '主题节点详情应解析到固定 Wiki 页版本（versionRef）');
    assert(row(db, 'SELECT id FROM knowledge_wiki_page_versions WHERE id = ?', detail.versionRef.versionId),
      `主题固定 Wiki 版本必须存在：${detail.versionRef.versionId}`);
  }
}

function assertCreationUsageFixedVersions(db) {
  const packages = rows(db, 'SELECT id, request_id AS requestId, stage FROM knowledge_usage_packages ORDER BY created_at');
  assert(packages.length >= 1, '创作链路应存在 knowledge_usage_packages（Studio 保存即记录）');
  // 版本列：note_version_id XOR wiki_page_version_id（schema CHECK 强制恰好一个）。
  const records = rows(db, `SELECT id, note_version_id AS noteVersionId, wiki_page_version_id AS wikiPageVersionId
    FROM knowledge_usage_records WHERE note_version_id IS NOT NULL OR wiki_page_version_id IS NOT NULL`);
  for (const record of records) {
    if (record.noteVersionId) {
      assert(row(db, 'SELECT id FROM knowledge_note_versions WHERE id = ?', record.noteVersionId),
        `usage 必须引用存在的固定 Note 版本：${record.noteVersionId}`);
    }
    if (record.wikiPageVersionId) {
      assert(row(db, 'SELECT id FROM knowledge_wiki_page_versions WHERE id = ?', record.wikiPageVersionId),
        `usage 必须引用存在的固定 Wiki 版本：${record.wikiPageVersionId}`);
    }
  }
  // 零知识诚实性：存在空血缘包不冒充 used/consulted（WMB-5232 契约；图片项目无 Topic 链接即为零知识）。
  const emptyOk = packages.some((p) => p.stage === 'core_draft');
  assert(emptyOk, '应存在 core_draft 阶段 usage 包');
}

function assertPublicationZeroWrite(db) {
  for (const table of ['publications', 'publication_snapshots', 'publication_attempts', 'publication_confirmations', 'publication_metric_snapshots']) {
    assert(count(db, `SELECT COUNT(*) AS c FROM ${table}`) === 0, `${table} 必须零自动写（人工发布边界）`);
  }
}
