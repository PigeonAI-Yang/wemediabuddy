// WMB-5241 单条/批量 Ingest、跨页 Wiki 更新、固定版本 Query/写回 生产链聚焦验收。
//
// 范围（Main 协调约定 2026-08-14）：聚焦测试输出 + tests/e2e/.artifacts/WMB-5241-* 证据；
// 不新增 Markdown 验收报告；矩阵由 RefreshKarpathyCapabilityMatrix 写入。
//
// 验收链（全部在同一 data-root 的同一真实 SQLite 上串行执行；禁止多 fixture 冒充全链路）：
//   A1 单条 Ingest：一条高价值 Source（verified + body_cache）晋升 → Topic Wiki 页 v1、
//      Knowledge Note 版本、Evidence 指向真实 Source、回执 counts 如实；
//   A2 低价值保留 Raw：同链编译一条纯复述 Source → 价值门跳过（结构化原因）、
//      零 Note/零 Wiki 版本/零 Evidence 写，Source 保持 Raw（回执 counts 全零如实记录）；
//   A3 批量部分失败诚实：knowledge.backfill 一步扫描 7 条（A/B/C/D/E/F/G）→ compiled/failed/skipped_weak/
//      skipped_no_topic/skipped_existing_receipt 逐条可见、checkpoint counts 如实、
//      operation_log 落失败 errorCode、失败零写；重试成功后计数历史保留（failed 不消失）；
//   A4 同 Topic 跨两 Source 重编译多个页面：Source A + Source B 都链接 Topic T1 →
//      T1 页 v1（来自 A）→ v2（来自 B，采纳 A+B 两代结论）；B 同时编译 T2 页（第二个页面）；
//   A5 固定旧版本在新版本后仍解析：T1 页四代版本（A→v1/B→v2/D→v3/E→v4），runFixedVersionQuery 同时解析 v1 与 v4（旧版本内容不变、
//      version_number 逐代、adopted 版本集按代增长）；resolveFixedVersionRefs 通过；
//   A6 Query 写回：restatement → 零知识写（仅 Artifact + Receipt，counts.restatements=1）；
//      new_synthesis → Note + derived_from 证据链指向冻结读取版本（citations）+ Synthesis Wiki 页
//      （basedOn.noteVersionIds=读取集、回答本身不是证据）；同 requestId 重放 duplicate 零增量。
//
// 模型输出纪律（不伪造模型输出）：所有行只经真实生产管线写入 ——
//   冻结（freezeKnowledgeSource）→ 确定性 prompt → modelCall 注入面（与 WMB-5228/5229/5230
//   同款脚本化文本，属生产接口）→ 严格 manifest 解析 → locator 门（回指冻结正文行）→
//   证据状态机 → 价值门 → compileSourceKnowledge 原子 ChangeSet → store 读回。
//   断言全部为 SQLite 真实读回；绝不直插行冒充编译，绝不以注入文本代替库中事实。
//
// 运行：node --test --test-concurrency=1 tests/wmb-5241-ingest-query-chain.test.mjs
//
// 最终 E2E 可复用 setup/断言（供 WMB-5241 统一场景引用）：
//   setup: migrateDatabase(root/wmb.db) → app_meta.workspace_id → upsertKnowledgeTopic(T1,T2)
//     → upsertSource(A..G) + writeSourceBodyCache(A,B,D,E,G) → topic_source_links(T1←A,B,C,D,E,F; T2←B)
//     → deps = { databasePath, modelCall: modelOf({bad:Set([E.id])}), openDatabase: migrateDatabase }
//     → backfillDeps = { databasePath, compileSource: createKnowledgeBackfillCompile(compileDeps), openDatabase }
//   assert 读回（表名:关键字段）：
//     knowledge_update_receipts:workspace_id+request_id+counts_json(failures_json 低价值)
//     knowledge_wiki_pages:page_type+subject_id+revision+current_version_id
//     knowledge_wiki_page_versions:version_number+body_json(compiledSourceIds/keyConclusions/adoptedNoteVersionIds)
//     knowledge_notes/knowledge_note_versions:canonical_key+statement+adopted_knowledge_version_ids_json
//     knowledge_evidence_links:knowledge_note_version_id+evidence_object_type+evidence_object_id+relation
//     knowledge_query_artifacts:write_back_decision+read_note_version_ids_json
//     app_meta(wmb_knowledge_backfill_checkpoint_v1):counts+status+pendingRetry
//     operation_log:command=knowledge.backfill+result+error_code
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { writeSourceBodyCache } = await import('../src/main/source-body-cache.ts');
const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const { runSourceKnowledgeCompile, knowledgeCompileTopicRequestId } = await import('../src/main/knowledge-compile-trigger.ts');
const { generateKnowledgeCandidatePlan } = await import('../src/main/knowledge-candidates.ts');
const {
  createKnowledgeBackfillCompile,
  runKnowledgeBackfillStep,
  BACKFILL_CHECKPOINT_META_KEY,
  KNOWLEDGE_BACKFILL_COMMAND
} = await import('../src/main/knowledge-backfill.ts');
const { runFixedVersionQuery, resolveFixedVersionRefs } = await import('../src/main/fixed-version-query.ts');
const { writebackQueryKnowledge } = await import('../src/main/query-writeback.ts');
const { knowledgeQueryWritebackRequestId } = await import('../src/shared/knowledge-flywheel.ts');

// ============================================================
// 通用工具
// ============================================================

function fenced(manifest) {
  return `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
}

function count(database, table, where = '', params = []) {
  const cond = where.replace(/^\s*WHERE\s+/i, '');
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}${cond ? ` WHERE ${cond}` : ''}`).get(...params).n);
}

