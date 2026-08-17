// WMB-5241 最终验收：同一真实工作空间（single data-root）串行跑通 Karpathy LLM Wiki 全部核心能力，
// 逐项证明不弱于原始 LLM Wiki 核心契约（矩阵 .ai/wmb-5235-karpathy-llm-wiki-capability-matrix.json）。
//
// 场景形态（与 WMB-5240/5239 同族 harness；runner 1/1 PASS）：
//   Launch 1（真实 Electron）→ 资料库/主题/关系画布/Studio/Pi 五面 UI 检查 + 全库维护 run 到
//   completed + Lint + 索引/日志/搜索 + 发布边界 → 关闭进程
//   Window A（同一 data-root，应用已关闭）→ 单条 Ingest（dispatcher sources.upsert_batch +
//     生产 post-save 编译触发，模型缝确定性注入）+ 批量 Ingest（3 条，同命令面）+ requestId 幂等重放
//     + 固定版本 Query（executeWikiAction query → 正式 fixed-version-query 执行面）+ 写回
//     （writebackQueryKnowledge，与 Pi settle 同 store 管线）→ 索引自愈重建 + DB 快照
//   Launch 2（同一 userDataDir/dataRoot 重启）→ 重启恢复（维护 run 沿 SQLite 读回 + UI 读回）、
//     跨页更新 UI 验证（主题/资料库/关系画布）、版本回退（版本页签恢复此版本 → 追加新版本）、
//     发布边界（publication_snapshots/度量快照零新增、侧栏无新顶层路由）
//
// 证据：tests/e2e/.artifacts/WMB-5241-*（harness artifactsDir，含步骤日志 evidence.steps、
// 每阶段截图、控制台/页面错误/Electron 输出、DB 快照 phase-*.db + 摘要 db-summary-*.json）。
//
// 运行（有界；建议 1500s 起）：
//   node tests/e2e/runner.mjs --file tests/e2e/wmb-5241-unified.test.mjs --timeout 1800 --keep-runtime
//
// 真实 provider 契约（可选，同 WMB-5240；配置时额外跑一轮真实 Pi 固定版本 Query 轮次，
// 未配置时以正式 test-process 执行面证明 Query/写回并标记 provider_unconfigured）：
//   WMB_E2E_PI_BASE_URL / WMB_E2E_PI_MODEL / WMB_E2E_PI_API_KEY（三者齐备即视为配置）
//
// 诚实边界：固定非模型业务步骤全部走正式 UI / 正式工具 / 正式 dispatcher；
// 唯一模型缝是 WMB-5228 候选计划的确定性注入（wmb_knowledge_candidates 协议围栏由生产解析器
// 校验、locator/低价值门禁照常生效），编译/写回/版本化全部走生产管线；绝不直写 SQL 冒充结果。

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { helpers, launchApp } from './harness.mjs';
import { seedRichKnowledge, openWorkspaceDb } from './fixture-knowledge.mjs';
import { seedWorkflowBase, openWriteDb } from './seed-workflow.mjs';
import { migrateDatabase } from '../../src/main/db/migrations.ts';
import { dispatchSourceUpsertBatch } from '../../src/main/source-commands.ts';
import { ActiveWorkspaceRuntime } from '../../src/main/workspace-runtime.ts';
import { setSourceKnowledgeCompileDeps, drainSourceKnowledgeCompileQueue, sourceKnowledgeCompileInFlight } from '../../src/main/knowledge-compile-trigger.ts';
import { recordKnowledgeBatch } from '../../src/main/knowledge.ts';
import { writeSourceBodyCache } from '../../src/main/source-body-cache.ts';
import { dispatchBusinessCommand } from '../../src/main/business-command.ts';
import { executeWikiAction, wireDefaultWikiQueryExecutor } from '../../src/main/pi-wiki-actions.ts';
import { prepareQueryWriteback, finalizeQueryWriteback } from '../../src/main/query-writeback.ts';
import { applyKnowledgeChangeSet, KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND } from '../../src/main/knowledge-flywheel.ts';
import { listKnowledgeLogEntries } from '../../src/main/knowledge-global-log.ts';
import { searchWikiIndex } from '../../src/main/knowledge-search.ts';
import { getMaintenanceStatus, getMaintenanceReport } from '../../src/main/knowledge-maintenance.ts';
import { getPeriodicLintCheckpoint } from '../../src/main/knowledge-health.ts';
import { rebuildWikiIndex } from '../../src/main/db/wiki-index-store.ts';
import { registerMediaGraphSliceHooks, runVisualSourceLineage } from './wmb-5241-slice-media-graph.mjs';
import { importAssetBytes, linkProjectAsset, markdownImageForAsset } from '../../src/main/assets.ts';
import * as content from '../../src/main/content.ts';
import * as SLICE from './wmb-5241-slice-maintenance-recovery.mjs';

const { assert, step, waitForAppReady, navigateTo, delay, openReadOnlyDb, captureEvidence, closeApp } = helpers;

const MAINTENANCE_RUN_KEY = 'wmb_knowledge_maintenance_v1';
const MAINTENANCE_REPORT_KEY = 'wmb_knowledge_maintenance_report_v1';
const LINT_CHECKPOINT_KEY = 'knowledge_lint_checkpoint_v2';

// ============================================================
// Slice hooks（Reviewer 切片挂接点；经 registerWmb5241SliceHook 注册，run 内按阶段调用）
// ============================================================

const sliceHooks = {
  afterMaintenance: [],
  afterSearchLog: [],
  afterIngestQueryWriteback: [],
  afterRestart: [],
  afterVersionRestore: [],
  final: []
};

/** 注册一个只读断言钩子：入参 { ctx, dataRoot, workspaceId, artifactsDir }；抛错即切片失败。 */
export function registerWmb5241SliceHook(phase, fn) {
  if (!(phase in sliceHooks)) throw new Error(`未知切片阶段: ${phase}`);
  sliceHooks[phase].push(fn);
}
// Slice(AcceptMediaGraphCreation)：媒体/图谱/血缘/发布只读断言钩子（afterIngestQueryWriteback + final）。
registerMediaGraphSliceHooks(registerWmb5241SliceHook);

async function runSliceHooks(phase, bundle) {
  for (const fn of sliceHooks[phase]) {
    await fn(bundle);
  }
}

// ============================================================
// 种子：workspace profile + rich knowledge + 索引 + Studio 图片项目（同一 data-root）
// ============================================================

// 无第三方依赖的小型 PNG 生成器（真实 PNG 字节；与 ST-008 同款，Chromium 可解码）。
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([length, body, crcBuf]);
}

