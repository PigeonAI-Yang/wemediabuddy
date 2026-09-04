import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PACKAGED_EXE = 'J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe';
const DATA_ROOT = 'J:/PigeonYang/WeMediaBuddyData';
const BUSINESS_DATE = '2026-08-25';
const DEBUG_PORT = 9337;
const BEFORE_PNG = 'J:/PigeonYang/WeMediaBuddy/.ai/scoring-before.png';
const AFTER_PNG = 'J:/PigeonYang/WeMediaBuddy/.ai/scoring-after.png';

const EXPECTED_PLAN = 'cc34c3b8-33bb-4ed8-b021-1defa9ba9c0a';
const EXPECTED_ITEMS = [
  'cbb016e5-e050-4bcd-bc14-2047ee6271ac',
  '293275c4-6f43-49db-844e-0e75f7c151c4',
  '1274b166-6326-4358-a80d-8b157e1237b4',
  '91fefb18-77cb-49cd-a03b-0be8d93e469a'
];

function openDb() { return new DatabaseSync(path.join(DATA_ROOT, 'wmb.db'), { readOnly: true }); }

function getScoringPending(db, businessDate) {
  const plan = db.prepare('SELECT id FROM plans WHERE plan_date=? AND is_current=1').get(businessDate);
  if (!plan) return { plan: null, items: [], all: [] };
  const all = db.prepare('SELECT id, planning_status, score_reasons_json FROM plan_items WHERE plan_id=?').all(plan.id);
  const items = all.filter(r => {
    try { const s = JSON.parse(r.score_reasons_json||'{}'); return s.status !== 'scored' || !Array.isArray(s.reasons) || s.reasons.length!==6; } catch { return true; }
  });
  return { plan, items, all };
}

console.log('=== SCORING RECOVERY VERIFICATION (PACKAGED) ===');
console.log('BUSINESS_DATE', BUSINESS_DATE);
console.log('EXPECTED_PLAN', EXPECTED_PLAN);

let beforePlan, beforeItems;
{
  const db = openDb();
  const info = getScoringPending(db, BUSINESS_DATE);
  beforePlan = info.plan;
  beforeItems = info.items;
  console.log('DB plan before', beforePlan);
  console.log('DB pending before', beforeItems.map(i=> ({id:i.id.slice(0,8), status:i.planning_status})));
  console.log('DB all before', info.all.map(i=> ({id:i.id.slice(0,8), status:i.planning_status, score: JSON.parse(i.score_reasons_json||'{}').status})));
  db.close();
  if (beforePlan?.id !== EXPECTED_PLAN) throw new Error(`Before plan not cc34, got ${beforePlan?.id}`);
  if (beforeItems.length !== 4) throw new Error(`Before pending count !=4, got ${beforeItems.length}`);
}

let beforeTaskIds = [];
{
  const db = openDb();
  const rows = db.prepare("SELECT id FROM agent_tasks WHERE business_date=?").all(BUSINESS_DATE);
  beforeTaskIds = rows.map(r=>r.id);
  console.log('BEFORE tasks count', beforeTaskIds.length);
  db.close();
}

console.log('Launching packaged app with CDP', DEBUG_PORT);
const child = spawn(PACKAGED_EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { detached: true, stdio: 'ignore', cwd: 'J:/PigeonYang/WeMediaBuddy' });
child.unref();
console.log('spawned', child.pid);
await new Promise(r=> setTimeout(r, 8000));