function one(database, sql, ...params) {
  return database.prepare(sql).get(...params);
}

function all(database, sql, ...params) {
  return database.prepare(sql).all(...params);
}

function parseJson(value) {
  return JSON.parse(value);
}

function linkTopic(database, sourceId, topicId) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`)
    .run(topicId, sourceId, 'primary', now, now);
}

const LINE_BODY_A = [
  'AgentForge v2 正式发布，支持多模型路由。',
  '官方定价为每百万 token 0.8 美元。',
  '社区反馈称高峰时段延迟明显上升。'
].join('\n');

const LINE_BODY_B = [
  'AgentForge 发布多模型路由的灰度调度能力。',
  '高峰期延迟上升 40%，官方建议启用缓存。',
  '路线图显示三季度将支持本地模型部署。'
].join('\n');

// ============================================================
// 确定性 manifest（按 sourceId + 冻结 Topic 上下文派生；全部回指真实正文行）
// ============================================================

function manifestA() {
  return {
    wmb_knowledge_candidates: {
      reason: 'WMB-5241：Source A 晋升验收。',
      topicCompile: { title: 'AI Agent 工具链', summary: 'AgentForge v2 发布与定价。' },
      entities: [
        { entityType: 'product', canonicalKey: 'agentforge', canonicalName: 'AgentForge', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方产品身份，可独立验证。' }
      ],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-router', statement: 'AgentForge v2 支持多模型路由。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', entityKeys: ['agentforge'], valueRationale: '官方发布，可验证。' },
        { kind: 'insight', canonicalKey: 'agentforge-pricing', statement: '官方定价为每百万 token 0.8 美元，适合高吞吐批量调用。', conclusionStatus: 'inference', evidenceLevel: 'single', locator: 'L2', excerpt: '官方定价为每百万 token 0.8 美元。', entityKeys: ['agentforge'], valueRationale: '定价事实 + 用量推断。' }
      ]
    }
  };
}

function manifestB(topicId) {
  const prefix = `b-${topicId.slice(0, 8)}`;
  return {
    wmb_knowledge_candidates: {
      reason: 'WMB-5241：Source B 跨 Topic 重编译验收。',
      topicCompile: { title: '跨 Source 重编译 Wiki', summary: '灰度调度与延迟应对。' },
      entities: [],
      notes: [
        { kind: 'claim', canonicalKey: `${prefix}-gray-routing`, statement: 'AgentForge 灰度调度支持按比例切换多模型路由。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'AgentForge 发布多模型路由的灰度调度能力。', valueRationale: '官方能力声明。' },
        { kind: 'insight', canonicalKey: `${prefix}-latency-cache`, statement: '高峰期延迟上升约 40%，官方建议启用缓存缓解。', conclusionStatus: 'inference', evidenceLevel: 'single', locator: 'L2', excerpt: '高峰期延迟上升 40%，官方建议启用缓存。', valueRationale: '延迟数据 + 官方建议。' }
      ]
    }
  };
}

function manifestB2(topicId) {
  const prefix = `b-${topicId.slice(0, 8)}`;
  return {
    wmb_knowledge_candidates: {
      reason: 'WMB-5241：Source B 第二个 Topic 页编译。',
      topicCompile: { title: '内容自动化', summary: '本地部署与灰度放量。' },
      entities: [],
      notes: [
        { kind: 'claim', canonicalKey: `${prefix}-local-deploy`, statement: '路线图显示三季度将支持本地模型部署。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L3', excerpt: '路线图显示三季度将支持本地模型部署。', valueRationale: '官方路线图。' },
        { kind: 'concept', canonicalKey: `${prefix}-gray-scheduling`, statement: '灰度调度可作为内容自动化发布链的渐进放量模式。', conclusionStatus: 'inference', evidenceLevel: 'single', locator: 'L1', excerpt: 'AgentForge 发布多模型路由的灰度调度能力。', valueRationale: '跨域迁移推断。' }
      ]
    }
  };
}

function manifestC() {
  return {
    wmb_knowledge_candidates: {
      reason: 'WMB-5241：Source C 纯复述（低价值）保留 Raw。',
      topicCompile: { title: 'AI Agent 工具链', summary: '无新增信息。' },
      entities: [],
      notes: [
        { kind: 'claim', canonicalKey: 'c-restate-1', statement: 'AgentForge v2 发布公告。', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'no_change', locator: 'L1', excerpt: 'AgentForge v2 发布公告（已收录，无增量信息）。', valueRationale: '既有事实复述。' },
        { kind: 'claim', canonicalKey: 'c-restate-2', statement: '无新增信息。', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'no_change', locator: 'L1', excerpt: 'AgentForge v2 发布公告（已收录，无增量信息）。', valueRationale: '无复用价值。' }
      ]
    }
  };
}

function manifestD(sourceId) {
  const tag = `bf-${sourceId.slice(0, 8)}`;
  return {
    wmb_knowledge_candidates: {
      reason: 'WMB-5241：批量回溯编译 Source D。',
      topicCompile: { title: 'AI Agent 工具链', summary: '回溯编译。' },
      entities: [
        { entityType: 'product', canonicalKey: tag, canonicalName: `产品${tag}`, excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方产品身份。' }
      ],
      notes: [
        { kind: 'claim', canonicalKey: `${tag}-claim`, statement: `${tag} 提供统一的模型路由 API。`, conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方发布，可验证。' }
      ]
    }
  };
}

/** 脚本化模型（生产 modelCall 注入面；bad 集合模拟模型失败；bySource 按真实 sourceId 派生 manifest）。 */
function modelOf({ bad = new Set(), bySource = new Map() } = {}) {
  return async (prompt) => {
    const sourceId = /sourceId=([0-9A-Za-z-]+)/.exec(prompt)?.[1];
    if (!sourceId) throw Object.assign(new Error('MODEL_CALL_NO_SOURCE'), { code: 'MODEL_CALL_FAILED' });
    if (bad.has(sourceId)) throw Object.assign(new Error('MODEL_CALL_FAILED'), { code: 'MODEL_CALL_FAILED' });
    const topicMatch = /# 冻结 Topic 上下文\n([\s\S]*?)\n\n# manifest/.exec(prompt);
    const context = topicMatch ? JSON.parse(topicMatch[1]) : null;
    const topicId = context?.topics?.[0]?.id ?? 'unknown';
    const make = bySource.get(sourceId) ?? ((_topicId, sid) => manifestD(sid));
    return fenced(make(topicId, sourceId));
  };
}

// ============================================================
// 验收链（单 test；同一 data-root）
// ============================================================

test('WMB-5241 ingest/query chain on one real workspace (SQLite readback)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wmb-5241-chain-'));
  const dbPath = path.join(root, 'wmb.db');
  const database = migrateDatabase(dbPath);
  const now = new Date().toISOString();
  const workspaceId = `ws-${randomUUID()}`;
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);

  // ---- 种子：Topic T1/T2 + Sources A..G（A/B/C/D/E/F 链接 T1；B 另链接 T2；G 无 Topic） ----
  const t1 = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
  const t2 = upsertKnowledgeTopic(database, { title: '内容自动化' });
  const make = (title, extra = {}, body = null) => {
    const s = upsertSource(database, { title, originalUrl: `https://example.com/${title}`, summary: body ?? null, ...extra });
    if (body) {
      writeSourceBodyCache(database, {
        sourceId: s.id, url: `https://example.com/body-${s.id}`, status: 'ready', contentType: 'text/plain',
        extractedText: body, extractedChars: body.length, errorMessage: null, fetchedAt: now, updatedAt: now
      });
    }
    return s;
  };
  // Source A：verified 高价值 + body_cache（body 摘要同源，保证 locator 可定位）
  const a = make('AgentForge v2 官方公告', { verificationStatus: 'verified', priority: 1 }, LINE_BODY_A);
  // Source B：verified + body_cache；链接 T1+T2
  const b = make('AgentForge 灰度调度公告', { verificationStatus: 'verified' }, LINE_BODY_B);
  // Source C：低价值（正文即摘要；纯复述 manifest）
  const c = make('AgentForge v2 发布公告（已收录）', { summary: 'AgentForge v2 发布公告（已收录，无增量信息）。' }, null);
  // Source D：verified + body_cache（批量 compiled）
  const d = make('批量回溯来源 D', { verificationStatus: 'verified' }, LINE_BODY_A);
  // Source E：verified + body_cache（批量 failed：模型失败）
  const e = make('批量回溯来源 E', { verificationStatus: 'verified' }, LINE_BODY_A);
  // Source F：弱资料（无正文无摘要，链接 T1）→ skipped_weak
  const f = make('弱资料来源 F', {}, null);
  // Source G：verified + body_cache 但无 Topic 链接 → skipped_no_topic
  const g = make('无主题来源 G', { verificationStatus: 'verified' }, LINE_BODY_A);
  for (const s of [a, b, c, d, e, f]) linkTopic(database, s.id, t1.id);
  linkTopic(database, b.id, t2.id);

  // 模型 manifest 按真实 sourceId 派生（A 晋升 / B 跨 Topic / C 纯复述 / D 批量 / E 失败 / F、G 不会触发）
  const bySource = new Map([
    [a.id, () => manifestA()],
    [b.id, (topicId) => (topicId === t2.id ? manifestB2(topicId) : manifestB(topicId))],
    [c.id, () => manifestC()],
    [d.id, (_topicId, sourceId) => manifestD(sourceId)],
    [e.id, (_topicId, sourceId) => manifestD(sourceId)],
    [f.id, (_topicId, sourceId) => manifestD(sourceId)],
    [g.id, (_topicId, sourceId) => manifestD(sourceId)]
  ]);
  const model = modelOf({ bad: new Set(), bySource });
  const deps = { databasePath: dbPath, modelCall: model, openDatabase: migrateDatabase };

  // ============================================================
  // A1 单条 Ingest：高价值 Source A 晋升
  // ============================================================
  const runA = await runSourceKnowledgeCompile(deps, { sourceId: a.id, revision: a.revision });
  assert.equal(runA.topics.length, 1, 'A 只链接一个 Topic');
  assert.equal(runA.topics[0].result, 'ok', 'A 编译成功');
  const aRequestId = knowledgeCompileTopicRequestId(a.id, a.revision, t1.id);
  const aReceipt = one(database,
    'SELECT counts_json AS countsJson, wiki_page_versions_json AS wikiPageVersions FROM knowledge_update_receipts WHERE request_id = ?',
    aRequestId);
  assert.ok(aReceipt, 'A 回执存在');
  const aCounts = parseJson(aReceipt.countsJson);
  assert.equal(aCounts.notesCreated, 2, 'A 晋升 2 条 Note');
  assert.equal(aCounts.wikiPagesCompiled, 1, 'A 编译 1 个 Wiki 页');
  assert.equal(parseJson(aReceipt.wikiPageVersions).length, 1, 'A 回执带 1 个页版本引用');
  // Note + Evidence 指向真实 Source
  const aNote = one(database, "SELECT id, current_version_id AS currentVersionId FROM knowledge_notes WHERE canonical_key = 'agentforge-router'");
  assert.ok(aNote, 'A 的 claim Note 已晋升');
  const aNoteVer = one(database,
    'SELECT id, statement FROM knowledge_note_versions WHERE note_id = ? AND version_number = 1', aNote.id);
  assert.equal(aNoteVer.statement, 'AgentForge v2 支持多模型路由。');
  const aEvidence = one(database,
    'SELECT evidence_object_id AS objectId FROM knowledge_evidence_links WHERE knowledge_note_version_id = ? AND evidence_object_type = \'source\'',
    aNoteVer.id);
  assert.equal(aEvidence.objectId, a.id, 'A 的 Note 证据回指 Source A');
  // Topic Wiki 页 v1
  const t1Page = one(database,
    "SELECT id, revision, current_version_id AS currentVersionId FROM knowledge_wiki_pages WHERE subject_type = 'topic' AND subject_id = ?", t1.id);
  assert.ok(t1Page, 'T1 Topic 页存在');
  assert.equal(t1Page.revision, 1, 'T1 页 revision=1');
  const t1v1 = one(database,
    'SELECT body_json AS bodyJson, adopted_note_version_ids_json AS adopted FROM knowledge_wiki_page_versions WHERE id = ?', t1Page.currentVersionId);
  const t1v1Body = parseJson(t1v1.bodyJson);
  assert.deepEqual(t1v1Body.compiledSourceIds, [a.id], 'v1 编译来源=[A]');
  assert.equal(t1v1Body.keyConclusions.length, 2, 'v1 采纳 2 条结论');
  assert.equal(parseJson(t1v1.adopted).length, 2, 'v1 adoptedNoteVersionIds=2');
  const entityCount = count(database, 'knowledge_entities', "WHERE canonical_key = 'agentforge'");
  assert.equal(entityCount, 1, 'Entity agentforge 晋升');

  // ============================================================
  // A2 低价值保留 Raw：Source C 纯复述 → 零晋升
  // ============================================================
  const beforeC = {
    notes: count(database, 'knowledge_notes'),
    noteVersions: count(database, 'knowledge_note_versions'),
    pageVersions: count(database, 'knowledge_wiki_page_versions'),
    evidence: count(database, 'knowledge_evidence_links')
  };
  const runC = await runSourceKnowledgeCompile(deps, { sourceId: c.id, revision: c.revision });
  assert.equal(runC.topics[0].result, 'ok', 'C 编译整体成功（空计划合法）');
  // 价值门证据（真实候选服务读回）
  const planC = await generateKnowledgeCandidatePlan(database, {
    workspaceId, sourceId: c.id, topicId: t1.id, createdBy: 'background_agent',
    triggerSource: 'ingest', sourceNature: 'primary_source', modelCall: model
  });
  assert.equal(planC.ok, true, 'C 候选计划合法');
  assert.equal(planC.skipped.filter((s) => s.stage === 'value' && s.reasonCode === 'LOW_VALUE_RESTATEMENT').length, 2,
    'C 两条候选在价值门被跳过（结构化原因）');
  assert.equal(planC.plan.notes.length, 0, 'C 计划零 Note 候选');
  const cRequestId = knowledgeCompileTopicRequestId(c.id, c.revision, t1.id);
  const cReceipt = one(database, 'SELECT counts_json AS countsJson FROM knowledge_update_receipts WHERE request_id = ?', cRequestId);
  assert.ok(cReceipt, 'C 回执存在（诚实记录零晋升）');
  const cCounts = parseJson(cReceipt.countsJson);
  assert.equal(cCounts.notesCreated, 0, 'C 零 Note 晋升');
  assert.equal(cCounts.wikiPagesCompiled, 0, 'C 零 Wiki 页编译');
  assert.equal(count(database, 'knowledge_notes'), beforeC.notes, 'C 后 Note 表零新增');
  assert.equal(count(database, 'knowledge_note_versions'), beforeC.noteVersions, 'C 后 Note 版本零新增');
  assert.equal(count(database, 'knowledge_wiki_page_versions'), beforeC.pageVersions, 'C 后 Wiki 版本零新增');
  assert.equal(count(database, 'knowledge_evidence_links'), beforeC.evidence, 'C 后 Evidence 零新增');
  const cSource = one(database, 'SELECT revision FROM source_items WHERE id = ?', c.id);
  assert.equal(cSource.revision, 1, 'Source C 保持原样（Raw）');

  // ============================================================
  // A4 同 Topic 跨两 Source 重编译多个页面：B（T1→v2；T2→v1）
  // ============================================================
  const runB = await runSourceKnowledgeCompile(deps, { sourceId: b.id, revision: b.revision });
  assert.equal(runB.topics.length, 2, 'B 编译两个 Topic');
  assert.ok(runB.topics.every((o) => o.result === 'ok'), 'B 两个 Topic 均成功');
  const t1Page2 = one(database,
    "SELECT revision, current_version_id AS currentVersionId FROM knowledge_wiki_pages WHERE subject_type = 'topic' AND subject_id = ?", t1.id);
  assert.equal(t1Page2.revision, 2, 'T1 页 revision 1→2（跨 Source 重编译）');
  const t1v2 = one(database,
    'SELECT body_json AS bodyJson, adopted_note_version_ids_json AS adopted FROM knowledge_wiki_page_versions WHERE id = ?', t1Page2.currentVersionId);
  const t1v2Body = parseJson(t1v2.bodyJson);
  assert.deepEqual(t1v2Body.compiledSourceIds, [b.id], 'v2 编译来源=[B]');
  assert.equal(t1v2Body.keyConclusions.length, 4, 'v2 采纳 A+B 两代 4 条结论');
  const statementsV2 = t1v2Body.keyConclusions.map((c) => c.statement);
  assert.ok(statementsV2.includes('AgentForge v2 支持多模型路由。'), 'v2 含 A 的结论');
  assert.ok(statementsV2.includes('AgentForge 灰度调度支持按比例切换多模型路由。'), 'v2 含 B 的结论');
  assert.equal(parseJson(t1v2.adopted).length, 4, 'v2 adoptedNoteVersionIds=4（A×2 + B×2）');
  // B 同时编译 T2 页（第二个页面）
  const t2Page = one(database,
    "SELECT revision, current_version_id AS currentVersionId FROM knowledge_wiki_pages WHERE subject_type = 'topic' AND subject_id = ?", t2.id);
  assert.ok(t2Page, 'T2 Topic 页创建');
  assert.equal(t2Page.revision, 1, 'T2 页 revision=1');
  const t2v1 = one(database,
    'SELECT body_json AS bodyJson FROM knowledge_wiki_page_versions WHERE id = ?', t2Page.currentVersionId);
  const t2v1Body = parseJson(t2v1.bodyJson);
  assert.deepEqual(t2v1Body.compiledSourceIds, [b.id], 'T2 页编译来源=[B]');
  const bT1RequestId = knowledgeCompileTopicRequestId(b.id, b.revision, t1.id);
  const bT2RequestId = knowledgeCompileTopicRequestId(b.id, b.revision, t2.id);
  assert.ok(one(database, 'SELECT 1 AS one FROM knowledge_update_receipts WHERE request_id = ?', bT1RequestId), 'B/T1 回执存在');
  assert.ok(one(database, 'SELECT 1 AS one FROM knowledge_update_receipts WHERE request_id = ?', bT2RequestId), 'B/T2 回执存在');

  // ============================================================
  // A3 批量部分失败诚实：knowledge.backfill 一步扫描 6 条
  // ============================================================
  const backfillDeps = {
    databasePath: dbPath,
    compileSource: createKnowledgeBackfillCompile({ databasePath: dbPath, modelCall: modelOf({ bad: new Set([e.id]) }), openDatabase: migrateDatabase }),
    openDatabase: migrateDatabase
  };
  const step1 = await runKnowledgeBackfillStep(database, backfillDeps, { batchLimit: 10 });
  assert.equal(step1.processed, 4, '第一步处理 4 条（A/B/D/E）；C/F/G 为排除项');
  const byStatus1 = Object.fromEntries(step1.outcomes.map((o) => [o.sourceId, o.status]));
  assert.equal(byStatus1[a.id], 'skipped_existing_receipt', 'A 已有回执 → 跳过');
  assert.equal(byStatus1[b.id], 'skipped_existing_receipt', 'B 已由 ingest 触发编译（T1+T2 回执）→ 跳过');
  assert.equal(byStatus1[c.id], 'skipped_no_signal', 'C 无价值信号 → skipped_no_signal（ingest 已编译但无回溯信号，诚实排除）');
  assert.equal(byStatus1[d.id], 'compiled', 'D 编译成功');
  assert.equal(byStatus1[e.id], 'failed', 'E 模型失败 → failed');
  assert.equal(byStatus1[f.id], 'skipped_weak', 'F 弱资料 → skipped_weak');
  assert.equal(byStatus1[g.id], 'skipped_no_topic', 'G 无 Topic → skipped_no_topic');
  const eOutcome = step1.outcomes.find((o) => o.sourceId === e.id);
  assert.equal(eOutcome.topics.length, 1, 'E 逐 Topic 失败证据');
  assert.equal(eOutcome.topics[0].result, 'error', 'E Topic 结果 error');
  assert.match(eOutcome.topics[0].code, /^BACKFILL:(PLAN|COMPILE):MODEL_CALL_FAILED$/, 'E 失败码可见');
  const cp1 = parseJson(one(database, 'SELECT value FROM app_meta WHERE key = ?', BACKFILL_CHECKPOINT_META_KEY).value);
  assert.deepEqual(cp1.counts, {
    scanned: 7, processed: 4, compiled: 1, failed: 1,
    skippedExistingReceipt: 2, skippedWeak: 1, skippedNoTopic: 1, skippedNoSignal: 1
  }, 'checkpoint counts 如实（无虚报成功）');
  assert.equal(cp1.status, 'running', '有待重试 → 状态 running（诚实）');
  assert.deepEqual(cp1.pendingRetry, [e.id], 'E 进入重试队列');
  // 失败零写：E 未产生任何 Note/版本/证据/回执
  assert.equal(count(database, 'knowledge_update_receipts', 'WHERE request_id LIKE ?', [`compile:source:${e.id}:%`]), 0, 'E 零回执');
  assert.equal(count(database, 'knowledge_evidence_links', 'WHERE locator LIKE ?', [`%bf-${e.id.slice(0, 8)}%`]), 0, 'E 零 Evidence');
  // operation_log 落失败 errorCode
  const eOps = all(database,
    "SELECT result, error_code AS errorCode FROM operation_log WHERE command = ? AND entity_id LIKE ?", KNOWLEDGE_BACKFILL_COMMAND, `${e.id}:%`);
  assert.ok(eOps.length >= 1, 'E 失败操作日志存在');
  assert.ok(eOps.every((o) => o.result === 'error' && o.errorCode), '失败日志带 errorCode');
  // 重试收敛：模型修复后第二步，failed 历史保留
  const step2 = await runKnowledgeBackfillStep(database, {
    databasePath: dbPath,
    compileSource: createKnowledgeBackfillCompile({ databasePath: dbPath, modelCall: modelOf({ bad: new Set() }), openDatabase: migrateDatabase }),
    openDatabase: migrateDatabase
  }, { batchLimit: 10 });
  assert.equal(step2.outcomes.filter((o) => o.sourceId === e.id)[0].status, 'compiled', 'E 重试成功');
  assert.equal(step2.done, true, '第二步完成');
  const cp2 = parseJson(one(database, 'SELECT value FROM app_meta WHERE key = ?', BACKFILL_CHECKPOINT_META_KEY).value);
  assert.deepEqual(cp2.counts, {
    scanned: 8, processed: 5, compiled: 2, failed: 1,
    skippedExistingReceipt: 2, skippedWeak: 1, skippedNoTopic: 1, skippedNoSignal: 1
  }, '重试后 compiled=2 且 failed=1 历史保留（诚实累计）');
  assert.deepEqual(cp2.pendingRetry, [], '重试队列清空');
  assert.equal(cp2.status, 'completed', '状态 completed');

  // ============================================================
  // A5 固定旧版本在新版本后仍解析
  // ============================================================
  const t1PageRow = one(database,
    "SELECT id FROM knowledge_wiki_pages WHERE subject_type = 'topic' AND subject_id = ?", t1.id);
  const t1Versions = all(database,
    'SELECT id, version_number AS versionNumber, adopted_note_version_ids_json AS adopted FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number', t1PageRow.id);
  assert.equal(t1Versions.length, 4, 'T1 页四代版本：A→v1、B→v2、批量 D→v3、重试 E→v4');
  assert.deepEqual(t1Versions.map((v) => v.versionNumber), [1, 2, 3, 4], '版本号逐代递增');
  assert.deepEqual(t1Versions.map((v) => parseJson(v.adopted).length), [2, 4, 5, 6], 'adopted 结论集随代增长');
  const t1VersionIds = t1Versions.map((v) => v.id);
  const [t1V1Id, t1V2Id, , t1V4Id] = t1VersionIds;
  const q5 = runFixedVersionQuery(database, {
    question: '基于这些固定版本回答：AgentForge 路由能力如何变化？',
    wikiVersionRefs: [`wiki_page:${t1PageRow.id}:${t1V1Id}`, `wiki_page:${t1PageRow.id}:${t1V4Id}`],
    noteVersionRefs: [`knowledge_note:${aNote.id}:${aNoteVer.id}`]
  });
  assert.equal(q5.ok, true, '固定版本查询成功（旧版本 v1 在新版本 v4 之后仍解析）');
  const pages = q5.wikiPages;
  assert.equal(pages.length, 2, '两个页版本都解析');
  const pv1 = pages.find((p) => p.versionId === t1V1Id);
  const pvLatest = pages.find((p) => p.versionId === t1V4Id);
  assert.equal(pv1.versionNumber, 1, '旧版本 version_number=1');
  assert.equal(pvLatest.versionNumber, 4, '最新版本 version_number=4');
  assert.deepEqual(pv1.adoptedNoteVersionIds, parseJson(t1Versions[0].adopted), '旧版本内容与库中 v1 一致（未随新版本改变）');
  assert.deepEqual(pvLatest.adoptedNoteVersionIds, parseJson(t1Versions[3].adopted), '最新版本内容与库中 v4 一致');
  assert.equal(q5.noteVersions.length, 1, 'Note 旧版本解析');
  assert.equal(q5.noteVersions[0].statement, 'AgentForge v2 支持多模型路由。');
  const refResolve = resolveFixedVersionRefs(database, [`wiki_page:${t1PageRow.id}:${t1V1Id}`, `knowledge_note:${aNote.id}:${aNoteVer.id}`]);
  assert.equal(refResolve.ok, true, 'resolveFixedVersionRefs 通过（旧版本归属校验）');

  // ============================================================
  // A6 Query 写回：restatement 零知识 / new_synthesis 引用写回
  // ============================================================
  // B-T1 的第一个 Note 版本（b-gray-routing）作为第二条读取版本
  const bGrayNote = one(database, "SELECT id FROM knowledge_notes WHERE canonical_key LIKE 'b-%-gray-routing'");
  const bGrayVer = one(database,
    'SELECT id, statement FROM knowledge_note_versions WHERE note_id = ? AND version_number = 1', bGrayNote.id);
  const synthKey = 'synthesis:agent-router-gray';
  const baseSnapshot = {
    notes: count(database, 'knowledge_notes'),
    noteVersions: count(database, 'knowledge_note_versions'),
    pages: count(database, 'knowledge_wiki_pages'),
    pageVersions: count(database, 'knowledge_wiki_page_versions'),
    evidence: count(database, 'knowledge_evidence_links'),
    artifacts: count(database, 'knowledge_query_artifacts'),
    receipts: count(database, 'knowledge_update_receipts')
  };
  const convId = 'conv-5241-chain';

  // --- A6.1 restatement：零知识写 ---
  const restateQuestion = 'AgentForge v2 是否支持多模型路由？';
  const restate = writebackQueryKnowledge(database, {
    workspaceId, scope: 'global',
    requestId: knowledgeQueryWritebackRequestId(convId, restateQuestion),
    conversationId: convId, question: restateQuestion,
    answerSummary: '支持。AgentForge v2 支持多模型路由（纯复述既有知识）。',
    classification: 'restatement',
    readWikiVersionIds: [], readNoteVersionIds: [aNoteVer.id], readEvidenceIds: []
  });
  assert.equal(restate.ok, true, 'restatement 写回成功');
  assert.equal(restate.writeBackDecision, 'skipped_repetition', 'restatement → skipped_repetition');
  assert.equal(restate.counts.restatements, 1, 'restatement 计数 1');
  assert.equal(count(database, 'knowledge_notes'), baseSnapshot.notes, 'restatement 零 Note 写');
  assert.equal(count(database, 'knowledge_note_versions'), baseSnapshot.noteVersions, 'restatement 零 Note 版本写');
  assert.equal(count(database, 'knowledge_wiki_pages'), baseSnapshot.pages, 'restatement 零 Wiki 页写');
  assert.equal(count(database, 'knowledge_wiki_page_versions'), baseSnapshot.pageVersions, 'restatement 零 Wiki 版本写');
  assert.equal(count(database, 'knowledge_evidence_links'), baseSnapshot.evidence, 'restatement 零 Evidence 写');
  assert.equal(count(database, 'knowledge_query_artifacts'), baseSnapshot.artifacts + 1, 'restatement 仅 Artifact');
  assert.equal(count(database, 'knowledge_update_receipts'), baseSnapshot.receipts + 1, 'restatement 仅 Receipt');

  // --- A6.2 new_synthesis：引用冻结读取版本写回 ---
  const synthQuestion = 'AgentForge 路由与灰度调度综合结论是什么？';
  const readNoteIds = [aNoteVer.id, bGrayVer.id];
  const synth = writebackQueryKnowledge(database, {
    workspaceId, scope: 'global',
    requestId: knowledgeQueryWritebackRequestId(convId, synthQuestion),
    conversationId: convId, question: synthQuestion,
    answerSummary: 'AgentForge v2 多模型路由 + 灰度调度支持高吞吐批处理。',
    classification: 'new_synthesis',
    readWikiVersionIds: [t1V2Id], readNoteVersionIds: readNoteIds, readEvidenceIds: [],
    synthesis: {
      canonicalKey: synthKey,
      title: 'AgentForge 路由与灰度',
      statement: '综合：AgentForge v2 多模型路由与灰度调度互相印证，支撑高吞吐批量调用。',
      basedOnNoteVersionIds: readNoteIds,
      valueRationale: '两条独立来源（官方公告 + 灰度调度公告）互相印证。'
    }
  });
  assert.equal(synth.ok, true, 'new_synthesis 写回成功');
  assert.equal(synth.writeBackDecision, 'created', 'new_synthesis → created');
  assert.equal(synth.counts.notesCreated, 1, '综合 Note 创建');
  assert.equal(synth.counts.noteVersionsCreated, 1, '综合 Note 版本创建');
  assert.equal(synth.counts.evidenceLinks, 3, '证据链=2 Note 版本 derived_from + 1 Wiki 版本 ai_inference');
  assert.equal(synth.counts.wikiPagesCompiled, 1, 'Synthesis Wiki 页编译');
  // SQLite 读回：综合 Note + 版本 + 引用
  const synthNote = one(database, 'SELECT id, kind FROM knowledge_notes WHERE canonical_key = ?', synthKey);
  assert.ok(synthNote, '综合 Note 落库');
  assert.equal(synthNote.kind, 'insight', '综合 Note kind=insight');
  const synthNoteVer = one(database,
    'SELECT id, adopted_knowledge_version_ids_json AS adopted FROM knowledge_note_versions WHERE note_id = ? AND version_number = 1', synthNote.id);
  assert.deepEqual(parseJson(synthNoteVer.adopted), readNoteIds, '综合 Note 版本 adoptedKnowledgeVersionIds=冻结读取集');
  // 引用证据（citations）：derived_from → 每条冻结读取 Note 版本
  const synthEvidence = all(database,
    'SELECT evidence_object_type AS type, evidence_object_id AS id, relation, source_nature AS nature FROM knowledge_evidence_links WHERE knowledge_note_version_id = ? ORDER BY evidence_object_id', synthNoteVer.id);
  assert.equal(synthEvidence.length, 3, '综合版本 3 条证据');
  const noteEvidences = synthEvidence.filter((ev) => ev.type === 'knowledge_note_version' && ev.relation === 'derived_from' && ev.nature === 'derived_knowledge');
  assert.deepEqual(noteEvidences.map((ev) => ev.id).sort(), [...readNoteIds].sort(), 'derived_from 指向两条冻结读取版本');
  assert.ok(synthEvidence.some((ev) => ev.type === 'wiki_page_version' && ev.id === t1V2Id && ev.relation === 'derived_from'), 'Wiki 版本以 ai_inference 记录');
  // Synthesis Wiki 页：basedOn.noteVersionIds=读取集
  const synthPage = one(database, "SELECT id, current_version_id AS currentVersionId FROM knowledge_wiki_pages WHERE page_type = 'synthesis' AND canonical_key = ?", `synthesis:${synthKey}`);
  assert.ok(synthPage, 'Synthesis Wiki 页创建');
  const synthPageVer = one(database, 'SELECT body_json AS bodyJson FROM knowledge_wiki_page_versions WHERE id = ?', synthPage.currentVersionId);
  const synthPageBody = parseJson(synthPageVer.bodyJson);
  assert.equal(synthPageBody.kind, 'synthesis-wiki', '页版本 kind=synthesis-wiki');
  assert.equal(synthPageBody.classification, 'new_synthesis');
  assert.deepEqual(synthPageBody.basedOn.noteVersionIds, readNoteIds, '页 basedOn.noteVersionIds=冻结读取集');
  // Artifact / Receipt
  const synthArtifact = one(database,
    'SELECT write_back_decision AS decision, read_note_version_ids_json AS readNote FROM knowledge_query_artifacts WHERE request_id = ?',
    knowledgeQueryWritebackRequestId(convId, synthQuestion));
  assert.equal(synthArtifact.decision, 'created');
  assert.deepEqual(parseJson(synthArtifact.readNote), readNoteIds, 'Artifact 记录冻结读取集');
  assert.equal(count(database, 'knowledge_update_receipts'), baseSnapshot.receipts + 2, 'Receipt 累计（restatement + synthesis）');
  // 写回产物进入固定版本读面（链闭环）
  const q6 = runFixedVersionQuery(database, { noteVersionRefs: [`knowledge_note:${synthNote.id}:${synthNoteVer.id}`] });
  assert.equal(q6.ok, true, '综合 Note 版本可被固定版本 Query 解析');
  assert.equal(q6.noteVersions[0].statement, '综合：AgentForge v2 多模型路由与灰度调度互相印证，支撑高吞吐批量调用。');

  // --- A6.3 同 requestId 重放 → duplicate 零增量 ---
  const beforeReplay = {
    notes: count(database, 'knowledge_notes'),
    noteVersions: count(database, 'knowledge_note_versions'),
    pages: count(database, 'knowledge_wiki_pages'),
    pageVersions: count(database, 'knowledge_wiki_page_versions'),
    evidence: count(database, 'knowledge_evidence_links'),
    artifacts: count(database, 'knowledge_query_artifacts'),
    receipts: count(database, 'knowledge_update_receipts')
  };
  const replay = writebackQueryKnowledge(database, {
    workspaceId, scope: 'global',
    requestId: knowledgeQueryWritebackRequestId(convId, synthQuestion),
    conversationId: convId, question: synthQuestion,
    answerSummary: 'AgentForge v2 多模型路由 + 灰度调度支持高吞吐批处理。',
    classification: 'new_synthesis',
    readWikiVersionIds: [t1V2Id], readNoteVersionIds: readNoteIds, readEvidenceIds: [],
    synthesis: {
      canonicalKey: synthKey, title: 'AgentForge 路由与灰度',
      statement: '综合：AgentForge v2 多模型路由与灰度调度互相印证，支撑高吞吐批量调用。',
      basedOnNoteVersionIds: readNoteIds,
      valueRationale: '两条独立来源（官方公告 + 灰度调度公告）互相印证。'
    }
  });
  assert.equal(replay.duplicate, true, '同问重放 → duplicate');
  assert.equal(replay.counts.notesCreated, 0, '重放零 Note 写');
  assert.equal(count(database, 'knowledge_notes'), beforeReplay.notes, '重放后 Note 零新增');
  assert.equal(count(database, 'knowledge_note_versions'), beforeReplay.noteVersions, '重放后 Note 版本零新增');
  assert.equal(count(database, 'knowledge_wiki_pages'), beforeReplay.pages, '重放后 Wiki 页零新增');
  assert.equal(count(database, 'knowledge_wiki_page_versions'), beforeReplay.pageVersions, '重放后 Wiki 版本零新增');
  assert.equal(count(database, 'knowledge_evidence_links'), beforeReplay.evidence, '重放后 Evidence 零新增');
  assert.equal(count(database, 'knowledge_query_artifacts'), beforeReplay.artifacts, '重放后 Artifact 零新增');
  assert.equal(count(database, 'knowledge_update_receipts'), beforeReplay.receipts, '重放后 Receipt 零新增');

  // ============================================================
  // 证据落盘（tests/e2e/.artifacts/WMB-5241-ingest-query-chain.json）
  // ============================================================
  const evidence = {
    schema: 'wmb-5241-ingest-query-chain.v1',
    dataRoot: dbPath,
    workspaceId,
    pass: ['A1-single-ingest-promote', 'A2-low-value-raw', 'A3-batch-partial-failure-honest', 'A4-cross-source-recompile', 'A5-fixed-old-version-resolves', 'A6-query-restatement-zero-write', 'A6-new-synthesis-writeback-cited'],
    sqliteReadback: {
      topicPages: {
        t1: { id: t1PageRow.id, versions: t1VersionIds, revision: t1Page2.revision },
        t2: { id: t2Page.id, version: t2Page.currentVersionId, revision: t2Page.revision }
      },
      promotedNotes: ['agentforge-router', 'agentforge-pricing', 'b-gray-routing', 'b-latency-cache'],
      receipts: { a: aRequestId, c: cRequestId, bT1: bT1RequestId, bT2: bT2RequestId },
      backfillCheckpoint: cp2,
      queryWriteback: {
        restatementRequestId: knowledgeQueryWritebackRequestId(convId, restateQuestion),
        synthesisRequestId: knowledgeQueryWritebackRequestId(convId, synthQuestion),
        synthesisNoteVersionId: synthNoteVer.id,
        synthesisPageVersionId: synthPage.currentVersionId,
        evidenceLinks: synthEvidence
      }
    }
  };
  try {
    const artifactDir = path.resolve(import.meta.dirname, 'e2e', '.artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, 'WMB-5241-ingest-query-chain.json'), JSON.stringify(evidence, null, 2), 'utf8');
  } catch (error) {
    console.warn('[WMB-5241] 证据文件写入失败（不影响断言结果）:', error.message);
  }

  database.close();
});
