
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0];
const info = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[data-testid="listCell"]')).slice(0,3).map((cell, i) => {
    const anchors = Array.from(cell.querySelectorAll('a')).map(a => ({href:a.getAttribute('href'), text:(a.textContent||'').slice(0,40)}));
    return {
      i,
      text: (cell.innerText||'').slice(0,120),
      htmlSnippet: cell.outerHTML.slice(0,500),
      anchors
    };
  });
});
console.log(JSON.stringify(info,null,2));
await browser.close();
