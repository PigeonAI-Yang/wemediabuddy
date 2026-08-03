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
  if (!await page.locator('.settings-workspace').isVisible()) await page.locator('.sidebar button[title="设置"]').click();
  await page.locator('.settings-nav button[title="X Lists"]').click();
  await page.getByRole('heading', { name: 'List 管理', exact: true }).waitFor();
  await page.locator('.x-list-confirmation').waitFor();
  const settingsText = await page.locator('.settings-content').innerText();
  const confirmationText = await page.locator('.x-list-confirmation').innerText();
  const historyCount = await page.locator('.x-list-history button').count();
  const settingsOverflow = await page.locator('.settings-content').evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  await page.screenshot({ path: path.join(process.cwd(), '.ai', 'wmb-3700-live-settings.png'), fullPage: true });
  await page.locator('.settings-back').click();
  await page.locator('.sidebar button[title="发现"]').click();
  await page.waitForSelector('.discover-page');
  const discoverText = await page.locator('.discover-page').innerText();
  const result = {
    title: await page.title(),
    workspace: await page.locator('.brand small').innerText(),
    settingsHasManagement: settingsText.includes('List 管理') && settingsText.includes('操作记录'),
    preparedOperationVisible: confirmationText.includes('添加成员') && confirmationText.includes('@ukhomeoffice') && confirmationText.includes('读取最新快照'),
    operationHistoryCount: historyCount,
    discoverHasManagement: discoverText.includes('接入今日情报') || discoverText.includes('移出今日情报') || discoverText.split(/\r?\n/).includes('管理'),
    settingsOverflow
  };
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-3700-live-readback.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.title !== 'WeMediaBuddy' || !result.settingsHasManagement || !result.preparedOperationVisible || result.operationHistoryCount < 2 || result.discoverHasManagement || result.settingsOverflow.scrollWidth > result.settingsOverflow.clientWidth) process.exitCode = 1;
} finally {
  await browser.close();
}
