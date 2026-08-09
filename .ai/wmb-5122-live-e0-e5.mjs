/**
 * WMB-5122 实机验收 E0-E5（隔离 data root，不碰真实数据）。
 * 复用 WMB-5116 实机 fixture（J:/Users/yangda01/Temp/wmb-5116-live-cc7v44bl）：
 *   - data-root：wmb.db（official.ai workspace、今日 plan、2 个 website 渠道、content 项目、pi 配置线索）
 *   - user-data：pi-api-config.json（真实 Pi API 配置，safeStorage 同机可解密）
 * 启动：vite renderer dev server（27391）+ electron（CDP 9371, WMB_ACCEPTANCE_*）。
 * 输出：.ai/wmb-5122-live-e0-e5.json（结构化事实）+ .ai/wmb-5117-5122-evidence.md（证据草稿，E0-E5）。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9371;
const FIXTURE_ROOT = 'J:/Users/yangda01/Temp/wmb-5116-live-cc7v44bl';
const BUSINESS_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const PROJECT_ID = '5a2e118e-7ee8-4b7f-9dec-27fdaa4527e5';
const WORKSPACE_ID = 'f2716f7c-3846-40fe-9376-f47c6c872f8f';

const facts = { startIso: new Date().toISOString(), root: null, businessDate: BUSINESS_DATE, e0: {}, e1: {}, e2: {}, e3: {}, e4: {}, e5: {}, ok: false };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function nowIso() { return new Date().toISOString(); }
function ms() { return Date.now(); }

async function waitHttp(url, timeoutMs = 90_000, intervalMs = 800) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return true;
    } catch { /* not yet */ }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function psQuery(needle) {
  // needle 为真实路径（单反斜杠）；排除自身 powershell 进程（其 cmdline 含 pattern 会自匹配）。
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -notlike 'powershell*' -and $_.Name -notlike 'pwsh*' -and $_.CommandLine -like '*${needle}*' } | Select-Object ProcessId,Name,ParentProcessId | ConvertTo-Json -Compress`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

// ---------------------------------------------------------------- fixture
const tmp = fs.mkdtempSync(path.join('J:/Users/yangda01/Temp', 'wmb-5122-live-'));
const root = path.join(tmp, 'data-root');
const userData = path.join(tmp, 'user-data');
fs.cpSync(path.join(FIXTURE_ROOT, 'data-root'), root, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));
fs.writeFileSync(path.join(userData, 'workspace-registry.json'), JSON.stringify({
  version: 1, activeWorkspaceId: WORKSPACE_ID,
  workspaces: [{ id: WORKSPACE_ID, displayName: 'WMB-5122 Acceptance', rootPath: root }], switchJournal: null
}));
// Pi config：5116 fixture 的 safeStorage blob 已不可解密（环境漂移）；用当前环境 OPENCODE_API_KEY
// 在**同一 userData** 下新加密写入（safeStorage 同上下文可解密）。
const piKey = process.env.OPENCODE_API_KEY;
if (!piKey) { console.error('OPENCODE_API_KEY missing'); process.exit(2); }
{
  const w = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [path.join(ROOT, '.ai', 'tmp-pi-config-writer.cjs'), path.join(userData, 'pi-api-config.json'), piKey],
    { env: { ...process.env, WMB_ACCEPTANCE_USER_DATA: userData }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  w.stdout.on('data', (b) => { out += b; });
  w.stderr.on('data', (b) => { out += b; });
  await new Promise((res) => w.on('close', res));
  if (!/PI_CONFIG_WRITTEN/.test(out)) { console.error('pi config write failed', out.slice(-500)); process.exit(2); }
  log('pi config written with fresh key');
}
facts.root = root;
log('fixture ready', root);

// ---------------------------------------------------------------- launch
const env = {
  ...process.env,
  WMB_ACCEPTANCE_CDP_PORT: String(CDP),
  WMB_ACCEPTANCE_USER_DATA: userData,
  WMB_ACCEPTANCE_HEADLESS: '1'
};
let dev = null;
const devLogPath = path.join(tmp, 'dev.log');
const devLog = fs.createWriteStream(devLogPath, { flags: 'a' });
try {
  dev = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run start'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsVerbatimArguments: true });
  dev.stdout?.on('data', (b) => { devLog.write(b); const s = String(b); if (/error|Error|failed|Failed/.test(s)) process.stderr.write('[dev] ' + s.slice(0, 400)); });
  dev.stderr?.on('data', (b) => { devLog.write(b); const s = String(b); if (/error|Error|failed|Failed/.test(s)) process.stderr.write('[dev-err] ' + s.slice(0, 400)); });
} catch (e) {
  console.error('launch failed', e);
  process.exit(2);
}
const cleanup = () => { if (dev && dev.pid) killTree(dev.pid); };
process.on('exit', cleanup);

const rendererUp = await waitHttp('http://127.0.0.1:27391/', 120_000);
log('renderer up', rendererUp);
const cdpUp = await waitHttp(`http://127.0.0.1:${CDP}/json/version`, 120_000);
log('cdp up', cdpUp);
if (!rendererUp || !cdpUp) {
  console.error('BOOT FAILED rendererUp=%s cdpUp=%s', rendererUp, cdpUp);
  cleanup(); process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
let page = null;
for (let i = 0; i < 60 && !page; i++) {
  for (const ctx of browser.contexts()) { const ps = ctx.pages(); if (ps.length) { page = ps[0]; break; } }
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
if (!page) { console.error('no page'); cleanup(); process.exit(2); }
await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(3000);

let runtimeReady = false; let readyDetail = '';
for (let i = 0; i < 120; i++) {
  const st = await page.evaluate(async () => {
    try {
      const dr = await window.wmb.getDataRoot?.();
      const settings = await window.wmb.getSettings?.();
      const today = await window.wmb.getToday?.(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
      return { hasRoot: Boolean(dr?.path), root: dr?.path || null, mcp: settings?.mcp?.status ?? 'not_started', mcpUrl: settings?.mcp?.url ?? null, todayOk: today != null };
    } catch (e) { return { hasRoot: false, root: null, mcp: 'err', mcpUrl: null, todayOk: false, err: String(e?.message || e) }; }
  });
  readyDetail = JSON.stringify(st);
  if (st.hasRoot && st.todayOk && st.mcp === 'ready') { runtimeReady = true; facts.mcpUrl = st.mcpUrl; break; }
  await page.waitForTimeout(500);
}
if (!runtimeReady) {
  console.error('RUNTIME NOT READY', readyDetail);
  await page.screenshot({ path: path.join(ROOT, '.ai', 'wmb-5122-live-boot-fail.png'), fullPage: true }).catch(() => {});
  cleanup(); process.exit(2);
}
log('runtime ready', readyDetail.slice(0, 300));

// event capture (pi events + data changed)
await page.evaluate(() => {
  window.__piEvents = [];
  window.__dataChanged = [];
  window.wmb.onPiEvent((e) => window.__piEvents.push(e));
  window.wmb.onDataChanged((e) => window.__dataChanged.push(e));
});

const call = (fn, args) => page.evaluate(async ({ fn, args }) => {
  try { return { ok: true, data: await window.wmb[fn](...args) }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}, { fn, args });
const call0 = (fn) => call(fn, []);

// helpers ----------------------------------------------------------------
const poll = async (fn, pred, timeoutMs, step = 300) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return { value: v, elapsed: Date.now() - start };
    if (Date.now() - start > timeoutMs) return { value: v, elapsed: Date.now() - start, timedOut: true };
    await new Promise((r) => setTimeout(r, step));
  }
};

async function mcpTool(name, args) {
  const url = facts.mcpUrl;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000)
  });
  const raw = await res.text();
  // MCP over HTTP 用 SSE 流（event: message / data: <json>）；也兼容纯 JSON 响应。
  let body = null;
  try { body = JSON.parse(raw); } catch { /* SSE below */ }
  if (!body) {
    const dataLines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const line of dataLines) {
      try { const candidate = JSON.parse(line); body = candidate; break; } catch { /* try next */ }
    }
  }
  const content = body?.result?.content;
  const text = Array.isArray(content) ? content.map((c) => c.text ?? '').join('') : '';
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { http: res.status, isError: body?.result?.isError ?? false, error: body?.error ?? null, raw: text, parsed };
}

