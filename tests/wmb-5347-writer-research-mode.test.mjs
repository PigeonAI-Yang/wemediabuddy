import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';

const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { parseRoleJobRequest, deriveRoleJobSpec } = await import('../src/main/role-job-registry.ts');
const { buildJobContextRefs, buildJobObjectBoundary, rebuildRoleJobRequest } = await import('../src/main/job-object-boundary.ts');
const { draftPrompt } = await import('../src/main/agent-runner.ts');
const { assertStudioDraftResearchReady } = await import('../src/main/mcp-business-commands.ts');
const { createContentProject, saveCoreVersion, getContentProject } = await import('../src/main/content.ts');

const BUSINESS_DATE = '2026-08-23';
function nowIso(){ return new Date().toISOString(); }
function tempDb(){ return mkdtemp(path.join(os.tmpdir(), 'wmb-5347-')); }
async function withDb(run){
  const dir = await tempDb();
  const db = migrateDatabase(path.join(dir, 'wmb.db'));
  try { await run(db, dir); } finally { db.close(); await rm(dir, { recursive: true, force: true }).catch(()=>{}); }
}
function insertTask(db, { id, intent='studio_draft', roleId='writer', projectId='proj-1', researchGate='required', researchMode, research_mode, extra={} }){
  const refs = { roleId, projectId, writerTask: 'core_draft', researchGate, ...(researchMode?{researchMode}:{}), ...(research_mode?{research_mode}:{}), ...extra };
  const now = nowIso();
  db.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at,
    error_code, error_message, created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', NULL, ?, ?, ?, ?, NULL)`).run(
    id, intent, BUSINESS_DATE, 'running', 'starting', JSON.stringify(refs), JSON.stringify({}),
    JSON.stringify({}), JSON.stringify({}), null, null, now, now
  );
}

test('WMB-5347: researchMode 显式优先、required覆盖brief禁研、缺字段brief兼容', () => {
  const req1 = parseRoleJobRequest({ roleId:'writer', brief:'此轮严禁研究，请写观点文', projectId:'p1', writerTask:'core_draft', researchMode:'required' });
  assert.equal(req1.researchMode, 'required');
  const req2 = parseRoleJobRequest({ roleId:'writer', brief:'正常', projectId:'p1', writerTask:'core_draft', research_mode:'prohibited' });
  assert.equal(req2.researchMode, 'prohibited');
  const req3 = parseRoleJobRequest({ roleId:'writer', brief:'此轮禁止研究，观点型方法文', projectId:'p1', writerTask:'core_draft' });
  assert.equal(req3.researchMode, 'prohibited');
  const req4 = parseRoleJobRequest({ roleId:'writer', brief:'正常事实稿，需核查', projectId:'p1', writerTask:'core_draft' });
  assert.equal(req4.researchMode, 'auto');
  const req5 = parseRoleJobRequest({ roleId:'writer', brief:'严禁研究', projectId:'p1', writerTask:'core_draft', researchMode:'auto' });
  assert.equal(req5.researchMode, 'auto');
});

test('WMB-5347: 未知 researchMode 值在外部输入拒绝', () => {
  assert.throws(() => parseRoleJobRequest({ roleId:'writer', brief:'x', projectId:'p1', writerTask:'core_draft', researchMode:'unknown' }), e => e.code==='VALIDATION_ERROR');
  assert.throws(() => parseRoleJobRequest({ roleId:'writer', brief:'x', projectId:'p1', writerTask:'core_draft', research_mode:'forbidden' }), e => e.code==='VALIDATION_ERROR');
});

