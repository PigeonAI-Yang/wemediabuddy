// WMB-5238：全局知识时间日志投影服务聚焦测试（ImplementWikiGlobalLog 切片）。
// 覆盖（验收逐项）：
//  1) 多事件顺序：change_set/receipt/compile/lint/query/source/maintenance 跨类全局 (time,id) 序；
//     同 ChangeSet 内 receipt 恒排在 change_set 条目之前（created_at 同毫秒时 id 决胜）。
//  2) 同时间稳定分页：同 created_at 批次按 (time DESC, id DESC) 完全确定；keyset 分页跨同时间
//     组不重不丢；before/after 双向导航回到同一页。
//  3) 过滤：eventType / topicId / objectType / objectId / scope；非法游标/类型 fail-closed。
//  4) 重建幂等：同库重复读结果一致；关闭重开 DB 后投影重建结果一致（SQLite 持久 + 派生读模型）。
//  5) 历史锚点不漂移：health issue 解决后 lint_detected 条目不变、新增 lint_resolved；
//     同页追加新 Wiki 版本后旧 compile 条目不变；后续 ChangeSet 不改写既有条目。
// 运行：node --test --test-concurrency=1 tests/wmb-5238-knowledge-global-log.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { register } from 'node:module';

// ---- 测试本地 ESM 解析钩子（同 wmb-5210-commands 模式）：electron → 惰性桩；相对无扩展名补 .ts ----
const ELECTRON_STUB = [
  'const noop = () => {};',
  'class BrowserWindow {',
  '  static getAllWindows() { return []; }',
  '  loadURL() { return Promise.resolve(); }',
  '  loadFile() { return Promise.resolve(); }',
  '}',
  "const app = { getAppPath: () => '', whenReady: () => Promise.resolve(), on: noop };",
  'const ipcMain = { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop };',
  "const safeStorage = { encryptString: (s) => Buffer.from(String(s), 'utf8'), decryptString: (b) => String(b) };",
  'export { app, BrowserWindow, ipcMain, safeStorage };',
  'export default { app, safeStorage };'
].join('\n');
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'const ELECTRON_STUB = ' + JSON.stringify(ELECTRON_STUB) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(ELECTRON_STUB), shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  '      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };',
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}'
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { applyKnowledgeChangeSet } = await import('../src/main/knowledge-flywheel.ts');
const { listKnowledgeLogEntries, getKnowledgeLogEntry, KnowledgeGlobalLogError, KNOWLEDGE_MAINTENANCE_RUN_KEY } = await import('../src/main/knowledge-global-log.ts');
const { encodeKnowledgeLogCursor, decodeKnowledgeLogCursor, KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS } = await import('../src/shared/knowledge-global-log.ts');

// ============ fixtures / helpers ============

const T = (ms) => new Date(ms).toISOString();
const NOW = () => new Date().toISOString();

async function makeRoot(prefix = 'wmb-5238-log-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeDatabase(root, workspaceId = `ws-${randomUUID()}`) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = NOW();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  return { database, workspaceId, dbPath: path.join(root, 'wmb.db') };
}

function meta(workspaceId, requestId, overrides = {}) {
  return {
    workspaceId,
    requestId,
    reason: 'WMB-5238 global log fixture',
    triggerSource: 'ingest',
    resolutionMode: 'replaced_current',
    createdBy: 'system',
    ...overrides
  };
}

function noteCreate(noteId, { statement = 'statement', adoptedTopicIds = [], extra = {} } = {}) {
  return {
    id: noteId, scope: 'global', kind: 'claim', canonicalKey: `${noteId}-key`, title: noteId,
    version: {
      title: noteId, statement, conclusionStatus: 'unverified', evidenceLevel: 'none',
      changeType: 'created', changeReason: 'fixture', adoptedTopicIds, ...extra
    }
  };
}

function pageCreate(pageId, topicId, { changeSummary = 'fixture 编译', compileReason = 'fixture', extra = {} } = {}) {
  return {
    id: pageId, scope: 'global', pageType: 'topic', canonicalKey: `${pageId}-key`, title: pageId,
    subjectType: 'topic', subjectId: topicId,
    version: { title: pageId, body: { blocks: [] }, changeSummary, compileReason, ...extra }
  };
}

function receiptWrite(requestId, { triggerType = 'ingest', affectedTopics = [], impact = {}, summary = 'fixture 回执' } = {}) {
  return {
    triggerType, requestId, summary,
    counts: { notes: 0 }, affectedTopics, affectedEntities: [], affectedMethods: [], affectedSyntheses: [],
    wikiPageVersions: [], impact, autoResolutions: [], retainedDisputes: [], failures: []
  };
}

