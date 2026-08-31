import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = 'J:/PigeonYang/WeMediaBuddy';
const DATA_ROOT_PROD = 'J:/PigeonYang/WeMediaBuddyData';
const PACKAGED_DIR = 'J:/wmb-out/WeMediaBuddy-win32-x64';
const ARTIFACTS_BASE = path.join(REPO_ROOT, 'tests/e2e/artifacts/packaged-ferment-verify');
fs.mkdirSync(ARTIFACTS_BASE, {recursive:true});

async function importFile(p){ return import(pathToFileURL(p).href); }

const harness = await importFile(path.join(REPO_ROOT, 'tests/e2e/harness.mjs'));
const { launchApp, waitForAppReady, navigateTo, captureEvidence, closeApp, delay, seedWorkspace, openReadOnlyDb } = harness;

import { DatabaseSync } from 'node:sqlite';

const prodDb = new DatabaseSync(path.join(DATA_ROOT_PROD, 'wmb.db'), {readonly:true});
let prodWorkspaceId=null;
try{
  const row = prodDb.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get();
  prodWorkspaceId = row?.value || null;
  console.log('prodWorkspaceId',prodWorkspaceId);
} finally{ prodDb.close(); }
if(!prodWorkspaceId) prodWorkspaceId = 'prod-workspace';

const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'wmb-ferment-verify-ud-'));
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'wmb-ferment-verify-dr-'));
console.log('userDataDir', userDataDir);
console.log('dataRoot', dataRoot);

// Seed workspace with prodWorkspaceId so after copy IDs match
seedWorkspace({ userDataDir, dataRoot, workspaceId: prodWorkspaceId, displayName: 'VerifyProd', seedPi:true, onboarding:true });
console.log('seeded workspace');

// Now overwrite wmb.db with production copy
const prodDbPath = path.join(DATA_ROOT_PROD, 'wmb.db');
const destDbPath = path.join(dataRoot, 'wmb.db');
fs.copyFileSync(prodDbPath, destDbPath);
console.log('copied prod db to', destDbPath, 'size', fs.statSync(destDbPath).size);

// Also copy assets folder contents? Not needed for ferment but do minimal
try{
  // ensure assets dir exists
  fs.mkdirSync(path.join(dataRoot, 'assets'), {recursive:true});
} catch{}