test('WMB-5347: 持久化与回读 - buildJobContextRefs 持久化 mode，rebuild 恢复，旧 refs fallback', () => {
  const req = parseRoleJobRequest({ roleId:'writer', brief:'此轮严禁调用外部研究', projectId:'proj-123', writerTask:'core_draft' });
  assert.equal(req.researchMode, 'prohibited');
  const spec = deriveRoleJobSpec(req, 'ws-test');
  assert.equal(spec.researchMode, 'prohibited');
  const boundary = buildJobObjectBoundary(req, BUSINESS_DATE);
  const refs = buildJobContextRefs({ jobId:'job-1', request:req, boundary });
  assert.equal(refs.researchMode, 'prohibited');
  assert.equal(refs.research_mode, 'prohibited');
  const rebuilt = rebuildRoleJobRequest(refs);
  assert.ok(rebuilt && rebuilt.roleId==='writer' && rebuilt.researchMode==='prohibited');
  const legacyRefs = { jobId:'job-legacy', roleId:'writer', brief:'此轮不要研究，观点文', projectId:'proj-old', writerTask:'core_draft' };
  const rebuiltLegacy = rebuildRoleJobRequest(legacyRefs);
  assert.equal(rebuiltLegacy.researchMode, 'prohibited');
  const legacyAuto = { jobId:'job-legacy2', roleId:'writer', brief:'正常稿', projectId:'proj-old', writerTask:'core_draft' };
  assert.equal(rebuildRoleJobRequest(legacyAuto).researchMode, 'auto');
});

test('WMB-5347: draftPrompt prohibited 为受限写作、无 must dispatch、含观点标注', () => {
  const task = { id:'task-prohibited' };
  const prompt = draftPrompt(task, 'proj-1', 'req-1', 'core_draft', '此轮严禁研究', false, 'prohibited');
  assert.doesNotMatch(prompt, /必须调用 wmb_dispatch_research/);
  assert.match(prompt, /受限写作·已豁免外部研究/);
  assert.match(prompt, /严禁调用 wmb_dispatch_research/);
  assert.match(prompt, /仅依据项目已关联来源/);
  assert.match(prompt, /删除或明确标为.*观点/);
});

test('WMB-5347: draftPrompt auto/required 未ready 仍为必须派研究', () => {
  const task = { id:'task-auto' };
  const autoPrompt = draftPrompt(task, 'proj-1', 'req-2', 'core_draft', '正常', false, 'auto');
  assert.match(autoPrompt, /必须调用 wmb_dispatch_research/);
  assert.match(autoPrompt, /外部研究前置交接/);
  const reqPrompt = draftPrompt(task, 'proj-1', 'req-3', 'core_draft', '正常', false, 'required');
  assert.match(reqPrompt, /必须调用 wmb_dispatch_research/);
  const prohibitedPrompt = draftPrompt(task, 'proj-1', 'req-4', 'core_draft', '严禁研究', false, 'prohibited');
  assert.doesNotMatch(prohibitedPrompt, /必须调用 wmb_dispatch_research/);
});

test('WMB-5347: 显式 required 覆盖 brief 禁研仍派研究', () => {
  const task = { id:'task-required-override' };
  const prompt = draftPrompt(task, 'proj-1', 'req-5', 'core_draft', '此轮严禁研究，但显式 required', false, 'required');
  assert.match(prompt, /必须调用 wmb_dispatch_research/);
});

test('WMB-5347: prohibited exempt 允许保存，revision 1->2 且无 research handoff', async () => withDb(async (db) => {
  const proj = createContentProject(db, { title:'AI 项目成本复盘' });
  const v1 = saveCoreVersion(db, { projectId: proj.id, body:'初稿 v1', expectedRevision: proj.revision });
  assert.ok(v1.ok);
  assert.equal(v1.data.versionNumber, 1);
  const afterV1 = getContentProject(db, proj.id);
  assert.equal(afterV1.revision, 2);
  const versionCount1 = db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(proj.id).c;
  assert.equal(versionCount1, 1);
  insertTask(db, { id:'task-exempt-ok', intent:'studio_draft', roleId:'writer', projectId: proj.id, researchGate:'exempt', researchMode:'prohibited' });
  const runtime = { database: db };
  assert.doesNotThrow(() => assertStudioDraftResearchReady(runtime, 'task-exempt-ok', proj.id));
  const v2 = saveCoreVersion(db, { projectId: proj.id, body:'观点型方法文 v2 - 受限资料', expectedRevision: afterV1.revision });
  assert.ok(v2.ok);
  assert.equal(v2.data.versionNumber, 2);
  const afterV2 = getContentProject(db, proj.id);
  assert.equal(afterV2.revision, 3);
  const versionCount2 = db.prepare('SELECT COUNT(*) as c FROM content_versions WHERE project_id=?').get(proj.id).c;
  assert.equal(versionCount2, 2);
  const researchJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE kind='research_successor'").get().c;
  assert.equal(researchJobs, 0);
}));

