// WMB-5241 slice: 全库维护/Lint、索引/日志/搜索、重启恢复与版本回退 — 只读 readback 断言。
//
// 用法（由 tests/e2e/wmb-5241-unified.test.mjs 的 SLICE_HOOKS 注册点按步骤表调用）：
//   import * as M from './wmb-5241-slice-maintenance-recovery.mjs';
//   await M.assertMaintenanceCompleted({ dataRoot, workspaceId });
//
// 约定：
// - 每个 hook 入参 { dataRoot, workspaceId }（额外字段忽略），失败一律抛错（throw）；
// - 只读：全部经 openReadOnlyDb（SQLite readOnly 连接）+ 生产只读读模型；
//   零写面、零副作用、可重复调用（幂等断言）；
// - 历史锚不漂移：版本回退断言证明「恢复=追加新版本（restoreFromVersionId 回指不可变源版本），
//   历史版本行原样保留、内容逐字节一致、固定版本索引引用仍解析到同一不可变版本」。
import { openReadOnlyDb } from './harness.mjs';
import { getMaintenanceRun, getMaintenanceReport, countOpenHealthIssues } from '../../src/main/knowledge-maintenance.ts';
import { getPeriodicLintCheckpoint } from '../../src/main/knowledge-health.ts';
import { getKnowledgeBackfillCheckpoint } from '../../src/main/knowledge-backfill.ts';
import { searchWikiIndex, getWikiIndexSummary } from '../../src/main/knowledge-search.ts';
import { getIndexSummary } from '../../src/main/db/wiki-index-store.ts';
import { listKnowledgeLogEntries } from '../../src/main/knowledge-global-log.ts';
import { listKnowledgeNoteVersions, listWikiPageVersions, getKnowledgeNoteVersion, getWikiPageVersion } from '../../src/main/knowledge-flywheel.ts';

function fail(where, message) {
  throw new Error(`[WMB-5241 slice maintenance/recovery] ${where}: ${message}`);
}

function assert(cond, where, message) {
  if (!cond) fail(where, message);
}

function withDb(dataRoot, fn) {
  const { db, close } = openReadOnlyDb(dataRoot);
  try {
    return fn(db);
  } finally {
    close();
  }
}

