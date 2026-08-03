import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const get = (pathname) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:9371${pathname}`, (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
let version;
for (let attempt = 0; attempt < 120 && !version; attempt += 1) {
  try { version = await get('/json/version'); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
}
if (!version) throw new Error('WMB package CDP unavailable');
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root');
  if (await page.locator('.settings-workspace').isVisible().catch(() => false)) await page.locator('.settings-back').click();
  await page.locator('.sidebar button[title="今日"]').click();
  await page.waitForSelector('.today-layout');
  if (await page.locator('.pi-dock.collapsed').isVisible().catch(() => false)) await page.locator('.pi-dock-toggle').click();
  await page.locator('.pi-x-list-approval').waitFor();
  const approval = await page.locator('.pi-x-list-approval').innerText();
  await page.screenshot({ path: path.join(process.cwd(), '.ai', 'wmb-3702-pi-approval.png'), fullPage: true });
  await page.locator('.sidebar button[title="设置"]').click();
  await page.locator('.settings-nav button[title="X Lists"]').click();
  const settings = await page.locator('.settings-content').innerText();
  await page.locator('.settings-back').click();
  await page.locator('.sidebar button[title="今日"]').click();
  const result = {
    title: await page.title(),
    approval,
    piHasOneConfirmation: approval.includes('等待一次确认') && approval.includes('确认并交给 Pi 执行'),
    exactOperationVisible: approval.includes('@KimbomArtist') && approval.includes('英国资讯') && approval.includes('@ukhomeoffice'),
    settingsHasConfirmationAction: settings.includes('最终确认并执行') || settings.includes('读取最新快照')
  };
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-3702-live-readback.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.title !== 'WeMediaBuddy' || !result.piHasOneConfirmation || !result.exactOperationVisible || result.settingsHasConfirmationAction) process.exitCode = 1;
} finally { await browser.close(); }