test('WMB-5347: auto/required 未ready 仍 blocked', async () => withDb(async (db) => {
  const proj = createContentProject(db, { title:'blocked-test' });
  const v1 = saveCoreVersion(db, { projectId: proj.id, body:'v1', expectedRevision: proj.revision });
  assert.ok(v1.ok);
  insertTask(db, { id:'task-required', intent:'studio_draft', roleId:'writer', projectId: proj.id, researchGate:'required', researchMode:'required' });
  insertTask(db, { id:'task-auto', intent:'studio_draft', roleId:'writer', projectId: proj.id, researchGate:'required', researchMode:'auto' });
  const runtime = { database: db };
  assert.throws(() => assertStudioDraftResearchReady(runtime, 'task-required', proj.id), e => e.code==='RESEARCH_REQUIRED');
  assert.throws(() => assertStudioDraftResearchReady(runtime, 'task-auto', proj.id), e => e.code==='RESEARCH_REQUIRED');
}));

test('WMB-5347: 伪造 exempt、错项目、非 writer 全部拒绝', async () => withDb(async (db) => {
  const proj = createContentProject(db, { title:'gate-test' });
  insertTask(db, { id:'task-fake-exempt', intent:'studio_draft', roleId:'writer', projectId: proj.id, researchGate:'exempt', researchMode:'auto' });
  insertTask(db, { id:'task-wrong-proj', intent:'studio_draft', roleId:'writer', projectId:'other-proj', researchGate:'exempt', researchMode:'prohibited' });
  insertTask(db, { id:'task-not-writer', intent:'studio_draft', roleId:'librarian', projectId: proj.id, researchGate:'exempt', researchMode:'prohibited' });
  db.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at,
    error_code, error_message, created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', NULL, ?, ?, ?, ?, NULL)`).run(
    'task-bare-exempt', 'studio_draft', BUSINESS_DATE, 'running', 'starting', JSON.stringify({ roleId:'writer', projectId: proj.id, researchGate:'exempt' }), JSON.stringify({}), JSON.stringify({}), JSON.stringify({}), null, null, nowIso(), nowIso()
  );
  const runtime = { database: db };
  assert.throws(() => assertStudioDraftResearchReady(runtime, 'task-fake-exempt', proj.id), e => e.code==='RESEARCH_GATE_EXEMPT_INVALID');
  assert.throws(() => assertStudioDraftResearchReady(runtime, 'task-wrong-proj', proj.id), e => e.code==='RESEARCH_GATE_EXEMPT_INVALID');
  assert.throws(() => assertStudioDraftResearchReady(runtime, 'task-not-writer', proj.id), e => e.code==='RESEARCH_GATE_EXEMPT_INVALID');
  assert.throws(() => assertStudioDraftResearchReady(runtime, 'task-bare-exempt', proj.id), e => e.code==='RESEARCH_GATE_EXEMPT_INVALID');
}));

test('WMB-5347: research successor 仍视为 evidenceReady，不因 prohibited 逻辑退化', async () => withDb(async (db) => {
  const now = nowIso();
  db.prepare(`INSERT INTO jobs (id, kind, status, due_at, attempts, dedupe_key, payload_json, last_error, created_at, updated_at, started_at, finished_at)
     VALUES (?, 'research_successor', 'pending', ?, 0, ?, ?, NULL, ?, ?, NULL, NULL)`).run('job-successor-1', now, 'dedupe-job-successor-1', JSON.stringify({ parentJobId: 'job-successor-1' }), now, now);
  const { isResearchSuccessorRow } = await import('../src/main/research-successor.ts');
  assert.equal(isResearchSuccessorRow(db, 'job-successor-1'), true);
  const task = { id:'task-successor' };
  const prompt = draftPrompt(task, 'proj-1', 'req-succ', 'core_draft', 'succ brief', true, 'prohibited');
  assert.doesNotMatch(prompt, /必须调用 wmb_dispatch_research/);
  const normal = draftPrompt(task, 'proj-1', 'req-succ2', 'core_draft', 'normal', true, 'auto');
  assert.doesNotMatch(normal, /必须调用 wmb_dispatch_research/);
  assert.match(normal, /已保存核心正文/);
}));