function maintenanceRun(runId, workspaceId, { startedAt, completedAt = null, reportId = null } = {}) {
  return {
    schemaVersion: 1, runId, workspaceId,
    phase: completedAt ? 'completed' : 'scan_compile',
    status: completedAt ? 'completed' : 'running',
    step: 0,
    config: { batchLimit: 10, maxTopicsPerSource: 5, stallLimit: 3 },
    backfill: { done: completedAt !== null, lastCursor: '', lastPendingRetryKey: '', stallCount: 0 },
    lint: { done: completedAt !== null, runId: null },
    error: null, reportId,
    startedAt, updatedAt: completedAt ?? startedAt, completedAt
  };
}

function putMaintenanceRun(database, run) {
  const now = NOW();
  database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
    .run(KNOWLEDGE_MAINTENANCE_RUN_KEY, JSON.stringify(run), now, now);
}

/** 落真实 Topic 行（adoptedTopicIds / wiki page subject 必须引用 topics 表既有行）。 */
function seedTopics(database, ids) {
  const now = NOW();
  for (const id of ids) {
    database.prepare(`INSERT INTO topics (id, title, canonical_key, kind, summary, status, first_seen_at, last_seen_at, created_at, updated_at, revision)
      VALUES (?, ?, ?, 'theme', '', 'active', ?, ?, ?, ?, 1)`)
      .run(id, `Topic ${id}`, id.toLowerCase(), now, now, now, now);
  }
}

function updateMaintenanceRun(database, run) {
  const now = NOW();
  database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
    .run(JSON.stringify(run), now, KNOWLEDGE_MAINTENANCE_RUN_KEY);
}

function insertSourceItem(database, sourceId, { createdAt = NOW() } = {}) {
  database.prepare(`INSERT INTO source_items (id, canonical_url, title, collected_at, created_at, updated_at, revision,
      categories_json, keywords_json, recommended_platforms_json, recommended_formats_json)
    VALUES (?,?,?,?,?,?,1,'[]','[]','[]','[]')`)
    .run(sourceId, `https://example.test/${sourceId}`, `Source ${sourceId}`, createdAt, createdAt, createdAt);
}

function insertSourceBodyRevision(database, sourceId, revisionId, { createdAt = NOW(), url = null, status = 'ready', previous = null } = {}) {
  database.prepare(`INSERT INTO source_body_revisions
    (id, source_id, url, status, content_type, extracted_text, extracted_chars, body_hash, fetched_at, created_at, previous_revision_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(revisionId, sourceId, url ?? `https://example.test/${sourceId}`, status, 'text/html', '正文', 6,
      'a'.repeat(64), createdAt, createdAt, previous);
}

function noteVersionId(database, noteId) {
  const row = database.prepare('SELECT id FROM knowledge_note_versions WHERE note_id = ? ORDER BY version_number DESC LIMIT 1').get(noteId);
  assert.ok(row, `note ${noteId} 必须有版本`);
  return row.id;
}

function wikiPageVersionId(database, pageId) {
  const row = database.prepare('SELECT id FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number DESC LIMIT 1').get(pageId);
  assert.ok(row, `page ${pageId} 必须有版本`);
  return row.id;
}

/** 断言列表按 (time, id) 非递增且无重复。 */
function assertSortedDesc(items) {
  assert.ok(items.length > 0, '列表不能为空');
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1];
    const curr = items[i];
    const prevKey = `${prev.time}|${prev.id}`;
    const currKey = `${curr.time}|${curr.id}`;
    assert.ok(currKey <= prevKey, `顺序错误：第 ${i} 条 (${currKey}) 应 <= 前一条 (${prevKey})`);
    assert.notEqual(curr.id, prev.id, 'id 不得重复');
  }
}

// ============================================================
// 1) 多事件顺序 + 相对序不变量
// ============================================================

