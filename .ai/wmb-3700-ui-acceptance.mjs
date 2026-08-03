import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const temp = mkdtempSync(path.join(os.tmpdir(), 'wmb-3700-'));
const userData = path.join(temp, 'user-data');
const dataRoot = path.join(temp, 'data-root');
for (const dir of [userData, dataRoot, path.join(dataRoot, 'assets'), path.join(dataRoot, 'browser-profile'), path.join(dataRoot, 'logs'), path.join(dataRoot, 'exports')]) mkdirSync(dir, { recursive: true });
copyFileSync(path.join(process.cwd(), 'data', 'ukcontentdata', 'wmb.db'), path.join(dataRoot, 'wmb.db'));
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: dataRoot }));
copyFileSync(path.join(process.env.APPDATA, 'WeMediaBuddy', 'browser-config.json'), path.join(userData, 'browser-config.json'));

const cdpPort = 9370;
const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd start'], {
  cwd: process.cwd(),
  env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(cdpPort), WMB_ACCEPTANCE_USER_DATA: userData },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const json = (pathname) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: cdpPort, path: pathname }, (res) => {
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
if (!version) throw new Error(`Electron CDP did not start: ${stderr.slice(-2000)}`);

const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
try {
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root');
  await page.locator('.sidebar button[title="设置"]').click();
  await page.locator('.settings-nav button[title="X Lists"]').click();
  await page.getByRole('heading', { name: 'List 管理', exact: true }).waitFor();
  const settingsText = await page.locator('.settings-content').innerText();
  const prepared = await page.locator('.x-list-confirmation').innerText();
  const settingsOverflow = await page.locator('.settings-content').evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  await page.locator('.sidebar button[title="发现"]').click();
  await page.waitForSelector('.discover-page');
  const discoverText = await page.locator('.discover-page').innerText();
  const result = {
    title: await page.title(),
    settingsHasManagement: settingsText.includes('List 管理') && settingsText.includes('操作记录'),
    preparedOperationVisible: prepared.includes('添加成员') && prepared.includes('@ukhomeoffice') && prepared.includes('读取最新快照'),
    discoverHasManagement: discoverText.includes('接入今日情报') || discoverText.includes('移出今日情报') || discoverText.split(/\r?\n/).includes('管理'),
    settingsOverflow
  };
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-3700-ui-acceptance.json'), JSON.stringify({ ...result, temp }, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.title !== 'WeMediaBuddy' || !result.settingsHasManagement || !result.preparedOperationVisible || result.discoverHasManagement || result.settingsOverflow.scrollWidth > result.settingsOverflow.clientWidth) process.exitCode = 1;
} finally {
  await browser.close();
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
}
