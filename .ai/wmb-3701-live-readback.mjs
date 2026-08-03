import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const port = 9371;
const json = (pathname) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject);
});
const deadline = Date.now() + 45_000;
let version;
while (!version && Date.now() < deadline) {
  try { version = await json('/json/version'); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
}
if (!version) throw new Error('真实 WMB 未开放验收 CDP。');

const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root');
  const openXLists = async () => {
    if (!await page.locator('.settings-workspace').isVisible()) await page.locator('.sidebar button[title="设置"]').click();
    await page.locator('.settings-nav button[title="X Lists"]').click();
    await page.locator('.x-list-confirmation').waitFor();
  };
  await openXLists();
  const before = await page.locator('.x-list-confirmation').innerText();
  const historyBefore = await page.locator('.x-list-history button').count();
  await page.screenshot({ path: path.join(process.cwd(), '.ai', 'wmb-3701-awaiting-confirmation.png'), fullPage: true });
  await page.locator('.settings-back').click();
  await page.locator('.sidebar button[title="今日"]').click();
  await page.waitForSelector('.today-layout');
  await openXLists();
  const after = await page.locator('.x-list-confirmation').innerText();
  const result = {
    title: await page.title(),
    operationHistoryCount: historyBefore,
    before,
    after,
    persistedAcrossNavigation: before === after,
    latestAwaitingConfirmation: after.includes('步骤 1/2 已完成 · 步骤 2/2 等待最终确认'),
    truthfulPendingResult: after.includes('尚未执行 · 20 项待处理'),
    finalConfirmationAvailable: after.includes('最终确认并执行')
  };
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-3701-live-readback.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.title !== 'WeMediaBuddy' || result.operationHistoryCount < 2 || !result.persistedAcrossNavigation || !result.latestAwaitingConfirmation || !result.truthfulPendingResult || !result.finalConfirmationAvailable) process.exitCode = 1;
} finally {
  await browser.close();
}