let browser;
for (let i=0;i<20;i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`); console.log('CDP connected attempt', i); break; } catch(e){ console.log('retry',i); await new Promise(r=>setTimeout(r,1000));}
}
if (!browser) throw new Error('CDP connect failed');

let context = browser.contexts()[0];
let page = context?.pages()?.[0];
for (let i=0;i<15 && !page;i++) { await new Promise(r=>setTimeout(r,1000)); context=browser.contexts()[0]; page=context.pages()[0];}
if (!page) throw new Error('no page');
console.log('page url', page.url());
const consoleErrors=[]; const pageErrors=[];
page.on('console', m=> { if(m.type()==='error') consoleErrors.push(m.text()); });
page.on('pageerror', e=> pageErrors.push(String(e)));
await page.waitForTimeout(3000);

await page.waitForSelector('.app-shell', {timeout:15000}).catch(()=> console.log('no app-shell'));
await page.waitForSelector('.today-layout', {timeout:15000}).catch(()=> console.log('no today-layout'));
await page.waitForTimeout(1000);

const beforeDom = await page.evaluate(() => {
  const bodyText = document.body.innerText || '';
  const bodySnippet = bodyText.slice(0,4000);
  return {
    bodySnippet,
    bodyTextLength: bodyText.length,
    hasScoringIncomplete: bodyText.includes('本轮评分未完成'),
    hasContinueScoring: Array.from(document.querySelectorAll('button')).some(b=> (b.textContent||'').trim()==='继续评分'),
    hasAppShell: !!document.querySelector('.app-shell'),
    hasTodayLayout: !!document.querySelector('.today-layout'),
    buttons: Array.from(document.querySelectorAll('button')).map(b=> (b.textContent||'').trim()).filter(t=>t).slice(0,20)
  };
});
console.log('BEFORE DOM', JSON.stringify(beforeDom,null,2));
console.log('consoleErrors before', consoleErrors);
console.log('pageErrors before', pageErrors);

await page.screenshot({ path: BEFORE_PNG, fullPage: true });
console.log('before screenshot', BEFORE_PNG, fs.statSync(BEFORE_PNG).size);

const beforeOk = beforeDom.hasScoringIncomplete && beforeDom.hasContinueScoring;
console.log('BEFORE scoring_incomplete?', beforeOk);
if (!beforeOk) {
  console.log('BEFORE DOM missing expected scoring incomplete / CTA');
  console.log(beforeDom.bodySnippet.slice(0,2000));
  throw new Error('Before UI does not show 本轮评分未完成 + 继续评分');
}
console.log('=== BEFORE VERIFIED, now triggering continuation ===');

const clickResult = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b=> (b.textContent||'').trim()==='继续评分');
  if (!btn) return { ok:false, reason:'not found' };
  if (btn.disabled) return { ok:false, reason:'disabled' };
  btn.click();
  return { ok:true };
});
console.log('click result', clickResult);
if (!clickResult.ok) throw new Error('Failed to click 继续评分: '+clickResult.reason);

await page.waitForTimeout(3000);

let pollStart = Date.now();
let newTaskId = null;
for (let i=0;i<48;i++) {
  await new Promise(r=> setTimeout(r, 10000));
  const db = openDb();
  const allTasks = db.prepare("SELECT id, intent, status, created_at FROM agent_tasks WHERE business_date=? ORDER BY created_at DESC").all(BUSINESS_DATE);
  const newTasks = allTasks.filter(t=> !beforeTaskIds.includes(t.id));
  const judgeTasks = newTasks.filter(t=> t.intent==='daily_judge');
  console.log(`[poll ${i}] newTasks ${newTasks.length} judge ${judgeTasks.length} total ${allTasks.length}`);
  if (judgeTasks.length>0) {
    newTaskId = judgeTasks[0].id;
    const row = db.prepare("SELECT id, status, phase, error_code, error_message FROM agent_tasks WHERE id=?").get(newTaskId);
    console.log('latest judge', row);
    if (['succeeded','failed','partial','needs_user'].includes(row.status) && row.phase !== 'running') {
      console.log('terminal reached', row.status, row.phase);
      db.close();
      break;
    }
  }
  const pending = getScoringPending(db, BUSINESS_DATE);
  console.log('pending count', pending.items.length);
  db.close();
  if (Date.now() - pollStart > 8*60*1000) break;
}

const finalDb = openDb();
const finalPlan = finalDb.prepare("SELECT id, is_current FROM plans WHERE id=?").get(EXPECTED_PLAN);
console.log('FINAL plan', finalPlan);
if (!finalPlan || finalPlan.is_current !== 1) throw new Error('Final plan not still cc34 current');
const finalInfo = getScoringPending(finalDb, BUSINESS_DATE);
console.log('FINAL pending count', finalInfo.items.length);
console.log('FINAL all', finalInfo.all.map(i=> ({id:i.id.slice(0,8), status:i.planning_status, score: JSON.parse(i.score_reasons_json||'{}').status})));
const allPlans = finalDb.prepare("SELECT id FROM plans WHERE plan_date=?").all(BUSINESS_DATE);
console.log('ALL plans for date count', allPlans.length, allPlans.map(p=> p.id.slice(0,8)));
const allTasksAfter = finalDb.prepare("SELECT id, intent, status, created_at FROM agent_tasks WHERE business_date=? ORDER BY created_at DESC").all(BUSINESS_DATE);
const newTasksAfter = allTasksAfter.filter(t=> !beforeTaskIds.includes(t.id));
console.log('ALL new tasks after', newTasksAfter.map(t=> ({id:t.id.slice(0,8), intent:t.intent, status:t.status})));
const judgeTasks = newTasksAfter.filter(t=> t.intent==='daily_judge');
console.log('judge tasks count', judgeTasks.length);
if (judgeTasks.length !== 1) throw new Error(`Expected exactly one planner recovery (daily_judge), got ${judgeTasks.length}: ${judgeTasks.map(t=>t.id).join(',')}`);
const reporterTasks = newTasksAfter.filter(t=> ['reporter','daily_scan','daily_intelligence'].includes(t.intent));
if (reporterTasks.length>0) throw new Error('Unexpected reporter/scan tasks: '+reporterTasks.map(t=>t.intent).join(','));
let finalOutcome = 'pending';
if (finalInfo.items.length===0) {
  const allScored = finalInfo.all.every(r=> {
    try { const s=JSON.parse(r.score_reasons_json||'{}'); return s.status==='scored' && Array.isArray(s.reasons) && s.reasons.length===6; } catch { return false; }
  });
  console.log('allScored', allScored);
  finalOutcome = allScored ? 'scored' : 'pending';
} else {
  const taskRow = finalDb.prepare("SELECT error_code, error_message FROM agent_tasks WHERE id=?").get(judgeTasks[0].id);
  console.log('pending remains, error', taskRow);
  if (String(taskRow.error_message||'').includes('getPath')) throw new Error('Still getPath error, B not fixed');
  finalOutcome = 'pending_with_error';
}
for (let id of EXPECTED_ITEMS) {
  const row = finalDb.prepare("SELECT id FROM plan_items WHERE id=?").get(id);
  if (!row) throw new Error(`Missing expected item ${id}`);
}
finalDb.close();

const finalDom = await page.evaluate(() => {
  const body = document.body.innerText||'';
  return {
    bodySnippet: body.slice(0,3000),
    hasScoringIncomplete: body.includes('本轮评分未完成'),
    hasContinue: body.includes('继续评分'),
    hasScoringActive: body.includes('正在评分'),
    buttons: Array.from(document.querySelectorAll('button')).map(b=> (b.textContent||'').trim()).filter(t=>t).slice(0,20)
  };
});
console.log('FINAL DOM', JSON.stringify(finalDom,null,2));
await page.screenshot({ path: AFTER_PNG, fullPage: true });
console.log('after screenshot', AFTER_PNG, fs.statSync(AFTER_PNG).size);

console.log('consoleErrors', consoleErrors);
console.log('pageErrors', pageErrors);

const result = {
  businessDate: BUSINESS_DATE,
  expectedPlan: EXPECTED_PLAN,
  beforePending: 4,
  finalPending: finalInfo.items.length,
  finalOutcome,
  newTaskId,
  planStillCurrent: true,
  screenshots: { before: BEFORE_PNG, after: AFTER_PNG }
};
fs.writeFileSync('J:/PigeonYang/WeMediaBuddy/.ai/scoring-recovery-result.json', JSON.stringify(result,null,2));
console.log('RESULT written', JSON.stringify(result,null,2));

console.log('Closing CDP but leaving app running');
await browser.close();
console.log('browser closed');
await new Promise(r=> setTimeout(r,2000));
console.log('VERIFY DONE');
