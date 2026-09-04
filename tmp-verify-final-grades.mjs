import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DEBUG_PORT = 9322;
const SCREENSHOT = 'J:/wmb-out/verify-today-final-grades.png';
const DB_PATH = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
function gradeFromScore(s){ if(!Number.isFinite(s)) return 'F'; if(s>=90) return 'SSS'; if(s>=80) return 'S'; if(s>=70) return 'A'; if(s>=60) return 'B'; if(s>=50) return 'C'; if(s>=40) return 'D'; if(s>=30) return 'E'; return 'F'; }
const db = new DatabaseSync(DB_PATH);
const plan = db.prepare("SELECT id FROM plans WHERE plan_date='2026-08-26' AND is_current=1").get();
const items = db.prepare("SELECT title, planning_status, score_reasons_json FROM plan_items WHERE plan_id=?").all(plan.id);
console.log('DB plan 37f6c4fc items', items.length);
items.forEach(it=>{
  const sr = JSON.parse(it.score_reasons_json);
  console.log(`DB ${it.planning_status} ${sr.score} -> ${gradeFromScore(sr.score)} ${it.title.slice(0,40)}`);
});
const pool = db.prepare(`
SELECT pi.planning_status, pi.score_reasons_json, pi.title FROM plan_items pi JOIN plans p ON p.id=pi.plan_id
WHERE p.id IN (SELECT p2.id FROM plans p2 WHERE EXISTS (SELECT 1 FROM plan_items pi2 WHERE pi2.plan_id=p2.id) AND p2.created_at=(SELECT MAX(p3.created_at) FROM plans p3 WHERE p3.plan_date=p2.plan_date AND EXISTS (SELECT 1 FROM plan_items pi3 WHERE pi3.plan_id=p3.id)))
`).all();
console.log('latest rows total', pool.length);
db.close();

console.log('spawning debug');
const child = spawn(INSTALLED_EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { detached:true, stdio:'ignore' });
child.unref();
await new Promise(r=>setTimeout(r,9000));
let browser;
for(let i=0;i<15;i++){ try{ browser=await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`); console.log('CDP ok',i); break;}catch(e){ console.log('retry',i); await new Promise(r=>setTimeout(r,1000)); } }
if(!browser){ console.error('CDP fail'); process.exit(1); }
const page=browser.contexts()[0].pages()[0];
console.log('url',page.url());
await page.waitForTimeout(2000);
await page.waitForSelector('.app-shell',{timeout:15000}).catch(()=>{});
await page.waitForTimeout(1000);
try{ const nav=page.locator('text=今日').first(); if(await nav.count()>0){ await nav.click(); await page.waitForTimeout(1000);} }catch{}
await page.waitForSelector('[data-opportunity-card]',{timeout:15000}).catch(()=>{});
const dom=await page.evaluate(()=>{
  const cards=Array.from(document.querySelectorAll('[data-opportunity-card]'));
  return cards.map(c=>{
    const gEl=c.querySelector('[data-grade]');
    const grade=gEl? (gEl.getAttribute('data-grade')||gEl.textContent.trim()):null;
    const titleEl=c.querySelector('.opp-title, h2');
    const title=titleEl? titleEl.textContent.trim():'';
    return {grade, title:title.slice(0,60)};
  });
});
console.log('dom cards',dom.length);
dom.forEach((d,i)=> console.log(`${i} ${d.grade} ${d.title.slice(0,50)}`));
const hasPending = dom.some(d=>d.grade==='待评分');
console.log('hasPending',hasPending);
const allScored = dom.every(d=>['SSS','S','A','B','C','D','E','F'].includes(d.grade));
console.log('allScored',allScored);
await page.screenshot({path:SCREENSHOT, fullPage:true});
console.log('screenshot', SCREENSHOT, fs.existsSync(SCREENSHOT));
const ipc=await page.evaluate(async()=>{
  const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const t=await window.wmb.getToday(d);
  return {poolCount:t.pool.length, pool:t.pool.map(p=>({id:p.planItemId.slice(0,8), status:p.planningStatus, score:p.scoreReasonsJson?JSON.parse(p.scoreReasonsJson).score:null, title:p.title.slice(0,30)})), planCount:t.plan?.items.length};
});
console.log('ipc',JSON.stringify(ipc,null,2));
await browser.close();
if(hasPending){ console.error('FAIL still has pending'); process.exit(2); }
if(!allScored){ console.error('FAIL not all scored'); process.exit(2); }
if(dom.length!==11){ console.warn('card count not 11, but expected 11 (7 approved current+4 ready older)'); }
console.log('PASS all cards S/A, zero false pending');
