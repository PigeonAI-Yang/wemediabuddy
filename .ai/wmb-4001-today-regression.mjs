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
  if (await page.locator('.settings-workspace').isVisible().catch(() => false)) await page.locator('.settings-back').click();
  await page.locator('.sidebar button[title="今日"]').click();
  await page.locator('.today-layout').waitFor();
  const rows = page.locator('.fermenting-rail .fermenting-row');
  const result = {
    title: await page.title(),
    rowCount: await rows.count(),
    actions: await rows.locator('.fermenting-actions button').allTextContents(),
    creationActions: await rows.locator('[aria-label="开始创作"]').count(),
    sourceUrl: page.url()
  };
  await page.screenshot({ path: path.join(process.cwd(), '.ai', 'wmb-4001-today-after.png'), fullPage: true });
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-4001-today-after.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.rowCount || result.creationActions !== result.rowCount || result.actions.includes('继续做') || result.actions.includes('观察') || result.actions.includes('不再显示')) process.exitCode = 1;
} finally { await browser.close(); }
