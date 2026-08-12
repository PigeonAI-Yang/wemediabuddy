import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { register } from 'node:module';

// ---- 测试本地 ESM 解析钩子（同 wmb-5210-knowledge-flywheel-commands.test.mjs）：electron → 惰性桩；相对无扩展名补 .ts ----
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
  'export default { app, safeStorage };',
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
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { runLegacyKnowledgeInitAtStartup, legacyInitRequestId, LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION } = await import('../src/main/legacy-knowledge-init.ts');
const { getUpdateReceiptByRequest, KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND, listWikiPages } = await import('../src/main/knowledge-flywheel.ts');
const { setDataChangedPublisher } = await import('../src/main/data-changed.ts');

const T = '2026-08-01T00:00:00.000Z';

/**
 * WMB-5217 M8 历史初始化生产启动路径验收（真实 ActiveWorkspaceRuntime + CommandDispatcher）：
 *  1) 工作空间激活后经 knowledge_flywheel.legacy_init dispatcher 命令有界初始化（write-guard 授权，
 *     直接 SQL 写被拒；scheduler actor；command_receipt 审计）；
 *  2) 重启续跑：已初始化 Topic 不再派发，新 Topic 续初始化，零重复知识写；
 *  3) 失败可重试：pre-seed 'failed' 状态行 → 下次启动重试成功；运行时不可用 → 返回结果不抛出（不阻断启动）；
 *  4) dataChanged（knowledge/receipt 等 scopes）与 migration 回执可见；知识 ChangeSet trigger_source=
 *     'migration'（不伪造历史）。
 * 退出码 0 = 全部通过。
 */