const opts = { appPath: PACKAGED_DIR, userDataDir, dataRoot, seed:false, artifactsDir: ARTIFACTS_BASE };
console.log('launching packaged app', PACKAGED_DIR);
const { app, page, workspace, evidence } = await launchApp(opts);
console.log('launched pid', app.process()?.pid);
try{
  await waitForAppReady(page, {timeoutMs:60000});
  console.log('app ready');
  // Ensure we are on Today
  await navigateTo(page, 'today', {timeoutMs:20000});
  console.log('navigated today');
  await delay(2000);
  // Wait for fermenting rail
  await page.waitForSelector('.app-shell', {timeout:15000});
  // Capture Today title and ferment counts
  const shellVisible = await page.evaluate(()=> !!document.querySelector('.app-shell'));
  console.log('shellVisible', shellVisible);
  const todayPlanVisible = await page.evaluate(()=> document.body.innerText.includes('今日') || document.body.innerText.includes('Today'));
  console.log('todayPlanVisible', todayPlanVisible);
  const piVisible = await page.evaluate(()=> !!document.querySelector('.pi-dock') || document.body.innerText.includes('Pi'));
  console.log('piVisible', piVisible);
  // Extract fermenting titles
  const fermentInfo = await page.evaluate(()=>{
    const rail = document.querySelector('.fermenting-rail');
    const railText = rail ? rail.innerText : '';
    const titles = [...document.querySelectorAll('.fermenting-rail .fermenting-row h3, .fermenting-rail h3, .fermenting-row-text h3')].map(el=>el.textContent.trim()).filter(Boolean);
    // fallback: all h3 in rail
    const allH3 = [...document.querySelectorAll('.fermenting-rail h3')].map(e=>e.textContent.trim());
    const bodyText = document.body.innerText.slice(0,8000);
    return { railText: railText.slice(0,4000), titles, allH3, bodySnippet: bodyText.slice(0,2000) };
  });
  console.log('fermentInfo', JSON.stringify(fermentInfo,null,2));
  // Check forbidden titles absent
  const forbidden = [
    '把 bug 看板直接交给 AI，最先要防的不是犯错而是提示词注入',
    'AI 代写得越完整，申请材料越容易失去你的贡献',
    '企业愿意用 AI，前提可能不是更聪明，而是还能控制住数据和系统',
    '产品想法先别急着开发，先找人把首页的价值说清楚',
    '别只记录粉丝数：把公开表达换算成四种可复用资产',
    'AI 做分析时，提示词和数据也应该像代码一样留下来',
    'AI 服务的最小交付物不是聊天记录，而是一张当天能用的卡片',
    '同一提示词和参考图，才看得出模型差异在哪里',
    'Agent 不是越多越强，先做一个 3 个角色的工作流实验'
  ];
  const pageText = await page.evaluate(()=> document.body.innerText);
  const foundForbidden = forbidden.filter(t=> pageText.includes(t));
  console.log('foundForbidden', foundForbidden);
  // Extract counts via DOM if possible
  const counts = await page.evaluate(()=>{
    const rail = document.querySelector('.fermenting-rail');
    if(!rail) return { hasRail:false };
    const summary = rail.querySelector('.fermenting-head h2')?.textContent || '';
    const rows = [...rail.querySelectorAll('.fermenting-row')].length;
    const watching = document.querySelector('.fermenting-watching-count')?.textContent || '';
    return { hasRail:true, summary, rows, watching };
  });
  console.log('counts', counts);
  // Screenshot
  const screenshotPath = path.join(ARTIFACTS_BASE, 'packaged-today.png');
  await page.screenshot({path: screenshotPath, fullPage:true});
  console.log('screenshot', screenshotPath);
  await captureEvidence({app, page, artifactsDir: ARTIFACTS_BASE, name: 'packaged-ferment'});
  // DB readback dual verification: query ferment bundle via DB
  let dbInfo=null;
  try{
    const handle = openReadOnlyDb(dataRoot);
    const topics = handle.db.prepare("SELECT title, status FROM topics WHERE status IN ('active','watching') AND title IN (?,?,?,?,?,?,?,?,?)").all(...forbidden);
    dbInfo = topics;
    // Check archived status for the four
    const fourArchived = handle.db.prepare("SELECT title, status FROM topics WHERE title IN (?,?,?,?)").all(
      'AI 做分析时，提示词和数据也应该像代码一样留下来',
      'AI 服务的最小交付物不是聊天记录，而是一张当天能用的卡片',
      '同一提示词和参考图，才看得出模型差异在哪里',
      'Agent 不是越多越强，先做一个 3 个角色的工作流实验'
    );
    console.log('fourArchived', fourArchived);
    console.log('topics found in active/watching among forbidden', topics);
    handle.close();
  }catch(e){ console.log('db read error',e); }
  // Collect errors
  console.log('evidence.errors', evidence.errors);
  console.log('evidence.pageerrors', evidence.pageerrors);
  console.log('evidence.console last 20', evidence.console.slice(-20));
  const success = foundForbidden.length===0 && counts.hasRail && shellVisible;
  console.log('VERDICT', success ? 'PASS' : 'FAIL');
  console.log(JSON.stringify({ foundForbidden, counts, shellVisible, piVisible },null,2));
  fs.writeFileSync(path.join(ARTIFACTS_BASE, 'ferment-verify.json'), JSON.stringify({ fermentInfo, foundForbidden, counts, shellVisible, piVisible, forbidden, evidence: { errors: evidence.errors, pageerrors: evidence.pageerrors, consoleTail: evidence.console.slice(-50) } }, null, 2));
} finally {
  await closeApp(app, {timeoutMs:20000});
  console.log('closed app');
  // cleanup temp dirs? Keep for proof
}
