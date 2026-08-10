import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createOnboardingState, writeOnboardingState } from '../src/main/onboarding.ts';
import { createTopicMaintenanceProposal } from '../src/main/topic-maintenance.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-5150-ui-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });
const database = migrateDatabase(path.join(root, 'wmb.db'));
const now = new Date().toISOString();
database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','wmb-5150-ui',?,?,1)").run(now, now);
for (const [id, title, key] of [['keep', 'Agent 工作流', 'agent-workflow'], ['old', 'Agent工作流方法', 'agent-workflow-method']]) database.prepare('INSERT INTO topics(id,title,canonical_key,kind,status,created_at,updated_at,revision,first_seen_at,last_seen_at) VALUES(?,?,?,\'theme\',\'active\',?,?,1,?,?)').run(id, title, key, now, now, now, now);
database.prepare("INSERT INTO source_items(id,canonical_url,title,collected_at,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision,verification_status,management_status) VALUES('source','https://example.com/source','测试资料',?,'[]','[]','[]','[]',?,?,1,'pending','active')").run(now, now, now);
database.prepare("INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES('old','source','primary',?,?)").run(now, now);
createTopicMaintenanceProposal(database, { title: '合并重复主题', reason: '名称重复，资料员建议保留长期主题并迁移全部关系。', changes: [{ kind: 'merge', retainedTopicId: 'keep', mergedTopicId: 'old' }] });
database.close();
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));
writeFileSync(path.join(userData, 'workspace-registry.json'), JSON.stringify({ version: 1, activeWorkspaceId: 'wmb-5150-ui', workspaces: [{ id: 'wmb-5150-ui', displayName: '验收空间', rootPath: root }], switchJournal: null }));
writeFileSync(path.join(userData, 'pi-api-config.json'), JSON.stringify({ version: 1, state: { activeId: 'acceptance', profiles: [{ id: 'acceptance', name: '验收', baseUrl: 'https://example.invalid/v1', model: 'gpt-5.4', api: 'openai-responses', encryptedApiKey: 'acceptance-only' }], fallbackOrder: [] } }));
writeOnboardingState(path.join(userData, 'onboarding.json'), { ...createOnboardingState(now), currentStep: 'complete', workspace: { workspaceId: 'wmb-5150-ui', rootPath: root, createdAt: now }, ai: { profileId: 'acceptance', savedAt: now, testedAt: now, lastTest: null }, completedAt: now, updatedAt: now });

const port = 9515;
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData };
const electron = new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(electron, ['.'], { env, cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] });
const cleanup = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} };
process.on('exit', cleanup);
const json = (route) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: route }, (response) => { let body = ''; response.on('data', (chunk) => body += chunk); response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject));
for (let index = 0; index < 60; index++) { try { await json('/json/version'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); } }
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page;
for (let index = 0; index < 60 && !page; index++) { const pages = browser.contexts().flatMap((context) => context.pages()); page = pages.find((candidate) => candidate.url().includes('127.0.0.1:27391')); if (!page) await new Promise((resolve) => setTimeout(resolve, 500)); }
if (!page) throw new Error('WMB_ACCEPTANCE_PAGE_MISSING');
await page.waitForLoadState('domcontentloaded');
await page.getByRole('button', { name: '主题', exact: true }).click();
await page.getByRole('heading', { name: '主题整理提案台账' }).waitFor({ timeout: 30000 });
await page.locator('.topic-maintenance-diff > summary').click();
const session = await page.context().newCDPSession(page);
const readback = {};
for (const [width, height] of [[1440, 900], [1100, 760]]) {
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(300);
  readback[`topic${width}`] = await page.evaluate(() => { const home = document.querySelector('.topic-home'); return { fullDiff: document.body.innerText.includes('画布主题节点') && document.body.innerText.includes('资料 1'), approve: document.querySelector('.topic-maintenance-row button')?.disabled === false, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || !!home && home.scrollWidth > home.clientWidth + 1 }; });
  writeFileSync(`.ai/wmb-5150-topic-${width}.png`, await page.screenshot({ fullPage: true }));
}
await page.getByRole('button', { name: '今日' }).click();
const pending = page.getByText('有 1 份主题整理提案待你批准');
await pending.waitFor({ timeout: 15000 });
await pending.scrollIntoViewIfNeeded();
readback.todayPending = true;
writeFileSync('.ai/wmb-5150-today-pending.png', await page.screenshot({ fullPage: true }));
console.log(JSON.stringify(readback));
await browser.close();
cleanup();
process.exit(Object.values(readback).every((value) => value === true || (value.fullDiff && value.approve && !value.overflow)) ? 0 : 1);
