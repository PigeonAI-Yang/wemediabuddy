import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const liveRoot = 'J:\\PigeonYang\\WeMediaBuddyData';
const temp = mkdtempSync(path.join(os.tmpdir(), 'wmb-1036-'));
const root = path.join(temp, 'root');
const userData = path.join(temp, 'user-data');
for (const directory of [root, userData, 'assets', 'browser-profile', 'exports', 'logs']) {
  mkdirSync(path.isAbsolute(directory) ? directory : path.join(root, directory), { recursive: true });
}
copyFileSync(path.join(liveRoot, 'wmb.db'), path.join(root, 'wmb.db'));
const liveUserData = path.join(process.env.APPDATA, 'WeMediaBuddy');
if (existsSync(path.join(liveUserData, 'Local State'))) copyFileSync(path.join(liveUserData, 'Local State'), path.join(userData, 'Local State'));
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));

const CDP = 9360;
const env = {
  ...process.env,
  WMB_ACCEPTANCE_CDP_PORT: String(CDP),
  WMB_ACCEPTANCE_USER_DATA: userData,
  WMB_ACCEPTANCE_HEADLESS: '1'
};
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const child = spawn(executable, [], { cwd: path.dirname(executable), env, stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} };
process.on('exit', cleanup);
const getJson = (requestPath) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP, path: requestPath }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject);
});
let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { await getJson('/json/version'); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
}
if (!ready) throw new Error('打包桌面端未暴露 CDP。');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
const page = browser.contexts()[0].pages()[0];
await page.waitForSelector('.pi-composer textarea', { timeout: 30000 });
const settings = await page.evaluate(() => window.wmb.getSettings());
await page.evaluate(() => {
  window.__wmbPiEvents = [];
  window.wmb.onPiEvent((event) => window.__wmbPiEvents.push(event));
});

const slowPrompt = '先用 bash 执行 PowerShell Start-Sleep 12 秒，结束后只回复 done。不要提前回复。';
const queuedPrompt = '插队';
const composer = page.locator('.pi-composer textarea');
await composer.fill(slowPrompt);
await composer.press('Enter');
await page.waitForTimeout(2500);
const starting = await page.evaluate(() => ({
  composerDisabled: document.querySelector('.pi-composer textarea')?.disabled ?? true,
  buttonClass: document.querySelector('.pi-send-button')?.className ?? '',
  dockStatus: document.querySelector('.pi-dock-title-row span[data-phase]')?.textContent ?? '',
  phase: document.querySelector('.pi-dock-title-row span[data-phase]')?.getAttribute('data-phase') ?? ''
}));
if (!starting.buttonClass.includes('pi-stop-button')) throw new Error(JSON.stringify({ settings, starting }));
await composer.fill(queuedPrompt);
await composer.press('Enter');
await page.waitForTimeout(1200);
const during = await page.evaluate(() => ({
  inputEnabled: !(document.querySelector('.pi-composer textarea')?.disabled ?? true),
  squareStop: Boolean(document.querySelector('.pi-send-button.pi-stop-button rect')),
  messageCount: document.querySelectorAll('.pi-bubble-wrap').length,
  queueText: document.querySelector('.pi-native-queue')?.textContent ?? '',
  dockStatus: document.querySelector('.pi-dock-title-row span[data-phase]')?.textContent ?? '',
  phase: document.querySelector('.pi-dock-title-row span[data-phase]')?.getAttribute('data-phase') ?? '',
  events: window.__wmbPiEvents.slice(-20)
}));
if (during.messageCount < 2 || !during.queueText.includes('插队')) throw new Error(JSON.stringify({ during }));
await page.click('.pi-send-button.pi-stop-button');
await page.waitForFunction(() => ['stopped', 'idle', 'failed'].includes(document.querySelector('.pi-dock-title-row span[data-phase]')?.getAttribute('data-phase') ?? ''), null, { timeout: 60000 });
const first = await page.evaluate(() => ({
  phase: document.querySelector('.pi-dock-title-row span[data-phase]')?.getAttribute('data-phase') ?? '',
  messages: [...document.querySelectorAll('.pi-bubble-wrap')].map((node) => node.textContent?.trim() ?? '')
}));
await page.waitForSelector('.pi-bubble-wrap.user button[title="按 Pi 原生分叉撤回"]', { timeout: 10000 });
const forkReady = await page.evaluate(() => Boolean(document.querySelector('.pi-bubble-wrap.user button[title="按 Pi 原生分叉撤回"]')));
if (forkReady) {
  await page.evaluate(() => (document.querySelector('.pi-bubble-wrap.user button[title="按 Pi 原生分叉撤回"]') ).click());
  await page.waitForFunction(() => (document.querySelector('.pi-composer textarea') ).value.includes('先用 bash'), null, { timeout: 10000 });
}
const after = await page.evaluate((forkReady) => ({
  userMessages: [...document.querySelectorAll('.pi-bubble-wrap.user .pi-bubble')].map((node) => node.textContent?.trim() ?? ''),
  input: (document.querySelector('.pi-composer textarea') ).value,
  forkReady
}), forkReady);
const receipt = { during, first, after };
writeFileSync('.ai/wmb-1036-receipt.json', JSON.stringify(receipt, null, 2));
writeFileSync('.ai/wmb-1036.png', await page.screenshot());
await browser.close();
cleanup();
const pass = during.inputEnabled && during.squareStop && during.messageCount >= 2 && during.queueText.includes('插队') && first.phase === 'stopped' && forkReady && after.input.includes('先用 bash');
console.log(JSON.stringify(receipt, null, 2));
process.exit(pass ? 0 : 1);