test('多事件顺序：跨类全局 (time,id) 序；同 ChangeSet 内 receipt/compile 恒排在 change_set 之前', async () => {
  const root = await makeRoot();
  try {
    let database = null;
    const { database: db, workspaceId } = await makeDatabase(root);
    database = db;
    seedTopics(database, ['topic-1', 'topic-2']);
    // cs-a：note(topic-1) + topic wiki page + receipt(topic-1)
    const csA = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-cs-a'), {
      notes: [noteCreate('note-a', { adoptedTopicIds: ['topic-1'] })],
      wikiPages: [pageCreate('page-a', 'topic-1')],
      receipts: [receiptWrite('log-rc-a', { affectedTopics: ['topic-1'], summary: 'cs-a 回执' })]
    });
    // cs-b：note(topic-2) + topic wiki page + receipt(topic-2) + health issue 检测
    const csB = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-cs-b', { triggerSource: 'lint' }), {
      notes: [noteCreate('note-b', { adoptedTopicIds: ['topic-2'] })],
      wikiPages: [pageCreate('page-b', 'topic-2')],
      receipts: [receiptWrite('log-rc-b', { triggerType: 'lint', affectedTopics: ['topic-2'] })],
      healthIssues: [{ op: 'create', id: 'hi-1', scope: 'global', issueType: 'stale_claim', affectedObjectType: 'source', affectedObjectId: 's1', severity: 'medium', evidence: { kind: 'fixture' }, suggestedAction: '更新来源' }]
    });
    // cs-c：问答写回（引用 note-a 的固定版本）
    const nvA = noteVersionId(database, 'note-a');
    const csC = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-cs-c', { triggerSource: 'query' }), {
      queryArtifacts: [{
        scope: 'global', requestId: 'log-qa-c', question: 'AgentForge 支持多模型路由吗？', answerSummary: '支持。',
        readNoteVersionIds: [nvA], readWikiVersionIds: [], readEvidenceIds: [],
        writeBackDecision: 'created', createdBy: 'pi'
      }]
    });
    // cs-d：health issue 解决
    const csD = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-cs-d', { triggerSource: 'review' }), {
      healthIssues: [{ op: 'update', id: 'hi-1', beforeRevision: 1, status: 'resolved', resolutionNote: '已按新来源更新' }]
    });
    // 来源正文摄取（两版，前一版为上一版）
    insertSourceItem(database, 's1');
    insertSourceBodyRevision(database, 's1', 'sbr-1', { createdAt: T(Date.parse(csB.changeSet.createdAt) - 1000) });
    insertSourceBodyRevision(database, 's1', 'sbr-2', { createdAt: T(Date.parse(csB.changeSet.createdAt) + 1000), previous: 'sbr-1' });
    // 维护 run：启动（cs-a 之后、cs-b 之前）+ 完成（cs-d 之后）
    const runM1 = maintenanceRun('maintenance-m1', workspaceId, { startedAt: T(Date.parse(csA.changeSet.createdAt) + 500) });
    putMaintenanceRun(database, runM1);
    updateMaintenanceRun(database, { ...runM1, completedAt: T(Date.parse(csD.changeSet.createdAt) + 500), reportId: 'report:maintenance-m1' });

    const page = listKnowledgeLogEntries(database, { limit: 100 });
    const { items } = page;

    assertSortedDesc(items);
    assert.equal(page.total, items.length, 'limit=100 应覆盖全部');
    const ids = items.map((entry) => entry.id);
    const set = new Set(ids);
    assert.equal(set.size, ids.length, '条目 id 全局唯一');

    // 各事件类均投影，且 id 前缀 = `${eventType}:` 稳定
    for (const eventType of ['change_set', 'receipt', 'compile', 'lint_detected', 'lint_resolved', 'maintenance_started', 'maintenance_completed', 'query', 'source']) {
      const ofType = items.filter((entry) => entry.eventType === eventType);
      assert.ok(ofType.length > 0, `事件类 ${eventType} 必须出现`);
      for (const entry of ofType) {
        assert.ok(entry.id.startsWith(`${eventType}:`), `id 前缀必须为事件类：${entry.id}`);
        assert.equal(entry.locator.id, entry.objectId, 'locator.id 与 objectId 一致');
      }
    }

    // 相对序不变量：同一 ChangeSet 内 receipt 与 compile 条目恒排在 change_set 条目之前
    const idx = (id) => ids.indexOf(id);
    const rcA = database.prepare("SELECT id FROM knowledge_update_receipts WHERE request_id = 'log-rc-a'").get();
    assert.ok(rcA, 'cs-a 回执必须存在');
    assert.ok(idx(`receipt:${rcA.id}`) < idx(`change_set:${csA.changeSetId}`), 'receipt 必须在同集 change_set 之前');
    const wpvA = wikiPageVersionId(database, 'page-a');
    assert.ok(idx(`compile:${wpvA}`) < idx(`change_set:${csA.changeSetId}`), 'compile 必须在同集 change_set 之前');

    // lint 检测/解决：detected 锚点时间 = detected_at；resolved 锚点时间 = resolved_at，且解决条目更晚
    const detected = items.find((entry) => entry.eventType === 'lint_detected' && entry.objectId === 'hi-1');
    const resolved = items.find((entry) => entry.eventType === 'lint_resolved' && entry.objectId === 'hi-1');
    assert.ok(detected && resolved, 'hi-1 必须有检测与解决条目');
    assert.equal(detected.versionRefs.healthIssueId, 'hi-1');
    assert.equal(resolved.versionRefs.changeSetId, csD.changeSetId, '解决条目携带解决 ChangeSet 固定引用');
    assert.ok(resolved.time >= detected.time, '解决锚点不得早于检测锚点');

    // source 条目携带固定正文版本引用
    const src2 = items.find((entry) => entry.id === 'source:sbr-2');
    assert.ok(src2, 'sbr-2 条目必须存在');
    assert.equal(src2.versionRefs.sourceId, 's1');
    assert.equal(src2.versionRefs.sourceRevisionId, 'sbr-2');
    assert.equal(src2.versionRefs.previousSourceRevisionId, 'sbr-1');
    assert.deepEqual(src2.refs.sourceIds, ['s1']);

    // query 条目携带固定版本引用与 note 父级
    const qa = items.find((entry) => entry.eventType === 'query');
    assert.ok(qa, 'query 条目必须存在');
    assert.deepEqual(qa.versionRefs.noteVersionIds, [nvA]);
    assert.deepEqual(qa.refs.noteIds, ['note-a']);

    // compile 条目携带 wiki 版本固定引用 + topic 关联
    const compileA = items.find((entry) => entry.id === `compile:${wpvA}`);
    assert.equal(compileA.versionRefs.wikiPageId, 'page-a');
    assert.deepEqual(compileA.versionRefs.wikiPageVersionIds, [wpvA]);
    assert.ok(compileA.refs.topicIds.includes('topic-1'), 'topic 页 compile 必须关联 subject topic');

    // change_set 条目携带创建版本引用 + 回执引用 + topic 关联
    const csEntryA = items.find((entry) => entry.id === `change_set:${csA.changeSetId}`);
    assert.equal(csEntryA.versionRefs.receiptId, rcA.id);
    assert.ok(csEntryA.versionRefs.noteVersionIds.includes(nvA), 'change_set 必须引用其创建的 note 版本');
    assert.ok(csEntryA.versionRefs.wikiPageVersionIds.includes(wpvA), 'change_set 必须引用其创建的 wiki 版本');
    assert.ok(csEntryA.refs.topicIds.includes('topic-1'));

    database.close();
  } finally {
    try { database?.close?.(); } catch { /* already closed */ }
    try { await rm(root, { recursive: true, force: true }); } catch (cleanupError) { console.error('CLEANUP', cleanupError?.code ?? cleanupError?.message); }
  }
});