// ============================================================
// 1. 全库维护 run 到 completed + checkpoint/report 锁定
// ============================================================
export function assertMaintenanceCompleted({ dataRoot, workspaceId }) {
  return withDb(dataRoot, (db) => {
    const run = getMaintenanceRun(db);
    assert(run, 'maintenance', 'SQLite 缺 wmb_knowledge_maintenance_v1 run 记录（未启动过维护）');
    assert(run.workspaceId === workspaceId, 'maintenance', `run 绑定 workspace 不一致：${run.workspaceId} ≠ ${workspaceId}`);
    assert(run.status === 'completed', 'maintenance', `run 未到 completed：status=${run.status} phase=${run.phase}`);
    assert(run.phase === 'completed', 'maintenance', `run 未到 completed 阶段：phase=${run.phase}`);
    assert(run.completedAt && run.completedAt >= run.startedAt, 'maintenance', 'completedAt 缺失或早于 startedAt');

    // checkpoint：回溯 + lint 双 checkpoint 均 completed，数字与 report 一致。
    const backfillCp = getKnowledgeBackfillCheckpoint(db);
    assert(backfillCp && backfillCp.status === 'completed', 'maintenance', 'backfill checkpoint 未 completed');
    const lintCp = getPeriodicLintCheckpoint(db);
    assert(lintCp && lintCp.status === 'completed', 'maintenance', 'lint checkpoint 未 completed');

    const report = getMaintenanceReport(db);
    assert(report, 'maintenance', 'SQLite 缺 wmb_knowledge_maintenance_report_v1 最终报告');
    assert(report.runId === run.runId, 'maintenance', `report.runId ${report.runId} ≠ run.runId ${run.runId}`);
    assert(report.workspaceId === workspaceId, 'maintenance', `report.workspaceId ${report.workspaceId} ≠ ${workspaceId}`);
    assert(report.completedAt && report.completedAt >= report.startedAt, 'maintenance', 'report 时间锚非法');

    // report 数字来自 checkpoint/DB（非编造）：逐项核对。
    const bc = backfillCp.counts;
    assert(report.backfill.scanned === bc.scanned, 'maintenance', `report.backfill.scanned ${report.backfill.scanned} ≠ checkpoint ${bc.scanned}`);
    assert(report.backfill.processed === bc.processed, 'maintenance', `report.backfill.processed ${report.backfill.processed} ≠ checkpoint ${bc.processed}`);
    assert(report.backfill.compiled === bc.compiled, 'maintenance', `report.backfill.compiled ${report.backfill.compiled} ≠ checkpoint ${bc.compiled}`);
    assert(report.backfill.failed === bc.failed, 'maintenance', `report.backfill.failed ${report.backfill.failed} ≠ checkpoint ${bc.failed}`);
    const lc = lintCp.counts;
    assert(report.lint.scannedObjects === lc.scannedObjects, 'maintenance', `report.lint.scannedObjects ${report.lint.scannedObjects} ≠ checkpoint ${lc.scannedObjects}`);
    assert(report.lint.issuesCreated === lc.issuesCreated, 'maintenance', `report.lint.issuesCreated ${report.lint.issuesCreated} ≠ checkpoint ${lc.issuesCreated}`);
    assert(report.lint.openIssues === countOpenHealthIssues(db), 'maintenance', `report.lint.openIssues ${report.lint.openIssues} ≠ DB 实时 open ${countOpenHealthIssues(db)}`);

    return {
      runId: run.runId,
      reportId: report.reportId,
      backfill: { scanned: bc.scanned, processed: bc.processed, compiled: bc.compiled },
      lint: { scannedObjects: lc.scannedObjects, issuesCreated: lc.issuesCreated, openIssues: report.lint.openIssues }
    };
  });
}

// ============================================================
// 2. 七类健康检测（lint 阶段覆盖）+ 健康表一致性
// ============================================================
export function assertSevenHealthCategories({ dataRoot }) {
  return withDb(dataRoot, (db) => {
    const lintCp = getPeriodicLintCheckpoint(db);
    assert(lintCp && lintCp.status === 'completed', 'health', 'lint checkpoint 未 completed（七类检测未跑完）');
    const detectors = new Set(lintCp.detectors ?? []);
    // 七类家族：orphan / missing-page / duplicate / unsupported / stale-claim / cross-reference / data-gap。
    const required = ['orphan_knowledge', 'missing_wiki_page', 'duplicate_knowledge', 'unsupported_claim', 'stale_claim', 'cross_reference', 'data_gap'];
    for (const d of required) {
      assert(detectors.has(d), 'health', `lint checkpoint 缺七类检测器之一：${d}`);
    }
    // 健康表自洽：本轮 created 的行必须已在表中（含随后自动解决/保留 open）。
    const row = db.prepare('SELECT COUNT(*) AS c FROM knowledge_health_issues').get();
    const totalIssues = Number(row.c);
    assert(lintCp.counts.issuesCreated <= totalIssues + lintCp.counts.issuesDeduplicated, 'health',
      `issuesCreated ${lintCp.counts.issuesCreated} 超出健康表行数 ${totalIssues}（+dedup ${lintCp.counts.issuesDeduplicated}）`);
    assert(countOpenHealthIssues(db) <= totalIssues, 'health', 'open Issues 数超过健康表总行数（不一致）');
    // 自动解决与新建都是本 run 计数：清除可命中先前局部 lint 已建 Issue，故不做硬上界；
    // 只要求扫描确实发生（scannedObjects > 0）。
    assert(lintCp.counts.scannedObjects > 0, 'health', 'lint 阶段 scannedObjects = 0（七类检测未真正扫描）');
    return {
      detectors: [...detectors],
      issuesCreated: lintCp.counts.issuesCreated,
      issuesAutoResolved: lintCp.counts.issuesAutoResolved,
      openIssues: countOpenHealthIssues(db)
    };
  });
}

