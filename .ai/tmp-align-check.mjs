
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = context.pages()[0];
for (const p of context.pages()) {
  const ok = await p.evaluate(() => /今日|DeepSeek/.test(document.body?.innerText || '')).catch(() => false);
  if (ok) { page = p; break; }
}
await page.bringToFront();
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 2200));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /今日/.test(x.title || x.textContent || ''));
  b?.click();
});
await new Promise(r => setTimeout(r, 1000));
await page.evaluate(() => document.querySelector('.today-main')?.scrollTo({ top: 0 }));
// if list is scrollable, pin to end so bottom-aligned pack is visible
await page.evaluate(() => {
  const list = document.querySelector('.today-opps .opp-list');
  if (list) list.scrollTop = list.scrollHeight;
});
await new Promise(r => setTimeout(r, 100));
const m = await page.evaluate(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
  };
  const opps = document.querySelector('.today-opps');
  const list = document.querySelector('.today-opps .opp-list');
  const rail = document.querySelector('.today-rail');
  const rows = [...document.querySelectorAll('.today-opps .opp-list .opp-row')];
  const last = rows[rows.length - 1];
  // last fully visible row inside list viewport
  const visible = rows.filter((row) => {
    const r = row.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    return r.bottom <= lr.bottom + 1 && r.top >= lr.top - 1;
  });
  const lastVisible = visible[visible.length - 1] || last;
  return {
    opps: box(opps),
    rail: box(rail),
    list: box(list),
    last: last && box(last),
    lastVisible: lastVisible && box(lastVisible),
    colMatch: Math.abs(box(opps).bottom - box(rail).bottom) <= 2,
    lastAlign: lastVisible ? (box(list).bottom - box(lastVisible).bottom) : null,
    justify: getComputedStyle(list).justifyContent,
    rowCount: rows.length,
    visibleCount: visible.length,
  };
});
console.log(JSON.stringify(m, null, 2));
const fs = await import('node:fs');
fs.writeFileSync('j:/PigeonYang/WeMediaBuddy/.ai/wmb-today-align-check.png', await page.screenshot({ fullPage: false }));
await browser.close().catch(() => {});
