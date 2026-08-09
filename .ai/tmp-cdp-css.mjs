
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
const session = await page.context().newCDPSession(page);
await session.send('DOM.enable');
await session.send('CSS.enable');
// hover button
const box = await page.evaluate(() => {
  const b=document.querySelector('.pi-dock-toggle');
  const r=b.getBoundingClientRect();
  return {x:r.x+r.width/2,y:r.y+r.height/2};
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(250);
const {root} = await session.send('DOM.getDocument', {depth: 0});
const {nodeId} = await session.send('DOM.querySelector', {nodeId: root.nodeId, selector: '.pi-dock-toggle'});
const matched = await session.send('CSS.getMatchedStylesForNode', {nodeId});
const opacityRules = [];
for (const m of matched.matchedCSSRules || []) {
  const style = m.rule?.style;
  if (!style) continue;
  const props = style.cssProperties || [];
  const op = props.find(p => p.name === 'opacity');
  if (op) {
    opacityRules.push({
      origin: m.rule.origin,
      source: m.rule.styleSheetId,
      selector: m.rule.selectorList?.text,
      opacity: op.value,
      important: op.important,
      disabled: op.disabled,
      range: op.range,
    });
  }
}
const inline = matched.inlineStyle?.cssProperties?.filter(p=>p.name==='opacity') || [];
const attrs = matched.attributesStyle?.cssProperties?.filter(p=>p.name==='opacity') || [];
const computed = await session.send('CSS.getComputedStyleForNode', {nodeId});
const cop = (computed.computedStyle||[]).find(p=>p.name==='opacity');
console.log(JSON.stringify({computed: cop, inline, attrs, opacityRules}, null, 2));
await browser.close().catch(()=>{});