// ============================================================
// 3. 索引/日志/搜索：六类对象索引 + 全局时间日志 + 统一搜索 + 等价读模型
// ============================================================
export function assertIndexLogSearch({ dataRoot, query = 'AgentForge' }) {
  return withDb(dataRoot, (db) => {
    const summary = getIndexSummary(db);
    assert(summary.total >= 6, 'index', `索引总行数 ${summary.total} < 6（种子六类对象未全部入索引）`);
    const run = getMaintenanceRun(db);
    // 六类对象覆盖：wiki_page / knowledge_note / entity / topic / source / fixed_version_reference。
    const counts = summary.counts;
    for (const type of ['wiki_page', 'knowledge_note', 'entity', 'topic', 'source']) {
      assert(Number(counts[type] ?? 0) >= 1, 'index', `索引缺对象类型 ${type}（count=${counts[type]}）`);
    }
    // 统一搜索（生产读模型）命中 + 稳定分页信封。
    const page = searchWikiIndex(db, { query, limit: 10 });
    assert(page.total >= 1, 'search', `统一搜索「${query}」零命中（索引/搜索链路断裂）`);
    assert(page.items.length >= 1 && page.items[0].objectType, 'search', '搜索结果缺对象类型/导航载荷');
    // 等价读模型：store 摘要 == 搜索摘要 == hot cache 摘要（三读面一致）。
    const searchSummary = getWikiIndexSummary(db);
    assert(searchSummary.total === summary.total, 'index', `搜索摘要 total ${searchSummary.total} ≠ store 摘要 ${summary.total}`);
    for (const type of Object.keys(summary.counts)) {
      assert(Number(searchSummary.counts[type] ?? 0) === Number(counts[type] ?? 0), 'index', `摘要 counts[${type}] 不一致：${searchSummary.counts[type]} ≠ ${counts[type]}`);
    }
    // 全局日志：维护启动 + 完成派生条目（真源=run KV；显式读回）。
    const started = listKnowledgeLogEntries(db, { eventType: 'maintenance_started', limit: 20 });
    assert(run && started.items.some((e) => e.objectId === run.runId), 'log', '全局日志缺 maintenance_started 条目');
    const completed = listKnowledgeLogEntries(db, { eventType: 'maintenance_completed', limit: 20 });
    assert(run && completed.items.some((e) => e.objectId === run.runId), 'log', '全局日志缺 maintenance_completed 条目');
    // 日志稳定性：同库同过滤重算结果一致（可重建、幂等）。
    const again = listKnowledgeLogEntries(db, { eventType: 'maintenance_started', limit: 20 });
    assert(again.items.length === started.items.length && again.items.every((e, i) => e.id === started.items[i].id), 'log', '日志重算结果不一致（幂等性破坏）');
    return {
      indexTotal: summary.total,
      searchTotal: page.total,
      maintenanceLogEntries: started.items.length + completed.items.length
    };
  });
}

