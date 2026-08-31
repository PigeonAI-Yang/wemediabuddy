import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { agentRequestId, completeAgentTask, getAgentTask, readLatestJudgeWatermark, reportAgentTaskProgress, startAgentTask } from '../src/main/agent-tasks.ts';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { applyDailyLaneGate, buildDailyGateRun, parseDailyPlanOutput, savePlanFromSynthesisOutput } from '../src/main/agent-runner.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

async function safeRm(target){
  for(let i=0;i<8;i++){
    try{ await rm(target,{recursive:true,force:true}); return; }catch(e){ if(e && (e.code==='EBUSY' || e.code==='EPERM' || e.code==='ENOTEMPTY')){ await new Promise(r=>setTimeout(r,200)); continue; } throw e; }
  }
  await rm(target,{recursive:true,force:true});
}

function planInputWithScore(title, sourceIds){
  const pointOfView = '需验证';
  return { title, priority:1, whyNow:'热点 2-3 天内真实发布', timeliness:'热点 2-3 天', targetAudience:'AI 商业化人群', angle:'模型选型', pointOfView, platforms:['x'], formats:['text'], titleGuidance:'标题', openingGuidance:'开头', structureGuidance:'结构', effortEstimate:'40m', sourceIds, scoreReasons: scoredReasons(), editorialDecision: editorialDecision(pointOfView) };
}

test('watermark advances only after lane+plan succeed; empty with failure does not advance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-wan-watermark-'));
  let db;
  try {
    db = migrateDatabase(path.join(root,'wmb.db'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-watermark-test', now, now);
    ensureOfficialWorkspaceProfile(db, 'official.ai');
    const wan = upsertSource(db, { title: 'Wan 3.0 is now live', originalUrl: 'https://x.com/Alibaba_Wan/status/2091813588302503969', summary: 'Wan 3.0 发布', publishedAt: '2026-08-24T09:03:18.000Z' });
    db.prepare("UPDATE source_items SET collected_at=?, canonical_url=? WHERE id=?").run('2026-08-24T11:02:49.202Z', 'https://x.com/Alibaba_Wan/status/2091813588302503969', wan.id);
    const task1 = startAgentTask(db, { intent:'daily_judge', businessDate:'2026-08-24' });
    assert.equal(task1.ok, true);
    const beforeWatermark = readLatestJudgeWatermark(db);
    assert.equal(beforeWatermark, null);
    reportAgentTaskProgress(db, task1.data.id, { checkpoint:{ judgeWatermark: '2026-08-23T17:58:50.209Z' } });
    const gateRun1 = buildDailyGateRun(db, getAgentTask(db, task1.data.id));
    assert.ok(gateRun1.pending.length + gateRun1.autoRelevant.length > 0, 'initial window should contain Wan');
    const task2 = startAgentTask(db, { intent:'daily_judge', businessDate:'2026-08-24' });
    assert.equal(task2.ok, true);
    db.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, side_effect_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), 'ws-watermark-test', 'epoch', `${task2.data.id}:gate-tier0`, 'sources.lane_gate', 'hash', 'scheduler', 'scheduler', task2.data.id, '{}', JSON.stringify({ ok:false, error:{code:'REVISION_CONFLICT', message:'revision conflict'}}), 'error', 'not_started', new Date().toISOString());
    db.prepare("INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(),'2026-08-24','Asia/Shanghai','empty',1,now,now,1);
    const validate = completeAgentTask(db, task2.data.id);
    assert.equal(validate.ok, false, 'empty plan with lane error must not be marked succeeded');
    assert.match(validate.error.message, /空方案不能/);
    const afterWatermark = readLatestJudgeWatermark(db);
    assert.equal(afterWatermark, '2026-08-23T17:58:50.209Z', 'watermark must not advance on failed empty');
    const src2 = upsertSource(db, { title: 'Valid source', originalUrl: 'https://example.com/valid2' });
    const item = planInputWithScore('Valid scored opportunity valid title', [src2.id]);
    const saved = saveCurrentPlan(db, { planDate:'2026-08-24', timezone:'Asia/Shanghai', summary:'4 opportunities', items:[item] });
    assert.ok(saved.id, 'valid six-reason plan must persist');
    const rows = db.prepare('SELECT COUNT(*) as c FROM plan_items WHERE plan_id=?').get(saved.id);
    assert.equal(rows.c, 1);
  } finally {
    try { db?.close(); } catch {}
    await safeRm(root);
  }
});

