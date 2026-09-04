// WMB-5351 targeted planner fix: bounded exact-item contract, lock, prompt, readback, daily preservation
// Verify via: node --test tests/wmb-5351-targeted-planner.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function readFileRel(p) {
  return fs.readFile(path.join(root, p), 'utf8');
}

// --- helper to import TS modules (Node 22 strips types) ---
let registry, policies, runner;
async function ensureModules() {
  if (!registry) {
    registry = await import('../src/main/role-job-registry.ts');
    policies = await import('../src/main/role-job-policies.ts');
    runner = await import('../src/main/generic-employee-runner.ts');
  }
}

test('registry: carries optional planItemId through RoleJobSpec and derives exact lock + plan_item_ready readback', async () => {
  await ensureModules();
  const { deriveRoleJobSpec } = registry;
  const ws = 'ws-test';
  // targeted
  const specTargeted = deriveRoleJobSpec({ roleId: 'planner', brief: 'bounded test', businessDate: '2026-08-24', planItemId: 'pi-exact-123' }, ws);
  assert.equal(specTargeted.planItemId, 'pi-exact-123');
  assert.equal(specTargeted.readback, 'plan_item_ready');
  assert.ok(specTargeted.resourceLocks[0].startsWith('plan-item:'), 'targeted lock must be exact plan-item');
  assert.ok(specTargeted.resourceLocks[0].includes('pi-exact-123'), 'lock must contain exact planItemId');
  // daily unchanged
  const specDaily = deriveRoleJobSpec({ roleId: 'planner', brief: 'daily', businessDate: '2026-08-24' }, ws);
  assert.equal(specDaily.planItemId, null);
  assert.equal(specDaily.readback, 'plans_revision');
  assert.ok(specDaily.resourceLocks[0].startsWith('plan:'), 'daily lock unchanged');
  assert.ok(specDaily.resourceLocks[0].includes('2026-08-24'));
});

test('registry: deriveResourceLocks exact vs daily', async () => {
  await ensureModules();
  const { deriveResourceLocks } = registry;
  const daily = deriveResourceLocks({ roleId: 'planner', workspaceId: 'ws1', businessDate: '2026-08-24' });
  assert.deepEqual(daily, ['plan:ws1:2026-08-24']);
  const targeted = deriveResourceLocks({ roleId: 'planner', workspaceId: 'ws1', businessDate: '2026-08-24', planItemId: 'pi-999' });
  assert.deepEqual(targeted, ['plan-item:ws1:pi-999']);
  // empty planItemId falls back to daily
  const empty = deriveResourceLocks({ roleId: 'planner', workspaceId: 'ws1', businessDate: '2026-08-24', planItemId: '  ' });
  assert.deepEqual(empty, ['plan:ws1:2026-08-24']);
});


test('policies: runJudgePolicy branches to targeted and preserves ordinary daily judge', async () => {
  const content = await readFileRel('src/main/role-job-policies.ts');
  // branch must exist
  assert.ok(content.includes('runTargetedPlannerPolicy') || content.includes('targetedPlannerPrompt'), 'must have targeted planner policy');
  assert.ok(content.includes("ctx.spec.planItemId"), 'must carry planItemId through spec');
  // targeted must create/use scoped planner task
  assert.ok(content.includes("intent: 'daily_judge'"), 'targeted must use daily_judge intent with scoped task');
  assert.ok(content.includes('dispatchStartAgentTask'), 'targeted must create task via dispatchStartAgentTask');
  assert.ok(content.includes('planItemId'), 'targeted task must be scoped to planItemId');
  // bounded Pi prompt forbidding bypass
  assert.ok(content.includes('禁止调用 read、bash、grep') || content.includes('禁止旁路') || content.includes('forbid'), 'prompt must forbid filesystem/SQLite bypass');
  assert.ok(content.includes('plan_item.submit'), 'prompt must require exact plan_item.submit');
  assert.ok(content.includes('wmb_get_agent_task') || content.includes('WMB MCP'), 'prompt must require WMB MCP reads');
  assert.ok(content.includes('ready_for_review'), 'prompt must require readback ready_for_review');
  // ordinary daily path unchanged
  assert.ok(content.includes('startWorkspaceDailyIntelligence'), 'must preserve startWorkspaceDailyIntelligence');
  assert.ok(content.includes('judgeOnly: true'), 'daily path must remain judgeOnly');
  // ensure no direct SQLite business mutation in planner runtime
  const plannerSection = content.slice(content.indexOf('runTargetedPlannerPolicy'));
  assert.ok(!plannerSection.includes('UPDATE plan_items SET planning_status'), 'planner runtime must not do direct SQLite business mutation');
});

