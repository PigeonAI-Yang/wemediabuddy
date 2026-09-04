import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DEBUG_PORT = 9322;
const BUSINESS_DATE = '2026-08-26';
const SCREENSHOT = 'J:/wmb-out/verify-today-final.png';

function directMetrics(dbPath, planDate) {
  const db = new DatabaseSync(dbPath);
  // replicate getTodayOverviewMetrics logic for direct comparison
  function toUtcIsoBound(s){ return new Date(s).toISOString(); }
  function addDaysDate(d, delta){ const date = new Date(d+'T00:00:00+08:00'); date.setDate(date.getDate()+delta); const y=date.getFullYear(); const m=String(date.getMonth()+1).padStart(2,'0'); const day=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
  const dayStart = toUtcIsoBound(`${planDate}T00:00:00.000+08:00`);
  const dayEnd = toUtcIsoBound(`${planDate}T23:59:59.999+08:00`);
  const prevDate = addDaysDate(planDate, -1);
  const prevStart = toUtcIsoBound(`${prevDate}T00:00:00.000+08:00`);
  const prevEnd = toUtcIsoBound(`${prevDate}T23:59:59.999+08:00`);
  const todayRow = db.prepare(`SELECT COUNT(*) AS total FROM source_items WHERE management_status != 'archived' AND collected_at >= ? AND collected_at <= ?`).get(dayStart, dayEnd);
  const prevRow = db.prepare(`SELECT COUNT(*) AS total FROM source_items WHERE management_status != 'archived' AND collected_at >= ? AND collected_at <= ?`).get(prevStart, prevEnd);
  const sourcesCur = Number(todayRow?.total ?? 0);
  const todayPlanIdRow = db.prepare(`SELECT id FROM plans WHERE plan_date = ? AND is_current = 1 LIMIT 1`).get(planDate);
  const curOpp = todayPlanIdRow ? Number((db.prepare(`SELECT COUNT(*) AS total FROM plan_items WHERE plan_id = ? AND planning_status = 'approved'`).get(todayPlanIdRow.id)?.total ?? 0)) : 0;
  const activeRow = db.prepare(`SELECT COUNT(*) AS total FROM content_projects WHERE archived_at IS NULL AND status != 'completed'`).get();
  const pendingRow = db.prepare(`SELECT COUNT(*) AS total FROM content_projects WHERE archived_at IS NULL AND status IN ('idea','review','ready')`).get();
  const projectsCur = Number(activeRow?.total ?? 0);
  const pending = Number(pendingRow?.total ?? 0);
  const dayEnd2 = toUtcIsoBound(`${planDate}T23:59:59.999+08:00`);
  const weekStart = toUtcIsoBound(`${addDaysDate(planDate, -6)}T00:00:00.000+08:00`);
  const curPubRow = db.prepare(`SELECT COUNT(*) AS total FROM publications WHERE status = 'published' AND published_at >= ? AND published_at <= ?`).get(weekStart, dayEnd2);
  const curPub = Number(curPubRow?.total ?? 0);
  db.close();
  return { sources: sourcesCur, opportunities: curOpp, projects: projectsCur, pending, publications: curPub };
}

const direct = directMetrics('J:/PigeonYang/WeMediaBuddyData/wmb.db', BUSINESS_DATE);
console.log('DIRECT DB metrics for', BUSINESS_DATE, direct);
// Expected from direct: should be authoritative
// For verification we will compare installed UI metrics to this

async function run() {
  let browser;
  for(let i=0;i<20;i++){
    try{ browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`); console.log('CDP connected'); break; } catch(e){ console.log('retry',i, e.message); await new Promise(r=>setTimeout(r,1000)); }
  }
  if(!browser) throw new Error('CDP connect failed');
  const context = browser.contexts()[0];
  let page = context.pages()[0];
  for(let i=0;i<10 && !page;i++){ await new Promise(r=>setTimeout(r,1000)); page = context.pages()[0]; }
  console.log('page url', page.url());
  await page.waitForTimeout(2000);
  await page.waitForSelector('.app-shell', {timeout:15000}).catch(()=> console.log('no app-shell'));
  await page.waitForSelector('.today-layout', {timeout:15000}).catch(()=> console.log('no today-layout'));
  await page.waitForTimeout(1000);
  // Ensure Today view
  const navSelectors = ['text=今日', '[data-testid="nav-today"]', 'a:has-text("今日")'];
  for(const sel of navSelectors){
    try{
      const el = page.locator(sel).first();
      if(await el.count()>0){ console.log('clicking Today nav', sel); await el.click({timeout:2000}); break; }
    }catch{}
  }
  await page.waitForTimeout(1500);
  await page.waitForSelector('.today-overview', {timeout:10000}).catch(()=> console.log('no today-overview'));
  // Read metrics via IPC
  const metrics = await page.evaluate(async (planDate) => {
    // @ts-ignore
    const m = await window.wmb.getTodayOverviewMetrics(planDate);
    return m;
  }, BUSINESS_DATE);
  console.log('INSTALLED METRICS', JSON.stringify(metrics,null,2));
  const bodyText = await page.evaluate(()=> document.body.innerText);
  const hasUnknownMarker = bodyText.includes('—') && bodyText.includes('今日概览') ? 'check' : 'no';
  // Check for unknown marker in overview section specifically
  const overviewCheck = await page.evaluate(()=>{
    const el = document.querySelector('.today-overview');
    const txt = el ? el.innerText : '';
    const hasDash = txt.includes('—');
    // But changeText may legitimately be "—" when no previous data? Need to check values are numeric
    return { txt: txt.slice(0,2000), hasDash, bodySnippet: document.body.innerText.slice(0,3000) };
  });
  console.log('overviewCheck', overviewCheck);
  // Also check ledger
  const ledger = await page.evaluate(async (planDate)=>{
    try{
      // @ts-ignore
      const l = await window.wmb.getProposalLedger({ planDate, tab: 'today' });
      return { ok:true, count: l.items?.length ?? 0, items: (l.items||[]).slice(0,3).map(i=>({id:i.id.slice(0,8), status:i.planningStatus, date:i.planDate})) };
    } catch(e){ return { ok:false, error: String(e) }; }
  }, BUSINESS_DATE);
  console.log('LEDGER', JSON.stringify(ledger,null,2));
  // Compare
  const installedValues = {
    sources: metrics.sources.value,
    opportunities: metrics.opportunities.value,
    projects: metrics.projects.value,
    pending: metrics.projects.pending,
    publications: metrics.publications.value
  };
  console.log('INSTALLED VALUES', installedValues);
  console.log('DIRECT VALUES', direct);
  const match = installedValues.sources===direct.sources && installedValues.opportunities===direct.opportunities && installedValues.projects===direct.projects && installedValues.publications===direct.publications;
  console.log('MATCH DIRECT?', match);
  const numericCheck = [metrics.sources.value, metrics.opportunities.value, metrics.projects.value, metrics.publications.value].every(v=> typeof v==='number' && v!==null);
  console.log('NUMERIC CHECK', numericCheck);
  const noUnknownForValues = numericCheck; // values are numeric not null
  // Check changeText not unknown marker for projects? Actually projects changeText is "待处理 395" when pending >0, not "—"
  const changeTexts = [metrics.sources.changeText, metrics.opportunities.changeText, metrics.projects.changeText, metrics.publications.changeText];
  console.log('changeTexts', changeTexts);
  const noUnknownMarkerOverall = !overviewCheck.txt.includes('未知') && numericCheck;
  console.log('noUnknownMarkerOverall', noUnknownMarkerOverall);
  await page.screenshot({ path: SCREENSHOT, fullPage:true });
  console.log('screenshot', SCREENSHOT, fs.statSync(SCREENSHOT).size);
  const result = {
    businessDate: BUSINESS_DATE,
    direct,
    installed: installedValues,
    metrics,
    ledger,
    match,
    numericCheck,
    overviewHasDash: overviewCheck.hasDash,
    screenshot: SCREENSHOT,
    bodySnippet: overviewCheck.bodySnippet.slice(0,1500)
  };
  fs.writeFileSync('J:/wmb-out/verify-today-final.json', JSON.stringify(result,null,2));
  console.log('RESULT', JSON.stringify(result,null,2));
  await browser.close();
  console.log('verify done, keep app running');
  if(!match) throw new Error(`Metrics mismatch direct vs installed`);
  if(!numericCheck) throw new Error('Metrics not numeric');
}
run().catch(e=>{ console.error(e); process.exit(1); });