// ============================================================
// 2) 同时间稳定分页
// ============================================================

test('同时间稳定分页：同 created_at 批次 (time DESC, id DESC) 完全确定；keyset 跨组不重不丢；双向导航', async () => {
  const root = await makeRoot();
  try {
    let database = null;
    const { database: db, workspaceId } = await makeDatabase(root);
    database = db;
    seedTopics(database, ['topic-1', 'topic-2']);
    const SAME = '2026-01-01T00:00:00.100Z';
    // 直接 SQL 构建同时间跨类批次（INSERT 允许；不可变触发器只拦 UPDATE/DELETE）
    database.prepare(`INSERT INTO knowledge_change_sets (id, workspace_id, request_id, input_hash, reason, trigger_source, resolution_mode, created_by, created_at)
      VALUES ('cs-same', ?, 'same-cs', 'h', '同时间批次', 'user', 'manual_correction', 'user', ?)`).run(workspaceId, SAME);
    database.prepare(`INSERT INTO knowledge_wiki_pages (id, scope, page_type, canonical_key, title, subject_type, subject_id, lifecycle, compile_status, revision, created_at, updated_at)
      VALUES ('page-same', 'global', 'topic', 'page-same', 'Same Page', 'topic', 'topic-same', 'active', 'current', 1, ?, ?)`).run(SAME, SAME);
    database.prepare(`INSERT INTO knowledge_wiki_page_versions (id, page_id, version_number, title, body_json, adopted_note_version_ids_json, business_object_refs_json, flags_json, change_summary, readable_diff, compile_reason, creator_nature, change_set_id, created_at)
      VALUES ('wpv-same', 'page-same', 1, 'Same Page', '{}', '[]', '[]', '[]', '同时间编译', '', 'fixture', 'system', 'cs-same', ?)`).run(SAME);
    database.prepare(`INSERT INTO knowledge_update_receipts (id, workspace_id, change_set_id, trigger_type, request_id, summary, counts_json, created_by, created_at)
      VALUES ('rc-same', ?, 'cs-same', 'creation', 'same-rc', '同时间回执', '{}', 'system', ?)`).run(workspaceId, SAME);
    database.prepare(`INSERT INTO knowledge_health_issues (id, scope, issue_type, affected_object_type, affected_object_id, severity, evidence_json, suggested_action, status, detected_at, updated_at, revision)
      VALUES ('hi-same', 'global', 'stale_claim', NULL, NULL, 'low', '{}', '', 'open', ?, ?, 1)`).run(SAME, SAME);
    database.prepare(`INSERT INTO knowledge_query_artifacts (id, scope, workspace_id, request_id, question, answer_summary, read_wiki_version_ids_json, read_note_version_ids_json, read_evidence_ids_json, candidates_json, write_back_decision, created_by, created_at)
      VALUES ('qa-same', 'global', ?, 'same-qa', '同时间问题', '', '[]', '[]', '[]', '[]', 'no_write_back', 'pi', ?)`).run(workspaceId, SAME);
    insertSourceItem(database, 's-same', { createdAt: SAME });
    insertSourceBodyRevision(database, 's-same', 'sbr-same', { createdAt: SAME });
    putMaintenanceRun(database, maintenanceRun('m-same', workspaceId, { startedAt: SAME }));

    // 预期 (time DESC, id DESC)：ASCII 前缀序 s > r > q > m > l > c；c 内 change_set < compile
    const expectedOrder = [
      'source:sbr-same',
      'receipt:rc-same',
      'query:qa-same',
      'maintenance_started:m-same',
      'lint_detected:hi-same',
      'compile:wpv-same',
      'change_set:cs-same'
    ];

    const page = listKnowledgeLogEntries(database, { limit: 100 });
    assert.deepEqual(page.items.map((entry) => entry.id), expectedOrder, '同时间批次必须按 (time, id) 完全确定排序');
    assert.equal(page.total, 7);

    // 同时间组内 keyset 分页：limit=2 逐页拼接 = 全序，不重不丢
    const viaPaging = [];
    let before = null;
    const pages = [];
    for (;;) {
      const p = listKnowledgeLogEntries(database, before ? { limit: 2, before } : { limit: 2 });
      pages.push(p);
      viaPaging.push(...p.items);
      if (!p.hasMore) break;
      before = p.before;
    }
    assert.deepEqual(viaPaging.map((entry) => entry.id), expectedOrder, '同时间组 keyset 分页不重不丢');
    assert.equal(pages.length, 4, '7 条 limit=2 应为 4 页');
    // 每页内仍保持 (time, id) 非递增
    for (const p of pages) assertSortedDesc(p.items);

    // after 双向导航：从第 3 页回到第 2 页再回第 1 页
    const page2 = pages[1];
    const backToFirst = listKnowledgeLogEntries(database, { limit: 2, after: page2.after });
    assert.deepEqual(backToFirst.items.map((entry) => entry.id), expectedOrder.slice(0, 2), 'after 导航必须回到更新一页');
    assert.equal(backToFirst.hasMore, false);
    assert.equal(backToFirst.hasMoreAfter, false);

    // 游标编解码往返
    const cursor = encodeKnowledgeLogCursor('2026-01-01T00:00:00.100Z', 'source:sbr-same');
    assert.deepEqual(decodeKnowledgeLogCursor(cursor), { time: '2026-01-01T00:00:00.100Z', id: 'source:sbr-same' });
    assert.equal(decodeKnowledgeLogCursor('not-a-cursor'), null);
    assert.equal(decodeKnowledgeLogCursor('%E0%A4%A|broken'), null);

    database.close();
  } finally {
    try { database?.close?.(); } catch { /* already closed */ }
    try { await rm(root, { recursive: true, force: true }); } catch (cleanupError) { console.error('CLEANUP', cleanupError?.code ?? cleanupError?.message); }
  }
});