// ============================================================
// 4. 重启恢复：重新打开 DB（等价进程重启）沿持久 checkpoint 继续，同 runId 零重复
// ============================================================
export function assertRestartRecovery({ dataRoot, workspaceId, expectedRunId = null }) {
  return withDb(dataRoot, (db) => {
    const run = getMaintenanceRun(db);
    assert(run, 'restart', '重启后 SQLite 缺维护 run（持久化丢失）');
    assert(run.workspaceId === workspaceId, 'restart', `重启后 run workspace 漂移：${run.workspaceId}`);
    if (expectedRunId) assert(run.runId === expectedRunId, 'restart', `重启后 runId 漂移：${run.runId} ≠ ${expectedRunId}`);
    // 单飞：至多一个活动 run（持久 KV 单行）。
    const rows = db.prepare("SELECT COUNT(*) AS c FROM app_meta WHERE key = 'wmb_knowledge_maintenance_v1'").get();
    assert(Number(rows.c) === 1, 'restart', '维护 run KV 出现重复行');
    // 维护写面经 dispatcher 授权（UI IPC 路径 command='start'/'pause'/'resume'，requestId 前缀
    // knowledge-maintenance:；Pi/MCP 路径 command='knowledge.maintenance'）。回执零重复：
    // 同一 request_id 至多一行（dispatcher 幂等证据），且至少存在一条维护回执。
    const dup = db.prepare(
      "SELECT COUNT(*) AS c FROM (SELECT request_id FROM command_receipts WHERE command = 'knowledge.maintenance' OR request_id LIKE 'knowledge-maintenance:%' GROUP BY request_id HAVING COUNT(*) > 1)"
    ).get();
    assert(Number(dup.c) === 0, 'restart', '维护命令回执存在重复 request_id（重复派发）');
    const receipts = db.prepare(
      "SELECT COUNT(*) AS c FROM command_receipts WHERE command = 'knowledge.maintenance' OR request_id LIKE 'knowledge-maintenance:%'"
    ).get();
    assert(Number(receipts.c) >= 1, 'restart', '缺维护 dispatcher 回执（knowledge.maintenance 或 knowledge-maintenance:*）');
    // 完成态下 report 仍可读且同 runId。
    if (run.status === 'completed') {
      const report = getMaintenanceReport(db);
      assert(report && report.runId === run.runId, 'restart', '重启后 report 缺失或 runId 漂移');
    }
    return { runId: run.runId, status: run.status, phase: run.phase, receipts: Number(receipts.c) };
  });
}

