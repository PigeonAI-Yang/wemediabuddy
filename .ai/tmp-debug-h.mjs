
import { chromium } from 'playwright-core';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages().find(Boolean);
await page.bringToFront();
const m=await page.evaluate(()=>{
  const opps=document.querySelector('.today-opps');
  const kids=[...opps.children].map(el=>{
    const r=el.getBoundingClientRect();
    const cs=getComputedStyle(el);
    return {tag:el.tagName, cls:el.className?.toString?.().slice(0,80), h:Math.round(r.height), minH:cs.minHeight, maxH:cs.maxHeight, flex:cs.flex, overflow:cs.overflow};
  });
  const grid=document.querySelector('.today-grid');
  const gcs=getComputedStyle(grid);
  // count feed items
  const feedN=document.querySelectorAll('.feed-item').length;
  const feed=document.querySelector('.feed-list');
  const track=document.querySelector('.feed-stream-track');
  return {
    oppsH:Math.round(opps.getBoundingClientRect().height),
    kids,
    gridH:Math.round(grid.getBoundingClientRect().height),
    gridAlign:gcs.alignItems,
    feedN,
    feedH:feed&&Math.round(feed.getBoundingClientRect().height),
    trackH:track&&Math.round(track.getBoundingClientRect().height),
    railKids:[...document.querySelector('.today-rail').children].map(el=>({cls:el.className?.toString?.().slice(0,60), h:Math.round(el.getBoundingClientRect().height), minH:getComputedStyle(el).minHeight}))
  };
});
console.log(JSON.stringify(m,null,2));
await browser.close().catch(()=>{});