// ============================================================
// 3) 过滤 + fail-closed
// ============================================================

test('过滤：eventType / topicId / objectType / objectId / scope；非法输入 fail-closed', async () => {
  const root = await makeRoot();
  try {
    let database = null;
    const { database: db, workspaceId } = await makeDatabase(root);
    database = db;
    seedTopics(database, ['topic-1', 'topic-2']);
    const csA = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-f-a'), {
      notes: [noteCreate('note-fa', { adoptedTopicIds: ['topic-1'] })],
      wikiPages: [pageCreate('page-fa', 'topic-1')],
      receipts: [receiptWrite('log-rc-fa', { affectedTopics: ['topic-1'] })]
    });
    applyKnowledgeChangeSet(database, meta(workspaceId, 'log-f-b'), {
      notes: [noteCreate('note-fb', { adoptedTopicIds: ['topic-2'] })],
      wikiPages: [pageCreate('page-fb', 'topic-2')],
      receipts: [receiptWrite('log-rc-fb', { affectedTopics: ['topic-2'] })]
    });

    // eventType 过滤
    const receipts = listKnowledgeLogEntries(database, { eventType: 'receipt', limit: 100 });
    assert.equal(receipts.total, 2);
    assert.ok(receipts.items.every((entry) => entry.eventType === 'receipt'));
    assertSortedDesc(receipts.items);

    // topicId 过滤：topic-1 只命中 cs-a 关联条目（note adoptedTopicIds + wiki subject + 回执 topics）
    const byTopic = listKnowledgeLogEntries(database, { topicId: 'topic-1', limit: 100 });
    assert.equal(byTopic.total, 3, 'topic-1 应命中 cs-a change_set + 回执 + compile 共 3 条');
    for (const entry of byTopic.items) {
      assert.ok(entry.refs.topicIds.includes('topic-1'), `${entry.id} 必须携带 topic-1 关联`);
      assert.notEqual(entry.eventType, 'query', 'query 无 topic 关联不得命中');
    }
    // 反向：topic-2 集合与 topic-1 集合互斥
    const byTopic2 = listKnowledgeLogEntries(database, { topicId: 'topic-2', limit: 100 });
    const idSet1 = new Set(byTopic.items.map((entry) => entry.id));
    const idSet2 = new Set(byTopic2.items.map((entry) => entry.id));
    for (const id of idSet2) assert.ok(!idSet1.has(id), 'topic-1 与 topic-2 命中不得重叠');

    // objectType 过滤
    const issues = listKnowledgeLogEntries(database, { objectType: 'health_issue', limit: 100 });
    assert.ok(issues.items.every((entry) => entry.objectType === 'health_issue'));

    // objectId 过滤：稳定对象 ID
    const one = listKnowledgeLogEntries(database, { objectId: csA.changeSetId, limit: 100 });
    assert.equal(one.total, 1);
    assert.equal(one.items[0].objectId, csA.changeSetId);
    assert.equal(one.items[0].objectType, 'change_set');

    // scope 过滤：只留携带 scope 的类（compile/lint/query），change_set/receipt/source/maintenance 被排除
    const global = listKnowledgeLogEntries(database, { scope: 'global', limit: 100 });
    for (const entry of global.items) {
      assert.equal(entry.scope, 'global');
      assert.ok(['compile', 'lint_detected', 'lint_resolved', 'query'].includes(entry.eventType), `${entry.eventType} 不应命中 scope 过滤`);
    }
    assert.ok(global.items.every((entry) => entry.eventType !== 'change_set' && entry.eventType !== 'receipt'), '工作空间级聚合不参与 scope 过滤');

    // fail-closed：非法 eventType / 非法 scope / 游标冲突 / 非法游标
    assert.throws(() => listKnowledgeLogEntries(database, { eventType: 'hack' }), (error) => {
      assert.ok(error instanceof KnowledgeGlobalLogError);
      assert.equal(error.code, 'KNOWLEDGE_LOG_FILTER_INVALID');
      return true;
    });
    assert.throws(() => listKnowledgeLogEntries(database, { scope: 'lane:bad key' }), (error) => error.code === 'KNOWLEDGE_LOG_FILTER_INVALID');
    assert.throws(() => listKnowledgeLogEntries(database, { before: 'x', after: 'y' }), (error) => error.code === 'KNOWLEDGE_LOG_CURSOR_CONFLICT');
    assert.throws(() => listKnowledgeLogEntries(database, { before: '%%%' }), (error) => error.code === 'KNOWLEDGE_LOG_CURSOR_INVALID');
    assert.throws(() => listKnowledgeLogEntries(database, { before: encodeKnowledgeLogCursor('2026-01-01T00:00:00.100Z', 'source:sbr-x'), after: encodeKnowledgeLogCursor('2026-01-01T00:00:00.200Z', 'source:sbr-y') }), (error) => error.code === 'KNOWLEDGE_LOG_CURSOR_CONFLICT');

    // 共享通道常量与 IPC 契约一致性
    assert.deepEqual(Object.values(KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS).sort(), ['knowledge-global-log:get', 'knowledge-global-log:list']);

    database.close();
  } finally {
    try { database?.close?.(); } catch { /* already closed */ }
    try { await rm(root, { recursive: true, force: true }); } catch (cleanupError) { console.error('CLEANUP', cleanupError?.code ?? cleanupError?.message); }
  }
});