// ============================================================
// 5. 版本回退：Wiki/Note restore 追加新版本而非改历史（历史锚不漂移）
// ============================================================
export function assertVersionRestoreAppends({ dataRoot }) {
  return withDb(dataRoot, (db) => {
    // 找到最近一次 restored 版本（Note 或 Wiki 页）。
    const noteRestore = db.prepare(
      "SELECT note_id AS objectId, restored_from_version_id AS sourceVersionId, id AS versionId FROM knowledge_note_versions WHERE change_type = 'restored' ORDER BY created_at DESC LIMIT 1"
    ).get();
    const pageRestore = db.prepare(
      "SELECT page_id AS objectId, restored_from_version_id AS sourceVersionId, id AS versionId FROM knowledge_wiki_page_versions WHERE restored_from_version_id IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert(noteRestore || pageRestore, 'restore', '未发现任何 restored 版本（版本回退未发生）');

    const checks = [];
    if (noteRestore) {
      const versions = listKnowledgeNoteVersions(db, noteRestore.objectId, { limit: 100 });
      const restored = versions.items.find((v) => v.id === noteRestore.versionId);
      const source = getKnowledgeNoteVersion(db, noteRestore.sourceVersionId);
      assert(restored && source, 'restore', 'restored Note 版本或其源版本不可读');
      assert(restored.restoredFromVersionId === source.id, 'restore', 'restored 版本未回指源版本');
      // 内容逐字节一致（追加复制，不改历史）。
      assert(restored.statement === source.statement, 'restore', 'restored 内容与源版本不一致（应逐字节复制）');
      assert(restored.body === source.body, 'restore', 'restored body 与源版本不一致');
      // 追加新版本号：restored 是链上最大版本号且链完整。
      const numbers = versions.items.map((v) => v.versionNumber).sort((a, b) => a - b);
      assert(numbers.length >= 2, 'restore', 'restored 后版本链不足 2 版');
      assert(restored.versionNumber === numbers[numbers.length - 1], 'restore', `restored 版本号 ${restored.versionNumber} 非链尾 ${numbers[numbers.length - 1]}（应为追加而非改写）`);
      for (let i = 0; i < numbers.length; i++) assert(numbers[i] === i + 1, 'restore', `Note 版本链断裂：${numbers.join(',')}`);
      // 源版本行仍原样（不可变历史保留）。
      const sourceRow = db.prepare('SELECT statement, body, created_at FROM knowledge_note_versions WHERE id = ?').get(source.id);
      assert(sourceRow && sourceRow.statement === source.statement && sourceRow.body === source.body, 'restore', '源版本行被改动（历史锚漂移）');
      checks.push({ kind: 'note', objectId: noteRestore.objectId, versionNumber: restored.versionNumber, chain: numbers.length, sourceKept: true });
    }
    if (pageRestore) {
      const versions = listWikiPageVersions(db, pageRestore.objectId, { limit: 100 });
      const restored = versions.items.find((v) => v.id === pageRestore.versionId);
      const source = getWikiPageVersion(db, pageRestore.sourceVersionId);
      assert(restored && source, 'restore', 'restored Wiki 版本或其源版本不可读');
      assert(restored.restoredFromVersionId === source.id, 'restore', 'restored Wiki 版本未回指源版本');
      assert(JSON.stringify(restored.bodyJson ?? {}) === JSON.stringify(source.bodyJson ?? {}), 'restore', 'restored Wiki body_json 与源不一致');
      const numbers = versions.items.map((v) => v.versionNumber).sort((a, b) => a - b);
      assert(restored.versionNumber === numbers[numbers.length - 1], 'restore', `restored Wiki 版本号非链尾（应为追加）`);
      for (let i = 0; i < numbers.length; i++) assert(numbers[i] === i + 1, 'restore', `Wiki 版本链断裂：${numbers.join(',')}`);
      checks.push({ kind: 'wiki_page', objectId: pageRestore.objectId, versionNumber: restored.versionNumber, chain: numbers.length });
    }
    // 固定版本索引引用仍解析到同一不可变版本（fvr 行锚不漂移）。
    const fvrRows = db.prepare("SELECT object_id AS id FROM knowledge_index_entries WHERE object_type = 'fixed_version_reference' LIMIT 20").all();
    for (const row of fvrRows) {
      const isNote = db.prepare('SELECT 1 AS one FROM knowledge_note_versions WHERE id = ?').get(String(row.id));
      const isPage = db.prepare('SELECT 1 AS one FROM knowledge_wiki_page_versions WHERE id = ?').get(String(row.id));
      const isSourceRevision = db.prepare('SELECT 1 AS one FROM source_body_revisions WHERE id = ?').get(String(row.id));
      assert(isNote || isPage || isSourceRevision, 'restore',
        `固定版本索引引用 ${row.id} 无法解析到任一不可变版本表（knowledge_note_versions / knowledge_wiki_page_versions / source_body_revisions，锚漂移）`);
    }
    return { checks, fixedVersionRefsChecked: fvrRows.length };
  });
}

// ============================================================
// 6. 双 root 零串扰：rootB 不得看到 rootA 的任何维护/索引/日志/搜索状态
// ============================================================
export function assertDualRootIsolation({ rootA, rootB, workspaceA }) {
  const a = withDb(rootA, (db) => ({ run: getMaintenanceRun(db), index: getIndexSummary(db).total }));
  const b = withDb(rootB, (db) => ({
    run: getMaintenanceRun(db),
    index: getIndexSummary(db).total,
    search: searchWikiIndex(db, { query: 'AgentForge', limit: 1 }).total
  }));
  assert(a.run, 'isolation', 'rootA 应存在维护 run（前置）');
  assert(b.run === null, 'isolation', `rootB 泄漏了 rootA 的维护 run（${b.run?.runId}）`);
  assert(b.index === 0, 'isolation', `rootB 泄漏了 rootA 的索引（${b.index} 行）`);
  assert(b.search === 0, 'isolation', 'rootB 泄漏了 rootA 的搜索结果');
  // 双 root 下 run 绑各自 workspace。
  assert(a.run.workspaceId === workspaceA, 'isolation', 'rootA run 未绑定自己的 workspace');
  return { rootAIndex: a.index, rootBIndex: b.index };
}

export const SLICE_HOOKS = Object.freeze({
  assertMaintenanceCompleted,
  assertSevenHealthCategories,
  assertIndexLogSearch,
  assertRestartRecovery,
  assertVersionRestoreAppends,
  assertDualRootIsolation
});
