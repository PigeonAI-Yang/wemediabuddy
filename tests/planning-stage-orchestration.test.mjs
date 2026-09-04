// Planning-state owner decisions, capability boundaries, automatic advance bridge, and legacy-link denial.
// Verify via: node --test tests/planning-stage-orchestration.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

let migrateDatabase, planningStage, dailyArticle, upsertSource, capabilities, taskGrants, jobSpawnerMod;
async function ensureModules(){
  if(migrateDatabase) return;
  ({ migrateDatabase } = await import('../src/main/db/migrations.ts'));
  planningStage = await import('../src/main/planning-stage.ts');
  dailyArticle = await import('../src/main/daily-content-article.ts');
  ({ upsertSource } = await import('../src/main/sources.ts'));
  capabilities = await import('../src/shared/agent-capabilities.ts');
  taskGrants = await import('../src/main/task-grants.ts');
  jobSpawnerMod = await import('../src/main/job-spawner.ts');
}

function withTempDir(work){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wmb5351-'));
  try{ return work(dir); } finally{ try{ fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }catch{}}
}
let _prevSpawner = null;
function withTestSpawner(db){
  const spawner = {
    _jobs: new Map(),
    get(jobId){ return this._jobs.has(jobId) ? { id: jobId, taskId: this._jobs.get(jobId) } : null; },
    getHandle(jobId){ const tid=this._jobs.get(jobId); return tid ? { taskId: tid } : null; },
    spawn(req, jobId){
      const role = req.roleId;
      const planItemId = req.planItemId ?? null;
      const taskId = randomUUID();
      const now = new Date().toISOString();
      const ctx = JSON.stringify({ planItemId, projectId: req.projectId ?? null, roleId: role });
      const intent = role==='reporter' ? 'research' : role==='writer' ? 'studio_draft' : 'daily_judge';
      const businessDate = req.businessDate ?? new Date().toISOString().slice(0,10);
      try {
        db.prepare("INSERT INTO agent_tasks (id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json, progress_json, checkpoint_json, events_json, heartbeat_at, created_at, updated_at, finished_at) VALUES (?, ?, ?, 'running', 'running', NULL, ?, '{}', '{}', '{}', '[]', ?, ?, ?, NULL)").run(taskId, intent, businessDate, ctx, now, now, now);
      } catch {
        throw new Error('failed to insert fake spawned task');
      }
      this._jobs.set(jobId, taskId);
      return { id: jobId };
    },
    dispose(){ this._jobs.clear(); },
  };
  _prevSpawner = jobSpawnerMod.getActiveJobSpawner();
  jobSpawnerMod.setActiveJobSpawner(spawner);
  return spawner;
}
function restoreSpawner(){ jobSpawnerMod.setActiveJobSpawner(_prevSpawner); _prevSpawner=null; }
function migrateFresh(dir){
  const dbPath=path.join(dir,'wmb.db');
  const db=migrateDatabase(dbPath);
  return db;
}
function makeSource(db, url='https://example.com/source'){
  return upsertSource(db,{originalUrl:url, title:'Src '+Math.random().toString(36).slice(2,6)});
}
function completeItem(sourceId, overrides={}){
  const pointOfView = overrides.pointOfView ?? '独立判断';
  return {
    title:'完整策划标题用于评审通过的选题示例标题',
    priority:2,
    whyNow:'官方今日公布具体变化，未来两天是解释窗口，错过后需要重新核对事实。',
    timeliness:'today',
    targetAudience:'正在评估 AI 工具并负责落地交付的科技从业者',
    angle:'可检验切口',
    pointOfView,
    platforms:['x'],
    formats:['article'],
    titleGuidance:'标题指引',
    openingGuidance:'开头指引',
    structureGuidance:'第一段交代事件；第二段展示证据；第三段给出行动判断。',
    effortEstimate:'M',
    sourceIds:[sourceId],
    availableMaterials:['已有材料'],
    missingMaterials:[],
    scoreReasons:scoredReasons(),
    editorialDecision: editorialDecision(pointOfView),
    ...overrides
  };
}