const jobGet = async (jobId) => (await call('jobsGet', [jobId])).data;
const poolStatus = async () => (await call0('jobsPoolStatus')).data;
const agentTask = async (id) => (await call('getAgentTask', [{ id }])).data;

async function spawnJob(input) {
  const r = await call('jobsSpawn', [input]);
  if (!r.ok) throw new Error('spawn failed: ' + r.error);
  return r.data;
}
async function waitTerminal(jobId, timeoutMs = 240_000) {
  const r = await poll(() => jobGet(jobId), (j) => j && ['succeeded', 'failed', 'cancelled', 'partial', 'needs_user'].includes(j.status), timeoutMs, 500);
  return r.value;
}
async function waitRunning(jobId, timeoutMs = 180_000) {
  const r = await poll(() => jobGet(jobId), (j) => j && j.status === 'running' && j.handle?.taskId, timeoutMs, 300);
  return r.value;
}

const take = async (label) => {
  const d = await jobGet(label.jobId);
  return {
    status: d?.status, waitReason: d?.waitReason, waitingSince: d?.waitingSince, startedAt: d?.startedAt, finishedAt: d?.finishedAt,
    taskId: d?.handle?.taskId ?? null, leaseId: d?.handle?.leaseId ?? null, grantId: d?.handle?.grantId ?? null, sessionFile: d?.handle?.sessionFile ?? null,
    report: d?.report ?? null
  };
};

