import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const version = await new Promise((resolve, reject) => http.get('http://127.0.0.1:9371/json/version', (response) => {
  let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
const page = browser.contexts()[0].pages()[0];
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  await page.waitForSelector('#root');
  const sessions = await page.evaluate(() => window.wmb.listPiConversations());
  const titleCounts = new Map(sessions.map((item) => [item.title, sessions.filter((other) => other.title === item.title).length]));
  const target = sessions.find((item) => !item.active && !item.archivedAt && titleCounts.get(item.title) === 1);
  if (!target) throw new Error('No unique inactive conversation available for archive acceptance.');
  const conversationFile = path.join(process.cwd(), 'data', 'ukcontentdata', 'pi-agent', 'conversations', `${target.id}.json`);
  const snapshot = { conversation: hash(conversationFile), session: hash(JSON.parse(readFileSync(conversationFile, 'utf8')).sessionFile) };

  if (!await page.locator('.pi-session-menu').isVisible()) await page.locator('.pi-session-trigger').click();
  if (await page.getByRole('button', { name: '返回', exact: true }).isVisible()) await page.getByRole('button', { name: '返回', exact: true }).click();
  const row = () => page.locator(`.pi-session-row[data-session-id="${target.id}"]`);
  await row().locator('.pi-session-more').click();
  await row().getByRole('button', { name: '归档会话', exact: true }).click();
  await page.waitForFunction((id) => window.wmb.listPiConversations().then((items) => Boolean(items.find((item) => item.id === id)?.archivedAt)), target.id);
  await row().waitFor({ state: 'detached' });
  const hiddenFromDefault = true;
  await page.locator('.pi-session-archived-link').click();
  await row().waitFor();
  await page.screenshot({ path: path.join(process.cwd(), '.ai', 'wmb-4300-archived.png') });
  await row().locator('.pi-session-more').click();
  await row().getByRole('button', { name: '恢复会话', exact: true }).click();
  await page.waitForFunction((id) => window.wmb.listPiConversations().then((items) => items.find((item) => item.id === id)?.archivedAt === null), target.id);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await row().waitFor();
  const restored = await row().count() === 1;
  const after = { conversation: hash(conversationFile), session: hash(JSON.parse(readFileSync(conversationFile, 'utf8')).sessionFile) };
  const result = { target: { id: target.id, title: target.title }, hiddenFromDefault, restored, filesUnchanged: snapshot.conversation === after.conversation && snapshot.session === after.session, snapshot, after };
  writeFileSync(path.join(process.cwd(), '.ai', 'wmb-4300-package-acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!hiddenFromDefault || !restored || !result.filesUnchanged) process.exitCode = 1;
} finally { await browser.close(); }