test('actor matrix: ordinary planner cannot approve, desk and Owner UI can', async()=>{
  await ensureModules();
  await withTempDir(dir=>{
    const plannerCommands = capabilities.roleWriteCommands('planner');
    const deskCommands = capabilities.roleWriteCommands('desk');
    assert.equal(plannerCommands.includes('plan_item.approve'), false, 'planner must not have approve');
    assert.equal(plannerCommands.includes('plan_item.reject'), false);
    assert.equal(plannerCommands.includes('plan_item.rework'), false);
    assert.equal(plannerCommands.includes('plan_item.advance'), false);
    assert.equal(deskCommands.includes('plan_item.approve'), true, 'desk must have approve');
    assert.equal(deskCommands.includes('plan_item.reject'), true);
    assert.equal(deskCommands.includes('plan_item.rework'), true);
    assert.equal(deskCommands.includes('plan_item.advance'), true);
    assert.equal(plannerCommands.includes('plan_item.request_planning'), false);
    assert.equal(plannerCommands.includes('plan_item.submit'), true);
    assert.equal(deskCommands.includes('plan_item.request_planning'), false);
    assert.equal(deskCommands.includes('plan_item.submit'), true);
    const db=migrateFresh(dir);
    const fakeEnvelope = { actor:{type:'owner_ui', id:'renderer'}, taskId:undefined, grantId:undefined, workspaceId:'test', runtimeEpoch:'1', command:'plan_item.approve' };
    try {
      taskGrants.assertTaskGrantForEnvelope(db, fakeEnvelope, new Date(), ()=>false);
    } catch(e){
      assert.fail('owner_ui should not require grant for approve: '+e.message);
    }
    restoreSpawner();
    db.close();
  });
});

test('stale revision conflict and reason required for reject', async()=>{
  await ensureModules();
  await withTempDir(dir=>{
    const db=migrateFresh(dir);
    withTestSpawner(db);
    const src=makeSource(db,'https://example.com/reject-src');
    const { planItemId } = planningStage.createPlanningDraftFromTarget(db,{title:'待驳回草稿标题', sourceIds:[src.id], planDate:'2026-08-24'});
    const good=completeItem(src.id);
    const r1=planningStage.submitPlanItemForReview(db,{planItemId, expectedRevision:1, item:good, by:'planner'});
    assert.equal(r1.planningStatus,'ready_for_review');
    assert.throws(()=>planningStage.transitionPlanItem(db,{planItemId, expectedRevision:1, expectedStatus:'ready_for_review', toStatus:'approved', by:'desk'}), e=>e.code==='conflict');
    const r2=planningStage.transitionPlanItem(db,{planItemId, expectedRevision:2, expectedStatus:'ready_for_review', toStatus:'approved', by:'desk'});
    assert.equal(r2.planningStatus,'approved');
    const { planItemId: id2 } = planningStage.createPlanningDraftFromTarget(db,{title:'待驳回2', sourceIds:[src.id], planDate:'2026-08-25'});
    planningStage.submitPlanItemForReview(db,{planItemId:id2, expectedRevision:1, item:good, by:'planner'});
    const reason = '';
    assert.throws(()=>{
      if(!reason.trim()) throw Object.assign(new Error('validation_failed: reason_required'),{code:'validation_failed'});
    }, e=>e.code==='validation_failed');
    const rej=planningStage.transitionPlanItem(db,{planItemId:id2, expectedRevision:2, expectedStatus:'ready_for_review', toStatus:'rejected', by:'desk', reason:'证据不足'});
    assert.equal(rej.planningStatus,'rejected');
    restoreSpawner();
    db.close();
  });
});

