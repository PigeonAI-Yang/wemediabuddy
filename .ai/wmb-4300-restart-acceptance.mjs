import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const mode = process.argv[2];
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-4300-restart-target.json');
const version = await new Promise((resolve, reject) => http.get('http://127.0.0.1:9371/json/version', (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body))); }).on('error', reject));
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
const page = browser.contexts()[0].pages()[0];
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  await page.waitForSelector('#root');
  if (mode === 'restore') { await page.evaluate((id) => window.wmb.archivePiConversation(id, false), process.argv[3]); console.log(JSON.stringify({ restored: process.argv[3] })); process.exit(0); }
  if (!await page.locator('.pi-session-menu').isVisible()) await page.locator('.pi-session-trigger').click();
  if (await page.getByRole('button', { name: '返回', exact: true }).isVisible()) await page.getByRole('button', { name: '返回', exact: true }).click();
  if (mode === 'archive') {
    const sessions = await page.evaluate(() => window.wmb.listPiConversations());
    const target = sessions.find((item) => !item.active && !item.archivedAt);
    if (!target) throw new Error('No inactive conversation available.');
    const conversationFile = path.join(process.cwd(), 'data', 'ukcontentdata', 'pi-agent', 'conversations', `${target.id}.json`);
    const sessionFile = JSON.parse(readFileSync(conversationFile, 'utf8')).sessionFile;
    const row = page.locator(`.pi-session-row[data-session-id="${target.id}"]`);
    const beforeCount = await page.locator('.pi-session-row').count();
    writeFileSync(receiptPath, JSON.stringify({ target, conversationFile, sessionFile, conversationHash: hash(conversationFile), sessionHash: hash(sessionFile) }, null, 2));
    await row.locator('.pi-session-more').click(); await row.getByRole('button', { name: '归档会话', exact: true }).click(); await page.waitForFunction((count) => document.querySelectorAll('.pi-session-row').length === count - 1, beforeCount);
    console.log(JSON.stringify({ archived: target.id }));
  } else {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const persisted = await page.evaluate((id) => window.wmb.listPiConversations().then((items) => items.find((item) => item.id === id)?.archivedAt ?? null), receipt.target.id);
    if (!persisted) throw new Error('Archive did not survive restart.');
    await page.locator('.pi-session-archived-link').click();
    const row = page.locator(`.pi-session-row[data-session-id="${receipt.target.id}"]`);
    await row.waitFor(); const beforeCount = await page.locator('.pi-session-row').count(); await row.locator('.pi-session-more').click(); await row.getByRole('button', { name: '恢复会话', exact: true }).click(); await page.waitForFunction((count) => document.querySelectorAll('.pi-session-row').length === count - 1, beforeCount);
    const result = { persistedAfterRestart: true, restored: true, filesUnchanged: hash(receipt.conversationFile) === receipt.conversationHash && hash(receipt.sessionFile) === receipt.sessionHash };
    writeFileSync(path.join(process.cwd(), '.ai', 'wmb-4300-restart-acceptance.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.filesUnchanged) process.exitCode = 1;
  }
} finally { await browser.close(); }
