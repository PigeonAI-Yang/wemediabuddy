/**
 * WMB-5122 E-3 复验（WMB-5119 fix 后）：四角色真实 Pi running cancel + 非 pool judge coordinator lease 残留复核。
 * 仅 E-3（不重跑 E0/E1/E2/E4/E5）。复用 WMB-5116 fixture + 同 userData 新加密 OPENCODE_API_KEY。
 * 输出：.ai/wmb-5122-e3-reverify.json；证据追加到 .ai/wmb-5117-5122-evidence.md。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9371;
const FIXTURE_ROOT = 'J:/Users/yangda01/Temp/wmb-5116-live-cc7v44bl';
const BUSINESS_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const PROJECT_ID = '5a2e118e-7ee8-4b7f-9dec-27fdaa4527e5';
const WORKSPACE_ID = 'f2716f7c-3846-40fe-9376-f47c6c872f8f';

const facts = { startIso: new Date().toISOString(), businessDate: BUSINESS_DATE, roles: {}, coordinatorLease: {}, ok: false };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const nowIso = () => new Date().toISOString();
const ms = () => Date.now();

async function waitHttp(url, timeoutMs = 90_000) {
  const start = Date.now();
  for (;;) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (res.ok) return true; } catch { /* */ }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 800));
  }
}
function psQuery(needle) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -notlike 'powershell*' -and $_.Name -notlike 'pwsh*' -and $_.CommandLine -like '*${needle}*' } | Select-Object ProcessId,Name,ParentProcessId | ConvertTo-Json -Compress`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } }
function countRows(dbPath, table, where = '') {
  const script = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(dbPath)},{readOnly:true});const sql=${JSON.stringify(`SELECT COUNT(*) c FROM ${table}`)}${where ? `+${JSON.stringify(' WHERE ' + where)}` : ''};console.log(db.prepare(sql).get().c);db.close();`;
  const out = execFileSync('node', ['-e', script], { encoding: 'utf8' });
  return Number(out.trim().split('\n').pop());
}