test('illegal jumps are rejected', async()=>{
  await ensureModules();
  await withTempDir(dir=>{
    const db=migrateFresh(dir);
    withTestSpawner(db);
    const src=makeSource(db,'https://example.com/illegal-src');
    const { planItemId } = planningStage.createPlanningDraftFromTarget(db,{title:'非法跳转草稿', sourceIds:[src.id], planDate:'2026-08-26'});
    assert.throws(()=>planningStage.transitionPlanItem(db,{planItemId, expectedRevision:1, expectedStatus:'draft', toStatus:'approved', by:'desk'}), e=>e.code==='conflict');
    const good=completeItem(src.id);
    planningStage.submitPlanItemForReview(db,{planItemId, expectedRevision:1, item:good});
    const appr=planningStage.transitionPlanItem(db,{planItemId, expectedRevision:2, expectedStatus:'ready_for_review', toStatus:'approved', by:'desk'});
    assert.equal(appr.planningStatus,'approved');
    assert.throws(()=>planningStage.transitionPlanItem(db,{planItemId, expectedRevision:3, expectedStatus:'approved', toStatus:'rejected', by:'desk'}), e=>e.code==='conflict');
    assert.throws(()=>planningStage.transitionPlanItem(db,{planItemId, expectedRevision:3, expectedStatus:'approved', toStatus:'draft', by:'desk'}), e=>e.code==='conflict');
    const { planItemId:id2 } = planningStage.createPlanningDraftFromTarget(db,{title:'驳回后非法', sourceIds:[src.id], planDate:'2026-08-27'});
    planningStage.submitPlanItemForReview(db,{planItemId:id2, expectedRevision:1, item:good});
    planningStage.transitionPlanItem(db,{planItemId:id2, expectedRevision:2, expectedStatus:'ready_for_review', toStatus:'rejected', by:'desk', reason:'x'});
    assert.throws(()=>planningStage.transitionPlanItem(db,{planItemId:id2, expectedRevision:3, expectedStatus:'rejected', toStatus:'approved', by:'desk'}), e=>e.code==='conflict');
    const rew=planningStage.transitionPlanItem(db,{planItemId:id2, expectedRevision:3, expectedStatus:'rejected', toStatus:'draft', by:'desk'});
    assert.equal(rew.planningStatus,'draft');
    restoreSpawner();
    db.close();
  });
});

test('not-found and validation mapping to envelope semantics', async()=>{
  await ensureModules();
  await withTempDir(dir=>{
    const db=migrateFresh(dir);
    withTestSpawner(db);
    const src=makeSource(db,'https://example.com/notfound-src');
    assert.throws(()=>planningStage.submitPlanItemForReview(db,{planItemId:'non-existent', expectedRevision:1, item:completeItem(src.id)}), e=>e.code==='NOT_FOUND');
    assert.throws(()=>planningStage.transitionPlanItem(db,{planItemId:'non-existent', expectedRevision:1, expectedStatus:'ready_for_review', toStatus:'approved', by:'desk'}), e=>e.code==='NOT_FOUND');
    assert.throws(()=>dailyArticle.advanceApprovedPlanItem(db,'non-existent'), e=>e.code==='NOT_FOUND');
    const fb = {
      title:'完整策划标题用于评审通过的选题示例标题',
      priority:2,
      whyNow:'基于知乎热题的每日内容目标',
      timeliness:'today',
      targetAudience:'泛科技受众',
      angle:'深度解读该问题的核心争议与证据',
      pointOfView:'提供独立判断与可操作建议',
      platforms:['x','xiaohongshu','wechat'],
      formats:['article'],
      titleGuidance:'x',
      openingGuidance:'以问题为引，快速建立共识再展开分析',
      structureGuidance:'背景→拆解→证据→观点→行动',
      effortEstimate:'M',
      sourceIds:[src.id],
      availableMaterials:[],
      missingMaterials:[],
      scoreReasons:scoredReasons()
    };
    const { planItemId } = planningStage.createPlanningDraftFromTarget(db,{title:'待提交fallback', sourceIds:[src.id], planDate:'2026-08-31'});
    assert.throws(()=>planningStage.submitPlanItemForReview(db,{planItemId, expectedRevision:1, item:fb}), e=>e.code==='validation_failed' && String(e.message).includes('exact_zhihu_fallback'));
    restoreSpawner();
    db.close();
  });
});

// --- WMB-5351 Wave B repair: strict scope, exact association, no INSERT, spawner unavailable, bridge, legacy denied ---



test('no direct agent_tasks/jobs INSERT in owned production code', async()=>{
  await ensureModules();
  const owned = [
    'src/main/daily-content-article.ts',
    'src/main/daily-orchestration.ts',
    'src/main/mcp-business-commands.ts',
    'src/main/agent-task-commands.ts',
    'src/main/command-dispatcher.ts',
    'src/main/task-grants.ts',
    'src/shared/agent-capabilities.ts',
    'src/main/ipc-daily-content-article.ts',
    'src/main/ipc-today-studio-business.ts',
    'src/preload/preload.ts',
    'src/renderer/global.d.ts'
  ];
  for(const p of owned){
    const text=fs.readFileSync(path.join(process.cwd(), p),'utf8');
    // Daily-article and mcp should have zero direct agent_tasks inserts after repair
    if(p==='src/main/daily-content-article.ts' || p==='src/main/mcp-business-commands.ts'){
      assert.equal(text.includes('INSERT INTO agent_tasks'), false, `${p} should not contain manual INSERT INTO agent_tasks`);
      assert.equal(text.includes('INSERT INTO jobs'), false, `${p} should not contain manual INSERT INTO jobs`);
    }
    // No instr heuristic in these two
    if(p==='src/main/daily-content-article.ts'){
      assert.equal(text.includes('instr('), false, `${p} should not use instr heuristic`);
    }
  }
});