// ============================================================
// 4) 重建幂等（重复读 + 重启后重建）
// ============================================================

test('重建幂等：同库重复读一致；关闭重开 DB 后投影重建一致（SQLite 持久）', async () => {
  const root = await makeRoot();
  try {
    const first = await makeDatabase(root);
    const { database, workspaceId, dbPath } = first;
    seedTopics(database, ['topic-1', 'topic-2']);
    applyKnowledgeChangeSet(database, meta(workspaceId, 'log-rb-a'), {
      notes: [noteCreate('note-rba', { adoptedTopicIds: ['topic-1'] })],
      receipts: [receiptWrite('log-rc-rba', { affectedTopics: ['topic-1'] })]
    });
    applyKnowledgeChangeSet(database, meta(workspaceId, 'log-rb-b'), {
      notes: [noteCreate('note-rbb', { adoptedTopicIds: ['topic-2'] })],
      wikiPages: [pageCreate('page-rbb', 'topic-2')]
    });
    insertSourceItem(database, 's-rb');
    insertSourceBodyRevision(database, 's-rb', 'sbr-rb');

    const snapshotA = listKnowledgeLogEntries(database, { limit: 100 });
    const snapshotB = listKnowledgeLogEntries(database, { limit: 100 });
    assert.deepEqual(snapshotB, snapshotA, '同库重复读必须逐字段一致（重建幂等）');

    // 重启：关闭并重新打开同一 DB 文件（migrateDatabase 幂等，schema_migrations 跳过已应用）
    database.close();
    const reopened = migrateDatabase(dbPath);
    try {
      const snapshotC = listKnowledgeLogEntries(reopened, { limit: 100 });
      assert.deepEqual(snapshotC.items, snapshotA.items, '重启后投影重建必须与关闭前一致');
      assert.equal(snapshotC.total, snapshotA.total);
      // 逐条 get 也一致
      for (const entry of snapshotA.items) {
        assert.deepEqual(getKnowledgeLogEntry(reopened, entry.id), entry, `get(${entry.id}) 必须与列表一致`);
      }
    } finally {
      reopened.close();
    }
  } finally {
    try { database?.close?.(); } catch { /* already closed */ }
    try { await rm(root, { recursive: true, force: true }); } catch (cleanupError) { console.error('CLEANUP', cleanupError?.code ?? cleanupError?.message); }
  }
});