test('policies: targeted prompt is bounded and forbids filesystem/SQLite bypass (would catch old daily-only runJudgePolicy)', async () => {
  await ensureModules();
  // old path was runJudgePolicy() => startWorkspaceDailyIntelligence({judgeOnly:true}) unconditionally — no planItemId branch.
  // New path must have branch and prompt containing forbid list and exact submit.
  const content = await readFileRel('src/main/role-job-policies.ts');
  assert.ok(content.includes('不得自动换成安全小题'), 'targeted prompt must retain the strongest thesis instead of preserving a safe fallback');
  assert.ok(content.includes('editorial_thesis_v1'), 'targeted prompt must require three-level thesis competition');
  assert.ok(content.includes('truthGate'), 'targeted prompt must require the truth admission gate');
  assert.ok(content.includes('knowledgeContext'), 'targeted prompt must persist a truthful knowledge receipt');
  for (const criterion of ['reality_change_significance(25)', 'tension_curiosity_gap(20)', 'audience_stakes(20)', 'why_now_window(15)', 'one_sentence_relayability(15)', 'account_fit(5)']) {
    assert.ok(content.includes(criterion), `targeted prompt must name ${criterion}`);
  }
  assert.ok(content.includes('propagation_v2'), 'targeted prompt must require the V2 score before its single submit');
  assert.ok(content.includes('可执行性、容易实验、容易拿到回执不是 propagation_v2 的独立加分项'), 'targeted prompt must not reward tactical experiments over a larger supported thesis');
  assert.ok(content.includes('不得仅因个人测试更容易落地'), 'targeted prompt must forbid collapsing a major release into a small personal test');
  assert.ok(content.includes('wiki_page:<pageId>:<currentVersionId>'), 'targeted prompt must compose canonical wiki page references');
  assert.ok(content.includes('knowledge_note:<noteId>:<versionId>'), 'targeted prompt must compose canonical note references');
  assert.ok(content.includes('严禁只提交 wver-* / ver-* 裸版本 ID'), 'targeted prompt must reject naked knowledge version IDs');
  assert.ok(content.includes('wmb_get_knowledge_context 返回的 sources/evidence ID 不得混入 sourceIds'), 'targeted prompt must keep knowledge evidence IDs out of frozen sourceIds');
  const hasBranch = content.includes("typeof ctx.spec.planItemId") || content.includes('ctx.spec.planItemId');
  assert.ok(hasBranch, 'old path missing branch would be caught here');
  // inspect prompt function if exported
  if (policies.targetedPlannerPrompt) {
    const fakeTask = { id: 'task-1' };
    const fakeCtx = { spec: { planItemId: 'pi-abc' }, jobId: 'job-1', businessDate: '2026-08-24', brief: 'test' };
    const prompt = policies.targetedPlannerPrompt(fakeTask, fakeCtx);
    assert.ok(prompt.includes('plan_item_id=pi-abc'), 'prompt must contain exact planItemId');
    assert.ok(prompt.includes('plan_item.submit'), 'prompt must require plan_item.submit');
    assert.ok(prompt.toLowerCase().includes('forbid') || prompt.includes('禁止'), 'prompt must forbid bypass');
    assert.ok(prompt.includes('WMB MCP') || prompt.includes('wmb_get'), 'prompt must require WMB MCP');
    assert.ok(prompt.includes('ready_for_review'), 'prompt must require ready_for_review');
    assert.ok(prompt.includes('不得调用 plans.save'), 'targeted must explicitly forbid plans.save');
  }
});