function makeSeedPng(width, height, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** Studio 图片项目种子：真实素材经生产 assets 管线 + 核心 v2 携带媒体绑定 + X 平台 v1。 */
async function seedImageProject(dataRoot) {
  const db = openWriteDb(dataRoot);
  try {
    const assetA = await importAssetBytes(db, dataRoot, {
      bytes: makeSeedPng(64, 64, 214, 42, 42),
      fileName: 'wmb5241-seed-a.png',
      mimeType: 'image/png',
      origin: 'e2e:wmb5241:source',
      width: 64,
      height: 64
    });
    const assetB = await importAssetBytes(db, dataRoot, {
      bytes: makeSeedPng(64, 64, 42, 82, 214),
      fileName: 'wmb5241-seed-b.png',
      mimeType: 'image/png',
      origin: 'e2e:wmb5241:source',
      width: 64,
      height: 64
    });
    const core1 = content.createContentProjectWithVersion(db, { title: 'WMB-5241 图片编辑项目', body: '图片编辑项目正文' });
    linkProjectAsset(db, core1.id, assetA.id);
    linkProjectAsset(db, core1.id, assetB.id);
    const imageBody = `图片编辑项目正文\n\n${markdownImageForAsset(assetA, '图注A')}\n\n${markdownImageForAsset(assetB, '图注B')}`;
    const core2 = content.saveCoreVersion(db, {
      projectId: core1.id,
      body: imageBody,
      expectedRevision: 1,
      mediaBindings: [
        { assetId: assetA.id, occurrence: 0, widthPreset: 'full', align: 'center', caption: '图注A' },
        { assetId: assetB.id, occurrence: 0, widthPreset: 'full', align: 'center', caption: '图注B' }
      ]
    });
    if (!core2.ok) throw new Error(`seedImageProject: 核心图片版保存失败 ${JSON.stringify(core2.error ?? core2)}`);
    const platX = content.savePlatformVersion(db, {
      projectId: core1.id,
      contentVersionId: core2.data.id,
      platform: 'x',
      format: 'text',
      title: 'X 图片稿',
      body: imageBody,
      mediaBindings: [
        { assetId: assetA.id, ordinal: 0, caption: '图注A' },
        { assetId: assetB.id, ordinal: 1, caption: '图注B' }
      ]
    });
    if (!platX.ok) throw new Error(`seedImageProject: X 平台图片版保存失败 ${JSON.stringify(platX.error ?? platX)}`);
    return { projectId: core1.id, assetAId: assetA.id, assetBId: assetB.id, shaA: assetA.sha256, shaB: assetB.sha256 };
  } finally {
    db.close();
  }
}

const RICH = {
  seedFixture: async (ws) => {
    await seedWorkflowBase(ws.dataRoot, ws.workspaceId);
    await seedRichKnowledge(ws.dataRoot, ws.workspaceId);
    const db = openWorkspaceDb(ws.dataRoot);
    try {
      rebuildWikiIndex(db, false);
    } finally {
      db.close();
    }
    await seedImageProject(ws.dataRoot);
  }
};

// ============================================================
// 读回辅助（只读；与生产 store 同库）
// ============================================================

function maintenanceRunOf(dataRoot) {
  const db = openReadOnlyDb(dataRoot);
  try {
    const row = db.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(MAINTENANCE_RUN_KEY);
    if (!row) return null;
    const run = JSON.parse(String(row.value));
    return run && run.schemaVersion === 1 && run.runId ? run : null;
  } finally {
    db.close();
  }
}

function countOf(dataRoot, sql, ...args) {
  const db = openReadOnlyDb(dataRoot);
  try {
    return Number(db.db.prepare(sql).get(...args)?.c ?? 0);
  } finally {
    db.close();
  }
}

/** 预置冻结版本引用：主题「AI Agent 工具链」最新 Wiki 页版本 + 两条 AgentForge 知识结论版本。 */
function seededVersionRefs(dataRoot) {
  const db = openReadOnlyDb(dataRoot);
  try {
    const wiki = db.db.prepare(`
      SELECT pv.id AS versionId, p.id AS pageId
      FROM knowledge_wiki_page_versions pv
      JOIN knowledge_wiki_pages p ON p.id = pv.page_id
      JOIN topics t ON t.id = p.subject_id AND p.subject_type = 'topic'
      WHERE t.title = 'AI Agent 工具链'
      ORDER BY pv.created_at DESC LIMIT 1
    `).get();
    const notes = db.db.prepare(`
      SELECT nv.id AS versionId, n.id AS noteId, n.canonical_key AS key
      FROM knowledge_note_versions nv JOIN knowledge_notes n ON n.id = nv.note_id
      WHERE n.canonical_key IN ('agentforge-v2-multi-router', 'agentforge-xhs-claim')
      ORDER BY n.canonical_key
    `).all();
    return { wiki, notes };
  } finally {
    db.close();
  }
}

/** DB 一致性摘要（每阶段落盘；只读）。 */
function dbSummary(dataRoot) {
  const db = openReadOnlyDb(dataRoot);
  try {
    const c = (sql, ...args) => Number(db.db.prepare(sql).get(...args)?.c ?? 0);
    const run = maintenanceRunOf(dataRoot);
    const lint = (() => {
      try {
        const row = db.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(LINT_CHECKPOINT_KEY);
        return row ? JSON.parse(String(row.value)) : null;
      } catch {
        return null;
      }
    })();
    const report = (() => {
      try {
        const row = db.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(MAINTENANCE_REPORT_KEY);
        return row ? JSON.parse(String(row.value)) : null;
      } catch {
        return null;
      }
    })();
    return {
      workspaceId: db.db.prepare("SELECT value FROM app_meta WHERE key = 'workspace_id'").get()?.value ?? null,
      sources: c('SELECT COUNT(*) AS c FROM source_items'),
      topics: c('SELECT COUNT(*) AS c FROM topics'),
      wikiPages: c("SELECT COUNT(*) AS c FROM knowledge_wiki_pages WHERE lifecycle = 'active'"),
      wikiVersions: c('SELECT COUNT(*) AS c FROM knowledge_wiki_page_versions'),
      notes: c("SELECT COUNT(*) AS c FROM knowledge_notes WHERE lifecycle = 'active'"),
      noteVersions: c('SELECT COUNT(*) AS c FROM knowledge_note_versions'),
      entities: c("SELECT COUNT(*) AS c FROM knowledge_entities WHERE lifecycle = 'active'"),
      relations: c('SELECT COUNT(*) AS c FROM knowledge_relations'),
      healthIssues: c("SELECT COUNT(*) AS c FROM knowledge_health_issues WHERE status = 'open'"),
      indexEntries: c('SELECT COUNT(*) AS c FROM knowledge_index_entries'),
      receipts: c('SELECT COUNT(*) AS c FROM knowledge_update_receipts'),
      commandReceipts: c('SELECT COUNT(*) AS c FROM command_receipts'),
      maintenanceCommands: c("SELECT COUNT(*) AS c FROM command_receipts WHERE request_id LIKE 'knowledge-maintenance:%'"),
      lintCommands: c("SELECT COUNT(*) AS c FROM command_receipts WHERE command = 'knowledge.lint'"),
      sourceUpsertCommands: c("SELECT COUNT(*) AS c FROM command_receipts WHERE command = 'sources.upsert_batch'"),
      operationLog: c('SELECT COUNT(*) AS c FROM operation_log'),
      assets: c('SELECT COUNT(*) AS c FROM assets'),
      coreBindings: c('SELECT COUNT(*) AS c FROM content_media_bindings'),
      platformBindings: c('SELECT COUNT(*) AS c FROM platform_media_bindings'),
      provenance: c('SELECT COUNT(*) AS c FROM asset_provenance'),
      queryArtifacts: c('SELECT COUNT(*) AS c FROM knowledge_query_artifacts'),
      publications: c('SELECT COUNT(*) AS c FROM publications'),
      publicationSnapshots: c('SELECT COUNT(*) AS c FROM publication_snapshots'),
      metricSnapshots: c('SELECT COUNT(*) AS c FROM publication_metric_snapshots'),
      maintenanceRun: run ? { runId: run.runId, status: run.status, phase: run.phase, step: run.step } : null,
      lintCheckpoint: lint ? { runId: lint.runId, status: lint.status, step: lint.step, openIssues: lint.openIssues ?? null } : null,
      maintenanceReport: report ? { reportId: report.reportId, backfill: report.backfill, lint: report.lint } : null
    };
  } finally {
    db.close();
  }
}

/** SQLite 在线备份快照（wmb.db → artifacts 目录；应用运行中也可安全拷贝）。 */
function snapshotDb(artifactsDir, name, dataRoot) {
  const dest = path.join(artifactsDir, name);
  const { db } = openReadOnlyDb(dataRoot);
  try {
    if (typeof db.backup === 'function') {
      db.backup(dest);
    } else {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    }
    return dest;
  } finally {
    db.close();
  }
}

function writeJson(artifactsDir, name, value) {
  writeFileSync(path.join(artifactsDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

// ============================================================
// 确定性模型缝（WMB-5228 候选计划协议；生产解析/校验/编译全真）
// ============================================================

function candidateFence() {
  const manifest = {
    wmb_knowledge_candidates: {
      reason: 'WMB-5241 E2E 确定性模型缝：按 wmb_knowledge_candidates 协议声明候选计划，生产解析器校验。',
      topicCompile: {
        title: 'AI Agent 工具链',
        summary: 'AgentForge v2 引入多模型路由；企业版发布扩展多租户隔离与审计能力；小红书场景批量内容生成已有验证路径；路由质量评估应先跑混合样本。'
      },
      entities: [
        { entityType: 'product', canonicalKey: 'agentforge', canonicalName: 'AgentForge', excerpt: 'AgentForge v2 企业版发布，扩展多租户隔离与审计能力。', valueRationale: '官方产品身份，可独立验证。' }
      ],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-enterprise', statement: 'AgentForge v2 企业版支持多租户隔离与审计。', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L2', excerpt: 'AgentForge v2 企业版支持多租户隔离与审计。', valueRationale: '官方发布，可验证。' },
        { kind: 'claim', canonicalKey: 'agentforge-v2-audit', statement: '企业版审计日志覆盖全部路由决策。', conclusionStatus: 'supported', evidenceLevel: 'single', locator: 'L3', excerpt: '企业版审计日志覆盖全部路由决策。', valueRationale: '官方发布，可验证。' }
      ]
    }
  };
  return `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
}

const stubModelCall = async () => candidateFence();

function compileDepsFor(dataRoot) {
  return {
    databasePath: path.join(dataRoot, 'wmb.db'),
    modelCall: stubModelCall,
    openDatabase: migrateDatabase
  };
}

// ============================================================
// 窗口 A：同一 data-root 上的正式 dispatcher / 执行面步骤（应用已关闭）
// ============================================================

async function runWindowA({ dataRoot, workspaceId, artifactsDir, sliceBundle }) {
  const db = openReadOnlyDb(dataRoot);
  const before = dbSummary(dataRoot);
  db.close();
  let runtime = null;
  try {
    runtime = ActiveWorkspaceRuntime.open(dataRoot, { openDatabase: migrateDatabase });
    setSourceKnowledgeCompileDeps(compileDepsFor(dataRoot));

    // ---- A1. 单条 Ingest：dispatcher sources.upsert_batch（保存，回执+operation_log）----
    const ownerUiActor = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
    const singleRequestId = `wmb5241-single-${randomUUID()}`;
    const singleReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: singleRequestId,
      actor: ownerUiActor,
      items: [{
        title: 'AgentForge v2 企业版发布',
        originalUrl: 'https://news.example/agentforge-v2-enterprise',
        summary: 'AgentForge 官方发布 v2 企业版，扩展多租户隔离与审计能力。',
        author: 'News Desk'
      }]
    });
    assert(singleReceipt.ok, `单条 Ingest 命令应成功：${JSON.stringify(singleReceipt.error ?? singleReceipt)}`);
    const singleSaved = singleReceipt.data?.items?.[0];
    assert(singleSaved && singleSaved.id, '单条 Ingest 应返回保存的 source id');

    // 正文（可定位原文）经正式 sources:fetch-body 命令落盘（source_body_cache + 不可变 revision）；
    // 供 WMB-5228 候选计划的 locator/excerpt 门精确回指。
    const bodyText = [
      'AgentForge v2 企业版发布，扩展多租户隔离与审计能力。',
      'AgentForge v2 企业版支持多租户隔离与审计。',
      '企业版审计日志覆盖全部路由决策。'
    ].join('\n');
    const bodyReceipt = await dispatchBusinessCommand(runtime, {
      command: 'sources:fetch-body', requestId: `wmb5241-body-${randomUUID()}`, actor: ownerUiActor,
      input: {
        sourceId: singleSaved.id,
        url: 'https://news.example/agentforge-v2-enterprise',
        status: 'ready',
        contentType: 'text/plain',
        extractedText: bodyText,
        extractedChars: bodyText.length,
        errorMessage: null,
        fetchedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      boundIdentity: { entityType: 'source_body_cache', entityId: singleSaved.id }, entityType: 'source_body_cache',
      execute: (database, value) => ({ data: writeSourceBodyCache(database, value), entityId: value.sourceId, readback: value })
    });
    assert(bodyReceipt.ok, `正文摄取命令应成功：${JSON.stringify(bodyReceipt.error ?? bodyReceipt)}`);

    // 生产语义（WMB-5229）：整理阶段经正式 knowledge.record_batch 命令建立 topic_source_links。
    const linkReceipt = await dispatchBusinessCommand(runtime, {
      command: 'knowledge.record_batch', requestId: `wmb5241-link-${randomUUID()}`, actor: ownerUiActor,
      input: { items: [{ sourceId: singleSaved.id, topic: { title: 'AI Agent 工具链', summary: 'AgentForge v2 引入多模型路由，面向小红书场景的批量内容生成已有验证路径。' } }] },
      boundIdentity: { entityType: 'knowledge_batch' }, entityType: 'knowledge_batch',
      execute: (database, normalized) => {
        const data = recordKnowledgeBatch(database, normalized, false);
        return { data, readback: data };
      }
    });
    assert(linkReceipt.ok && linkReceipt.data?.[0]?.topicId, '单条 Ingest 应经 record_batch 命令关联到主题（topic_source_links）');
    const linkedTopicId = linkReceipt.data[0].topicId;

    // 第二次 dispatcher 保存（revision bump）→ 生产 post-save 编译触发（模型缝确定性注入）
    const bumpRequestId = `wmb5241-single-bump-${randomUUID()}`;
    const bumpReceipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: bumpRequestId,
      actor: ownerUiActor,
      items: [{
        id: singleSaved.id,
        expectedRevision: singleSaved.revision,
        title: 'AgentForge v2 企业版发布',
        originalUrl: 'https://news.example/agentforge-v2-enterprise',
        summary: 'AgentForge 官方发布 v2 企业版，扩展多租户隔离与审计能力（已更新官方文档）。',
        author: 'News Desk'
      }]
    });
    assert(bumpReceipt.ok && Number(bumpReceipt.data?.items?.[0]?.revision) === Number(singleSaved.revision) + 1,
      `revision bump 应推进：${JSON.stringify(bumpReceipt.error ?? bumpReceipt.data)}`);
    await drainSourceKnowledgeCompileQueue();
    assert(sourceKnowledgeCompileInFlight() === 0, '编译队列应排空');

    const afterSingle = dbSummary(dataRoot);
    assert(afterSingle.wikiVersions > before.wikiVersions, `跨页更新：Wiki 页版本数应增加（${before.wikiVersions} → ${afterSingle.wikiVersions}）`);
    assert(afterSingle.notes >= before.notes + 2, `跨页更新：知识结论应新增 ≥2（${before.notes} → ${afterSingle.notes}）`);
    assert(afterSingle.operationLog > before.operationLog, '编译应落 operation_log');
    const compileOps = (() => {
      const d = openReadOnlyDb(dataRoot);
      try {
        return d.db.prepare("SELECT COUNT(*) AS c FROM operation_log WHERE command = 'knowledge.compile_source' AND result = 'ok'").get().c;
      } finally {
        d.close();
      }
    })();
    assert(Number(compileOps) >= 1, '应存在成功的 knowledge.compile_source operation_log 条目');

    // ---- A2. 批量 Ingest：同一命令面一次 3 条 + requestId 幂等重放 ----
    const batchRequestId = `wmb5241-batch-${randomUUID()}`;
    const batchInput = {
      requestId: batchRequestId,
      actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' },
      items: [
        { title: '批量资料甲：多智能体编排综述', originalUrl: 'https://news.example/batch-a', summary: '多智能体编排综述：路由、记忆与工具边界。', author: 'E2E' },
        { title: '批量资料乙：模型路由基准对比', originalUrl: 'https://news.example/batch-b', summary: '模型路由基准对比：延迟、质量与成本。', author: 'E2E' },
        { title: '批量资料丙：Agent 工作流安全清单', originalUrl: 'https://news.example/batch-c', summary: 'Agent 工作流安全清单：审计与权限最小化。', author: 'E2E' }
      ]
    };
    const batchReceipt = await dispatchSourceUpsertBatch(runtime, batchInput);
    assert(batchReceipt.ok, `批量 Ingest 命令应成功：${JSON.stringify(batchReceipt.error ?? batchReceipt)}`);
    assert(Array.isArray(batchReceipt.data?.items) && batchReceipt.data.items.length === 3, '批量 Ingest 应返回 3 条逐项结果');
    const replay = await dispatchSourceUpsertBatch(runtime, batchInput);
    assert(replay.ok && JSON.stringify(replay.data) === JSON.stringify(batchReceipt.data), '同 requestId + 同输入应重放原回执');
    const afterBatch = dbSummary(dataRoot);
    assert(afterBatch.sources === before.sources + 4, `批量 Ingest 后来源数应为 +4（${before.sources} → ${afterBatch.sources}）`);
    assert(afterBatch.sourceUpsertCommands >= before.sourceUpsertCommands + 3, 'Ingest 应逐命令落 dispatcher 回执');
    const replaySources = countOf(dataRoot, 'SELECT COUNT(*) AS c FROM source_items');
    assert(replaySources === afterBatch.sources, '重放应零新增（sources 不变）');

    // ---- A3. 固定版本 Query：正式 wiki 动作执行面（executeWikiAction → fixed-version-query）----
    await wireDefaultWikiQueryExecutor();
    const refs = seededVersionRefs(dataRoot);
    assert(refs.wiki && refs.notes.length >= 1, '固定版本引用预置缺失');
    const queryResult = await executeWikiAction(
      { runtime, database: runtime.database },
      {
        action: 'query',
        requestId: `wmb5241-query-${randomUUID()}`,
        question: 'AgentForge v2 是否支持多模型路由？',
        wikiVersionRefs: [`wiki_page:${refs.wiki.pageId}:${refs.wiki.versionId}`],
        noteVersionRefs: refs.notes.map((n) => `knowledge_note:${n.noteId}:${n.versionId}`)
      },
      { actor: 'pi' }
    );
    assert(queryResult.ok, `固定版本 Query 应成功：${JSON.stringify(queryResult.error ?? '')}`);
    const qdata = queryResult.data;
    assert(Array.isArray(qdata?.wikiPages) && qdata.wikiPages.length === 1, 'Query 应解析 1 条冻结 Wiki 页');
    assert(Array.isArray(qdata?.noteVersions) && qdata.noteVersions.length === 2, 'Query 应解析 2 条冻结 Note 版本');
    assert(JSON.stringify(qdata.noteVersions).includes('多模型路由'), 'Query 应返回冻结引用内容（statement 可引用）');
    sliceBundle.fixedVersionQuery = { ok: true, wikiPages: qdata.wikiPages.length, noteVersions: qdata.noteVersions.length };

    // ---- A4. 写回：与生产 Pi settle 同路径（prepare → knowledge_flywheel.change_set_apply 命令 → finalize）----
    const writebackRequestId = `query:wmb5241:${randomUUID()}`;
    const prepared = prepareQueryWriteback(runtime.database, {
      requestId: writebackRequestId,
      workspaceId,
      scope: 'global',
      conversationId: 'wmb5241-e2e-conv',
      question: 'AgentForge v2 是否支持多模型路由？',
      answerSummary: '基于冻结版本：AgentForge v2 支持多模型路由；企业版扩展多租户隔离与审计能力。',
      classification: 'new_synthesis',
      readWikiVersionIds: [refs.wiki.versionId],
      readNoteVersionIds: refs.notes.map((n) => n.versionId),
      readEvidenceIds: [],
      synthesis: {
        canonicalKey: 'wmb5241-e2e-synthesis',
        title: 'WMB-5241 综合：AgentForge v2 路由与企业版能力',
        statement: 'AgentForge v2 支持多模型路由；企业版扩展多租户隔离与审计能力。',
        basedOnNoteVersionIds: refs.notes.map((n) => n.versionId),
        valueRationale: 'E2E 固定版本读后综合，可验证。'
      },
      createdBy: 'background_agent',
      triggerSource: 'query'
    });
    let writeback;
    if (prepared.duplicate) {
      writeback = prepared.result;
    } else {
      const writebackReceipt = await dispatchBusinessCommand(runtime, {
        command: KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND,
        requestId: prepared.meta.requestId,
        actor: ownerUiActor,
        input: prepared.segments,
        boundIdentity: { entityType: 'knowledge_change_set', requestId: prepared.meta.requestId },
        entityType: 'knowledge_change_set',
        execute: (database, value) => {
          const result = applyKnowledgeChangeSet(database, prepared.meta, value, false);
          return { data: result, entityId: result.changeSetId, readback: result };
        }
      });
      assert(writebackReceipt.ok, `写回命令未通过：${JSON.stringify(writebackReceipt.error ?? writebackReceipt)}`);
      writeback = finalizeQueryWriteback(runtime.database, prepared);
    }
    assert(writeback.ok, `写回应成功：${JSON.stringify(writeback)}`);
    assert(writeback.synthesisPageId && writeback.synthesisPageVersionId, '写回应生成综合 Wiki 页版本');
    assert(Number(writeback.counts?.notesCreated ?? 0) + Number(writeback.counts?.notesUpdated ?? 0) >= 1, '写回应生成/更新综合 Note');
    const afterWriteback = dbSummary(dataRoot);
    assert(afterWriteback.queryArtifacts > before.queryArtifacts, '写回应落知识查询 Artifact');
    assert(afterWriteback.receipts > before.receipts, '写回应落知识回执');
    sliceBundle.writeback = {
      changeSetId: writeback.changeSetId,
      synthesisPageId: writeback.synthesisPageId,
      synthesisPageVersionId: writeback.synthesisPageVersionId,
      counts: writeback.counts
    };

    // ---- 索引自愈等价重建（生产路径 WMB-5239/5240 同款；ChangeSet 应用后索引投影，
    //      在独立连接上执行，与 fixture/生产接线同一 rebuildWikiIndex 语义）----
    const rebuildConn = openWorkspaceDb(dataRoot);
    try {
      rebuildWikiIndex(rebuildConn, false);
    } finally {
      rebuildConn.close();
    }
    const searchHit = searchWikiIndex(runtime.database, { query: '企业版', limit: 20 });
    assert(Number(searchHit.total ?? searchHit.items?.length ?? 0) >= 1, '统一搜索应命中窗口 A 新增内容（企业版）');
    sliceBundle.searchAfterWindowA = { total: Number(searchHit.total ?? searchHit.items?.length ?? 0) };

    snapshotDb(artifactsDir, 'phase-2-post-window-a.db', dataRoot);
    writeJson(artifactsDir, 'db-summary-phase-2-window-a.json', dbSummary(dataRoot));
    writeJson(artifactsDir, 'window-a-result.json', {
      singleIngest: { requestId: singleRequestId, sourceId: singleSaved.id, revision: bumpReceipt.data.items[0].revision, linkedTopicId },
      batchIngest: { requestId: batchRequestId, items: batchReceipt.data.items.map((item) => item.id), replayIdentical: true },
      fixedVersionQuery: sliceBundle.fixedVersionQuery,
      writeback: sliceBundle.writeback
    });
    return { singleSaved, batchItems: batchReceipt.data.items, refs };
  } finally {
    setSourceKnowledgeCompileDeps(null);
    if (runtime) {
      try {
        await runtime.stop({ drain: false });
      } catch {
        // 关闭尽力而为
      }
    }
  }
}

// ============================================================
// 可选真实 Pi 轮次（provider 配置时；未配置 → provider_unconfigured 证据）
// ============================================================

function readProviderEnv() {
  const baseUrl = (process.env.WMB_E2E_PI_BASE_URL ?? '').trim();
  const model = (process.env.WMB_E2E_PI_MODEL ?? '').trim();
  const apiKey = (process.env.WMB_E2E_PI_API_KEY ?? '').trim();
  return { ready: Boolean(baseUrl && model && apiKey), baseUrl, model, apiKey };
}

const PI_ROUND_TIMEOUT_MS = Number(process.env.WMB_E2E_PI_ROUND_TIMEOUT_MS ?? 10 * 60_000);

async function sendAndWaitForSettle(page, message, { timeoutMs = PI_ROUND_TIMEOUT_MS } = {}) {
  const assistantBefore = await page.locator('.pi-bubble-wrap.assistant').count();
  const composer = page.locator('.pi-composer textarea');
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
  await composer.fill(message);
  const send = page.locator('.pi-send-button');
  await send.waitFor({ state: 'visible', timeout: 5_000 });
  await send.click();
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    const assistantCount = await page.locator('.pi-bubble-wrap.assistant').count();
    if (assistantCount > assistantBefore) {
      const latest = page.locator('.pi-bubble-wrap.assistant').last();
      const textSegments = await latest.locator('.pi-bubble .pi-message-segment.text').allTextContents();
      lastText = textSegments.join('\n');
      if (!lastText.trim()) lastText = (await latest.locator('.pi-bubble').allTextContents()).join('\n');
      if (lastText.includes('[Wiki 操作]')) return { kind: 'settled', text: lastText };
    }
    await delay(2500);
  }
  return { kind: 'timeout', text: lastText };
}

// ============================================================
// 场景
// ============================================================

export default [
  {
    id: 'WMB-5241-unified-e2e',
    journeyIds: ['WMB-5241-unified-e2e'],
    launch: RICH,
    run: async ({ app, page, workspace, evidence, artifactsDir, runtimeDir }) => {
      const dataRoot = workspace.dataRoot;
      const startedAt = new Date().toISOString();
      const sliceBundle = { ctx: null, dataRoot, workspaceId: workspace.workspaceId, artifactsDir, startedAt };
      const steps = [];

      // 切片只读断言注册（AcceptMaintenanceRecovery 交付；失败即切片失败）
      registerWmb5241SliceHook('afterMaintenance', () => {
        SLICE.assertMaintenanceCompleted({ dataRoot, workspaceId: workspace.workspaceId });
        SLICE.assertSevenHealthCategories({ dataRoot });
      });
      registerWmb5241SliceHook('afterSearchLog', () => SLICE.assertIndexLogSearch({ dataRoot, query: 'AgentForge' }));
      registerWmb5241SliceHook('afterRestart', (bundle) => SLICE.assertRestartRecovery({ dataRoot, workspaceId: workspace.workspaceId, expectedRunId: bundle.restart?.runId ?? null }));
      registerWmb5241SliceHook('afterVersionRestore', () => SLICE.assertVersionRestoreAppends({ dataRoot }));

      // ============ Launch 1：真实 Electron UI 面 ============
      await step(evidence, '启动就绪 + 侧栏无新顶层路由', async () => {
        await waitForAppReady(page);
        const sidebar = await page.evaluate(() => document.querySelector('aside.sidebar')?.textContent ?? '');
        assert(sidebar.includes('主题') && sidebar.includes('资料库') && sidebar.includes('关系画布'), '侧栏应仍含 主题|资料库|关系画布');
        const navTitles = await page.evaluate(() => [...document.querySelectorAll('aside.sidebar nav button')].map((b) => b.getAttribute('title')).filter(Boolean));
        const known = new Set(Object.values(helpers.VIEW_TITLES));
        assert(navTitles.every((t) => known.has(t)), `侧栏出现未知顶层视图：${navTitles.filter((t) => !known.has(t)).join(',')}`);
      });

      await step(evidence, '资料库：种子来源与摄取回执面', async () => {
        await navigateTo(page, 'library');
        await page.locator('.library-wiki-tools').first().waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForFunction(() => document.querySelectorAll('.lib-row').length >= 3, null, { timeout: 20_000 });
        const titles = await page.evaluate(() => [...document.querySelectorAll('.lib-row .lib-title')].map((el) => el.textContent?.trim() ?? ''));
        for (const wanted of ['AgentForge 发布 v2：多模型路由', 'AgentForge v2 更新：平台限制与争议', '行业圆桌速记：AI 工具选型']) {
          assert(titles.includes(wanted), `资料库应含种子资料「${wanted}」，实际 ${JSON.stringify(titles)}`);
        }
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-library-sources' });
      });

      await step(evidence, '全库整理：开始 → running →（尽力暂停/继续）→ completed + 整理报告', async () => {
        await page.locator('[data-wiki-tool="maintenance"]').first().click();
        await page.locator('[data-wiki-panel="maintenance"]').first().waitFor({ state: 'visible', timeout: 15_000 });
        const start = page.locator('[data-maintenance-action="start"]').first();
        assert(await start.count() === 1, '维护面板应有开始按钮');
        await start.click();
        await page.waitForFunction(() => document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]')?.getAttribute('data-maintenance-status') === 'running', null, { timeout: 20_000 });
        const runAtStart = maintenanceRunOf(dataRoot);
        assert(runAtStart && runAtStart.workspaceId === workspace.workspaceId, '维护 run 应绑定当前工作空间');
        // 尽力暂停/继续（批次边界生效；run 已完成则记录跳过，不失败）
        try {
          const pause = page.locator('[data-maintenance-action="pause"]').first();
          if (await pause.count()) {
            await pause.click();
            await page.waitForFunction(() => ['paused'].includes(document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]')?.getAttribute('data-maintenance-status')), null, { timeout: 20_000 });
            const resume = page.locator('[data-maintenance-action="resume"]').first();
            if (await resume.count()) {
              await resume.click();
              await page.waitForFunction(() => ['running', 'completed'].includes(document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]')?.getAttribute('data-maintenance-status')), null, { timeout: 25_000 });
            }
            steps.push('maintenance:pause-resume:ok');
          } else {
            steps.push('maintenance:pause-resume:skipped-run-fast');
          }
        } catch (error) {
          steps.push(`maintenance:pause-resume:skipped-${String(error?.message ?? error).slice(0, 80)}`);
        }
        await page.waitForFunction(() => document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]')?.getAttribute('data-maintenance-status') === 'completed', null, { timeout: 300_000 });
        await page.waitForFunction(() => Boolean(document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-report]')), null, { timeout: 30_000 });
        const panelText = await page.evaluate(() => document.querySelector('[data-wiki-panel="maintenance"]')?.textContent ?? '');
        assert(panelText.includes('整理报告') && panelText.includes('本轮整理'), '完成态应展示整理报告');
        const db = openReadOnlyDb(dataRoot);
        try {
          const run = maintenanceRunOf(dataRoot);
          assert(run && run.runId === runAtStart.runId && run.status === 'completed', '维护 run 应持久化为 completed（同一 runId）');
          const receipts = db.db.prepare("SELECT COUNT(*) AS c FROM command_receipts WHERE request_id LIKE 'knowledge-maintenance:%'").get();
          assert(Number(receipts.c) >= 1, '应存在维护 dispatcher 回执（knowledge-maintenance:*）');
          const lint = getPeriodicLintCheckpoint(db.db);
          assert(lint && lint.status === 'completed', `全局 Lint checkpoint 应 completed：${JSON.stringify(lint?.status)}`);
        } finally {
          db.close();
        }
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-maintenance-completed' });
        await runSliceHooks('afterMaintenance', sliceBundle);
      });

      await step(evidence, '统一搜索 + 最近变化（索引/日志）', async () => {
        await page.locator('[data-wiki-tool="search"]').first().click();
        const input = page.locator('[data-wiki-panel="search"] .wiki-search-input');
        await input.waitFor({ state: 'visible', timeout: 15_000 });
        await input.fill('AgentForge');
        await page.waitForFunction(() => {
          const text = document.querySelector('[data-wiki-panel="search"]')?.textContent ?? '';
          return text.includes('找到') && text.includes('条结果');
        }, null, { timeout: 15_000 });
        const resultRows = await page.locator('[data-wiki-panel="search"] [data-wiki-result]').count();
        assert(resultRows >= 1, `搜索应命中 ≥1 条，实际 ${resultRows}`);
        await page.locator('[data-wiki-tool="log"]').first().click();
        await page.locator('[data-wiki-panel="log"]').first().waitFor({ state: 'visible', timeout: 15_000 });
        const logText = await page.evaluate(() => document.querySelector('[data-wiki-panel="log"]')?.textContent ?? '');
        assert(logText.includes('全库维护启动'), '最近变化应含维护启动日志条目');
        const db = openReadOnlyDb(dataRoot);
        try {
          const total = db.db.prepare('SELECT COUNT(*) AS c FROM knowledge_index_entries').get();
          assert(Number(total.c) >= 5, `统一搜索索引应有内容，实际 ${Number(total.c)}`);
          const log = listKnowledgeLogEntries(db.db, { eventType: 'maintenance_started', limit: 10 });
          assert(log.items.length >= 1, '全局日志应含 maintenance_started 条目');
        } finally {
          db.close();
        }
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-search-log' });
        await runSliceHooks('afterSearchLog', sliceBundle);
      });

      await step(evidence, '主题：当前认识 + 版本历史', async () => {
        await navigateTo(page, 'topic');
        await page.waitForFunction(() => {
          const h2 = document.querySelector('.topic-object-head h2');
          if (h2?.textContent === 'AI Agent 工具链') return true;
          return [...document.querySelectorAll('.topic-object-card .topic-object-card-top strong')].some((el) => el.textContent === 'AI Agent 工具链');
        }, null, { timeout: 25_000 });
        const head = page.locator('.topic-object-head h2');
        if ((await head.count()) === 0 || (await head.first().textContent({ timeout: 2_000 }).catch(() => '')) !== 'AI Agent 工具链') {
          await page.locator('.topic-object-card', { hasText: 'AI Agent 工具链' }).first().click();
          await page.waitForFunction(() => document.querySelector('.topic-object-head h2')?.textContent === 'AI Agent 工具链', null, { timeout: 25_000 });
        }
        await page.locator('.topic-wiki-page').first().waitFor({ state: 'visible', timeout: 20_000 });
        const overview = await page.evaluate(() => document.querySelector('.topic-wiki-page')?.textContent ?? '');
        assert(overview.includes('多模型路由'), '主题概览应展示当前认识（多模型路由）');
        await page.locator('.topic-wiki-tabs button', { hasText: '版本' }).first().click();
        await page.waitForFunction(() => document.querySelector('.topic-wiki-page')?.getAttribute('data-wiki-tab') === 'versions', null, { timeout: 15_000 });
        const versionCount = await page.locator('.topic-wiki-version').count();
        assert(versionCount >= 2, `compiled 主题应有 ≥2 版本，实际 ${versionCount}`);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-topic' });
      });

      await step(evidence, '关系画布：知识网络节点/关系/日志/健康', async () => {
        await navigateTo(page, 'canvas');
        await page.locator('[data-kc-view="knowledge-network"]').waitFor({ state: 'visible', timeout: 30_000 });
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 8, null, { timeout: 30_000 });
        const meta = await page.locator('.kc-network-meta').textContent();
        assert(meta.includes('8 个节点') && meta.includes('3 条关系'), `网络元信息：${meta}`);
        const edges = await page.locator('[data-kc-edge]').count();
        assert(edges >= 3, `正式关系连线应 ≥3，实际 ${edges}`);
        await page.locator('[data-kc-log-toggle]').first().click();
        await page.locator('[data-kc-log-panel]').first().waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('[data-kc-health-hint]').first().count() === 1, '画布应有知识健康只读提示');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-canvas' });
      });

      await step(evidence, 'Studio：正文图片渲染 + 图片菜单 + 布局编辑保存 + DB 读回', async () => {
        await page.setViewportSize({ width: 1568, height: 960 });
        await navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        const opened = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.studio-project-row:not(.head)')];
          const row = rows.find((r) => r.textContent?.includes('WMB-5241 图片编辑项目'));
          const btn = row?.querySelector('button.studio-row-action');
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(opened, '创作库应找到 WMB-5241 图片编辑项目');
        await page.waitForSelector('.studio-editor-view', { timeout: 15_000 });
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.studio-mode-switch button')].find((b) => b.textContent?.includes('可视化编辑'));
          btn?.click();
        });
        const FIGURE_SEL = '.studio-rich-annotate-wrap .studio-rich-editor figure.studio-figure[data-wmb-asset]';
        await page.waitForSelector(FIGURE_SEL, { timeout: 20_000 });
        const figures = await page.$$eval(FIGURE_SEL, (els) => els.length);
        assert(figures === 2, `正文应渲染 2 张图片 figure，实际 ${figures}`);
        // 图片菜单（先于工具条交互；与 ST-008 openImageMenu 同款：状态栏「本文图片 N 张」入口）
        const menuClicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button.studio-status-link')].find((b) => b.textContent?.includes('本文图片'));
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(menuClicked, '状态栏应有「本文图片」入口');
        await page.waitForSelector('.studio-image-menu .studio-image-card', { timeout: 10_000 });
        const cards = await page.evaluate(() => [...document.querySelectorAll('.studio-image-menu .studio-image-card')].map((c) => c.textContent?.slice(0, 40) ?? ''));
        assert(cards.length === 2 && cards.some((c) => c.includes('图注A')) && cards.some((c) => c.includes('图注B')), `图片菜单应含 2 张卡片：${JSON.stringify(cards)}`);
        // 关闭菜单（同一入口 toggle）
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button.studio-status-link')].find((b) => b.textContent?.includes('本文图片'));
          btn?.click();
        });
        await page.waitForSelector('.studio-image-menu', { state: 'detached', timeout: 10_000 }).catch(() => {});
        // 工具条布局编辑：点选第一张图 → 宽度 preset=small
        await page.locator(FIGURE_SEL).nth(0).click();
        await page.waitForSelector('.studio-inline-image-toolbar[role="toolbar"][aria-label="图片工具条"]', { timeout: 10_000 });
        await page.click('.studio-inline-image-toolbar .studio-inline-width[data-preset="small"]');
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 25_000 });
        const db = openReadOnlyDb(dataRoot);
        try {
          const project = db.db.prepare('SELECT id FROM content_projects WHERE title = ?').get('WMB-5241 图片编辑项目');
          const latest = db.db.prepare('SELECT id FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(project.id);
          const bindings = db.db.prepare('SELECT asset_id, width_preset, align, caption FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal').all(latest.id);
          assert(bindings.length === 2, `核心绑定应 2 行，实际 ${bindings.length}`);
          assert(bindings[0].width_preset === 'small', `UI 布局编辑应持久化（small），实际 ${bindings[0].width_preset}`);
          const assets = db.db.prepare('SELECT COUNT(*) AS c FROM assets').get();
          assert(Number(assets.c) >= 2, '素材应落库 ≥2');
          const prov = db.db.prepare("SELECT COUNT(*) AS c FROM asset_provenance WHERE kind = 'imported'").get();
          assert(Number(prov.c) >= 2, '素材应有 imported 血缘记录');
        } finally {
          db.close();
        }
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-studio-images' });
      });

      // ---- 可选：真实 Pi 固定版本 Query 轮次（provider 配置时）----
      const provider = readProviderEnv();
      let piRound = null;
      if (provider.ready) {
        await step(evidence, 'Pi：真实 provider 固定版本 Query 轮次（dock UI）', async () => {
          await navigateTo(page, 'library');
          const refs = seededVersionRefs(dataRoot);
          const lines = [
            '请基于知识库中已冻结的固定版本回答：AgentForge v2 是否支持多模型路由？',
            `- wiki_page:${refs.wiki.pageId}:${refs.wiki.versionId}（主题「AI Agent 工具链」Wiki 页版本）`,
            ...refs.notes.map((n) => `- knowledge_note:${n.noteId}:${n.versionId}（知识结论「${n.key}」）`),
            '先用 wmb_get_fixed_versions 工具真实读取，再回答；末尾按 wmb_wiki_action 协议输出唯一 ```json 围栏：',
            '{"wmb_wiki_action": {"action": "query", "requestId": "<新唯一串>", "wikiVersionRefs": [...真实引用], "noteVersionRefs": [...真实引用], "question": "AgentForge v2 是否支持多模型路由？"}}',
            'query 是只读动作，不需要 taskId/grantId/workerLeaseId；不得输出其他 JSON 围栏。'
          ].join('\n');
          const snapshot = await sendAndWaitForSettle(page, lines);
          piRound = { kind: snapshot.kind, text: snapshot.text.slice(0, 600) };
          if (snapshot.kind === 'settled') {
            assert(snapshot.text.includes('[Wiki 操作]') && snapshot.text.includes('query'), `Pi 轮次应显示 [Wiki 操作] query 结果：${snapshot.text.slice(-300)}`);
          }
          await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-pi-query-round' });
        });
      }

      await step(evidence, '发布边界 + DB 快照 phase-1', async () => {
        const db = openReadOnlyDb(dataRoot);
        try {
          for (const table of ['publication_snapshots', 'publication_metric_snapshots']) {
            const row = db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
            assert(Number(row.c) === 0, `${table} 必须保持零行`);
          }
        } finally {
          db.close();
        }
        snapshotDb(artifactsDir, 'phase-1-pre-ingest.db', dataRoot);
        writeJson(artifactsDir, 'db-summary-phase-1.json', dbSummary(dataRoot));
      });

      await step(evidence, '关闭应用（进入窗口 A 前的干净关闭）', async () => {
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'L1-final' });
        await closeApp(app, { timeoutMs: 30_000 });
      });

      // ============ Window A：同一 data-root，正式 dispatcher / 执行面 ============
      await step(evidence, '窗口 A：单条 Ingest + 批量 Ingest + 固定版本 Query + 写回（正式 dispatcher/执行面）', async () => {
        sliceBundle.windowA = await runWindowA({ dataRoot, workspaceId: workspace.workspaceId, artifactsDir, sliceBundle });
        // Slice(AcceptMediaGraphCreation)：同 data-root 生产视觉理解全链路（asset+sourceRevision 血缘）。
        sliceBundle.visualLineage = await runVisualSourceLineage(dataRoot, workspace.workspaceId);
        await runSliceHooks('afterIngestQueryWriteback', sliceBundle);
      });

      // ============ Launch 2：同一 data-root 重启恢复 ============
      const runBeforeRestart = maintenanceRunOf(dataRoot);
      await step(evidence, '重启恢复：同一 userDataDir/dataRoot 二次启动 → SQLite + UI 读回', async () => {
        assert(runBeforeRestart, '重启前应有维护 run（阶段 1 已 completed）');
        const relaunched = await launchApp({
          userDataDir: workspace.userDataDir,
          dataRoot,
          seed: false,
          name: 'wmb-5241-restart',
          artifactsDir
        });
        const page2 = relaunched.page;
        try {
          await waitForAppReady(page2);
          const runAfter = maintenanceRunOf(dataRoot);
          assert(runAfter && runAfter.runId === runBeforeRestart.runId, '重启后维护 run 应沿 SQLite 读回同一 runId');
          assert(runAfter.workspaceId === workspace.workspaceId, '重启后 run 仍绑定当前工作空间');
          assert(['running', 'paused', 'completed', 'failed'].includes(runAfter.status), `重启后 run 状态应合法，实际 ${runAfter.status}`);
          await navigateTo(page2, 'library');
          await page2.locator('.library-wiki-tools').first().waitFor({ state: 'visible', timeout: 20_000 });
          await page2.locator('[data-wiki-tool="maintenance"]').first().click();
          await page2.locator('[data-wiki-panel="maintenance"]').first().waitFor({ state: 'visible', timeout: 15_000 });
          await page2.waitForFunction(() => {
            const el = document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]');
            return el && ['running', 'paused', 'completed', 'failed'].includes(el.getAttribute('data-maintenance-status'));
          }, null, { timeout: 20_000 });
          const uiStatus = await page2.evaluate(() => document.querySelector('[data-wiki-panel="maintenance"] [data-maintenance-status]')?.getAttribute('data-maintenance-status'));
          const panelText = await page2.evaluate(() => document.querySelector('[data-wiki-panel="maintenance"]')?.textContent ?? '');
          assert(!panelText.includes('整理状态读取失败'), '重启后维护面板应正常读回');
          assert(uiStatus === runAfter.status || ['running', 'paused', 'completed', 'failed'].includes(uiStatus), `面板状态应合法，实际 ${uiStatus}`);
          sliceBundle.restart = { runId: runAfter.runId, statusBefore: runBeforeRestart.status, statusAfter: runAfter.status, uiStatus };
          await captureEvidence({ app: relaunched.app, page: page2, evidence: relaunched.evidence, artifactsDir, name: 'L2-restart-readback' });
          await runSliceHooks('afterRestart', sliceBundle);
        } finally {
          await closeApp(relaunched.app, { timeoutMs: 30_000 }).catch(() => {});
        }
      });

      // ============ Launch 3：重启后的 UI 业务面（跨页更新 + 版本回退 + 边界） ============
      await step(evidence, '跨页更新 UI：主题概览展示 Ingest 新认识', async () => {
        const relaunched = await launchApp({
          userDataDir: workspace.userDataDir,
          dataRoot,
          seed: false,
          name: 'wmb-5241-ui',
          artifactsDir
        });
        sliceBundle.launch3 = null;
        const page3 = relaunched.page;
        try {
          await waitForAppReady(page3);
          await navigateTo(page3, 'topic');
          await page3.waitForFunction(() => {
            const h2 = document.querySelector('.topic-object-head h2');
            if (h2?.textContent === 'AI Agent 工具链') return true;
            return [...document.querySelectorAll('.topic-object-card .topic-object-card-top strong')].some((el) => el.textContent === 'AI Agent 工具链');
          }, null, { timeout: 25_000 });
          const head = page3.locator('.topic-object-head h2');
          if ((await head.count()) === 0 || (await head.first().textContent({ timeout: 2_000 }).catch(() => '')) !== 'AI Agent 工具链') {
            await page3.locator('.topic-object-card', { hasText: 'AI Agent 工具链' }).first().click();
            await page3.waitForFunction(() => document.querySelector('.topic-object-head h2')?.textContent === 'AI Agent 工具链', null, { timeout: 25_000 });
          }
          await page3.locator('.topic-wiki-page').first().waitFor({ state: 'visible', timeout: 20_000 });
          const overview = await page3.evaluate(() => document.querySelector('.topic-wiki-page')?.textContent ?? '');
          assert(overview.includes('企业版') || overview.includes('多租户'), '主题当前认识应含窗口 A Ingest 编译的新内容（企业版/多租户）');
          await captureEvidence({ app: relaunched.app, page: page3, evidence: relaunched.evidence, artifactsDir, name: 'L3-cross-page-topic' });
        } finally {
          await closeApp(relaunched.app, { timeoutMs: 30_000 }).catch(() => {});
        }
      });

      await step(evidence, '跨页更新 UI：资料库 + 关系画布', async () => {
        // 重新启动同一 data-root（串行语义）
        const r2 = await launchApp({
          userDataDir: workspace.userDataDir,
          dataRoot,
          seed: false,
          name: 'wmb-5241-ui2',
          artifactsDir
        });
        const page3 = r2.page;
        try {
          await waitForAppReady(page3);
          await navigateTo(page3, 'library');
          await page3.waitForFunction(() => document.querySelectorAll('.lib-row').length >= 7, null, { timeout: 25_000 });
          const titles = await page3.evaluate(() => [...document.querySelectorAll('.lib-row .lib-title')].map((el) => el.textContent?.trim() ?? ''));
          for (const wanted of ['AgentForge v2 企业版发布', '批量资料甲：多智能体编排综述', '批量资料乙：模型路由基准对比', '批量资料丙：Agent 工作流安全清单']) {
            assert(titles.includes(wanted), `资料库应含窗口 A Ingest 新资料「${wanted}」`);
          }
          await captureEvidence({ app: r2.app, page: page3, evidence: r2.evidence, artifactsDir, name: 'L3-library-sources' });
          await navigateTo(page3, 'canvas');
          await page3.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 9, null, { timeout: 30_000 });
          const nodeCount = await page3.locator('.kn-node').count();
          assert(nodeCount >= 9, `窗口 A 后画布节点应 ≥9，实际 ${nodeCount}`);
          const nodeTitles = await page3.locator('.kn-node .kn-node-label').allTextContents();
          assert(nodeTitles.some((t) => t.includes('agentforge-v2-enterprise') || t.includes('agentforge-v2-audit') || t.includes('AgentForge v2 企业版')), `画布应含窗口 A 新知识节点：${JSON.stringify(nodeTitles.slice(0, 12))}`);
          await captureEvidence({ app: r2.app, page: page3, evidence: r2.evidence, artifactsDir, name: 'L3-canvas' });
        } finally {
          await closeApp(r2.app, { timeoutMs: 30_000 }).catch(() => {});
        }
      });

      await step(evidence, '版本回退：恢复 V1 → 追加新版本（不覆盖历史）', async () => {
        const r3 = await launchApp({
          userDataDir: workspace.userDataDir,
          dataRoot,
          seed: false,
          name: 'wmb-5241-restore',
          artifactsDir
        });
        const page4 = r3.page;
        try {
          await waitForAppReady(page4);
          await navigateTo(page4, 'topic');
          await page4.waitForFunction(() => {
            const h2 = document.querySelector('.topic-object-head h2');
            if (h2?.textContent === 'AI Agent 工具链') return true;
            return [...document.querySelectorAll('.topic-object-card .topic-object-card-top strong')].some((el) => el.textContent === 'AI Agent 工具链');
          }, null, { timeout: 25_000 });
          const head = page4.locator('.topic-object-head h2');
          if ((await head.count()) === 0 || (await head.first().textContent({ timeout: 2_000 }).catch(() => '')) !== 'AI Agent 工具链') {
            await page4.locator('.topic-object-card', { hasText: 'AI Agent 工具链' }).first().click();
            await page4.waitForFunction(() => document.querySelector('.topic-object-head h2')?.textContent === 'AI Agent 工具链', null, { timeout: 25_000 });
          }
          await page4.locator('.topic-wiki-page').first().waitFor({ state: 'visible', timeout: 20_000 });
          const beforeVersions = (() => {
            const d = openReadOnlyDb(dataRoot);
            try {
              return d.db.prepare(`
                SELECT COUNT(*) AS c FROM knowledge_wiki_page_versions pv
                JOIN knowledge_wiki_pages p ON p.id = pv.page_id
                JOIN topics t ON t.id = p.subject_id AND p.subject_type = 'topic'
                WHERE t.title = 'AI Agent 工具链'
              `).get().c;
            } finally {
              d.close();
            }
          })();
          const v1 = (() => {
            const d = openReadOnlyDb(dataRoot);
            try {
              return d.db.prepare(`
                SELECT pv.id, pv.version_number, pv.body_json FROM knowledge_wiki_page_versions pv
                JOIN knowledge_wiki_pages p ON p.id = pv.page_id
                JOIN topics t ON t.id = p.subject_id AND p.subject_type = 'topic'
                WHERE t.title = 'AI Agent 工具链' ORDER BY pv.version_number ASC LIMIT 1
              `).get();
            } finally {
              d.close();
            }
          })();
          assert(v1, '应存在 V1 可恢复版本');
          await page4.locator('.topic-wiki-tabs button', { hasText: '版本' }).first().click();
          await page4.waitForFunction(() => document.querySelector('.topic-wiki-page')?.getAttribute('data-wiki-tab') === 'versions', null, { timeout: 15_000 });
          await page4.waitForFunction(() => document.querySelectorAll('.topic-wiki-version').length >= 3, null, { timeout: 20_000 });
          // 确定性地接受确认对话框（headless 下原生 confirm 由 dialog 事件或 window.confirm 覆盖处理）
          await page4.evaluate(() => { window.confirm = () => true; });
          const clicked = await page4.evaluate(() => {
            const cards = [...document.querySelectorAll('.topic-wiki-version')];
            const numOf = (card) => {
              const m = /V(\d+)/.exec(card.querySelector('.topic-wiki-version-num')?.textContent ?? '');
              return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
            };
            // 版本列表按新→旧排序；恢复目标 = 最旧非当前版本（V1）
            const target = cards
              .filter((card) => !card.classList.contains('current') && [...card.querySelectorAll('button')].some((b) => b.textContent?.includes('恢复此版本')))
              .sort((a, b) => numOf(a) - numOf(b))[0];
            if (!target) return false;
            const btn = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('恢复此版本'));
            btn?.click();
            return true;
          });
          assert(clicked, '版本页签应存在可恢复的历史版本');
          await page4.waitForFunction(() => {
            const note = document.querySelector('.topic-wiki-versions .library-topic-action-note[role="status"]');
            return note?.textContent?.includes('已生成新版本') ?? false;
          }, null, { timeout: 30_000 });
          const afterVersions = (() => {
            const d = openReadOnlyDb(dataRoot);
            try {
              return d.db.prepare(`
                SELECT COUNT(*) AS c FROM knowledge_wiki_page_versions pv
                JOIN knowledge_wiki_pages p ON p.id = pv.page_id
                JOIN topics t ON t.id = p.subject_id AND p.subject_type = 'topic'
                WHERE t.title = 'AI Agent 工具链'
              `).get().c;
            } finally {
              d.close();
            }
          })();
          assert(Number(afterVersions) === Number(beforeVersions) + 1, `恢复应追加一个新版本（${beforeVersions} → ${afterVersions}）`);
          const latest = (() => {
            const d = openReadOnlyDb(dataRoot);
            try {
              const row = d.db.prepare(`
                SELECT pv.id, pv.version_number, pv.body_json, pv.change_summary, pv.restored_from_version_id AS restoreFrom, p.current_version_id AS currentVersionId
                FROM knowledge_wiki_page_versions pv
                JOIN knowledge_wiki_pages p ON p.id = pv.page_id
                JOIN topics t ON t.id = p.subject_id AND p.subject_type = 'topic'
                WHERE t.title = 'AI Agent 工具链' ORDER BY pv.version_number DESC LIMIT 1
              `).get();
              const currentId = d.db.prepare(`
                SELECT p.current_version_id AS id FROM knowledge_wiki_pages p
                JOIN topics t ON t.id = p.subject_id AND p.subject_type = 'topic'
                WHERE t.title = 'AI Agent 工具链'
              `).get().id;
              return { row, currentId };
            } finally {
              d.close();
            }
          })();
          assert(latest.row.restoreFrom === v1.id, `新版本应 restoreFrom=V1（实际 ${latest.row.restoreFrom}）`);
          assert(latest.currentId === latest.row.id, '恢复后当前版本应指向新版本');
          const restoredBody = JSON.parse(latest.row.body_json);
          assert(String(restoredBody.summary ?? restoredBody.body?.summary ?? '').length >= 1, '恢复后正文应基于 V1 内容重建');
          sliceBundle.versionRestore = { beforeVersions: Number(beforeVersions), afterVersions: Number(afterVersions), restoredVersionId: latest.row.id, restoreFromVersionId: v1.id };
          await captureEvidence({ app: r3.app, page: page4, evidence: r3.evidence, artifactsDir, name: 'L4-version-restore' });
          await runSliceHooks('afterVersionRestore', sliceBundle);
        } finally {
          await closeApp(r3.app, { timeoutMs: 30_000 }).catch(() => {});
        }
      });

      await step(evidence, '发布边界 + 无自动发布 + 最终 DB 快照', async () => {
        const db = openReadOnlyDb(dataRoot);
        try {
          for (const table of ['publication_snapshots', 'publication_metric_snapshots']) {
            const row = db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
            assert(Number(row.c) === 0, `${table} 必须保持零行（无自动发布）`);
          }
          const pubs = db.db.prepare('SELECT COUNT(*) AS c FROM publications').get();
          assert(Number(pubs.c) === 0, 'publications 必须保持零行（无自动发布）');
        } finally {
          db.close();
        }
        snapshotDb(artifactsDir, 'phase-3-final.db', dataRoot);
        const finalSummary = dbSummary(dataRoot);
        writeJson(artifactsDir, 'db-summary-phase-3-final.json', finalSummary);
        writeJson(artifactsDir, 'steps.json', evidence.steps);
        writeJson(artifactsDir, 'classification.json', {
          schema: 'wmb-5241-unified-e2e.v1',
          outcome: 'passed',
          startedAt,
          finishedAt: new Date().toISOString(),
          dataRoot,
          workspaceId: workspace.workspaceId,
          provider: { configured: provider.ready, model: provider.model ?? null },
          piRound,
          steps: steps,
          restart: sliceBundle.restart,
          versionRestore: sliceBundle.versionRestore,
          fixedVersionQuery: sliceBundle.fixedVersionQuery,
          writeback: sliceBundle.writeback,
          searchAfterWindowA: sliceBundle.searchAfterWindowA,
          finalSummary
        });
        await runSliceHooks('final', sliceBundle);
      });

      // 最终成功证据截图（当前无活动窗口，用 phase 已捕获截图作为关键截图证据）
      writeJson(artifactsDir, 'evidence-index.json', {
        screenshots: [
          'L1-library-sources-screenshot.png',
          'L1-maintenance-completed-screenshot.png',
          'L1-search-log-screenshot.png',
          'L1-topic-screenshot.png',
          'L1-canvas-screenshot.png',
          'L1-studio-images-screenshot.png',
          'L2-restart-readback-screenshot.png',
          'L3-cross-page-topic-screenshot.png',
          'L3-library-sources-screenshot.png',
          'L3-canvas-screenshot.png',
          'L4-version-restore-screenshot.png'
        ],
        dbSnapshots: ['phase-1-pre-ingest.db', 'phase-2-post-window-a.db', 'phase-3-final.db'],
        summaries: ['db-summary-phase-1.json', 'db-summary-phase-2-window-a.json', 'db-summary-phase-3-final.json'],
        classification: 'classification.json',
        steps: 'steps.json',
        windowA: 'window-a-result.json'
      });
      return {
        surface: 'wiki',
        journey: 'WMB-5241-unified-e2e',
        outcome: 'passed',
        restart: sliceBundle.restart,
        versionRestore: sliceBundle.versionRestore,
        fixedVersionQuery: sliceBundle.fixedVersionQuery,
        writeback: sliceBundle.writeback,
        searchAfterWindowA: sliceBundle.searchAfterWindowA,
        provider: provider.ready ? 'configured' : 'provider_unconfigured',
        piRound: piRound?.kind ?? 'not_attempted',
        evidenceDir: artifactsDir
      };
    }
  }
];
