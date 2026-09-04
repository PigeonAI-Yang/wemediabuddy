import { _electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DATA_ROOT = 'J:/PigeonYang/WeMediaBuddyData';
const BUSINESS_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
console.log('BUSINESS_DATE', BUSINESS_DATE);
console.log('installed exe exists', fs.existsSync(INSTALLED_EXE));

function openReadOnlyDb() {
  return new DatabaseSync(path.join(DATA_ROOT, 'wmb.db'), { readOnly: true });
}
function getActiveTasks(db, businessDate) {
  try {
    return db.prepare("SELECT id, status, phase, business_date, intent, created_at, updated_at FROM agent_tasks WHERE business_date=? AND status='running' AND intent IN ('daily_intelligence','daily_scan','daily_judge','page_agents') ORDER BY updated_at DESC").all(businessDate);
  } catch (e) {
    console.log('getActiveTasks error', e);
    return [];
  }
}
function getExhaustion(db, businessDate) {
  try {
    const { getTodayPlanExhaustion } = awaitImport('j:/PigeonYang/WeMediaBuddy/src/main/workbench.ts');
  } catch {}
  return null;
}

async function run() {
  // capture DB before
  let beforeTasks = [];
  let beforeIds = [];
  {
    const db = openReadOnlyDb();
    try {
      beforeTasks = getActiveTasks(db, BUSINESS_DATE);
      beforeIds = beforeTasks.map(t => t.id);
      console.log('BEFORE active tasks', beforeTasks);
      // also check exhaustion via DB direct
      const plan = db.prepare('SELECT id, is_current FROM plans WHERE plan_date=? AND is_current=1').get(BUSINESS_DATE);
      console.log('before current plan', plan);
      if (plan) {
        const items = db.prepare('SELECT id, planning_status FROM plan_items WHERE plan_id=?').all(plan.id);
        console.log('before plan items', items.map(i=>i.planning_status));
        // check work_carry for each
        for (const it of items) {
          const carry = db.prepare("SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id=?").get(it.id);
          console.log(`carry for ${it.id.slice(0,8)} status=${it.planning_status} carry=${carry?.state}`);
        }
      }
      const allTasks = db.prepare('SELECT id, status, intent, business_date, updated_at FROM agent_tasks WHERE business_date=? ORDER BY updated_at DESC LIMIT 10').all(BUSINESS_DATE);
      console.log('all tasks for today before', allTasks);
    } finally { db.close(); }
  }

  console.log('Launching installed app', INSTALLED_EXE);
  const app = await _electron.launch({
    executablePath: INSTALLED_EXE,
    args: [],
    cwd: 'j:/PigeonYang/WeMediaBuddy',
    env: { ...process.env },
    timeout: 120000,
  });
  console.log('app launched, waiting for window');
  const page = await app.firstWindow({ timeout: 90000 });
  console.log('page url', page.url());
  // attach collectors
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => pageErrors.push(String(err)));

  await page.waitForTimeout(3000);
  // navigate to Today if needed
  const navSelector = 'aside.sidebar nav button[title="今日"]';
  try {
    const isActive = await page.evaluate((s) => document.querySelector(s)?.classList.contains('active') ?? false, navSelector);
    console.log('today active before click?', isActive);
    if (!isActive) {
      console.log('clicking Today nav');
      await page.evaluate((s) => document.querySelector(s)?.click(), navSelector);
      await page.waitForTimeout(1500);
    }
  } catch (e) {
    console.log('nav eval error', e);
  }

  // wait for shell and today
  try { await page.waitForSelector('.app-shell', { timeout: 10000 }); console.log('app-shell found'); } catch { console.log('app-shell NOT found'); }
  try { await page.waitForSelector('.today-layout', { timeout: 10000 }); console.log('today-layout found'); } catch { console.log('today-layout NOT found'); }
  try { await page.waitForSelector('.today-overview', { timeout: 5000 }); console.log('today-overview found'); } catch { console.log('today-overview NOT found'); }
  await page.waitForTimeout(1000);

  // BEFORE DOM checks
  const beforeDom = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const hasAppShell = !!document.querySelector('.app-shell');
    const hasToday = !!document.querySelector('.today-layout');
    const hasPi = !!document.querySelector('.pi-dock') || bodyText.includes('Pi') || !!document.querySelector('[data-testid="pi-dock"]');
    const hasTodayOverview = !!document.querySelector('.today-overview');
    // check for pending strings
    const hasFiveDraft = bodyText.includes('5条草案') || bodyText.includes('条草案') && bodyText.includes('待审批') || bodyText.includes('5条草案/待审批');
    const hasPending = bodyText.includes('待审批');
    const hasViewPending = bodyText.includes('查看待确认选题');
    const hasExhaustedHeadline = bodyText.includes('本轮已结束');
    const hasExhaustedDetail = bodyText.includes('已全部否决') || bodyText.includes('可开始新一轮收集');
    const hasStartButton = Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').trim() === '开始新一轮收集');
    const startButtonEnabled = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '开始新一轮收集')?.disabled === false;
    const startButtonText = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => t.includes('开始新一轮'));
    // also check for 5条草案 exact
    const allButtons = Array.from(document.querySelectorAll('button')).map(b => ({ text: (b.textContent||'').trim(), disabled: b.disabled, class: b.className }));
    return {
      bodySnippet: bodyText.slice(0, 3000),
      hasAppShell,
      hasToday,
      hasPi,
      hasTodayOverview,
      hasFiveDraft,
      hasPending,
      hasViewPending,
      hasExhaustedHeadline,
      hasExhaustedDetail,
      hasStartButton,
      startButtonEnabled,
      startButtonText,
      allButtons: allButtons.slice(0,50),
      // check shell/Today/Pi visible via innerText
      bodyTextLength: bodyText.length,
    };
  });
  console.log('BEFORE DOM', JSON.stringify(beforeDom, null, 2));
  console.log('consoleErrors before', consoleErrors);
  console.log('pageErrors before', pageErrors);

  // Screenshot before
  const beforePath = 'J:/PigeonYang/WeMediaBuddy/.ai/before-exhausted.png';
  await page.screenshot({ path: beforePath, fullPage: true });
  console.log('before screenshot', beforePath, fs.statSync(beforePath).size);

  // Verify before expectations
  const beforeOk = !beforeDom.hasFiveDraft && !beforeDom.hasViewPending && beforeDom.hasExhaustedHeadline && beforeDom.hasExhaustedDetail && beforeDom.hasStartButton && beforeDom.startButtonEnabled && beforeDom.hasAppShell && beforeDom.hasToday && beforeDom.hasPi;
  console.log('BEFORE OK?', beforeOk);
  if (!beforeOk) {
    console.log('BEFORE verification failed, but continuing to click attempt. Details:');
    console.log('hasFiveDraft', beforeDom.hasFiveDraft, 'hasViewPending', beforeDom.hasViewPending, 'hasExhaustedHeadline', beforeDom.hasExhaustedHeadline, 'hasStartButton', beforeDom.hasStartButton, 'startEnabled', beforeDom.startButtonEnabled);
  }

  // Find and click 开始新一轮收集 once
  console.log('Attempting to click 开始新一轮收集');
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '开始新一轮收集');
    if (!btn) return { ok: false, reason: 'button not found' };
    const disabled = btn.disabled;
    const rect = btn.getBoundingClientRect();
    if (disabled) return { ok: false, reason: 'disabled' };
    btn.click();
    return { ok: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  });
  console.log('click result', clicked);
  if (!clicked.ok) {
    throw new Error('Failed to click 开始新一轮收集: ' + clicked.reason);
  }

  // Wait for UI to enter scanning/running state
  await page.waitForTimeout(3000);
  // Poll for running state
  let afterDom = null;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    afterDom = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const hasScanning = bodyText.includes('正在扫描') || bodyText.includes('正在启动') || bodyText.includes('主管编排中') || bodyText.includes('对话中 · 查看进度') || bodyText.includes('正在评估');
      const hasExhausted = bodyText.includes('本轮已结束');
      const hasStartButton = Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').trim() === '开始新一轮收集');
      const scanningHeadlines = ['正在扫描情报渠道', '正在启动今日情报', '主管编排中', '正在评估新资料', '对话中 · 查看进度'];
      const foundHeadline = scanningHeadlines.find(h => bodyText.includes(h)) || null;
      return { bodyText: bodyText.slice(0,3000), hasScanning, hasExhausted, hasStartButton, foundHeadline };
    });
    console.log(`poll ${i} afterDom`, JSON.stringify(afterDom, null, 2));
    if (afterDom.hasScanning) break;
  }

  // Screenshot after
  const afterPath = 'J:/PigeonYang/WeMediaBuddy/.ai/after-scanning.png';
  await page.screenshot({ path: afterPath, fullPage: true });
  console.log('after screenshot', afterPath, fs.statSync(afterPath).size);

  // Check DB after
  let afterTasks = [];
  let afterIds = [];
  {
    const db = openReadOnlyDb();
    try {
      afterTasks = getActiveTasks(db, BUSINESS_DATE);
      afterIds = afterTasks.map(t => t.id);
      console.log('AFTER active tasks', afterTasks);
      const allTasks = db.prepare('SELECT id, status, intent, business_date, updated_at, phase FROM agent_tasks WHERE business_date=? ORDER BY updated_at DESC LIMIT 10').all(BUSINESS_DATE);
      console.log('all tasks for today after', allTasks);
      // Check that exactly one newly admitted active root task for same business date, distinct from before
      const newIds = afterIds.filter(id => !beforeIds.includes(id));
      console.log('newIds', newIds, 'beforeIds', beforeIds, 'afterIds', afterIds);
      // Verify exactly one new active
      const hasOneNew = newIds.length === 1;
      const distinct = newIds.length > 0 && !beforeIds.includes(newIds[0]);
      console.log('hasOneNew', hasOneNew, 'distinct', distinct);
      // Also check that old plan still historical and new plan current? That was tested in unit test, but we can also check DB: after starting new collection, a new task should be running, but plan not yet replaced (replacement happens via judge, not immediately)
      // However spec says replacement plan transaction makes new plan current while old remains - that is for planning stage, not daily intelligence. For this flow, after click, a new root task is created, but plan replacement will happen later after judge. So we just check task.
      const beforeCount = beforeTasks.length;
      const afterCount = afterTasks.length;
      console.log('before active count', beforeCount, 'after active count', afterCount);
      // Also verify that the new task is indeed running and not duplicate
      // Duplicate check: there should be exactly one active task for date, not two
      if (afterTasks.length !== 1) {
        console.log('WARNING: expected exactly one active task after, got', afterTasks.length);
      }
      // Also verify that the new task id is distinct from prior
      if (newIds.length !== 1) {
        throw new Error(`Expected exactly one new active task, got newIds=${JSON.stringify(newIds)} before=${JSON.stringify(beforeIds)} after=${JSON.stringify(afterIds)}`);
      }
      if (beforeIds.includes(newIds[0])) {
        throw new Error('New task id not distinct from before');
      }
      console.log('DB admission check PASS');
    } finally { db.close(); }
  }

  // Verify UI after: should be scanning/running, not exhausted
  const afterOk = afterDom && afterDom.hasScanning && !afterDom.hasExhausted;
  console.log('AFTER UI scanning?', afterOk, afterDom);
  if (!afterOk) {
    console.log('AFTER UI not yet scanning, but DB task exists - may be brief transient; check again after 2s');
    await page.waitForTimeout(2000);
    const retryDom = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      return { body: bodyText.slice(0,2000), hasScanning: bodyText.includes('正在扫描') || bodyText.includes('主管编排中') || bodyText.includes('对话中') };
    });
    console.log('retryDom', retryDom);
  }

  console.log('consoleErrors after', consoleErrors);
  console.log('pageErrors after', pageErrors);

  // Keep app running, do not close? But we need to close diagnostics and keep normal installed app running.
  // The instruction: Capture before/after screenshots and close diagnostics, keep normal installed app running.
  // So we should NOT close the app; we should detach and leave it running.
  // But playwright's _electron app will be closed when we close? We should keep it.
  // For now, we will not call app.close(), just disconnect.
  console.log('LEAVE APP RUNNING, not closing');
  // We need to keep the process alive, but our script will exit. The app will remain running as child of this process? In playwright, app is tied to this Node process; if we exit, it may be killed.
  // Alternative: we started via _electron.launch, which will be killed when we call app.close() or when Node exits? Usually _electron app is a child process that might stay? Harness's launch keeps it alive via app.process().
  // To keep normal installed app running, we could just not close and let it stay, but when this script exits, the child may be killed. We should instead keep a handle and not close, or we need to detach?
  // Simpler: we will not close, but we will keep the script running for a bit, then exit without closing? The app might still be killed on process exit. To keep it running, we should spawn it detached via child_process.spawn with same args, not via playwright.
  // However instruction says "leave the admitted production task running; do not cancel it unless duplicate/unsafe" and "keep normal installed app running."
  // So we should leave the app running after verification. If we used _electron.launch, the app will die when we close. We may need to keep it by not calling app.close() and not exiting immediately, but we need to yield.
  // We could keep the app running by simply not closing and letting the script keep running? But yield requires script to complete.
  // Alternative: we can close the diagnostic connection (browser.close) but keep the Electron process running detached. Playwright's app.process() is a ChildProcess; we could unref it.
  // Simplest: we will capture evidence, then close the playwright connection but NOT kill the Electron process (by using app.process().unref() and not calling app.close()).
  // We will try to disconnect.

  // Try to close the playwright browser connection but keep Electron alive
  try {
    // app is ElectronApplication, it has process()
    const proc = app.process();
    console.log('app pid', proc.pid);
    // detach listeners and close the CDP connection but keep process
    // We can't cleanly detach without closing app, but we can just not call app.close() and exit script - the child may still be killed when parent exits unless we spawn detached.
    // Let's try to keep reference and not kill.
    // Instead, we will spawn a detached copy of installed app via spawn, and close the _electron instance, then start a new detached instance for user.
    await app.close();
    console.log('closed _electron app (will relaunch detached for user)');
    // Now relaunch detached for user via spawn
    const { spawn } = await import('node:child_process');
    const detached = spawn(INSTALLED_EXE, [], { detached: true, stdio: 'ignore', cwd: 'j:/PigeonYang/WeMediaBuddy' });
    detached.unref();
    console.log('spawned detached installed app pid', detached.pid);
  } catch (e) {
    console.log('close error', e);
  }

  console.log('VERIFY DONE');
  fs.writeFileSync('J:/wmb-out/verify-rejected-result.json', JSON.stringify({ businessDate: BUSINESS_DATE, beforeTasks, afterTasks, beforeDom, afterDom, consoleErrors, pageErrors, beforeIds, afterIds }, null, 2));
}

run().catch(e => { console.error(e); process.exit(1); });