test('WMB-5217 legacy init production startup path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5217-rt-'));
  let runtime = null;
  try {
    // ---- Phase 0：迁移 + 种子 legacy 业务链（raw DB，无 write-guard） + pre-seed 'failed' 状态行 ----
    {
      const db = migrateDatabase(path.join(root, 'wmb.db'));
      db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-runtime', ?, ?, 1)").run(T, T);
      ensureOfficialWorkspaceProfile(db, 'official.ai');
      const seedTopic = (id, title, summary, status, canonicalKey) => db.prepare(
        `INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, 1, ?, 'theme', ?, ?, ?, ?)`)
        .run(id, title, T, T, canonicalKey, summary, status, T, T);
      const seedSource = (id, title, summary, priority, verificationStatus, relation, topicId) => {
        db.prepare(`INSERT INTO source_items (
            id, feed_id, original_url, canonical_url, content_fingerprint, title, author, published_at, collected_at, summary,
            categories_json, keywords_json, value_judgment, ip_relevance, creation_angles, recommended_platforms_json,
            recommended_formats_json, timeliness, priority, evidence, client_label, verification_status, management_status,
            created_at, updated_at, revision
          ) VALUES (?, NULL, ?, ?, NULL, ?, 'author', NULL, ?, ?, '[]', '[]', '价值高', '', '', '[]', '[]', '当日', ?, 'evidence', 'test', ?, 'active', ?, ?, 1)`)
          .run(id, `https://example.com/${id}`, `https://example.com/${id}`, title, T, summary ?? null, priority ?? null, verificationStatus, T, T);
        db.prepare('INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(topicId, id, relation, T, T);
      };
      seedTopic('topic-a', 'AI 自媒体方法论', '关于 AI 自媒体内容方法论的沉淀。', 'active', 'ai-selfmedia-method');
      seedSource('src-a1', '钩子决定完播', 'Source A：首屏钩子直接决定完播率。', 1, 'verified', 'primary', 'topic-a');
      seedSource('src-a2', '未核验资料', '未核验但有总结。', 1, 'pending', 'primary', 'topic-a');
      seedTopic('topic-f', '弱证据话题', '只有弱证据的话题。', 'active', 'weak-topic');
      seedSource('src-f1', '无总结', null, 2, 'verified', 'primary', 'topic-f');
      seedTopic('topic-g', '孤岛话题', '没有任何来源证据的话题。', 'active', 'orphan-topic');
      seedTopic('topic-c', '休眠话题', '休眠话题总结。', 'dormant', 'dormant-topic');
      seedTopic('topic-x', '失败重试话题', '上次启动失败的话题。', 'active', 'retry-topic');
      seedSource('src-x1', '重试来源', 'Source X：重试来源总结。', 1, 'verified', 'primary', 'topic-x');
      db.prepare(`INSERT INTO knowledge_legacy_init_state (topic_id, workspace_id, scope, migration_version, status, wiki_page_id, change_set_id, receipt_id, last_error, completed_at)
        VALUES ('topic-x', 'ws-runtime', 'global', ?, 'failed', NULL, NULL, NULL, 'seeded failure for retry test', ?)`)
        .run(LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION, T);
      db.close();
    }

    // ---- Phase 1：真实 runtime 启动路径（epoch e1）----
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-e1' });
    let capturedEvent = null;
    setDataChangedPublisher((event) => { capturedEvent = event; });
    const r1 = await runLegacyKnowledgeInitAtStartup(runtime);
    assert.equal(r1.command, KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND);
    assert.equal(r1.workspaceId, 'ws-runtime');
    assert.equal(r1.totals.topics, 4, '仅 active/watching：topic-a/f/g/x（dormant topic-c 不枚举）');
    assert.equal(r1.totals.initialized, 4);
    assert.equal(r1.totals.failed, 0);
    assert.equal(r1.totals.alreadyInitialized, 0);
    assert.ok(r1.topicResults.find((t) => t.topicId === 'topic-x')?.status === 'initialized', 'pre-seed failed 状态行被重试为 initialized');
    assert.ok(r1.topicResults.find((t) => t.topicId === 'topic-a')?.counts?.notesCreated === 1);
    assert.ok(r1.topicResults.find((t) => t.topicId === 'topic-f')?.counts?.notesCreated === 0, '弱证据零 Note');

    const cmdReceipts = runtime.database.prepare(
      "SELECT request_id AS requestId, command FROM command_receipts WHERE command = ? ORDER BY request_id"
    ).all(KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND);
    assert.equal(cmdReceipts.length, 4, '每个 Topic 一条 dispatcher 命令收据（审计）');
    assert.ok(cmdReceipts.every((row) => row.command === KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND && row.requestId.startsWith('legacy-init:run:runtime-e1:topic-')));

    const changeSets = runtime.database.prepare(
      "SELECT request_id AS requestId, trigger_source AS triggerSource, created_by AS createdBy FROM knowledge_change_sets WHERE trigger_source = 'migration' ORDER BY request_id"
    ).all();
    assert.equal(changeSets.length, 4, '每个 Topic 一个真实知识 ChangeSet');
    assert.ok(changeSets.every((row) => row.requestId === legacyInitRequestId('topic-a') || row.requestId === legacyInitRequestId('topic-f')
      || row.requestId === legacyInitRequestId('topic-g') || row.requestId === legacyInitRequestId('topic-x')));
    assert.ok(changeSets.every((row) => row.triggerSource === 'migration' && row.createdBy === 'migration'), '不伪造历史 ChangeSet');

    const pages = listWikiPages(runtime.database, { scope: 'global', pageType: 'topic', limit: 50 });
    for (const topicId of ['topic-a', 'topic-f', 'topic-g', 'topic-x']) {
      assert.equal(pages.items.filter((p) => p.subjectId === topicId).length, 1, `一 Topic 一 Wiki：${topicId}`);
    }
    assert.equal(pages.items.filter((p) => p.subjectId === 'topic-c').length, 0, 'dormant 无 Wiki');

    const receiptA = getUpdateReceiptByRequest(runtime.database, 'ws-runtime', legacyInitRequestId('topic-a'));
    assert.ok(receiptA && receiptA.triggerType === 'migration', '初始化回执 triggerType=migration 可见');
    assert.equal(runtime.database.prepare("SELECT status FROM knowledge_legacy_init_state WHERE topic_id = 'topic-x'").get().status, 'initialized');
    assert.equal(runtime.database.prepare("SELECT count(*) AS c FROM knowledge_legacy_init_state WHERE status = 'initialized'").get().c, 4);
    await new Promise((resolve) => setTimeout(resolve, 80)); // broadcastDataChanged 50ms 去重 flush
    assert.ok(capturedEvent && capturedEvent.scopes.includes('knowledge') && capturedEvent.scopes.includes('receipt') && capturedEvent.scopes.includes('topics'),
      '初始化后广播 dataChanged（knowledge/receipt/topics）');
    assert.ok(runtime.database.prepare(`SELECT 1 FROM knowledge_health_issues hi JOIN knowledge_wiki_pages p ON p.id = hi.affected_object_id
      WHERE hi.issue_type='orphan_knowledge' AND p.subject_id='topic-g'`).get(), '孤岛 Topic 健康问题可见');

    // write-guard 生效：绕过 dispatcher 的直接 SQL 写必须被拒（启动路径没有绕 guard）
    assert.throws(
      () => runtime.database.prepare("INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, status) VALUES ('ghost', 'G', ?, ?, 1, 'ghost', 'theme', 'active')").run(T, T),
      /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/,
      '直接 SQL 写被 write-guard 拒绝'
    );
    await runtime.stop({ drain: false });
    runtime = null;

    // ---- Phase 2：重启续跑（epoch e2）—— 新 Topic 续初始化，旧 Topic 零重做 ----
    {
      const db = migrateDatabase(path.join(root, 'wmb.db'));
      db.prepare(`INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at)
        VALUES ('topic-b', '小红书图文排版', ?, ?, 1, 'xhs-layout', 'theme', '小红书图文排版观察。', 'active', ?, ?)`)
        .run(T, T, T, T);
      db.prepare(`INSERT INTO source_items (
          id, feed_id, original_url, canonical_url, content_fingerprint, title, author, published_at, collected_at, summary,
          categories_json, keywords_json, value_judgment, ip_relevance, creation_angles, recommended_platforms_json,
          recommended_formats_json, timeliness, priority, evidence, client_label, verification_status, management_status,
          created_at, updated_at, revision
        ) VALUES ('src-b1', NULL, 'https://example.com/src-b1', 'https://example.com/src-b1', NULL, '排版节奏', 'author', NULL, ?, 'Source B：首图信息密度决定滑动率。', '[]', '[]', '价值高', '', '', '[]', '[]', '当日', 1, 'evidence', 'test', 'verified', 'active', ?, ?, 1)`)
        .run(T, T, T);
      db.prepare("INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES ('topic-b', 'src-b1', 'supporting', ?, ?)").run(T, T);
      db.close();
    }
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-e2' });
    const before = {
      changeSets: runtime.database.prepare("SELECT count(*) AS c FROM knowledge_change_sets").get().c,
      cmdReceipts: runtime.database.prepare("SELECT count(*) AS c FROM command_receipts WHERE command = ?").get(KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND).c,
      wikiPages: runtime.database.prepare("SELECT count(*) AS c FROM knowledge_wiki_pages").get().c
    };
    const r2 = await runLegacyKnowledgeInitAtStartup(runtime);
    assert.equal(r2.totals.topics, 1, '重启只枚举未初始化 Topic');
    assert.equal(r2.totals.initialized, 1);
    assert.equal(r2.topicResults[0].topicId, 'topic-b');
    assert.equal(runtime.database.prepare("SELECT count(*) AS c FROM knowledge_change_sets").get().c, before.changeSets + 1, '旧 Topic 零重复知识写');
    assert.equal(runtime.database.prepare("SELECT count(*) AS c FROM command_receipts WHERE command = ?").get(KNOWLEDGE_FLYWHEEL_LEGACY_INIT_COMMAND).c, before.cmdReceipts + 1, '仅新 Topic 派发一条命令');
    assert.equal(runtime.database.prepare("SELECT count(*) AS c FROM knowledge_wiki_pages").get().c, before.wikiPages + 1, '仅新 Topic 新增 Wiki');
    assert.ok(runtime.database.prepare("SELECT 1 FROM command_receipts WHERE request_id = 'legacy-init:run:runtime-e2:topic-b'").get());
    await runtime.stop({ drain: false });
    runtime = null;

    // ---- Phase 3：运行时不可用 → 返回结果不抛出（不阻断启动）----
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-e3' });
    await runtime.stop({ drain: false });
    const r3 = await runLegacyKnowledgeInitAtStartup(runtime);
    assert.equal(r3.totals.topics, 0, '运行时不可读 → 零进度返回，不抛出');
    await runtime.stop({ drain: false }).catch(() => {});
    runtime = null;
  } finally {
    await runtime?.stop({ drain: false }).catch(() => {});
    setDataChangedPublisher(null);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