test('direct missing score stays pending while malformed or incomplete model output is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-wan-score-'));
  let db;
  try {
    db = migrateDatabase(path.join(root,'wmb.db'));
    const src = upsertSource(db, { title:'Score test source', originalUrl:'https://example.com/score' });
    const missingResult = saveCurrentPlan(db, { planDate:'2026-08-24', timezone:'Asia/Shanghai', summary:'missing score', items:[{ title:'Missing score opportunity with sufficient length', priority:1, whyNow:'now', timeliness:'today', targetAudience:'audience', angle:'angle', pointOfView:'pov', platforms:['x'], formats:['text'], titleGuidance:'tg', openingGuidance:'og', structureGuidance:'sg', effortEstimate:'30m', sourceIds:[src.id] }] });
    assert.ok(missingResult.id);
    const pendingRow = db.prepare("SELECT score_reasons_json AS json, planning_status AS status FROM plan_items WHERE plan_id=?").get(missingResult.id);
    const pending = JSON.parse(pendingRow.json);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.score, 0);
    assert.equal(pending.reasons.length, 6);
    assert.ok(pending.reasons.every((reason) => reason.score === 0 && reason.reason === 'insufficient_evidence'));
    assert.ok(typeof pending.pending_reason === 'string' && pending.pending_reason.length > 0);
    assert.equal(pendingRow.status, 'draft');
    const five = scoredReasons(); five.reasons = five.reasons.slice(0,5); five.score = 22+17+17+12+10;
    assert.throws(() => saveCurrentPlan(db, { planDate:'2026-08-24', timezone:'Asia/Shanghai', summary:'five reasons', items:[{ title:'Five reasons opportunity valid title length', priority:1, whyNow:'now', timeliness:'today', targetAudience:'audience', angle:'angle', pointOfView:'pov', platforms:['x'], formats:['text'], titleGuidance:'tg', openingGuidance:'og', structureGuidance:'sg', effortEstimate:'30m', sourceIds:[src.id], scoreReasons: five, editorialDecision: editorialDecision('pov') }] }), /six_required/);
    const ok = saveCurrentPlan(db, { planDate:'2026-08-24', timezone:'Asia/Shanghai', summary:'ok six', items:[planInputWithScore('Ok six scored opportunity title', [src.id])] });
    assert.ok(ok.id);
    const missingScoreBlock = '```json\n{"summary":"x","items":[{"title":"t","priority":1,"whyNow":"w","timeliness":"t","targetAudience":"ta","angle":"a","pointOfView":"p","platforms":["x"],"formats":["text"],"titleGuidance":"tg","openingGuidance":"og","structureGuidance":"sg","effortEstimate":"30m","sourceIds":["src-1"]}]}\n```';
    assert.throws(() => parseDailyPlanOutput(missingScoreBlock), /结构不完整/);
    const validBlock = `\`\`\`json\n{"summary":"x","items":[{"title":"Valid title with enough length","priority":1,"whyNow":"w","timeliness":"t","targetAudience":"ta","angle":"a","pointOfView":"p","platforms":["x"],"formats":["text"],"titleGuidance":"tg","openingGuidance":"og","structureGuidance":"sg","effortEstimate":"30m","sourceIds":["src-1"],"scoreReasons":${JSON.stringify(scoredReasons())},"editorialDecision":${JSON.stringify(editorialDecision('p'))}}]}\n\`\`\``;
    const parsed = parseDailyPlanOutput(validBlock);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].scoreReasons.reasons.length, 6);
  } finally { try { db?.close(); } catch {} await safeRm(root); }
});