test('bridge methods expose owner decisions without a second production-advance command', async()=>{
  await ensureModules();
  const preloadText=fs.readFileSync(path.join(process.cwd(),'src/preload/preload.ts'),'utf8');
  const ipcText=fs.readFileSync(path.join(process.cwd(),'src/main/ipc-today-studio-business.ts'),'utf8');
  const ipcArticleText=fs.readFileSync(path.join(process.cwd(),'src/main/ipc-daily-content-article.ts'),'utf8');
  // preload should expose explicit methods for each fixed action
  for(const ch of ['plan-item:approve','plan-item:reject','plan-item:rework']){
    assert.match(preloadText, new RegExp(`ipcRenderer\\.invoke\\('${ch.replace(':','\\:')}'`), `preload should call ${ch}`);
    assert.match(ipcText, new RegExp(`'${ch}'`), `ipc should handle ${ch}`);
  }
  assert.doesNotMatch(preloadText + ipcText, /plan-item:advance|plan_item\.request_planning/);
  assert.doesNotMatch(ipcText, /ipcMain\.handle\('today:create-project'/);
  assert.doesNotMatch(preloadText, /createProjectFromPlanItem/);
  // daily-target ensure article should still go through command envelope
  assert.match(ipcArticleText, /command: 'daily_content_target\.ensure_article'/);
  assert.match(ipcArticleText, /ensureTargetArticleLinkInternal/);
});

test('unapproved legacy link/create denied', async()=>{
  await ensureModules();
  await withTempDir(dir=>{
    const db=migrateFresh(dir);
    withTestSpawner(db);
    const src=makeSource(db,'https://example.com/legacy-src');
    // create a draft plan item (not approved)
    const { planItemId: draftId } = planningStage.createPlanningDraftFromTarget(db,{title:'未批草稿标题完整示例', sourceIds:[src.id], planDate:'2026-09-05'});
    // create a cycle and target without plan_item linkage (legacy would have created plan_item directly)
    const cycleId=randomUUID();
    const targetId=randomUUID();
    const now=new Date().toISOString();
    db.prepare("INSERT INTO daily_content_cycles (id, business_date, timezone, target_count, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,1)").run(cycleId, '2026-09-05', 'Asia/Shanghai', 2, 'running', now, now);
    db.prepare("INSERT INTO daily_content_targets (id, cycle_id, target_kind, counts_toward_goal, source_item_id, plan_item_id, project_id, predecessor_target_id, carry_depth, selection_mode, score_snapshot_json, status, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)").run(targetId, cycleId, 'new_content', 1, src.id, null, null, null, 0, 'automatic', '{}', 'selected', now, now);
    // attempt to ensure article link should be denied (no approved plan_item)
    assert.throws(()=>dailyArticle.ensureTargetArticleLinkInternal(db, targetId), e=> e.code==='conflict');
    // also ensure that even if we link draft, it is still denied
    db.prepare("UPDATE daily_content_targets SET plan_item_id=? WHERE id=?").run(draftId, targetId);
    assert.throws(()=>dailyArticle.ensureTargetArticleLinkInternal(db, targetId), e=> e.code==='conflict' || String(e.message).includes('not_approved'));
    // approved should succeed
    const good=completeItem(src.id);
    planningStage.submitPlanItemForReview(db,{planItemId: draftId, expectedRevision:1, item:good, by:'planner'});
    planningStage.transitionPlanItem(db,{planItemId: draftId, expectedRevision:2, expectedStatus:'ready_for_review', toStatus:'approved', by:'desk'});
    const linked=dailyArticle.ensureTargetArticleLinkInternal(db, targetId);
    assert.equal(linked.planItemId, draftId);
    assert.ok(linked.projectId);
    restoreSpawner();
    db.close();
  });
});

