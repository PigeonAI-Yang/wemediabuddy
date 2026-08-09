
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
const businessDate = '2026-08-08';
const r2 = await page.evaluate(async (businessDate) => window.wmb.startDailyIntelligence({ businessDate }), businessDate);
console.log('ACTION', r2?.data?.action, 'FOCUS', r2?.data?.focusDialog, 'MGR', r2?.data?.managerTask?.id?.slice(0,8), 'CHILD', r2?.data?.task?.intent, r2?.data?.task?.id?.slice(0,8));

// conversation files
const fs = await import('node:fs');
const path = await import('node:path');
const root = 'j:/PigeonYang/WeMediaBuddyData';
function walk(dir, out=[]) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.json') && /conversation|pi-agent/i.test(p)) out.push(p);
  }
  return out;
}
let files=[];
try { files = walk(root).filter(f => f.includes('pi-agent') || f.includes('conversation')); } catch {}
console.log('CONV_FILES', files.slice(0,20));
let hit=null;
for (const f of files.slice(0,50)) {
  const t = fs.readFileSync(f,'utf8');
  if (t.includes('主管任务') || t.includes('manager_task') || t.includes('e72b812d')) { hit=f; console.log('HIT', f); console.log(t.slice(0,500)); break; }
}
if (!hit) {
  // try list dir
  const agent=path.join(root,'pi-agent');
  console.log('pi-agent exists', fs.existsSync(agent));
  if (fs.existsSync(agent)) console.log(fs.readdirSync(agent));
  const conv=path.join(root,'pi-agent','conversations');
  if (fs.existsSync(conv)) {
    console.log('convs', fs.readdirSync(conv).slice(0,20));
    for (const name of fs.readdirSync(conv).slice(0,30)) {
      const f=path.join(conv,name);
      const t=fs.readFileSync(f,'utf8');
      if (t.includes('主管') || t.includes('今日情报')) { console.log('CARD_FILE', f); console.log(t.slice(0,800)); break; }
    }
  }
}

const ui = await page.evaluate(() => document.body.innerText.includes('【主管任务】') || document.body.innerText.includes('主管编排'));
console.log('UI_HAS_MANAGER', ui);
const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g,' ').slice(0,500));
console.log('UI', text);
await browser.close().catch(()=>{});
