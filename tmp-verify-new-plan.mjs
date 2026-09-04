import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DATA_ROOT = 'J:/PigeonYang/WeMediaBuddyData';
const BUSINESS_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const DEBUG_PORT = 9334;
const SCREENSHOT_TODAY = 'J:/PigeonYang/WeMediaBuddy/.ai/verify-today-new-plan.png';

const NEW_PLAN_ID = 'cc34c3b8-33bb-4ed8-b021-1defa9ba9c0a';
const NEW_TITLES = [
  '没有开发经验也能做出产品，但第一版上线只是起点：GoMovie 这次迭代最值得学的不是代码',
  'AI 产品能做出来，不等于订阅能留下：OpenDesign Go 停售退款暴露了最贵的一步',
  '静态商品图变成 AI 视频，先别谈规模：用 1 个 SKU 跑完一次可验收交付',
  'MiMo V2.5 限时免费，真正值得做的不是薅额度：先用同一任务测出它能不能替代你的工作流'
];

function openDb() { return new DatabaseSync(path.join(DATA_ROOT,'wmb.db'), {readOnly:true}); }

console.log('BUSINESS_DATE', BUSINESS_DATE);
console.log('NEW_PLAN_ID', NEW_PLAN_ID);

// Verify DB before launch
{
  const db = openDb();
  const plan = db.prepare('SELECT id, is_current, plan_date FROM plans WHERE id=?').get(NEW_PLAN_ID);
  console.log('DB new plan', plan);
  const items = db.prepare('SELECT id, planning_status, title FROM plan_items WHERE plan_id=? ORDER BY sort_order').all(NEW_PLAN_ID);
  console.log('DB items', items.map(i=> ({id:i.id.slice(0,8), s:i.planning_status, t:i.title.slice(0,50)})));
  const old = db.prepare('SELECT is_current FROM plans WHERE id=?').get('b8796009-6fc5-46be-9c1e-8630cd4011e3');
  console.log('old b879 is_current', old?.is_current);
  // checkpoint
  const cpRow = db.prepare('SELECT checkpoint_json FROM agent_tasks WHERE id=?').get('f36ac3dd-5123-4fa4-8e7d-2c63c614de65');
  const cp = JSON.parse(cpRow.checkpoint_json);
  console.log('checkpoint status', cp.status, 'businessDate', cp.businessDate);
  db.close();
}

console.log('Spawning diagnostic app with port', DEBUG_PORT);
const child = spawn(INSTALLED_EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { detached: true, stdio: 'ignore', cwd: 'J:/PigeonYang/WeMediaBuddy' });
child.unref();
console.log('spawned pid', child.pid);
await new Promise(r=>setTimeout(r, 7000));

let browser;
for(let i=0;i<15;i++){
  try{
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    console.log('connected CDP attempt', i);
    break;
  }catch(e){
    console.log('connect retry', i, e.message);
    await new Promise(r=>setTimeout(r,1000));
  }
}
if(!browser) throw new Error('failed to connectOverCDP');

let context = browser.contexts()[0];
let page = context?.pages()?.[0];
for(let i=0;i<10 && !page;i++){
  await new Promise(r=>setTimeout(r,1000));
  context = browser.contexts()[0];
  page = context?.pages()?.[0];
  console.log('waiting page', i, 'contexts', browser.contexts().length);
}
if(!page) throw new Error('no page found');
console.log('page url', page.url());

const consoleErrors=[]; const pageErrors=[];
page.on('console', msg=>{ if(msg.type()==='error') consoleErrors.push(msg.text()); });
page.on('pageerror', err=> pageErrors.push(String(err)));

await page.waitForTimeout(3000);

// Ensure Today view
const navSelector = 'aside.sidebar nav button[title="今日"]';
try{
  const isActive = await page.evaluate(s=> document.querySelector(s)?.classList.contains('active') ?? false, navSelector);
  console.log('today active before?', isActive);
  if(!isActive){
    console.log('clicking Today nav');
    await page.evaluate(s=> document.querySelector(s)?.click(), navSelector);
    await page.waitForTimeout(1500);
  }
}catch(e){ console.log('nav eval error', e); }

