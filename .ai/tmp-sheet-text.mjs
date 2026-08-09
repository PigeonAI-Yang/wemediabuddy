
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
const session = await page.context().newCDPSession(page);
await session.send('DOM.enable');
await session.send('CSS.enable');
const {root} = await session.send('DOM.getDocument', {depth:0});
const {nodeId} = await session.send('DOM.querySelector', {nodeId: root.nodeId, selector: '.pi-dock-toggle'});
const matched = await session.send('CSS.getMatchedStylesForNode', {nodeId});
// collect unique stylesheet ids from opacity rules
const ids = new Set();
for (const m of matched.matchedCSSRules||[]) {
  const props = m.rule?.style?.cssProperties||[];
  if (props.some(p=>p.name==='opacity')) ids.add(m.rule.styleSheetId);
}
for (const id of ids) {
  try {
    const all = await session.send('CSS.getStyleSheetText', {styleSheetId: id});
    const text = all.text || '';
    const lines = text.split(/\n/);
    // find lines with pi-dock-toggle and opacity nearby
    console.log('SHEET', id, 'len', text.length, 'lines', lines.length);
    for (let i=0;i<lines.length;i++) {
      if (lines[i].includes('pi-dock-toggle') && (lines[i].includes('opacity') || (lines[i+1]||'').includes('opacity') || lines[i].includes('{') )) {
        // print small window
      }
    }
    // extract all rule snippets containing pi-dock-toggle opacity
    const re = /[^}]*pi-dock-toggle[^}]*}/g;
    const hits = text.match(re) || [];
    for (const h of hits) {
      if (h.includes('opacity') || h.includes('z-index')) console.log('RULE:', h.replace(/\s+/g,' ').slice(0,300));
    }
  } catch (e) {
    console.log('sheet fail', id, String(e));
  }
}
// Also force set and see
await page.hover('.pi-dock-toggle');
await page.waitForTimeout(200);
const before = await page.evaluate(() => getComputedStyle(document.querySelector('.pi-dock-toggle')).opacity);
await page.evaluate(() => { document.querySelector('.pi-dock-toggle').style.setProperty('opacity','1','important'); });
const after = await page.evaluate(() => getComputedStyle(document.querySelector('.pi-dock-toggle')).opacity);
console.log({before, after, hovered: await page.evaluate(() => document.querySelector('.pi-dock-toggle').matches(':hover'))});
await browser.close().catch(()=>{});
