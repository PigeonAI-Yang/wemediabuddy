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
  await page.waitForSelector('.pi-conversation');
  const conversation = page.locator('.pi-conversation');
  await conversation.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const button = page.locator('.pi-jump-latest');
  await button.waitFor();
  const geometry = await page.evaluate(() => {
    const shell = document.querySelector('.pi-conversation-shell').getBoundingClientRect();
    const button = document.querySelector('.pi-jump-latest').getBoundingClientRect();
    return {
      shell: { left: shell.left, right: shell.right, bottom: shell.bottom, centerX: (shell.left + shell.right) / 2 },
      button: { left: button.left, right: button.right, bottom: button.bottom, centerX: (button.left + button.right) / 2 },
      centerDelta: Math.abs((shell.left + shell.right - button.left - button.right) / 2),
      computed: { left: getComputedStyle(document.querySelector('.pi-jump-latest')).left, right: getComputedStyle(document.querySelector('.pi-jump-latest')).right, transform: getComputedStyle(document.querySelector('.pi-jump-latest')).transform }
    };
  });
  await page.screenshot({ path: path.join(process.cwd(), '.ai', `wmb-4101-${mode}.png`), fullPage: true });
  await button.click();
  const distance = await conversation.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  const result = { title: await page.title(), geometry, distanceAfterClick: distance };
  writeFileSync(path.join(process.cwd(), '.ai', `wmb-4101-${mode}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (mode === 'after' && (geometry.centerDelta > 1 || distance > 1)) process.exitCode = 1;
} finally { await browser.close(); }