try{ await page.waitForSelector('.app-shell', {timeout:10000}); console.log('app-shell found'); }catch{ console.log('app-shell NOT found'); }
try{ await page.waitForSelector('.today-layout', {timeout:10000}); console.log('today-layout found'); }catch{ console.log('today-layout NOT found'); }
try{ await page.waitForSelector('.today-overview', {timeout:5000}); console.log('today-overview found'); }catch{ console.log('today-overview NOT found'); }
await page.waitForTimeout(1000);

// DOM checks
const dom = await page.evaluate(() => {
  const bodyText = document.body.innerText || '';
  const hasAppShell = !!document.querySelector('.app-shell');
  const hasTodayLayout = !!document.querySelector('.today-layout');
  const hasTodayOverview = !!document.querySelector('.today-overview');
  const hasPiDock = !!document.querySelector('.pi-dock') || !!document.querySelector('[data-testid="pi-dock"]') || bodyText.includes('主管');
  const hasCTA = bodyText.includes('查看待确认选题');
  const hasExhausted = bodyText.includes('本轮已结束') || bodyText.includes('已全部否决') || bodyText.includes('开始新一轮收集');
  const hasScanning = bodyText.includes('正在扫描') || bodyText.includes('正在评估') || bodyText.includes('主管编排中') || bodyText.includes('对话中');
  const hasPendingBadge = bodyText.includes('待确认') || bodyText.includes('待审批');
  const allButtons = Array.from(document.querySelectorAll('button')).map(b=> (b.textContent||'').trim()).filter(t=> t.length>0 && t.length<40);
  return {
    bodySnippet: bodyText.slice(0,3000),
    hasAppShell, hasTodayLayout, hasTodayOverview, hasPiDock,
    hasCTA, hasExhausted, hasScanning, hasPendingBadge,
    allButtons: allButtons.slice(0,30),
    bodyTextLength: bodyText.length
  };
});
console.log('DOM', JSON.stringify(dom,null,2));

// Check proposal ledger corresponds to new plan: look for titles
const ledgerCheck = await page.evaluate((titles) => {
  const bodyText = document.body.innerText || '';
  const found = titles.map(t=> ({ title: t.slice(0,20), found: bodyText.includes(t.slice(0,15)) }));
  const allFound = titles.every(t=> bodyText.includes(t.slice(0,15)));
  return { found, allFound };
}, NEW_TITLES);
console.log('ledgerCheck', ledgerCheck);

// Also check via DB that proposal UI should load from current plan
await page.waitForTimeout(1000);
console.log('consoleErrors', consoleErrors);
console.log('pageErrors', pageErrors);

// Screenshot
await page.screenshot({ path: SCREENSHOT_TODAY, fullPage: true });
console.log('screenshot', SCREENSHOT_TODAY, fs.statSync(SCREENSHOT_TODAY).size);

// Verify expectations
const pendingOk = dom.hasCTA && !dom.hasExhausted && !dom.hasScanning && dom.hasAppShell && dom.hasTodayLayout && dom.hasTodayOverview;
const ledgerOk = ledgerCheck.allFound;
const noErrors = consoleErrors.length===0 && pageErrors.length===0;
console.log('pendingOk', pendingOk, 'ledgerOk', ledgerOk, 'noErrors', noErrors);

const result = {
  businessDate: BUSINESS_DATE,
  dom,
  ledgerCheck,
  consoleErrors,
  pageErrors,
  pendingOk,
  ledgerOk,
  noErrors,
  screenshot: SCREENSHOT_TODAY
};
fs.writeFileSync('J:/PigeonYang/WeMediaBuddy/.ai/verify-new-plan-result.json', JSON.stringify(result,null,2));
console.log('result written');

// Close diagnostic but keep ability to leave normal app later via separate relaunch
await browser.close();
console.log('browser closed');

// Need to kill diagnostic app process
try{
  // child pid is detached, but we have its pid. Let's kill via taskkill the process tree
  // Use powershell to find processes with debug port
  console.log('killing diagnostic pid', child.pid);
  const {execSync} = await import('node:child_process');
  try{ execSync(`taskkill /PID ${child.pid} /T /F`, {stdio:'inherit'}); }catch{}
  await new Promise(r=>setTimeout(r,3000));
}catch(e){ console.log('kill error', e); }

console.log('verify done, diagnostic closed');