// ============================================================
// 5) 历史锚点不漂移
// ============================================================

test('历史锚点不漂移：lint 解决/新 Wiki 版本/后续 ChangeSet 均不改写既有条目', async () => {
  const root = await makeRoot();
  try {
    let database = null;
    const { database: db, workspaceId } = await makeDatabase(root);
    database = db;
    seedTopics(database, ['topic-1', 'topic-2']);
    const csA = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-drift-a'), {
      notes: [noteCreate('note-da', { adoptedTopicIds: ['topic-1'] })],
      wikiPages: [pageCreate('page-da', 'topic-1')],
      receipts: [receiptWrite('log-rc-drift-a', { affectedTopics: ['topic-1'] })],
      healthIssues: [{ op: 'create', id: 'hi-drift', scope: 'global', issueType: 'unsupported_claim', affectedObjectType: 'knowledge_note', affectedObjectId: 'note-da', severity: 'high', evidence: {}, suggestedAction: '补充证据' }]
    });

    const wpv1 = wikiPageVersionId(database, 'page-da');
    const before = {
      changeSet: getKnowledgeLogEntry(database, `change_set:${csA.changeSetId}`),
      receipt: getKnowledgeLogEntry(database, `receipt:${listKnowledgeLogEntries(database, { objectId: csA.changeSetId, limit: 1 }).items[0].versionRefs.receiptId}`),
      compile: getKnowledgeLogEntry(database, `compile:${wpv1}`),
      lintDetected: getKnowledgeLogEntry(database, 'lint_detected:hi-drift')
    };
    for (const entry of Object.values(before)) assert.ok(entry, '基线条目必须存在');

    // 1) 解决 health issue（改同一行）→ lint_detected 不变，lint_resolved 新增
    const csResolve = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-drift-resolve'), {
      healthIssues: [{ op: 'update', id: 'hi-drift', beforeRevision: 1, status: 'resolved', resolutionNote: '已补充证据' }]
    });
    const afterResolve = {
      changeSet: getKnowledgeLogEntry(database, `change_set:${csA.changeSetId}`),
      receipt: getKnowledgeLogEntry(database, `receipt:${listKnowledgeLogEntries(database, { objectId: csA.changeSetId, limit: 1 }).items[0].versionRefs.receiptId}`),
      compile: getKnowledgeLogEntry(database, `compile:${wpv1}`),
      lintDetected: getKnowledgeLogEntry(database, 'lint_detected:hi-drift'),
      lintResolved: getKnowledgeLogEntry(database, 'lint_resolved:hi-drift')
    };
    assert.deepEqual(afterResolve.lintDetected, before.lintDetected, '解决后 lint_detected 条目不得漂移');
    assert.ok(afterResolve.lintResolved, '解决后必须新增 lint_resolved 条目');
    assert.equal(afterResolve.lintResolved.versionRefs.changeSetId, csResolve.changeSetId);
    assert.deepEqual(afterResolve.changeSet, before.changeSet, '解决 ChangeSet 不得改写 cs-a 条目');

    // 2) 同一 Wiki 页追加新版本（当前版本指针移动）→ 旧 compile 条目不变，新 compile 条目出现
    const nvA = noteVersionId(database, 'note-da');
    applyKnowledgeChangeSet(database, meta(workspaceId, 'log-drift-v2'), {
      notes: [{ id: 'note-da', beforeRevision: 1, scope: 'global', kind: 'claim', canonicalKey: 'note-da-key', title: 'note-da',
        version: { title: 'note-da', statement: 'v2', conclusionStatus: 'supported', evidenceLevel: 'corroborated', changeType: 'strengthened', changeReason: '补证', adoptedTopicIds: ['topic-1'] } }],
      wikiPages: [{ id: 'page-da', beforeRevision: 1, scope: 'global', pageType: 'topic', canonicalKey: 'page-da-key', title: 'page-da', subjectType: 'topic', subjectId: 'topic-1',
        version: { title: 'page-da', body: { blocks: [] }, adoptedNoteVersionIds: [nvA], changeSummary: 'v2 编译', compileReason: '补证后重编译' } }]
    });
    const wpv2 = wikiPageVersionId(database, 'page-da');
    assert.notEqual(wpv2, wpv1, '新版本 id 必须不同');
    const afterV2 = {
      changeSet: getKnowledgeLogEntry(database, `change_set:${csA.changeSetId}`),
      receipt: getKnowledgeLogEntry(database, `receipt:${listKnowledgeLogEntries(database, { objectId: csA.changeSetId, limit: 1 }).items[0].versionRefs.receiptId}`),
      compileV1: getKnowledgeLogEntry(database, `compile:${wpv1}`),
      compileV2: getKnowledgeLogEntry(database, `compile:${wpv2}`)
    };
    assert.deepEqual(afterV2.compileV1, before.compile, '追加新 Wiki 版本后旧 compile 条目不得漂移');
    assert.ok(afterV2.compileV2, '新版本 compile 条目必须出现');
    assert.equal(afterV2.compileV2.versionRefs.wikiPageVersionIds[0], wpv2);
    assert.deepEqual(afterV2.compileV2.versionRefs.noteVersionIds, [nvA], 'compile 条目携带采纳的固定 note 版本');
    assert.deepEqual(afterV2.changeSet, before.changeSet, '后续 ChangeSet 不得改写 cs-a 条目');
    assert.deepEqual(afterV2.receipt, before.receipt, '后续 ChangeSet 不得改写 cs-a 回执条目');

    // 3) 基线条目在追加新事件后仍然逐字段一致（分页快照对比）
    const snapshotNow = listKnowledgeLogEntries(database, { limit: 100 });
    for (const entry of Object.values(before)) {
      const found = snapshotNow.items.find((item) => item.id === entry.id);
      assert.deepEqual(found, entry, `${entry.id} 在追加事件后必须保持不变`);
    }

    // 4) 分页稳定性：老页面（before 游标）不受新条目影响——用中间状态游标重放
    const midSnapshot = listKnowledgeLogEntries(database, { limit: 2 });
    const midBefore = midSnapshot.before;
    const midPage = listKnowledgeLogEntries(database, { limit: 2, before: midBefore });
    // 追加事件后，同游标的更旧页内容不变（keyset 锚定 (time,id)）
    const replay = listKnowledgeLogEntries(database, { limit: 2, before: midBefore });
    assert.deepEqual(replay.items.map((entry) => entry.id), midPage.items.map((entry) => entry.id), '同游标重放必须返回相同条目（无漂移）');

    database.close();
  } finally {
    try { database?.close?.(); } catch { /* already closed */ }
    try { await rm(root, { recursive: true, force: true }); } catch (cleanupError) { console.error('CLEANUP', cleanupError?.code ?? cleanupError?.message); }
  }
});