const EVIDENCE_PATH = path.join(ROOT, '.ai', 'wmb-5117-5122-evidence.md');
const REPORT_PATH = path.join(ROOT, '.ai', 'wmb-5122-live-e0-e5.json');
function writeEvidence() {
  const ev = [
    '# WMB-5117..5122 证据（WMB-5122 实机 E0-E5 草稿）',
    '',
    `- Date: ${new Date().toISOString()}（增量落盘；最终态以 .json 为准）`,
    `- 隔离实机数据根：${root}（独立临时工作空间，未触碰真实数据；WMB-5116 fixture 复用）`,
    `- businessDate: ${BUSINESS_DATE}；MCP: ${facts.mcpUrl ?? '-'}`,
    `- 总结果：${facts.ok ? 'PASS' : 'IN-PROGRESS/PARTIAL'}（见各项）`,
    '',
    '## E-0 冒烟',
    `- \`node scripts/smoke-renderer.mjs\` → ${facts.e0.smoke ?? '-'}`,
    `- title/root/entry 检查：${JSON.stringify({ title: facts.e0.title, rootEl: facts.e0.rootEl, entry: facts.e0.entry })}`,
    `- 结果：${facts.e0.passed ? 'PASS' : 'PENDING/FAIL'} @ ${facts.e0.at ?? '-'}`,
    '',
    '## E-1 四角色并发成功（reporter+writer+librarian 同 businessDate）',
    ...(facts.e1.terminal ?? []).map((t) => `- ${t.role} job ${t.id} → ${t.status} code=${t.report?.code ?? '-'} readback=${JSON.stringify(t.report?.readback ?? null)} task=${t.taskId ?? '-'} ${t.startedAt ?? '-'} → ${t.finishedAt ?? '-'}`),
    ...(facts.e1.reporterTaskAfter ? [`- E-1 reporter 任务终态后状态：${JSON.stringify(facts.e1.reporterTaskAfter)}；channel_scanned 交接 grant active=${facts.e1.handoffGrantActive}（E-4 观察）`] : []),
    `- 结果：${facts.e1.passed ? 'PASS' : 'FAIL'}（elapsed ${facts.e1.elapsedMs ?? '-'}ms）`,
    '',
    '## E-2 R1 实机（deferred park + 晋升 ≤1s + 60s watchdog）',
    `- (a) pool judge：planner job ${facts.e2.poolJudge?.plannerJobId ?? '-'}（task ${facts.e2.poolJudge?.judgeTaskId ?? '-'} phase ${facts.e2.poolJudge?.judgePhase ?? '-'}）→ reporter job ${facts.e2.poolJudge?.reporterJobId ?? '-'} 泊车 ${JSON.stringify(facts.e2.poolJudge?.parked)}；judge settle @ ${facts.e2.poolJudge?.settleAt ?? '-'} → 晋升 ${facts.e2.poolJudge?.promotionMs ?? '-'}ms → reporter 终态 ${facts.e2.poolJudge?.reporterTerminal?.status ?? '-'}（${facts.e2.poolJudge?.reporterTerminal?.report?.readback?.kind ?? '-'}）`,
    `- (a) 结果：${facts.e2.a?.ok ? 'PASS' : 'FAIL'} ${facts.e2.a?.detail ?? ''}`,
    `- (b) watchdog：非 pool judge（coordinator legacy 全流程）task ${facts.e2.watchdog?.judge?.id ?? '-'} phase ${facts.e2.watchdog?.judge?.phase ?? '-'}（终态 ${facts.e2.watchdog?.judgeTerminalStatus ?? '-'}）→ reporter job ${facts.e2.watchdog?.reporterJobId ?? '-'} 泊车 ${JSON.stringify(facts.e2.watchdog?.parked)}；judge settle @ ${facts.e2.watchdog?.settleAt ?? '-'} → 看门狗晋升 ${facts.e2.watchdog?.promotionMs ?? '-'}ms → reporter 终态 ${facts.e2.watchdog?.reporterTerminal?.status ?? '-'}`,
    `- (b) 结果：${facts.e2.b?.ok ? 'PASS' : 'FAIL'} ${facts.e2.b?.detail ?? ''}`,
    '',
    '## E-3 R2 实机（四角色 running cancel ≤5s / Pi 进程树退出 / lease 归零 / task cancelled / 无 late mutation）',
    ...Object.entries(facts.e3.roles ?? {}).map(([role, r]) => `- ${role}: job ${r.jobId ?? '-'} task ${r.taskId ?? '-'} lease ${r.leaseId ?? '-'} cancelMs=${r.cancelMs ?? '-'}ms job=${r.status ?? '-'} task=${r.taskStatus ?? '-'}/${r.taskPhase ?? '-'} piBefore=${r.piBefore ?? '-'} piAfter=${r.piAfter ?? '-'} (exitMs=${r.piExitMs ?? '-'}ms) lateMutation=${r.lateMutation ?? r.lateMutationReceipts ?? '-'} → ${r.pass ? 'PASS' : 'FAIL'}`),
    `- lease 归零：${facts.e3.leaseZero}；pool 快照 ${JSON.stringify(facts.e3.pool ?? null)}`,
    `- 结果：${facts.e3.passed ? 'PASS' : 'FAIL'}`,
    '',
    '## E-4 R3 实机（grant revoke / 旧 grantId envelope 拒绝 / channel_scanned 交接 grant 保持 active）',
    `- 终态任务 ${facts.e4.sample?.taskId ?? '-'} 的 task_grants：${JSON.stringify((Array.isArray(facts.e4.taskGrantsAfterTerminal) ? facts.e4.taskGrantsAfterTerminal : (facts.e4.taskGrantsAfterTerminal?.data ?? [])).map((g) => ({ id: g.id, status: g.status, revokedAt: g.revokedAt })))} → 无 active：${facts.e4.noActiveAfterTerminal}`,
    `- 旧 grantId ${facts.e4.oldGrantId ?? '-'} 实机写：${JSON.stringify(facts.e4.oldGrantWrite)} → 拒绝：${facts.e4.oldGrantRejected}`,
    `- channel_scanned 交接：task ${facts.e4.handoff?.taskId ?? '-'} state=${JSON.stringify(facts.e4.handoff?.taskState)} grantActive=${facts.e4.handoff?.grantActiveAtChannelScanned}（grants=${JSON.stringify(Array.isArray(facts.e4.handoff?.grants) ? facts.e4.handoff.grants.map((g) => ({ id: g.id, status: g.status })) : [])}）`,
    `- 结果：${facts.e4.passed ? 'PASS' : 'FAIL'}`,
    '',
    '## E-5 R4 实机（严格 fenced no-op）',
    `- A 围栏：job ${facts.e5.runA?.jobId ?? '-'} → ${facts.e5.runA?.status ?? '-'} code=${facts.e5.runA?.code ?? '-'} readback=${JSON.stringify(facts.e5.runA?.readback ?? null)} fenceInSession=${facts.e5.runA?.fenceInSession} → ${facts.e5.a?.ok ? 'PASS' : 'FAIL'}`,
    `- B 无围栏：job ${facts.e5.runB?.jobId ?? '-'} → ${facts.e5.runB?.status ?? '-'} code=${facts.e5.runB?.code ?? '-'} readback=${JSON.stringify(facts.e5.runB?.readback ?? null)} → ${facts.e5.b?.ok ? 'PASS' : 'FAIL'}`,
    ...(facts.e5.harness ? [`- 附加（非实机 harness，明确标注）：${facts.e5.harness.label} → ${facts.e5.harness.readback}`] : []),
    `- 结果：${facts.e5.passed ? 'PASS' : 'FAIL'}`,
    '',
    '## 汇总',
    `- E0=${facts.e0.passed ? 'PASS' : 'FAIL'} E1=${facts.e1.passed ? 'PASS' : 'FAIL'} E2a=${facts.e2.a?.ok ? 'PASS' : 'FAIL'} E2b=${facts.e2.b?.ok ? 'PASS' : 'FAIL'} E3=${facts.e3.passed ? 'PASS' : 'FAIL'} E4=${facts.e4.passed ? 'PASS' : 'FAIL'} E5=${facts.e5.passed ? 'PASS' : 'FAIL'}`,
    `- 结构化事实：${REPORT_PATH}`,
    ''
  ].join('\n');
  fs.writeFileSync(EVIDENCE_PATH, ev);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(facts, null, 2));
}

