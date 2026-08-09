
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(1500);
// ensure not settings
await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/今日/.test(x.textContent||''));
  b?.click();
});
await page.waitForTimeout(800);
const dump = async (label) => page.evaluate((label) => {
  const btn=document.querySelector('.pi-dock-toggle');
  const dock=document.querySelector('.pi-dock');
  const shell=document.querySelector('.app-shell');
  if(!btn) return {label, error:'no btn', shell:shell?.className};
  const cs=getComputedStyle(btn);
  const r=btn.getBoundingClientRect();
  return {
    label,
    shell: shell?.className,
    dock: dock?.className,
    opacity: cs.opacity,
    boxShadow: cs.boxShadow,
    filter: cs.filter,
    background: cs.backgroundColor,
    border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
    transform: cs.transform,
    pointerEvents: cs.pointerEvents,
    rect: {x:r.x,y:r.y,w:r.width,h:r.height},
    textShadow: cs.textShadow,
  };
}, label);
// move mouse away first
await page.mouse.move(100, 100);
await page.waitForTimeout(200);
const away = await dump('away');
// hover button center if visible rect
const r = away.rect || {x:0,y:0,w:18,h:44};
await page.mouse.move((r.x||0) + Math.max(2,(r.w||18)/2), (r.y||0) + Math.max(2,(r.h||44)/2));
await page.waitForTimeout(200);
const hover = await dump('hover');
// screenshot full right edge
const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/pi-toggle-away.png', await page.screenshot({type:'png'}));
console.log(JSON.stringify({away, hover}, null, 2));
// list matched stylesheets containing pi-dock-toggle text
const sheets = await page.evaluate(async () => {
  const out=[];
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try { rules = [...sheet.cssRules]; } catch { continue; }
    for (const rule of rules) {
      const text = rule.cssText || '';
      if (text.includes('pi-dock-toggle')) out.push({href: sheet.href || 'inline', text: text.slice(0,300)});
    }
  }
  return out.slice(0,30);
});
console.log('rules', JSON.stringify(sheets,null,2));
await browser.close().catch(()=>{});