test('runner: readback kind proves exact plan item is ready_for_review and terminal remains honest', async () => {
  await ensureModules();
  const { readbackPlanItemReady } = registry;
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE plan_items (id TEXT PRIMARY KEY, planning_status TEXT, planning_provenance_json TEXT, updated_at TEXT);
    CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, status TEXT, context_refs_json TEXT, planning_provenance_json TEXT);
  `);
  const pid = 'pi-runner-test';
  db.prepare('INSERT INTO plan_items (id, planning_status, planning_provenance_json, updated_at) VALUES (?, ?, ?, ?)').run(pid, 'draft', '{}', new Date().toISOString());
  // not ready -> null (honest: no fake succeeded)
  let rb = readbackPlanItemReady(db, pid);
  assert.equal(rb, null, 'draft must not be plan_item_ready');
  // approved also not ready
  db.prepare('UPDATE plan_items SET planning_status = ? WHERE id = ?').run('approved', pid);
  rb = readbackPlanItemReady(db, pid);
  assert.equal(rb, null, 'approved must not be plan_item_ready');
  // ready_for_review -> succeeds with exact kind
  db.prepare('UPDATE plan_items SET planning_status = ? WHERE id = ?').run('ready_for_review', pid);
  rb = readbackPlanItemReady(db, pid);
  assert.ok(rb && rb.kind === 'plan_item_ready' && rb.planItemId === pid && rb.status === 'ready_for_review', 'must prove exact ready_for_review');
  // wrong id must not succeed
  const wrong = readbackPlanItemReady(db, 'other-id');
  assert.equal(wrong, null);
  // runner file must handle plan_item_ready success code and honest terminal
  const runnerContent = await readFileRel('src/main/generic-employee-runner.ts');
  assert.ok(runnerContent.includes("case 'plan_item_ready'"), 'runner must handle plan_item_ready readback');
  assert.ok(runnerContent.includes('PLAN_ITEM_READY_FOR_REVIEW'), 'success code must be PLAN_ITEM_READY_FOR_REVIEW');
  assert.ok(runnerContent.includes("spec.readback === 'plan_item_ready'"), 'terminal must be honest for targeted');
  assert.ok(runnerContent.includes('readbackPlanItemReady'), 'runner must use readbackPlanItemReady');
  assert.ok(runnerContent.includes('JOB_READBACK_MISSING') || runnerContent.includes('缺少'), 'honest lifecycle must fail without readback');
});

test('no direct SQLite business mutation in Planner prompt path and daily preserved', async () => {
  const policiesContent = await readFileRel('src/main/role-job-policies.ts');
  const runnerContent = await readFileRel('src/main/generic-employee-runner.ts');
  // policies targeted should not contain direct plan_items UPDATE
  assert.ok(!policiesContent.includes("UPDATE plan_items SET planning_status = 'ready_for_review'"), 'planner policies must not directly mutate plan_items');
  // runner may read but not mutate for plan_item_ready (only via command)
  assert.ok(runnerContent.includes("case 'plans_revision'"), 'daily plans_revision must still exist');
  // ensure ordinary planner without planItemId still maps to plans_revision
  await ensureModules();
  const { deriveRoleJobSpec } = registry;
  const dailySpec = deriveRoleJobSpec({ roleId: 'planner', brief: 'daily', businessDate: '2026-08-24' }, 'ws');
  assert.equal(dailySpec.readback, 'plans_revision');
});

test('mcp: plan_item.get is scoped read-only requiring task_id + plan_item_id and returns required fields', async () => {
  const mcpBusiness = await readFileRel('src/main/mcp-business-commands.ts');
  const getStart = mcpBusiness.indexOf("server.registerTool('plan_item.get'");
  const getSection = mcpBusiness.slice(getStart, mcpBusiness.indexOf("server.registerTool('plan_item.submit'", getStart));
  const helperSection = mcpBusiness.slice(mcpBusiness.indexOf('export function readScopedPlanItem'), mcpBusiness.indexOf('export function registerBusinessMutationMcp'));
  assert.ok(getStart >= 0, 'must register plan_item.get');
  assert.ok(getSection.includes('task_id'), 'must require task_id');
  assert.ok(getSection.includes('plan_item_id'), 'must require plan_item_id');
  assert.ok(getSection.includes('readScopedPlanItem(runtime.database'), 'handler must use scoped read helper');
  assert.ok(!getSection.includes('dispatchBusinessCommand'), 'read must not require a write grant or dispatcher');
  assert.ok(helperSection.includes('assertPlannerScoped'), 'read helper must enforce exact Planner scope');
  assert.ok(helperSection.includes('revision'), 'must return revision');
  assert.ok(helperSection.includes('planning_status'), 'must return planning_status');
  assert.ok(helperSection.includes('source_ids'), 'must return source_ids');
  assert.ok(helperSection.includes('available_materials'), 'must return available_materials');
  assert.ok(helperSection.includes('missing_materials'), 'must return missing_materials');
  assert.ok(helperSection.includes('score_reasons'), 'must return score_reasons');
  assert.ok(helperSection.includes('plan_items WHERE id = ?'), 'must select exact row by id');
  assert.ok(!helperSection.includes('submitPlanItemForReview'), 'read must not submit');
  assert.ok(!helperSection.includes('UPDATE plan_items'), 'read must not mutate');
});

test('mcp: WMB_TOOL_IDENTITY aliases plan_item.get/submit to public wmb names', async () => {
  const mcp = await readFileRel('src/main/mcp.ts');
  assert.ok(mcp.includes("'plan_item.get': 'wmb_get_plan_item'"), 'must alias plan_item.get -> wmb_get_plan_item');
  assert.ok(mcp.includes("'plan_item.submit': 'wmb_submit_plan_item'"), 'must alias plan_item.submit -> wmb_submit_plan_item');
});

test('policies: targeted prompt names public aliases wmb_get_plan_item / wmb_submit_plan_item', async () => {
  const policiesContent = await readFileRel('src/main/role-job-policies.ts');
  // prompt must mention public aliases, not just internal names
  assert.ok(policiesContent.includes('wmb_get_plan_item'), 'prompt must name wmb_get_plan_item');
  assert.ok(policiesContent.includes('wmb_submit_plan_item'), 'prompt must name wmb_submit_plan_item');
  // should still mention internal command names alongside alias for clarity
  assert.ok(policiesContent.includes('plan_item.get'), 'prompt should still reference plan_item.get');
  assert.ok(policiesContent.includes('plan_item.submit'), 'prompt should still reference plan_item.submit');
  // ensure Pi reported missing surface is now covered
  assert.ok(policiesContent.includes('assertPlannerScoped') || policiesContent.includes('task_id + plan_item_id'), 'prompt must note task_id + plan_item_id requirement');
});

test('Pi extension exposes exact Planner read and submit tools', async () => {
  const extension = await readFileRel('.pi/extensions/wmb-mcp/wmb-mcp-tools-core.ts');
  const getSection = extension.slice(extension.indexOf('const getPlanItem'), extension.indexOf('const submitPlanItem'));
  assert.ok(extension.includes("name: 'wmb_get_plan_item'"), 'Pi must expose wmb_get_plan_item');
  assert.ok(getSection.includes("callTool('plan_item.get'"), 'read wrapper must call plan_item.get');
  assert.ok(getSection.includes("required: ['taskId', 'planItemId']"), 'read wrapper needs only exact task and plan item identities');
  assert.ok(getSection.includes("task_id: String(params.taskId"), 'read wrapper must pass scoped task id');
  assert.ok(extension.includes("name: 'wmb_submit_plan_item'"), 'Pi must expose wmb_submit_plan_item');
  assert.ok(extension.includes("callTool('plan_item.submit'"), 'submit wrapper must call plan_item.submit');
  assert.ok(extension.includes('savePlan, getPlanItem, submitPlanItem'), 'both tools must be registered in coreTools');
});

test('plan_item.get reads only the Planner-bound item without a write grant', async () => {
  const { readScopedPlanItem } = await import('../src/main/mcp-business-commands.ts');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agent_tasks (
      id TEXT PRIMARY KEY, intent TEXT, business_date TEXT, status TEXT, phase TEXT,
      pi_session_id TEXT, context_refs_json TEXT, result_refs_json TEXT, progress_json TEXT,
      checkpoint_json TEXT, events_json TEXT, control_action TEXT, heartbeat_at TEXT,
      error_code TEXT, error_message TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT
    );
    CREATE TABLE plan_items (
      id TEXT PRIMARY KEY, revision INTEGER, planning_status TEXT, planning_provenance_json TEXT,
      title TEXT, priority INTEGER, why_now TEXT, timeliness TEXT, target_audience TEXT,
      angle TEXT, point_of_view TEXT, platforms_json TEXT, formats_json TEXT, title_guidance TEXT,
      opening_guidance TEXT, structure_guidance TEXT, effort_estimate TEXT, source_ids_json TEXT,
      available_materials_json TEXT, missing_materials_json TEXT, score_reasons_json TEXT,
      topic_id TEXT, plan_id TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT
    );
    INSERT INTO agent_tasks VALUES ('task-planner','daily_judge','2026-08-24','running','starting',NULL,
      '{"roleId":"planner","planItemId":"plan-exact"}','{}','{}','{}','[]',NULL,NULL,NULL,NULL,'now','now',NULL);
    INSERT INTO plan_items VALUES ('plan-exact',4,'draft','{}','Exact',1,'why','long','audience','angle','pov','[]','[]','title','open','structure','small','["source-1"]','["body"]','[]','{}',NULL,'plan',0,'now','now');
    INSERT INTO plan_items VALUES ('plan-other',1,'draft','{}','Other',1,'why','long','audience','angle','pov','[]','[]','title','open','structure','small','[]','[]','[]','{}',NULL,'plan',1,'now','now');
  `);
  const exact = readScopedPlanItem(db, 'task-planner', 'plan-exact');
  assert.equal(exact.id, 'plan-exact');
  assert.equal(exact.revision, 4);
  assert.deepEqual(exact.source_ids, ['source-1']);
  assert.throws(() => readScopedPlanItem(db, 'task-planner', 'plan-other'), (error) => error?.code === 'TASK_SCOPE_BROADENED');
  assert.throws(() => readScopedPlanItem(db, 'missing-task', 'plan-exact'), (error) => error?.code === 'TASK_SCOPE_BROADENED');
  db.close();
});