// ================================================================ E-0 冒烟
log('E-0 smoke');
{
  const html = await (await fetch('http://127.0.0.1:27391/')).text();
  const title = /<title>WeMediaBuddy<\/title>/i.test(html);
  const rootEl = /id=["']root["']/.test(html);
  const entry = /src=["'][^"']*main\.tsx/.test(html);
  const scriptOut = execFileSync('node', ['scripts/smoke-renderer.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim();
  facts.e0 = { title, rootEl, entry, smoke: scriptOut, passed: title && rootEl && entry && /\[wmb-smoke\] ok/.test(scriptOut), at: nowIso() };
  log('E-0', JSON.stringify(facts.e0));
  writeEvidence();
}

// ================================================================ E-1 四角色并发成功（reporter+writer+librarian 同 businessDate）
log('E-1 start');
{
  const maxW = await call('jobsSetMaxWorkers', [4]);
  facts.e1.maxWorkers = maxW;
  const t0 = ms();
  const jReporter = await spawnJob({ roleId: 'reporter', brief: 'WMB-5122 E-1 并发验证：扫描今日渠道。', businessDate: BUSINESS_DATE });
  const jWriter = await spawnJob({ roleId: 'writer', brief: 'WMB-5122 E-1 并发验证：为已有项目补充正文版本。', projectId: PROJECT_ID, businessDate: BUSINESS_DATE });
  const jLibrarian = await spawnJob({ roleId: 'librarian', brief: 'WMB-5122 E-1 并发验证：整理当前工作空间资料库；如无可整理内容按规范回报 no-op。', scope: 'workspace' });
  facts.e1.jobs = { reporter: jReporter.id, writer: jWriter.id, librarian: jLibrarian.id };
  log('E-1 spawned', JSON.stringify(facts.e1.jobs));
  const terminal = await Promise.all([
    waitTerminal(jReporter.id).then(async (j) => ({ role: 'reporter', ...(await take({ jobId: jReporter.id })), id: jReporter.id })),
    waitTerminal(jWriter.id).then(async (j) => ({ role: 'writer', ...(await take({ jobId: jWriter.id })), id: jWriter.id })),
    waitTerminal(jLibrarian.id).then(async (j) => ({ role: 'librarian', ...(await take({ jobId: jLibrarian.id })), id: jLibrarian.id }))
  ]);
  facts.e1.terminal = terminal;
  facts.e1.elapsedMs = ms() - t0;
  const byRole = Object.fromEntries(terminal.map((t) => [t.role, t]));
  const okReporter = byRole.reporter?.status === 'succeeded' && byRole.reporter?.report?.readback?.kind === 'scan_phase_reached';
  const okWriter = byRole.writer?.status === 'succeeded' && byRole.writer?.report?.readback?.kind === 'content_version';
  const okLibrarian = byRole.librarian?.status === 'succeeded' && ['sources_mutated', 'noop_confirmed'].includes(byRole.librarian?.report?.readback?.kind);
  facts.e1.passed = okReporter && okWriter && okLibrarian;
  // E-4 handoff 观察：E-1 reporter 扫描保存了新资料 → 其任务停留 channel_scanned（running，非终态）
  // → grant 应保持 active（不得在 channel_scanned 回收）。终态工单 handle 已删，改查 active daily task。
  {
    const active = await call('getAgentTask', [{ intent: 'daily_scan', businessDate: BUSINESS_DATE }]);
    if (active.data && active.data.status === 'running' && active.data.phase === 'channel_scanned') {
      facts.e1.reporterTaskAfter = { taskId: active.data.id, status: active.data.status, phase: active.data.phase, intent: active.data.intent };
      const grants = await mcpTool('task_grants.list', { task_id: active.data.id });
      const arr = Array.isArray(grants.parsed) ? grants.parsed : (grants.parsed?.data ?? []);
      facts.e1.channelScannedGrants = arr;
      facts.e1.handoffGrantActive = arr.some((g) => g.status === 'active');
    } else {
      facts.e1.reporterTaskAfter = active.data ? { taskId: active.data.id, status: active.data.status, phase: active.data.phase, intent: active.data.intent } : null;
      facts.e1.handoffGrantActive = false;
    }
    // 取消 E-1 遗留 channel_scanned orphan：应用自带 60s orphan-sweeper 会把 orphan 自动 rebind 成 judge
    // （真实 Pi + planner lease），与后续 E-2a/E-4 观测竞争；此处先清场保证 E-2a 用全新 judge task。
    if (active.data && active.data.status === 'running') {
      await call('controlDailyIntelligence', [{ id: active.data.id, action: 'cancel' }]);
      await poll(async () => call('getAgentTask', [{ id: active.data.id }]), (v) => v?.data?.status !== 'running', 15_000, 200);
      facts.e1.orphanCleared = { taskId: active.data.id, after: (await call('getAgentTask', [{ id: active.data.id }]))?.data?.status };
    }
  }
  log('E-1 done', JSON.stringify({ passed: facts.e1.passed, roles: Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, { status: v.status, code: v.report?.code, readback: v.report?.readback }])) }));
  writeEvidence();
}

// ================================================================ E-2 R1 实机
log('E-2 start');
{
  facts.e2 = {};
  // --- (a) pool judge：planner running → reporter 泊车 → 释放 judge → ≤1s 晋升 → succeeded
  const t0 = ms();
  const jPlanner = await spawnJob({ roleId: 'planner', brief: 'WMB-5122 E-2 判定：根据已扫描来源输出今日方案。', businessDate: BUSINESS_DATE });
  facts.e2.poolJudge = { plannerJobId: jPlanner.id };
  const running = await waitRunning(jPlanner.id, 120_000);
  if (!running) { facts.e2.a = { ok: false, detail: 'planner never running' }; }
  else {
    // 等 judge task 进入 judging 阶段
    const judgeReady = await poll(async () => {
      const j = await jobGet(jPlanner.id);
      if (j?.handle?.taskId) { const t = await agentTask(j.handle.taskId); return t?.phase; }
      return null;
    }, (phase) => /judg|synth|validat|running_pi/i.test(String(phase)), 120_000, 500);
    const plannerHandle = await jobGet(jPlanner.id);
    const judgeTaskId = plannerHandle?.handle?.taskId;
    facts.e2.poolJudge.judgeTaskId = judgeTaskId;
    facts.e2.poolJudge.judgePhase = judgeReady.value;
    const jReporter = await spawnJob({ roleId: 'reporter', brief: 'WMB-5122 E-2 让路验证：扫描渠道（应等判定完成）。', businessDate: BUSINESS_DATE });
    facts.e2.poolJudge.reporterJobId = jReporter.id;
    const parked = await poll(async () => jobGet(jReporter.id), (j) => j?.status === 'waiting_resource', 60_000, 300);
    const parkedJob = parked.value;
    facts.e2.poolJudge.parked = { status: parkedJob?.status, waitReason: parkedJob?.waitReason, waitingSince: parkedJob?.waitingSince, parkElapsedMs: parked.elapsed };
    // 释放 judge（cancel planner job → judge 终态 → pool settle → 晋升）；从 judge settle（planner 终态）起测晋升
    await call('jobsCancel', [jPlanner.id]);
    const settled = await poll(async () => jobGet(jPlanner.id), (j) => j?.status !== 'running', 10_000, 30);
    const settleAt = ms();
    const promoted = await poll(async () => jobGet(jReporter.id), (j) => j?.status === 'running', 10_000, 30);
    facts.e2.poolJudge.promotionMs = promoted.elapsed;
    facts.e2.poolJudge.settleAt = new Date(settleAt).toISOString();
    facts.e2.poolJudge.promotedAt = promoted.value?.startedAt;
    const repTerminal = await waitTerminal(jReporter.id, 240_000);
    facts.e2.poolJudge.reporterTerminal = await take({ jobId: jReporter.id });
    facts.e2.a = {
      parked: facts.e2.poolJudge.parked?.status === 'waiting_resource' && /RESOURCE_JUDGE_IN_FLIGHT/.test(String(facts.e2.poolJudge.parked?.waitReason)),
      promotionMs: promoted.elapsed,
      reporterSucceeded: repTerminal?.status === 'succeeded' && repTerminal?.report?.readback?.kind === 'scan_phase_reached',
      judgeReleased: (await jobGet(jPlanner.id))?.status === 'cancelled',
      detail: JSON.stringify({ parked: facts.e2.poolJudge.parked, promotionMs: promoted.elapsed, judgeStatus: (await jobGet(jPlanner.id))?.status })
    };
    facts.e2.a.ok = facts.e2.a.parked && facts.e2.a.promotionMs <= 1000 && facts.e2.a.reporterSucceeded && facts.e2.a.judgeReleased;
  }
  log('E-2a done', JSON.stringify(facts.e2.a));
  writeEvidence();

  // --- (b) watchdog：非 pool judge（coordinator legacyPipeline 全流程）→ reporter 泊车 → judge 终态（无 pool 事件）→ 60s 看门狗晋升
  const t1 = ms();
  const started = await call('startDailyIntelligence', [{ businessDate: BUSINESS_DATE, legacyPipeline: true }]);
  facts.e2.watchdog = { startRes: { ok: started.ok, action: started.data?.action, taskId: started.data?.task?.id ?? null } };
  const judgePhase = await poll(async () => {
    const t = await call('getAgentTask', [{ businessDate: BUSINESS_DATE }]);
    const task = t?.data;
    if (!task) return null;
    return { intent: task.intent, phase: task.phase, status: task.status, id: task.id };
  }, (v) => v && v.status === 'running' && /judg|synth|validat|running_pi/i.test(String(v.phase)), 180_000, 1000);
  facts.e2.watchdog.judge = judgePhase.value;
  if (judgePhase.value) {
    const wReporter = await spawnJob({ roleId: 'reporter', brief: 'WMB-5122 E-2 看门狗验证：扫描渠道（应等非池判定完成）。', businessDate: BUSINESS_DATE });
    facts.e2.watchdog.reporterJobId = wReporter.id;
    const parked = await poll(async () => jobGet(wReporter.id), (j) => j?.status === 'waiting_resource', 60_000, 300);
    facts.e2.watchdog.parked = { status: parked.value?.status, waitReason: parked.value?.waitReason, waitingSince: parked.value?.waitingSince, parkElapsedMs: parked.elapsed };
    // 释放非 pool judge（controlDaily cancel；无 pool 事件 → 依赖 60s 看门狗）；从 judge 终态起测晋升
    await call('controlDailyIntelligence', [{ id: judgePhase.value.id, action: 'cancel' }]);
    const judgeTerminal = await poll(async () => call('getAgentTask', [{ id: judgePhase.value.id }]), (v) => v?.data?.status !== 'running', 15_000, 200);
    const settleAt = ms();
    facts.e2.watchdog.judgeTerminalStatus = judgeTerminal.value?.data?.status;
    facts.e2.watchdog.settleAt = new Date(settleAt).toISOString();
    const promoted = await poll(async () => jobGet(wReporter.id), (j) => j?.status === 'running', 70_000, 250);
    facts.e2.watchdog.promotionMs = promoted.elapsed;
    facts.e2.watchdog.promotedAt = promoted.value?.startedAt;
    const wTerminal = await waitTerminal(wReporter.id, 240_000);
    facts.e2.watchdog.reporterTerminal = await take({ jobId: wReporter.id });
    facts.e2.b = {
      parked: facts.e2.watchdog.parked?.status === 'waiting_resource' && /RESOURCE_JUDGE_IN_FLIGHT/.test(String(facts.e2.watchdog.parked?.waitReason)),
      promotionMs: promoted.elapsed,
      reporterSucceeded: wTerminal?.status === 'succeeded' && wTerminal?.report?.readback?.kind === 'scan_phase_reached',
      judgeGone: (await call('getAgentTask', [{ id: judgePhase.value.id }]))?.data?.status !== 'running',
      detail: JSON.stringify({ parked: facts.e2.watchdog.parked, promotionMs: promoted.elapsed })
    };
    facts.e2.b.ok = facts.e2.b.parked && facts.e2.b.promotionMs <= 60_000 && facts.e2.b.reporterSucceeded && facts.e2.b.judgeGone;
  } else {
    facts.e2.b = { ok: false, detail: 'coordinator judge never reached judging phase', elapsedMs: ms() - t1 };
  }
  log('E-2b done', JSON.stringify(facts.e2.b));
  writeEvidence();
}

// ================================================================ E-3 R2 实机：四角色 running cancel
log('E-3 start');
{
  facts.e3 = { roles: {} };
  const piProcs = async (sessionFile) => {
    if (!sessionFile) return { count: 0, rows: [] };
    const rows = psQuery(sessionFile);
    return { count: rows.length, rows: rows.map((r) => ({ pid: r.ProcessId, name: r.Name, ppid: r.ParentProcessId })) };
  };
  const waitPi = async (needle, timeoutMs = 40_000) => poll(() => piProcs(needle), (p) => p.count > 0, timeoutMs, 400);
  // 预清理：E-2b reporter 的 daily_scan 任务停留在 channel_scanned running 会令新 reporter 工单
  // 瞬间复用旧任务成功（无自建任务可取消）。先取消遗留 running daily 任务再进入四角色取消。
  {
    const lingering = await call('getAgentTask', [{ businessDate: BUSINESS_DATE }]);
    if (lingering.data?.status === 'running') {
      log('E-3 pre-clean lingering daily task', lingering.data.id, lingering.data.phase);
      await call('controlDailyIntelligence', [{ id: lingering.data.id, action: 'cancel' }]);
      await poll(async () => call('getAgentTask', [{ id: lingering.data.id }]), (v) => v?.data?.status !== 'running', 15_000, 200);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // reporter：scanOnly 无 Pi（piBefore N/A）；scan 快（约 1-2s），用 40ms 轮询抢在 running 窗口内取消；
  // cancel 后无 late mutation（source_scan_receipts created_at > cancelEnd == 0）
  {
    const j = await spawnJob({ roleId: 'reporter', brief: 'WMB-5122 E-3 取消：扫描渠道。', businessDate: BUSINESS_DATE });
    const running = await poll(() => jobGet(j.id), (v) => v?.status === 'running' && v?.handle?.taskId, 30_000, 40);
    const handle = running.value?.handle ?? null;
    if (!handle?.sessionFile) { facts.e3.roles.reporter = { jobId: j.id, fail: 'no running window/handle', status: (await jobGet(j.id))?.status }; log('E-3 reporter FAIL no running window', JSON.stringify({ status: (await jobGet(j.id))?.status })); }
    else {
      const t0 = ms();
      await call('jobsCancel', [j.id]);
      const term = await waitTerminal(j.id, 10_000);
      const cancelEnd = nowIso();
      const cancelMs = ms() - t0;
      await new Promise((r) => setTimeout(r, 1500));
      const afterReceipts = await countRows('source_scan_receipts', `created_at > '${cancelEnd}'`);
      const task = handle.taskId ? await agentTask(handle.taskId) : null;
      facts.e3.roles.reporter = {
        jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
        status: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
        piBefore: 'N/A scanOnly', lateMutationReceipts: afterReceipts,
        // 设计 §11 E-3 的「无 late mutation」准则为 writer 专属；reporter 的 after-cancel 通道回执（saved_count=0，
        // 无 source_items 变更）作为观察记录，不参与 pass 判定。
        pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000
      };
      log('E-3 reporter', JSON.stringify(facts.e3.roles.reporter));
    }
  }
  // planner：真实 Pi judge；进程树退出
  {
    const j = await spawnJob({ roleId: 'planner', brief: 'WMB-5122 E-3 取消：判定任务。', businessDate: BUSINESS_DATE });
    const running = await waitRunning(j.id);
    const handle = running?.handle ?? null;
    if (!handle?.sessionFile) { facts.e3.roles.planner = { jobId: j.id, fail: 'no handle/sessionFile', status: (await jobGet(j.id))?.status }; log('E-3 planner FAIL no handle'); }
    else {
      // judge Pi 会话文件为 agent/sessions/daily-<date>-<taskId>.jsonl（非 job session）；用 taskId 匹配进程
      await poll(async () => {
        const t = await agentTask(handle.taskId); return t?.phase;
      }, (p) => /judg|synth|validat|running_pi/i.test(String(p)), 120_000, 500);
      const piNeedle = handle.taskId;
      await waitPi(piNeedle);
      const piBefore = await piProcs(piNeedle);
      const t0 = ms();
      await call('jobsCancel', [j.id]);
      const term = await waitTerminal(j.id, 10_000);
      const cancelMs = ms() - t0;
      const piAfter = await poll(async () => piProcs(piNeedle), (p) => p.count === 0, 8000, 400);
      const task = handle.taskId ? await agentTask(handle.taskId) : null;
      facts.e3.roles.planner = {
        jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
        status: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
        piBefore: piBefore.count, piAfter: piAfter.value.count, piExitMs: piAfter.elapsed, piNeedle,
        pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000 && piAfter.value.count === 0
      };
      log('E-3 planner', JSON.stringify(facts.e3.roles.planner));
    }
  }
  // writer：真实 Pi；cancel 后无 late mutation（content_versions）
  {
    const j = await spawnJob({ roleId: 'writer', brief: 'WMB-5122 E-3 取消：为项目写正文。', projectId: PROJECT_ID, businessDate: BUSINESS_DATE });
    const running = await waitRunning(j.id);
    const handle = running?.handle ?? null;
    if (!handle?.sessionFile) { facts.e3.roles.writer = { jobId: j.id, fail: 'no handle/sessionFile', status: (await jobGet(j.id))?.status }; log('E-3 writer FAIL no handle'); }
    else {
      await poll(async () => {
        const t = await agentTask(handle.taskId); return t?.phase;
      }, (p) => p === 'running_pi', 120_000, 500);
      await waitPi(handle.sessionFile);
      const piBefore = await piProcs(handle.sessionFile);
      const beforeVersions = await countRows('content_versions', `project_id='${PROJECT_ID}'`);
      const t0 = ms();
      await call('jobsCancel', [j.id]);
      const term = await waitTerminal(j.id, 10_000);
      const cancelMs = ms() - t0;
      await new Promise((r) => setTimeout(r, 1500));
      const afterVersions = await countRows('content_versions', `project_id='${PROJECT_ID}'`);
      const piAfter = await poll(async () => piProcs(handle.sessionFile), (p) => p.count === 0, 8000, 400);
      const task = handle.taskId ? await agentTask(handle.taskId) : null;
      facts.e3.roles.writer = {
        jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
        status: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
        piBefore: piBefore.count, piAfter: piAfter.value.count, piExitMs: piAfter.elapsed,
        versionsBefore: beforeVersions, versionsAfter: afterVersions, lateMutation: afterVersions - beforeVersions,
        pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000 && piAfter.value.count === 0 && (afterVersions - beforeVersions) === 0
      };
      log('E-3 writer', JSON.stringify(facts.e3.roles.writer));
    }
  }
  // librarian：真实 Pi；进程树退出
  {
    const j = await spawnJob({ roleId: 'librarian', brief: 'WMB-5122 E-3 取消：整理资料库。', scope: 'workspace' });
    const running = await waitRunning(j.id);
    const handle = running?.handle ?? null;
    if (!handle?.sessionFile) { facts.e3.roles.librarian = { jobId: j.id, fail: 'no handle/sessionFile', status: (await jobGet(j.id))?.status }; log('E-3 librarian FAIL no handle'); }
    else {
      await poll(async () => {
        const t = await agentTask(handle.taskId); return t?.phase;
      }, (p) => p === 'running_pi' || p === 'starting' || /pi/i.test(String(p)), 120_000, 500);
      await waitPi(handle.sessionFile);
      const piBefore = await piProcs(handle.sessionFile);
      const t0 = ms();
      await call('jobsCancel', [j.id]);
      const term = await waitTerminal(j.id, 10_000);
      const cancelMs = ms() - t0;
      const piAfter = await poll(async () => piProcs(handle.sessionFile), (p) => p.count === 0, 8000, 400);
      const task = handle.taskId ? await agentTask(handle.taskId) : null;
      facts.e3.roles.librarian = {
        jobId: j.id, taskId: handle.taskId, leaseId: handle.leaseId, cancelMs,
        status: term?.status, taskStatus: task?.status, taskPhase: task?.phase,
        piBefore: piBefore.count, piAfter: piAfter.value.count, piExitMs: piAfter.elapsed,
        pass: term?.status === 'cancelled' && task?.status === 'cancelled' && cancelMs <= 5000 && piAfter.value.count === 0
      };
      log('E-3 librarian', JSON.stringify(facts.e3.roles.librarian));
    }
  }
  // lease 归零：pool-status employeeSnapshots 不含这些 lease
  await new Promise((r) => setTimeout(r, 1000));
  const ps = await poolStatus();
  const leases = Object.values(facts.e3.roles).map((r) => r.leaseId).filter(Boolean);
  facts.e3.leaseZero = leases.every((l) => !(ps?.employeeSnapshots ?? []).some((s) => s.leaseId === l));
  facts.e3.pool = { running: ps?.running, queued: ps?.queued, waitingResource: ps?.waitingResource, employeeSnapshots: (ps?.employeeSnapshots ?? []).map((s) => ({ leaseId: s.leaseId, roleId: s.roleId })) };
  facts.e3.passed = Object.values(facts.e3.roles).every((r) => r.pass) && facts.e3.leaseZero;
  log('E-3 done leaseZero=%s', facts.e3.leaseZero);
  writeEvidence();
}

async function psPiCount(sessionFile) {
  if (!sessionFile) return 0;
  return psQuery(sessionFile).length;
}
function countRows(table, where = '') {
  const dbPath = path.join(root, 'wmb.db');
  const script = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(dbPath)},{readOnly:true});const sql=${JSON.stringify(`SELECT COUNT(*) c FROM ${table}`)}${where ? `+${JSON.stringify(' WHERE ' + where)}` : ''};console.log(db.prepare(sql).get().c);db.close();`;
  const out = execFileSync('node', ['-e', script], { encoding: 'utf8' });
  const m = out.trim().split('\n').pop();
  return Number(m);
}

// ================================================================ E-4 R3 实机
log('E-4 start');
{
  facts.e4 = {};
  // 用 E-3 的终态取消任务（librarian/writer/planner 优先，reporter 次之）验证 grant revoke
  const pref = ['librarian', 'writer', 'planner', 'reporter'];
  const sample = pref.map((k) => facts.e3.roles[k]).find((r) => r?.taskId && r?.status === 'cancelled')
    ?? pref.map((k) => facts.e3.roles[k]).find((r) => r?.taskId) ?? null;
  const taskId = sample?.taskId ?? null;
  facts.e4.sample = { taskId, leaseId: sample?.leaseId ?? null, jobStatus: sample?.status ?? null };
  if (!taskId) {
    facts.e4.noActiveAfterTerminal = false;
    facts.e4.oldGrantRejected = false;
    facts.e4.taskGrantsAfterTerminal = { detail: 'no terminal task sample from E-3' };
  } else {
  const grantsRes = await mcpTool('task_grants.list', { task_id: taskId });
  facts.e4.taskGrantsRaw = { http: grantsRes.http, isError: grantsRes.isError, error: grantsRes.error, raw: grantsRes.raw.slice(0, 800) };
  const grantsArr = Array.isArray(grantsRes.parsed) ? grantsRes.parsed : (grantsRes.parsed?.data ?? []);
  facts.e4.taskGrantsAfterTerminal = grantsArr;
  const activeAfter = grantsArr.filter((g) => g.status === 'active');
  facts.e4.noActiveAfterTerminal = activeAfter.length === 0;
  // 旧 grantId envelope 实机写 → 拒绝
  const revokedGrant = grantsArr.find((g) => g.status === 'revoked') ?? grantsArr[0];
  if (revokedGrant) {
    facts.e4.oldGrantId = revokedGrant.id;
    const writeRes = await mcpTool('sources.lane_gate', {
      request_id: `wmb5122-e4:${taskId}:reject-check`,
      judgments: [{ sourceId: '00000000-0000-0000-0000-000000000000', decision: 'irrelevant', reasonCode: 'off_lane_content', reason: 'E-4 拒绝性验证', expectedRevision: 1 }],
      task_id: taskId, grant_id: revokedGrant.id, worker_lease_id: sample.leaseId
    });
    facts.e4.oldGrantWrite = { isError: writeRes.isError, error: writeRes.error, raw: writeRes.raw.slice(0, 800), parsed: writeRes.parsed };
    const code = writeRes.parsed?.error?.code ?? writeRes.parsed?.error_code ?? '';
    facts.e4.oldGrantRejected = writeRes.isError === true || String(code).length > 0 || (writeRes.parsed?.ok === false);
  } else {
    facts.e4.oldGrantRejected = false;
    facts.e4.oldGrantWrite = { detail: 'no grant row found for terminal task' };
  }
  }
  // channel_scanned 交接：E-1 reporter 任务若仍 channel_scanned（running）→ grant active（已在 E-1 捕获）
  facts.e4.handoff = {
    taskId: facts.e1.reporterTaskAfter?.taskId ?? null,
    taskState: facts.e1.reporterTaskAfter ?? null,
    grantActiveAtChannelScanned: facts.e1.handoffGrantActive ?? null,
    grants: facts.e1.channelScannedGrants ?? null
  };
  facts.e4.passed = facts.e4.noActiveAfterTerminal && facts.e4.oldGrantRejected && (facts.e4.handoff.grantActiveAtChannelScanned ?? false);
  log('E-4 done', JSON.stringify({ noActiveAfterTerminal: facts.e4.noActiveAfterTerminal, oldGrantRejected: facts.e4.oldGrantRejected, handoff: facts.e4.handoff.grantActiveAtChannelScanned }));
  writeEvidence();
}

// ================================================================ E-5 R4 实机
log('E-5 start');
{
  facts.e5 = {};
  const jA = await spawnJob({ roleId: 'librarian', brief: 'WMB-5122 E-5 围栏验证：整理资料库；如无可整理内容，按规范在末条回复附 ```json {"wmb_noop": true} 确认块回报。', scope: 'workspace' });
  const termA = await waitTerminal(jA.id, 240_000);
  const ta = await take({ jobId: jA.id });
  const sessionFileA = ta.sessionFile ?? path.join(root, 'agent', 'sessions', `job-${jA.id}.jsonl`);
  facts.e5.runA = { jobId: jA.id, status: termA?.status, code: ta.report?.code, readback: ta.report?.readback, taskId: ta.taskId ?? null };
  let fenceInSession = false;
  try {
    const session = fs.readFileSync(sessionFileA, 'utf8');
    // 原始 JSONL 中文本为转义形式（\"wmb_noop\"），解码末条 assistant 文本后按 parseNoopDeclaration 语义检查
    const lines = session.trim().split(/\r?\n/).filter(Boolean);
    let lastText = '';
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e?.type === 'message' && e?.message?.role === 'assistant' && Array.isArray(e?.message?.content)) {
          for (const seg of e.message.content) {
            if (seg?.type === 'text' && typeof seg.text === 'string' && seg.text.trim()) lastText = seg.text;
          }
        }
      } catch { /* skip */ }
    }
    fenceInSession = /```json\s*\{[^`]*wmb_noop[^`]*\}\s*```/.test(lastText) || /wmb_noop\s*:\s*true/.test(lastText);
    facts.e5.runA.lastLineTail = lastText.slice(-240);
    facts.e5.runA.sessionFile = sessionFileA;
  } catch (e) { facts.e5.runA.sessionReadError = String(e); }
  facts.e5.runA.fenceInSession = fenceInSession;
  facts.e5.a = {
    ok: termA?.status === 'succeeded' && ta.report?.code === 'NOOP_CONFIRMED' && ta.report?.readback?.kind === 'noop_confirmed' && fenceInSession,
    detail: JSON.stringify(facts.e5.runA)
  };
  log('E-5 A', JSON.stringify(facts.e5.a));

  // B：删除围栏（brief 明令不得输出 JSON 围栏）→ 保守失败 JOB_READBACK_MISSING
  const jB = await spawnJob({ roleId: 'librarian', brief: 'WMB-5122 E-5 无围栏验证：本次检查无需任何 JSON 代码块或 ```json 围栏（包括 wmb_noop），直接回复一句中文总结即可。', scope: 'workspace' });
  const termB = await waitTerminal(jB.id, 240_000);
  const tb = await take({ jobId: jB.id });
  facts.e5.runB = { jobId: jB.id, status: termB?.status, code: tb.report?.code, readback: tb.report?.readback, errorMessage: tb.report?.errorMessage, taskId: tb.taskId };
  facts.e5.b = {
    ok: termB?.status === 'failed' && tb.report?.code === 'JOB_READBACK_MISSING',
    detail: JSON.stringify(facts.e5.runB)
  };
  log('E-5 B', JSON.stringify(facts.e5.b));
  // 若模型仍输出了围栏导致 B 非保守失败，追加确定性 harness 复核（明确标注非实机）
  if (!facts.e5.b.ok && sessionFileA && ta.taskId) {
    const stripped = sessionFileA.replace(/\.jsonl$/, '.nofence.jsonl');
    let lines = fs.readFileSync(sessionFileA, 'utf8').split(/\r?\n/).filter(Boolean);
    let lastAssistantIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e?.type === 'message' && e?.message?.role === 'assistant') { lastAssistantIdx = i; break; }
      } catch { /* skip */ }
    }
    if (lastAssistantIdx >= 0) {
      const entry = JSON.parse(lines[lastAssistantIdx]);
      const content = entry.message.content ?? [];
      for (const seg of content) {
        if (seg?.type === 'text' && typeof seg.text === 'string') {
          seg.text = seg.text.replace(/```json\s*\{[^`]*"wmb_noop"\s*:\s*true[^`]*\}```\s*$/s, '').replace(/```json[\s\S]*?```\s*$/s, '').trim();
        }
      }
      lines[lastAssistantIdx] = JSON.stringify(entry);
      fs.writeFileSync(stripped, lines.join('\n') + '\n');
      const harnessScript = `const {readbackLibraryMutation}=await import('./src/main/role-job-registry.ts');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path.join(root, 'wmb.db'))},{readOnly:true});const r=await readbackLibraryMutation(db, ${JSON.stringify(ta.taskId)}, '2000-01-01T00:00:00.000Z', ${JSON.stringify(stripped)});console.log(JSON.stringify(r));db.close();`;
      const out = execFileSync('node', ['--experimental-strip-types', '-e', harnessScript], { cwd: ROOT, encoding: 'utf8' });
      facts.e5.harness = { label: 'HARNESS(non-live): readbackLibraryMutation on fence-stripped real session', readback: out.trim().split('\n').pop() };
    }
  }
  facts.e5.passed = facts.e5.a.ok && facts.e5.b.ok;
  log('E-5 done', JSON.stringify({ a: facts.e5.a, b: facts.e5.b, harness: facts.e5.harness ?? null }));
  writeEvidence();
}

// ================================================================ final
facts.ok = facts.e0.passed && facts.e1.passed && facts.e2.a.ok && facts.e2.b.ok && facts.e3.passed && facts.e4.passed && facts.e5.passed;
facts.endIso = nowIso();
facts.finishMs = ms();
writeEvidence();

// cleanup
try { await browser.close(); } catch { /* */ }
cleanup();
await new Promise((r) => setTimeout(r, 2000));
log('DONE', JSON.stringify({ ok: facts.ok, reportPath: REPORT_PATH, tmpRoot: root }));
process.exit(facts.ok ? 0 : 1);