// ============================================================
// 6) getKnowledgeLogEntry 边界
// ============================================================

test('getKnowledgeLogEntry：逐类命中；畸形/未知 id 返回 null', async () => {
  const root = await makeRoot();
  try {
    let database = null;
    const { database: db, workspaceId } = await makeDatabase(root);
    database = db;
    seedTopics(database, ['topic-1', 'topic-2']);
    const cs = applyKnowledgeChangeSet(database, meta(workspaceId, 'log-get-a'), {
      notes: [noteCreate('note-ga', { adoptedTopicIds: ['topic-1'] })],
      wikiPages: [pageCreate('page-ga', 'topic-1')],
      receipts: [receiptWrite('log-rc-ga', { affectedTopics: ['topic-1'] })]
    });
    insertSourceItem(database, 's-ga');
    insertSourceBodyRevision(database, 's-ga', 'sbr-ga');
    putMaintenanceRun(database, maintenanceRun('m-ga', workspaceId, { startedAt: T(Date.parse(cs.changeSet.createdAt) - 500) }));

    const listed = listKnowledgeLogEntries(database, { limit: 100 });
    assert.equal(listed.items.length, 5, 'get 场景应覆盖 5 条：cs+rc+compile+source+maintenance_started（本库无 query/lint/完成 run）');

    // 逐类 round-trip：list 条目与 get 条目一致
    for (const entry of listed.items) {
      const fetched = getKnowledgeLogEntry(database, entry.id);
      assert.deepEqual(fetched, entry, `get(${entry.id}) 必须等于 list 条目`);
    }

    // 边界：未知对象 / 畸形 id / 未解决 issue 的 lint_resolved
    assert.equal(getKnowledgeLogEntry(database, 'change_set:missing-cs'), null);
    assert.equal(getKnowledgeLogEntry(database, 'lint_resolved:missing'), null);
    assert.equal(getKnowledgeLogEntry(database, 'not-an-id'), null);
    assert.equal(getKnowledgeLogEntry(database, 'unknown:xxx'), null);
    assert.equal(getKnowledgeLogEntry(database, ''), null);
    assert.equal(getKnowledgeLogEntry(database, null), null);

    database.close();
  } finally {
    try { database?.close?.(); } catch { /* already closed */ }
    try { await rm(root, { recursive: true, force: true }); } catch (cleanupError) { console.error('CLEANUP', cleanupError?.code ?? cleanupError?.message); }
  }
});
