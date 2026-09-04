import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const INSTALLED_EXE = 'C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe';
const DATA_ROOT = 'J:/PigeonYang/WeMediaBuddyData';
const BUSINESS_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const DEBUG_PORT = 9322;
const BEFORE_PATH = 'J:/PigeonYang/WeMediaBuddy/.ai/before-exhausted2.png';
const AFTER_PATH = 'J:/PigeonYang/WeMediaBuddy/.ai/after-scanning2.png';

function openReadOnlyDb(){ return new DatabaseSync(path.join(DATA_ROOT,'wmb.db'),{readOnly:true}); }
function getActiveRoot(db, date){
  return db.prepare("SELECT id, status, intent FROM agent_tasks WHERE business_date=? AND status='running' AND intent IN ('daily_intelligence','daily_scan','daily_judge','page_agents') ORDER BY updated_at DESC").all(date);
}
console.log('BUSINESS_DATE', BUSINESS_DATE);
let beforeActive=[]; let beforeIds=[];
{
  const db=openReadOnlyDb();
  beforeActive=getActiveRoot(db,BUSINESS_DATE);
  beforeIds=beforeActive.map(t=>t.id);
  console.log('BEFORE activeRoot', beforeActive);
  db.close();
}
console.log('Spawning app with port',DEBUG_PORT);
const child=spawn(INSTALLED_EXE,[`--remote-debugging-port=${DEBUG_PORT}`],{detached:true, stdio:'ignore', cwd:'j:/PigeonYang/WeMediaBuddy'});
child.unref();
console.log('spawned',child.pid);
await new Promise(r=>setTimeout(r,6000));
let browser;
for(let i=0;i<20;i++){
  try{
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    console.log('connected on try',i);
    break;
  }catch(e){
    console.log('connect retry',i,e.message);
    await new Promise(r=>setTimeout(r,1000));
  }
}
if(!browser) throw new Error('no browser');
let context=browser.contexts()[0];
let page=context?.pages()[0];
for(let i=0;i<15 && !page;i++){
  console.log('waiting page', i, 'contexts', browser.contexts().length);
  await new Promise(r=>setTimeout(r,1000));
  context=browser.contexts()[0];
  page=context?.pages()[0];
  if(page) console.log('found page',page.url());
}
if(!page){
  console.log('contexts',browser.contexts().length);
  for(const c of browser.contexts()) console.log('pages',c.pages().map(p=>p.url()));
  throw new Error('no page');
}
console.log('page url',page.url());
const consoleErrors=[]; const pageErrors=[];
page.on('console',m=>{ if(m.type()==='error') consoleErrors.push(m.text()); });
page.on('pageerror',e=>pageErrors.push(String(e)));
await page.waitForTimeout(3000);
const navSelector='aside.sidebar nav button[title="今日"]';
try{
  const isActive=await page.evaluate(s=>document.querySelector(s)?.classList.contains('active')??false, navSelector);
  console.log('today active?',isActive);
  if(!isActive){
    await page.evaluate(s=>document.querySelector(s)?.click(), navSelector);
    await page.waitForTimeout(1500);
  }
}catch(e){console.log(e);}
try{ await page.waitForSelector('.app-shell',{timeout:10000}); console.log('app-shell found'); }catch{ console.log('app-shell NOT'); }
try{ await page.waitForSelector('.today-layout',{timeout:10000}); console.log('today-layout found'); }catch{ console.log('today-layout NOT'); }
await page.waitForTimeout(1000);
const beforeDom=await page.evaluate(()=>{
  const bodyText=document.body.innerText||'';
  return {
    hasAppShell: !!document.querySelector('.app-shell'),
    hasToday: !!document.querySelector('.today-layout'),
    hasPi: !!document.querySelector('.pi-dock') || bodyText.includes('Pi'),
    hasFiveDraft: bodyText.includes('5条草案'),
    hasViewPending: bodyText.includes('查看待确认选题'),
    hasExhaustedHeadline: bodyText.includes('本轮已结束'),
    hasExhaustedDetail: bodyText.includes('已全部否决'),
    hasStartButton: Array.from(document.querySelectorAll('button')).some(b=>(b.textContent||'').trim()==='开始新一轮收集'),
    startButtonEnabled: Array.from(document.querySelectorAll('button')).find(b=>(b.textContent||'').trim()==='开始新一轮收集')?.disabled===false,
    bodySnippet: bodyText.slice(0,2000),
  };
});
console.log('BEFORE DOM',JSON.stringify(beforeDom,null,2));
await page.screenshot({path:BEFORE_PATH,fullPage:true});
console.log('before shot',BEFORE_PATH,fs.statSync(BEFORE_PATH).size);
console.log('clicking');
const clicked=await page.evaluate(()=>{
  const btn=Array.from(document.querySelectorAll('button')).find(b=>(b.textContent||'').trim()==='开始新一轮收集');
  if(!btn) return {ok:false,reason:'not found'};
  if(btn.disabled) return {ok:false,reason:'disabled'};
  btn.click(); return {ok:true};
});
console.log('clicked',clicked);
if(!clicked.ok) throw new Error('click failed');
await page.waitForTimeout(4000);
let afterDom=null;
for(let i=0;i<10;i++){
  afterDom=await page.evaluate(()=>{
    const bodyText=document.body.innerText||'';
    return {
      hasScanning: bodyText.includes('正在扫描')||bodyText.includes('正在启动')||bodyText.includes('主管编排中')||bodyText.includes('对话中 · 查看进度'),
      hasExhausted: bodyText.includes('本轮已结束') && !bodyText.includes('正在扫描'),
      hasStartButton: Array.from(document.querySelectorAll('button')).some(b=>(b.textContent||'').trim()==='开始新一轮收集'),
      bodySnippet: bodyText.slice(0,2000),
    };
  });
  console.log(`poll ${i}`,afterDom);
  if(afterDom.hasScanning) break;
  await new Promise(r=>setTimeout(r,1000));
}
await page.screenshot({path:AFTER_PATH,fullPage:true});
console.log('after shot',AFTER_PATH,fs.statSync(AFTER_PATH).size);
{
  const db=openReadOnlyDb();
  const afterActive=getActiveRoot(db,BUSINESS_DATE);
  console.log('AFTER activeRoot',afterActive);
  const newIds=afterActive.map(t=>t.id).filter(id=>!beforeIds.includes(id));
  console.log('newIds',newIds);
  if(afterActive.length!==1) console.log('WARNING active count not 1');
  if(newIds.length!==1) throw new Error('expected one new');
  db.close();
}
console.log('consoleErrors',consoleErrors);
console.log('pageErrors',pageErrors);
await browser.close();
console.log('browser closed keep app',child.pid);
fs.writeFileSync('J:/wmb-out/verify-detached2-result.json',JSON.stringify({beforeDom,afterDom,beforeIds},null,2));
console.log('done');
