import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const mode = process.argv[2] ?? 'before';
const get = (pathname) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:9371${pathname}`, (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
const version = await get('/json/version');
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.status-bar');
  const read = async () => page.evaluate(() => {
    const rect = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const left = document.querySelector('.status-bar-left');
    const right = document.querySelector('.status-bar-right');
    const trigger = document.querySelector('.x-list-operation-trigger');
    const children = [...left.children];
    const overlaps = [];
    for (let i = 0; i < children.length; i += 1) for (let j = i + 1; j < children.length; j += 1) {
      const a = children[i].getBoundingClientRect(), b = children[j].getBoundingClientRect();
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps.push([children[i].textContent?.trim(), children[j].textContent?.trim()]);
    }
    if (trigger && trigger.parentElement !== left) {
      const a = trigger.getBoundingClientRect();
      for (const child of children) { const b = child.getBoundingClientRect(); if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps.push([trigger.textContent?.trim(), child.textContent?.trim()]); }
    }
    const theme = document.querySelector('.status-theme');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      theme: document.documentElement.dataset.theme,
      themeText: theme?.textContent?.trim(),
      themeTitle: theme?.getAttribute('title'),
      triggerParent: trigger?.parentElement?.className,
      triggerPosition: trigger ? getComputedStyle(trigger).position : null,
      bar: rect(document.querySelector('.status-bar')),
      left: rect(left), right: rect(right), trigger: trigger ? rect(trigger) : null,
      overlaps
    };
  });
  const darkBefore = await read();
  if (darkBefore.theme !== 'dark') await page.locator('.status-theme').click();
  const dark = await read();
  await page.locator('.status-theme').click();
  const light = await read();
  await page.locator('.status-theme').click();
  const result = { title: await page.title(), dark, light };
  await page.screenshot({ path: path.join(process.cwd(), '.ai', `wmb-4100-${mode}.png`), fullPage: true });
  writeFileSync(path.join(process.cwd(), '.ai', `wmb-4100-${mode}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (mode === 'after' && (dark.overlaps.length || light.overlaps.length || dark.themeText?.[0] !== '☾' || light.themeText?.[0] !== '☀' || dark.triggerParent !== 'status-bar-left' || dark.triggerPosition !== 'static')) process.exitCode = 1;
} finally { await browser.close(); }