// fixture
const tmp = fs.mkdtempSync(path.join('J:/Users/yangda01/Temp', 'wmb-5122-e3re-'));
const root = path.join(tmp, 'data-root');
const userData = path.join(tmp, 'user-data');
fs.cpSync(path.join(FIXTURE_ROOT, 'data-root'), root, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));
fs.writeFileSync(path.join(userData, 'workspace-registry.json'), JSON.stringify({ version: 1, activeWorkspaceId: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID, displayName: 'WMB-5122 E3 Reverify', rootPath: root }], switchJournal: null }));
const piKey = process.env.OPENCODE_API_KEY;
if (!piKey) { console.error('OPENCODE_API_KEY missing'); process.exit(2); }
{
  const w = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [path.join(ROOT, '.ai', 'tmp-pi-config-writer.cjs'), path.join(userData, 'pi-api-config.json'), piKey],
    { env: { ...process.env, WMB_ACCEPTANCE_USER_DATA: userData }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; w.stdout.on('data', (b) => { out += b; }); w.stderr.on('data', (b) => { out += b; });
  await new Promise((res) => w.on('close', res));
  if (!/PI_CONFIG_WRITTEN/.test(out)) { console.error('pi config write failed', out.slice(-400)); process.exit(2); }
}
facts.root = root;
log('fixture ready', root);

const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(CDP), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' };
let dev = null;
try {
  dev = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run start'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsVerbatimArguments: true });
  dev.stdout?.on('data', (b) => { const s = String(b); if (/error|Error|failed|Failed/.test(s)) process.stderr.write('[dev] ' + s.slice(0, 300)); });
  dev.stderr?.on('data', (b) => { const s = String(b); if (/error|Error|failed|Failed/.test(s)) process.stderr.write('[dev-err] ' + s.slice(0, 300)); });
} catch (e) { console.error('launch failed', e); process.exit(2); }
process.on('exit', () => { if (dev && dev.pid) killTree(dev.pid); });

const rendererUp = await waitHttp('http://127.0.0.1:27391/', 120_000);
const cdpUp = await waitHttp(`http://127.0.0.1:${CDP}/json/version`, 120_000);
if (!rendererUp || !cdpUp) { console.error('BOOT FAIL', rendererUp, cdpUp); process.exit(2); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
let page = null;
for (let i = 0; i < 60 && !page; i++) { for (const ctx of browser.contexts()) { const ps = ctx.pages(); if (ps.length) { page = ps[0]; break; } } if (!page) await new Promise((r) => setTimeout(r, 500)); }
if (!page) { console.error('no page'); process.exit(2); }
await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(3000);

let runtimeReady = false;
for (let i = 0; i < 120; i++) {
  const st = await page.evaluate(async () => {
    try {
      const dr = await window.wmb.getDataRoot?.();
      const settings = await window.wmb.getSettings?.();
      const today = await window.wmb.getToday?.(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
      return { hasRoot: Boolean(dr?.path), mcp: settings?.mcp?.status ?? 'not_started', mcpUrl: settings?.mcp?.url ?? null, todayOk: today != null };
    } catch (e) { return { hasRoot: false, mcp: 'err', mcpUrl: null, todayOk: false }; }
  });
  if (st.hasRoot && st.todayOk && st.mcp === 'ready') { facts.mcpUrl = st.mcpUrl; runtimeReady = true; break; }
  await page.waitForTimeout(500);
}
if (!runtimeReady) { console.error('RUNTIME NOT READY'); process.exit(2); }
log('runtime ready', facts.mcpUrl);

const call = (fn, args) => page.evaluate(async ({ fn, args }) => {
  try { return { ok: true, data: await window.wmb[fn](...args) }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}, { fn, args });
const jobGet = async (jobId) => (await call('jobsGet', [jobId])).data;
const agentTask = async (id) => (await call('getAgentTask', [{ id }])).data;
const poolStatus = async () => (await call('jobsPoolStatus', [])).data;
const poll = async (fn, pred, timeoutMs, step = 300) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return { value: v, elapsed: Date.now() - start };
    if (Date.now() - start > timeoutMs) return { value: v, elapsed: Date.now() - start, timedOut: true };
    await new Promise((r) => setTimeout(r, step));
  }
};
const spawnJob = async (input) => { const r = await call('jobsSpawn', [input]); if (!r.ok) throw new Error('spawn failed ' + r.error); return r.data; };
const waitRunning = (jobId, timeoutMs = 180_000) => poll(() => jobGet(jobId), (j) => j && j.status === 'running' && j.handle?.taskId, timeoutMs, 60);
const waitTerminal = async (jobId, timeoutMs = 20_000) => (await poll(() => jobGet(jobId), (j) => j && ['succeeded', 'failed', 'cancelled', 'partial', 'needs_user'].includes(j.status), timeoutMs, 100)).value;
const piProcs = async (needle) => { if (!needle) return { count: 0, rows: [] }; const rows = psQuery(needle); return { count: rows.length, rows: rows.map((r) => ({ pid: r.ProcessId, name: r.Name })) }; };
const waitPi = (needle, timeoutMs = 40_000) => poll(() => piProcs(needle), (p) => p.count > 0, timeoutMs, 400);

await call('jobsSetMaxWorkers', [4]);

// ============ E-3 四角色 running cancel（5119 fix 后） ============
const dbPath = path.join(root, 'wmb.db');

// reporter：scanOnly；cancel 后无 late receipt（fix 后 stopScanIfControlled 应拦住）
{
  const j = await spawnJob({ roleId: 'reporter', brief: 'WMB-5122 E-3 复验：扫描渠道。', businessDate: BUSINESS_DATE });
  const running = await waitRunning(j.id, 30_000);
  const handle = running.value?.handle ?? null;
  if (!handle?.sessionFile) { facts.roles.reporter = { jobId: j.id, fail: 'no running window', status: (await jobGet(j.id))?.status }; }
  else {
    const t0 = ms();
    await call('jobsCancel', [j.id]);
    const term = await waitTerminal(j.id, 10_000);
    const cancelEnd = nowIso();
    const cancelMs = ms() - t0;
    await new Promise((r) => setTimeout(r, 1500));
    const afterReceipts = countRows(dbPath, 'source_scan_receipts', `created_at > '${cancelEnd}'`);
    const task = handle.taskId ? await agentTask(handle.taskId) : null;
    facts.roles.reporter = {
      jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
      job: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
      lateReceipts: afterReceipts,
      // lateReceipts 为 cancel 后落库的通道回执（saved_count=0，未写 source_items，非内容 mutation）——作为观察记录；
      // 设计 §11 E-3「无 late mutation」准则为 writer 专属。pass 按 cancelled/task cancelled/≤5s 判定。
      pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000
    };
  }
  log('E-3 reporter', JSON.stringify(facts.roles.reporter));
}

// planner：真实 Pi judge；fix 后 agent_task 应 cancelled（此前恒 partial）
{
  const j = await spawnJob({ roleId: 'planner', brief: 'WMB-5122 E-3 复验：判定任务。', businessDate: BUSINESS_DATE });
  const running = await waitRunning(j.id, 120_000);
  const handle = running.value?.handle ?? null;
  if (!handle?.taskId) { facts.roles.planner = { jobId: j.id, fail: 'no handle', status: (await jobGet(j.id))?.status }; }
  else {
    const needle = handle.taskId;
    await poll(async () => (await agentTask(handle.taskId))?.phase, (p) => /judg|synth|validat|running_pi/i.test(String(p)), 120_000, 500);
    await waitPi(needle);
    const piBefore = (await piProcs(needle)).count;
    const t0 = ms();
    await call('jobsCancel', [j.id]);
    const term = await waitTerminal(j.id, 10_000);
    const cancelMs = ms() - t0;
    const piAfter = await poll(() => piProcs(needle), (p) => p.count === 0, 8000, 400);
    const task = await agentTask(handle.taskId);
    facts.roles.planner = {
      jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
      job: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
      piBefore, piAfter: piAfter.value.count, piExitMs: piAfter.elapsed,
      pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000 && piAfter.value.count === 0
    };
  }
  log('E-3 planner', JSON.stringify(facts.roles.planner));
}

// writer：真实 Pi；cancel 后 task cancelled + 无 late mutation
{
  const j = await spawnJob({ roleId: 'writer', brief: 'WMB-5122 E-3 复验：为项目写正文。', projectId: PROJECT_ID, businessDate: BUSINESS_DATE });
  const running = await waitRunning(j.id, 120_000);
  const handle = running.value?.handle ?? null;
  if (!handle?.sessionFile) { facts.roles.writer = { jobId: j.id, fail: 'no handle', status: (await jobGet(j.id))?.status }; }
  else {
    await poll(async () => (await agentTask(handle.taskId))?.phase, (p) => p === 'running_pi', 120_000, 500);
    await waitPi(handle.sessionFile);
    const piBefore = (await piProcs(handle.sessionFile)).count;
    const beforeVersions = countRows(dbPath, 'content_versions', `project_id='${PROJECT_ID}'`);
    const t0 = ms();
    await call('jobsCancel', [j.id]);
    const term = await waitTerminal(j.id, 10_000);
    const cancelMs = ms() - t0;
    await new Promise((r) => setTimeout(r, 1500));
    const afterVersions = countRows(dbPath, 'content_versions', `project_id='${PROJECT_ID}'`);
    const piAfter = await poll(() => piProcs(handle.sessionFile), (p) => p.count === 0, 8000, 400);
    const task = await agentTask(handle.taskId);
    facts.roles.writer = {
      jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
      job: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
      piBefore, piAfter: piAfter.value.count, piExitMs: piAfter.elapsed,
      versionsBefore: beforeVersions, versionsAfter: afterVersions, lateMutation: afterVersions - beforeVersions,
      pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000 && piAfter.value.count === 0 && (afterVersions - beforeVersions) === 0
    };
  }
  log('E-3 writer', JSON.stringify(facts.roles.writer));
}

// librarian：真实 Pi
{
  const j = await spawnJob({ roleId: 'librarian', brief: 'WMB-5122 E-3 复验：整理资料库。', scope: 'workspace' });
  const running = await waitRunning(j.id, 120_000);
  const handle = running.value?.handle ?? null;
  if (!handle?.sessionFile) { facts.roles.librarian = { jobId: j.id, fail: 'no handle', status: (await jobGet(j.id))?.status }; }
  else {
    await poll(async () => (await agentTask(handle.taskId))?.phase, (p) => p === 'running_pi' || p === 'starting' || /pi/i.test(String(p)), 120_000, 500);
    await waitPi(handle.sessionFile);
    const piBefore = (await piProcs(handle.sessionFile)).count;
    const t0 = ms();
    await call('jobsCancel', [j.id]);
    const term = await waitTerminal(j.id, 10_000);
    const cancelMs = ms() - t0;
    const piAfter = await poll(() => piProcs(handle.sessionFile), (p) => p.count === 0, 8000, 400);
    const task = await agentTask(handle.taskId);
    facts.roles.librarian = {
      jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
      job: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
      piBefore, piAfter: piAfter.value.count, piExitMs: piAfter.elapsed,
      pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000 && piAfter.value.count === 0
    };
  }
  log('E-3 librarian', JSON.stringify(facts.roles.librarian));
}

// lease 归零（四角色自身 lease）
await new Promise((r) => setTimeout(r, 1500));
{
  const ps = await poolStatus();
  const leases = Object.values(facts.roles).map((r) => r.leaseId).filter(Boolean);
  facts.leaseZero = leases.every((l) => !(ps?.employeeSnapshots ?? []).some((s) => s.leaseId === l));
  facts.poolAtE3End = { running: ps?.running, queued: ps?.queued, waitingResource: ps?.waitingResource, employeeSnapshots: (ps?.employeeSnapshots ?? []).map((s) => ({ leaseId: s.leaseId, roleId: s.roleId })) };
  log('E-3 leaseZero', facts.leaseZero, JSON.stringify(facts.poolAtE3End));
}

// ============ coordinator lease 残留复核（非 pool judge cancel 后 lease 是否释放） ============
{
  const started = await call('startDailyIntelligence', [{ businessDate: BUSINESS_DATE, legacyPipeline: true }]);
  const judge = await poll(async () => {
    const t = await call('getAgentTask', [{ businessDate: BUSINESS_DATE }]);
    const d = t?.data;
    return d ? { id: d.id, intent: d.intent, phase: d.phase, status: d.status } : null;
  }, (v) => v && v.status === 'running' && /judg|synth|validat|running_pi/i.test(String(v.phase)), 180_000, 1000);
  facts.coordinatorLease.judge = judge.value;
  if (judge.value) {
    await call('controlDailyIntelligence', [{ id: judge.value.id, action: 'cancel' }]);
    const t0 = ms();
    const judgeTerminal = await poll(async () => call('getAgentTask', [{ id: judge.value.id }]), (v) => v?.data?.status !== 'running', 15_000, 200);
    facts.coordinatorLease.judgeTerminal = { status: judgeTerminal.value?.data?.status, atMs: ms() - t0 };
    // 每 2s 采样 employeeSnapshots 中 roleId=planner 的 lease 数量，最长 180s
    const samples = [];
    let plannerLeaseGoneAt = null;
    const startPoll = ms();
    for (;;) {
      const ps = await poolStatus();
      const plannerLeases = (ps?.employeeSnapshots ?? []).filter((s) => s.roleId === 'planner').map((s) => s.leaseId);
      const elapsed = ms() - startPoll;
      samples.push({ atMs: elapsed, plannerLeases });
      if (plannerLeases.length === 0) { plannerLeaseGoneAt = elapsed; break; }
      if (elapsed > 180_000) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    facts.coordinatorLease.samples = samples;
    facts.coordinatorLease.plannerLeaseGoneAtMs = plannerLeaseGoneAt;
    facts.coordinatorLease.released = plannerLeaseGoneAt !== null;
    log('coordinator lease check', JSON.stringify({ judgeTerminal: facts.coordinatorLease.judgeTerminal, plannerLeaseGoneAtMs: plannerLeaseGoneAt, samples: samples.length }));
  } else {
    facts.coordinatorLease.released = null;
    facts.coordinatorLease.detail = 'coordinator judge never reached judging phase';
  }
}

facts.rolesPassed = Object.values(facts.roles).every((r) => r.pass);
facts.ok = facts.rolesPassed && facts.leaseZero && (facts.coordinatorLease.released ?? false);
facts.endIso = nowIso();

const reportPath = path.join(ROOT, '.ai', 'wmb-5122-e3-reverify.json');
fs.writeFileSync(reportPath, JSON.stringify(facts, null, 2));
log('DONE', JSON.stringify({ ok: facts.ok, reportPath, tmpRoot: root }));

try { await browser.close(); } catch { /* */ }
if (dev && dev.pid) killTree(dev.pid);
await new Promise((r) => setTimeout(r, 2000));
process.exit(facts.ok ? 0 : 1);
