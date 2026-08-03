import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const get = (pathname) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:9371${pathname}`, (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
const version = await get('/json/version');
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root');
  if (await page.locator('.pi-dock.collapsed').isVisible().catch(() => false)) await page.locator('.pi-dock-toggle').click();
  const conversation = page.locator('.pi-conversation');
  await conversation.waitFor();
  const initial = await conversation.evaluate((node) => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
  await conversation.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const latest = page.locator('.pi-jump-latest');
  await latest.waitFor();
  const held = await conversation.evaluate((node) => node.scrollTop);
  await page.screenshot({ path: path.join(process.cwd(), '.ai', 'wmb-3800-scroll-held.png'), fullPage: true });
  await latest.click();
  const returned = await conversation.evaluate((node) => ({ scrollTop: node.scrollTop, distance: node.scrollHeight - node.clientHeight - node.scrollTop }));
  const result = { title: await page.title(), initial, held, returnButtonVisible: true, returned };
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-3800-live-readback.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.title !== 'WeMediaBuddy' || initial.scrollHeight <= initial.clientHeight || held !== 0 || returned.distance > 1) process.exitCode = 1;
} finally { await browser.close(); }
