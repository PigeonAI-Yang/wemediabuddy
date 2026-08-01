// WMB-1603: real Electron UI readback. The only X action is the product's read-only List reload.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'wmb-1603-'));
const dataRoot = path.join(temporary, 'root');
const userData = path.join(temporary, 'user-data');
for (const folder of [dataRoot, userData, path.join(dataRoot, 'assets'), path.join(dataRoot, 'browser-profile'), path.join(dataRoot, 'logs'), path.join(dataRoot, 'exports')]) mkdirSync(folder, { recursive: true });
for (const name of ['wmb.db', 'wmb.db-wal', 'wmb.db-shm']) {
  const source = path.join('J:\\PigeonYang\\WeMediaBuddyData', name);
  if (existsSync(source)) copyFileSync(source, path.join(dataRoot, name));
}
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: dataRoot }));

const port = 9357;
const electronBin = new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(electronBin, ['.'], {
  cwd: process.cwd(),
  env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' },
  stdio: ['ignore', 'ignore', 'pipe']
});
child.stderr.on('data', () => {});
const stop = () => { if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); };
process.on('exit', stop);

const getJson = (requestPath) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject);
});

let browser;
try {
  let connected = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await getJson('/json/version'); connected = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.equal(connected, true, 'Electron CDP did not become available');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.goto('file:///J:/PigeonYang/WeMediaBuddy/.vite/renderer/main_window/index.html');
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await page.getByRole('button', { name: '发现', exact: true }).click();
  await page.getByRole('button', { name: 'X Lists', exact: true }).click();
  await page.locator('.x-lists-view').waitFor({ state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: '读取 X Lists', exact: true }).click();
  await page.locator('.x-list-index').waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(400);
  const result = await page.evaluate(() => ({
    account: document.querySelector('.x-list-account strong')?.textContent?.trim() ?? '',
    listCount: document.querySelectorAll('.x-list-row').length,
    noList: Boolean(document.querySelector('.x-list-empty')),
    create: [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('读取快照并准备确认')),
    confirmationCopy: document.body.textContent?.includes('最终确认并执行') ?? false,
    forbiddenSocialActions: ['关注', '私信', '转发'].filter((label) => document.body.textContent?.includes(label)),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }));
  writeFileSync('.ai/wmb-1603-x-lists-1100.png', await page.screenshot());
  assert.match(result.account, /^@[A-Za-z0-9_]{1,15}$/);
  assert.equal(result.create, true);
  assert.equal(result.confirmationCopy, false);
  assert.deepEqual(result.forbiddenSocialActions, []);
  assert.equal(result.overflow, false);
  assert.ok(result.listCount > 0, `expected visible X Lists, got ${result.listCount}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close().catch(() => {});
  stop();
  await new Promise((resolve) => setTimeout(resolve, 800));
}