test('WMB-5376 canonical Planner payload passes public schema and the production dispatcher for the exact item', async () => {
  const os = await import('node:os');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const z = await import('zod');
  const { migrateDatabase } = await import('../src/main/db/migrations.ts');
  const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
  const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
  const { upsertSource } = await import('../src/main/sources.ts');
  const { createPlanningDraftFromTarget, validatePlanItemForReview } = await import('../src/main/planning-stage.ts');
  const { dispatchStartAgentTask } = await import('../src/main/agent-task-commands.ts');
  const { ensureAutomaticTaskGrant } = await import('../src/main/task-grants.ts');
  const { registerBusinessMutationMcp, planItemSubmitInputSchema, buildPlannerReviewInput } = await import('../src/main/mcp-business-commands.ts');

  const legacyItem = {
    title: '杨立昆为什么不看好 ChatGPT？真正的争议，是它能不能可靠推理',
    priority: 3,
    whyNow: '知乎热题把归纳和演绎的争议推到台前，现在解释能帮助读者检查关键 AI 结论。',
    timeliness: '当前热点与长期方法论窗口并存',
    targetAudience: '使用生成式 AI 处理写作、分析和决策的中文创作者',
    angle: '从归纳与演绎边界解释可靠性，不做名人立场对决',
    pointOfView: '判断 AI 输出不能只看是否流畅，而要看结论能否在明确规则和反例前被检查。',
    platforms: ['x', 'xiaohongshu', 'wechat'], formats: ['article'], titleGuidance: '用争议问题直指可靠推理边界',
    openingGuidance: '先呈现流畅答案与可靠结论之间的落差。', structureGuidance: '事件命题→概念边界→用户检查动作', effortEstimate: 'medium',
    sourceIds: ['legacy-source'], availableMaterials: ['source summary'], missingMaterials: [],
    editorialDecision: {
      type: 'editorial_thesis_v1',
      candidates: [
        { layer: 'event', thesis: '事件层命题', claimType: 'fact', evidenceStatus: 'supported', evidenceBoundary: '资料直接支持', score: 90, reason: '直接证据' },
        { layer: 'user', thesis: '用户层命题', claimType: 'inference', evidenceStatus: 'supported_with_boundary', evidenceBoundary: '编辑推论', score: 80, reason: '实践价值' },
        { layer: 'industry_social', thesis: '产业层命题', claimType: 'inference', evidenceStatus: 'research_required', evidenceBoundary: '仍需研究', score: 70, reason: '外延更大' },
      ],
      winner: { layer: 'event', winnerThesis: '事件层命题' },
      knowledgeContext: { used: true, contextRefs: ['legacy-source'], queryDimensions: ['事件实体', '产业关联'], secondaryContext: 'none', boundary: '无额外材料' },
    },
    scoreReasons: { type: 'propagation_v2', reality_change_significance: 20, tension_curiosity_gap: 18, audience_stakes: 18, why_now_window: 12, one_sentence_relayability: 12, account_fit: 5, total: 85, truthGate: { status: 'supported', claims: [] } },
  };
  assert.deepEqual(validatePlanItemForReview(legacyItem).errors, [
    'score_status_must_be_scored', 'score_version_propagation_v2_required', 'score_range_0_100', 'score_reasons_six_required',
    'thesis_competition_version_invalid', 'thesis_candidate_level_invalid', 'thesis_evidence_status_invalid',
    'thesis_level_event_required', 'thesis_level_user_required', 'thesis_level_industry_or_society_required',
    'thesis_winner_not_in_candidates', 'thesis_winner_reason_required', 'knowledge_context_status_invalid', 'knowledge_context_reason_required',
  ], 'fixture must reproduce the production validation failure before the schema repair');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5376-'));
  let runtime;
  try {
    const database = migrateDatabase(path.join(dir, 'wmb.db'));
    const now = new Date().toISOString();
    const workspaceId = `ws-5376-${randomUUID()}`;
    database.prepare("INSERT OR REPLACE INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
    ensureOfficialWorkspaceProfile(database, 'official.ai');
    const source = upsertSource(database, { originalUrl: 'https://example.com/wmb-5376-source', title: 'Planner canonical source', body: 'Evidence for the exact Planner item.' });
    const exact = createPlanningDraftFromTarget(database, { title: '需要定向策划的可靠推理热点问题', sourceIds: [source.id], planDate: '2026-08-31' });
    const other = createPlanningDraftFromTarget(database, { title: '不得被当前任务修改的另一策划项', sourceIds: [source.id], planDate: '2026-08-31' });
    database.close();
    runtime = ActiveWorkspaceRuntime.open(dir, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5376-epoch' });
    const started = await dispatchStartAgentTask(runtime, {
      intent: 'daily_judge', businessDate: '2026-08-31',
      contextRefs: { workspaceId: runtime.identity.workspaceId, roleId: 'planner', planItemId: exact.planItemId },
    }, { actor: { type: 'scheduler', id: 'wmb-5376-test', label: 'wmb-5376-test' }, requestId: 'wmb-5376-task' });
    const lease = runtime.acquireWorkerLease(started.task.id);
    runtime.bindWorker(lease, { stop() {} });
    runtime.bindWorkerTask(lease, started.task.id);
    const grantId = await ensureAutomaticTaskGrant(runtime, started.task.id, new Date(), 'planner');

    let submitTool;
    const fakeServer = { registerTool(name, options, handler) { if (name === 'plan_item.submit') submitTool = { options, handler }; } };
    registerBusinessMutationMcp(fakeServer, runtime);
    assert.ok(submitTool, 'production plan_item.submit handler must be registered');

    const thesis = '判断 AI 输出不能只看是否流畅，而要看结论能否在明确规则和反例前被检查。';
    const reasons = [
      ['reality_change_significance', 25, 20], ['tension_curiosity_gap', 20, 18], ['audience_stakes', 20, 17],
      ['why_now_window', 15, 12], ['one_sentence_relayability', 15, 11], ['account_fit', 5, 5],
    ].map(([criterion, weight, score]) => ({ criterion, weight, score, reason: `${criterion} 有明确资料依据` }));
    const canonical = {
      request_id: 'wmb-5376:plan_item:submit', task_id: started.task.id, grant_id: grantId, worker_lease_id: lease.leaseId,
      plan_item_id: exact.planItemId, expected_revision: exact.revision,
      title: '杨立昆争议背后：怎样判断 AI 是否真的在可靠推理', priority: 3,
      why_now: '知乎热题把归纳和演绎的争议推到台前，现在解释能帮助读者检查关键 AI 结论。',
      timeliness: '当前热点与长期方法论窗口并存', target_audience: '使用生成式 AI 处理写作、分析和决策的中文创作者',
      angle: '从归纳与演绎边界解释可靠性，不做名人立场对决', point_of_view: thesis,
      platforms: ['x', 'xiaohongshu', 'wechat'], formats: ['article'], title_guidance: '用争议问题直指可靠推理边界',
      opening_guidance: '先呈现流畅答案与可靠结论之间的落差。', structure_guidance: '事件命题→概念边界→用户检查动作', effort_estimate: 'medium',
      source_ids: [source.id], available_materials: ['source summary'], missing_materials: [], review_ids: [], method_finding_ids: [], topic_id: null,
      editorial_decision: {
        version: 'editorial_thesis_v1',
        candidates: [
          { level: 'event', thesis: '现有资料支持归纳不能自动保证可靠演绎这一事件命题。', claim_type: 'fact', evidence_status: 'supported', evidence_boundary: '仅限当前来源摘要', score: 88, reason: '直接资料支持' },
          { level: 'user', thesis, claim_type: 'inference', evidence_status: 'supported', evidence_boundary: '由事件命题转译为用户检查动作', score: 92, reason: '传播价值最高且未越过资料边界' },
          { level: 'industry_or_society', thesis: '产业需要把可验证性作为生成式 AI 工作流的重要边界。', claim_type: 'opinion', evidence_status: 'research_required', evidence_boundary: '产业趋势仍需额外资料', score: 80, reason: '外延较大但证据不足' },
        ],
        winner_level: 'user', winner_thesis: thesis, winner_reason: '用户层命题具备最高传播价值且证据边界清楚',
        knowledge_context: { status: 'no_relevant_context', context_refs: [], query_dimensions: ['事件实体查询', '产业社会关联查询'], reason: '未找到可引用的历史知识，按事实记录' },
      },
      score_reasons: {
        status: 'scored', version: 'propagation_v2', score: 83,
        truth_gate: { status: 'passed', reason: '核心事实有当前来源支持，推论和观点均明确标注边界', claims: [
          { text: '归纳不能自动保证可靠演绎', type: 'fact', status: 'supported', source_ids: [source.id] },
          { text: thesis, type: 'opinion', status: 'supported', source_ids: [] },
        ] },
        reasons,
      },
    };
    const parsed = z.object(planItemSubmitInputSchema).parse(canonical);
    const mapped = buildPlannerReviewInput({ topic_id: null }, {
      ...parsed,
      request_id: undefined, task_id: undefined, grant_id: undefined, worker_lease_id: undefined,
      plan_item_id: undefined, expected_revision: undefined,
    });
    assert.equal(validatePlanItemForReview(mapped).valid, true, 'canonical snake_case payload must map to the internal review contract');

    const missingField = structuredClone(canonical);
    delete missingField.score_reasons.status;
    assert.equal(z.object(planItemSubmitInputSchema).safeParse(missingField).success, false, 'missing canonical fields must fail before dispatch');
    assert.equal(runtime.database.prepare('SELECT revision FROM plan_items WHERE id=?').get(exact.planItemId).revision, 1, 'schema rejection must be zero-write');

    const result = await submitTool.handler(parsed);
    const receipt = JSON.parse(result.content[0].text);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? null));
    assert.equal(receipt.data.id, exact.planItemId);
    assert.equal(receipt.data.planningStatus, 'ready_for_review');
    assert.deepEqual({ ...runtime.database.prepare('SELECT revision, planning_status AS status FROM plan_items WHERE id=?').get(exact.planItemId) }, { revision: 2, status: 'ready_for_review' });

    const crossPayload = { ...canonical, request_id: 'wmb-5376:cross-item', plan_item_id: other.planItemId, expected_revision: other.revision };
    const crossResult = await submitTool.handler(z.object(planItemSubmitInputSchema).parse(crossPayload));
    const crossReceipt = JSON.parse(crossResult.content[0].text);
    assert.equal(crossReceipt.ok, false);
    assert.equal(crossReceipt.error.code, 'TASK_SCOPE_BROADENED');
    assert.deepEqual({ ...runtime.database.prepare('SELECT revision, planning_status AS status FROM plan_items WHERE id=?').get(other.planItemId) }, { revision: 1, status: 'draft' }, 'cross-item attempt must be zero-write');
  } finally {
    if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