test('changed payload uses distinct requestId while identical remains idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-wan-idempotent-'));
  let runtime;
  try {
    const tmpDb = migrateDatabase(path.join(root,'wmb.db'));
    const now = new Date().toISOString();
    tmpDb.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-idempotent', now, now);
    const srcTmp = upsertSource(tmpDb, { title:'Idempotent source', originalUrl:'https://example.com/idem' });
    const srcId = srcTmp.id;
    tmpDb.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'epoch-idem' });
    const started = await dispatchStartAgentTask(runtime, { intent:'daily_judge', businessDate:'2026-08-24', contextRefs:{ workspaceId: runtime.identity.workspaceId } }, { actor:{type:'owner_ui',id:'renderer',label:'Owner UI'}, requestId:`idem-start-${randomUUID()}` });
    const task = started.task;
    const src = { id: srcId };
    const item1 = planInputWithScore('Idempotent title one sufficiently long', [src.id]);
    const input1 = { planDate:'2026-08-24', timezone:'Asia/Shanghai', summary:'first', items:[item1] };
    const baseRequestId = agentRequestId(task.id, 'plan');
    function stableJson(v){ if(v===null||typeof v!=='object') return JSON.stringify(v); if(Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`; const r=v; return `{${Object.keys(r).sort().map(k=>`${JSON.stringify(k)}:${stableJson(r[k])}`).join(',')}}`; }
    function planDispatchId(base,input){ const h=createHash('sha256').update(stableJson(input)).digest('hex').slice(0,12); return `${base}:${h}`; }
    const idSame1 = planDispatchId(baseRequestId, input1);
    const idSame2 = planDispatchId(baseRequestId, input1);
    const receipt1 = await runtime.dispatchCommand(createCommandEnvelope({ workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch, command:'plans.save', requestId:idSame1, actor:{type:'owner_ui',id:'renderer',label:'Owner UI'}, taskId:task.id, input:input1, boundIdentity:{planDate:'2026-08-24'} }), () => {
      const data = saveCurrentPlan(runtime.database, input1, false);
      return { data, entityId:data.id, afterRevision:data.revision, readback:data, entityType:'plan' };
    });
    assert.equal(receipt1.ok, true);
    const receipt2 = await runtime.dispatchCommand(createCommandEnvelope({ workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch, command:'plans.save', requestId:idSame2, actor:{type:'owner_ui',id:'renderer',label:'Owner UI'}, taskId:task.id, input:input1, boundIdentity:{planDate:'2026-08-24'} }), () => {
      const data = saveCurrentPlan(runtime.database, input1, false);
      return { data, entityId:data.id, afterRevision:data.revision, readback:data, entityType:'plan' };
    });
    assert.equal(receipt2.ok, true);
    assert.equal(receipt2.receiptId, receipt1.receiptId, 'identical payload retry must be idempotent same receipt');
    const item2 = planInputWithScore('Changed title two sufficiently long for test', [src.id]);
    const input2 = { planDate:'2026-08-24', timezone:'Asia/Shanghai', summary:'second changed summary', items:[item2] };
    const idChanged = planDispatchId(baseRequestId, input2);
    assert.notEqual(idChanged, idSame1, 'changed payload must produce distinct requestId');
    const receiptChanged = await runtime.dispatchCommand(createCommandEnvelope({ workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch, command:'plans.save', requestId:idChanged, actor:{type:'owner_ui',id:'renderer',label:'Owner UI'}, taskId:task.id, input:input2, boundIdentity:{planDate:'2026-08-24'} }), () => {
      const data = saveCurrentPlan(runtime.database, input2, false);
      return { data, entityId:data.id, afterRevision:data.revision, readback:data, entityType:'plan' };
    });
    assert.equal(receiptChanged.ok, true, 'changed payload with distinct id must not hit replay conflict');
    assert.notEqual(receiptChanged.receiptId, receipt1.receiptId);
    await assert.rejects(async () => {
      await runtime.dispatchCommand(createCommandEnvelope({ workspaceId: runtime.identity.workspaceId, runtimeEpoch: runtime.identity.runtimeEpoch, command:'plans.save', requestId:idSame1, actor:{type:'owner_ui',id:'renderer',label:'Owner UI'}, taskId:task.id, input:input2, boundIdentity:{planDate:'2026-08-24'} }), () => {
        const data = saveCurrentPlan(runtime.database, input2, false);
        return { data, entityId:data.id, afterRevision:data.revision, readback:data, entityType:'plan' };
      });
    }, (e)=> e.code==='REQUEST_REPLAY_CONFLICT');
  } finally {
    if(runtime) await runtime.stop({drain:false}).catch(()=>{});
    await safeRm(root);
  }
});

test('persistence errors cannot complete empty and incomplete synthesis output fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-wan-partial-'));
  let runtime;
  let tmpDb;
  try {
    tmpDb = migrateDatabase(path.join(root,'wmb.db'));
    const now = new Date().toISOString();
    tmpDb.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-partial', now, now);
    ensureOfficialWorkspaceProfile(tmpDb, 'official.ai');
    const src = upsertSource(tmpDb, { title:'Partial source', originalUrl:'https://example.com/partial' });
    const task = startAgentTask(tmpDb, { intent:'daily_judge', businessDate:'2026-08-24' });
    assert.equal(task.ok, true);
    tmpDb.prepare("INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(),'2026-08-24','Asia/Shanghai','empty due to failure',1,now,now,1);
    tmpDb.prepare(`INSERT INTO command_receipts (id, workspace_id, runtime_epoch, request_id, command, input_hash, actor_type, actor_id, task_id, envelope_json, receipt_json, status, side_effect_state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), 'ws-partial', 'epoch', `${task.data.id}:plan:hash`, 'plans.save', 'hash', 'pi', 'pi', task.data.id, '{}', JSON.stringify({ ok:false, error:{code:'validation_failed', message:'scoreReasons_required'}}), 'error', 'not_started', now);
    const completed = completeAgentTask(tmpDb, task.data.id);
    assert.equal(completed.ok, false, 'empty plan after persistence failure must not complete as succeeded');
    assert.match(completed.error.message, /空方案不能/);
    const task2 = startAgentTask(tmpDb, { intent:'daily_judge', businessDate:'2026-08-24' });
    assert.equal(task2.ok, true);
    const sessionFile = path.join(root, 'sess.jsonl');
    const badPlanText = '```json\n{"summary":"bad","items":[{"title":"Bad item missing score sufficiently long","priority":1,"whyNow":"w","timeliness":"t","targetAudience":"ta","angle":"a","pointOfView":"p","platforms":["x"],"formats":["text"],"titleGuidance":"tg","openingGuidance":"og","structureGuidance":"sg","effortEstimate":"30m","sourceIds":["'+src.id+'"]}]}\n```';
    await writeFile(sessionFile, JSON.stringify({ type:'message', message:{ role:'assistant', content:[{ type:'text', text: badPlanText }] } })+'\n','utf8');
    await assert.rejects(() => savePlanFromSynthesisOutput(tmpDb, task2.data, sessionFile, agentRequestId(task2.data.id,'plan')), /结构不完整/);
    const plans = tmpDb.prepare('SELECT COUNT(*) as c FROM plans WHERE plan_date=?').get('2026-08-24');
    assert.equal(plans.c, 1, 'incomplete synthesis output must not persist a new plan');
  } finally {
    try { tmpDb?.close(); } catch {}
    if(runtime) await runtime.stop({drain:false}).catch(()=>{});
    await safeRm(root);
  }
});
test('Wan remains in next window after simulated revision conflict with changed content and qualified empty is marked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-wan-retention-'));
  let db;
  try {
    db = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-retention', now, now);
    ensureOfficialWorkspaceProfile(db, 'official.ai');
    const wan = upsertSource(db, { title: 'Wan 3.0 is now live', originalUrl: 'https://x.com/Alibaba_Wan/status/2091813588302503969', summary: 'Wan 3.0 发布', publishedAt: '2026-08-24T09:03:18.000Z' });
    db.prepare("UPDATE source_items SET collected_at=?, canonical_url=? WHERE id=?").run('2026-08-24T11:02:49.202Z', 'https://x.com/Alibaba_Wan/status/2091813588302503969', wan.id);
    const task = startAgentTask(db, { intent: 'daily_judge', businessDate: '2026-08-24' });
    assert.equal(task.ok, true);
    reportAgentTaskProgress(db, task.data.id, { checkpoint: { judgeWatermark: '2026-08-23T00:00:00.000Z' } });
    const gateTask = getAgentTask(db, task.data.id);
    const gateRun = buildDailyGateRun(db, gateTask);
    assert.ok(gateRun.pending.some(c => c.sourceId === wan.id) || gateRun.autoRelevant.some(c => c.sourceId === wan.id), 'Wan should be in gate candidates');
    const wanCandidate = [...gateRun.pending, ...gateRun.autoRelevant].find(c => c.sourceId === wan.id);
    assert.ok(wanCandidate, 'candidate found');
    const judgedAt = new Date().toISOString();
    const planRequestId = agentRequestId(gateTask.id, 'plan');
    const sessionTextRelevant = '```json\n' + JSON.stringify({ gate: [{ sourceId: wan.id, relevant: true }] }) + '\n```';
    db.prepare("UPDATE source_items SET title=?, revision=revision+1, updated_at=? WHERE id=?").run('Wan 3.0 is now live CHANGED', new Date().toISOString(), wan.id);
    const applied = await applyDailyLaneGate(db, gateTask, gateRun, sessionTextRelevant, planRequestId, judgedAt);
    assert.equal(applied.unresolved, true, 'changed content should be unresolved');
    assert.ok(applied.unresolvedIds.has(wan.id), 'Wan should be in unresolved');
    const nextGateRun = buildDailyGateRun(db, gateTask);
    const stillInWindow = nextGateRun.pending.some(c => c.sourceId === wan.id) || nextGateRun.autoRelevant.some(c => c.sourceId === wan.id);
    assert.equal(stillInWindow, true, 'Wan must remain in next candidate window after simulated conflict');
    const emptyTask = startAgentTask(db, { intent: 'daily_judge', businessDate: '2026-08-25' });
    assert.equal(emptyTask.ok, true);
    const emptyPlan = saveCurrentPlan(db, { planDate: '2026-08-25', timezone: 'Asia/Shanghai', summary: 'no qualified', items: [] });
    assert.ok(emptyPlan.id);
    reportAgentTaskProgress(db, emptyTask.data.id, { checkpoint: { judgeWatermark: new Date().toISOString(), emptyQualified: true, qualifiedEmpty: true, dailyEmptyQualified: true } });
    const taskWithQualified = getAgentTask(db, emptyTask.data.id);
    assert.equal(taskWithQualified.checkpoint.emptyQualified, true);
    assert.equal(taskWithQualified.checkpoint.qualifiedEmpty, true);
    const todayEmpty = db.prepare("SELECT COUNT(*) as c FROM plan_items WHERE plan_id=?").get(emptyPlan.id);
    assert.equal(todayEmpty.c, 0, 'qualified empty plan has zero items');
  } finally {
    try { db?.close(); } catch {}
    await safeRm(root);
  }
});
