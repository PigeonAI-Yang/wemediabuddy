import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { enrollAiWorkspace, createOfficialWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';
import { createWebsiteSource, recordSourceScanReceipt } from '../src/main/intelligence-channels.ts';
import { startDailyChannelRun } from '../src/main/daily-intelligence-channels.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';
import { completeAgentTask, agentRequestId } from '../src/main/agent-tasks.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { resolveXListCandidates, confirmResolvedXList } from '../src/main/x-list-channel.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { configureRealXBrowser, exerciseRealXViaUi } from './wmb-2107-x-acceptance.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = process.env.WMB_2107_PACKAGE_DIR || path.join(os.tmpdir(), 'wmb-2107-package-fixed');
const appRoot = path.join(packageRoot, 'WeMediaBuddy-win32-x64');
const executable = path.join(appRoot, 'WeMediaBuddy.exe');
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-2107-package-acceptance.json');
const shotBase = path.join(process.cwd(), '.ai');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-2107-acceptance-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
const receipt = { task: 'WMB-2107', startedAt: new Date().toISOString(), package: {}, evaluations: {}, screenshots: [], rootCause: {
  id: 'workspace-gate-channel-confirm',
  reproduction: 'Before fix, delayed intelligence-channels:proposal-confirm did not increment WorkspaceRuntimeGate.active; closeAndDrain returned before release.',
  fix: 'Removed intelligence-channels:proposal-confirm from the index exemption list and added a drain/late-write regression.'
} };
let launched = null;
let packagedMissingLogin = null;

try {
  assert.equal(existsSync(executable), true, `packaged executable missing: ${executable}`);
  receipt.package = {
    root: packageRoot,
    executable: executable,
    exeSha256: await sha256(executable),
    asarSha256: await sha256(path.join(appRoot, 'resources', 'app.asar')),
    extension: await verifyPackagedExtension()
  };
  await mkdir(userData, { recursive: true });
  const openedAi = await openDataRoot(path.join(temp, 'ai'));
  migrateDatabase(path.join(openedAi.path, 'wmb.db')).close();
  const ai = await enrollAiWorkspace({ registryPath, rootPath: openedAi.path });
  const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(temp, 'uk'), templateId: 'official.uk' });
  const registry = await readWorkspaceRegistry(registryPath);
  const xProbe = await probeCdp(9334);
  if (xProbe.ok) configureRealXBrowser(ai.rootPath);

  launched = await launch({ workspace: ai, registry, port: 29611 });
  const page = launched.page;
  const settings = await page.evaluate(() => window.wmb.getSettings());
  assert.equal(await page.title(), 'WeMediaBuddy');
  assert.equal(await page.locator('#root').count(), 1);
  assert.equal(settings.workspace.id, ai.id);

  const website = await evaluate('EVAL-020', async () => {
    await goChannels(page);
    const before = counts(ai.rootPath);
    const queued = await queueWebsiteFromUi(page, 'https://www.gov.uk/government/news');
    assert.match(await page.locator('.channel-proposal-list').innerText(), /待确认的来源变更/);
    assert.match(await page.locator('.channel-proposal-list').innerText(), /确认这 1 项变更/);
    receipt.screenshots.push(...await capturePendingProposal(page));
    assert.equal(counts(ai.rootPath).items, before.items, 'confirmation check must not create a source item');
    await confirmFirstProposal(page);
    const channels = await page.evaluate(() => window.wmb.getIntelligenceChannels());
    const source = channels.summary.sources.find((item) => item.module === 'official_web' && item.canonicalUrl === queued.canonicalUrl);
    assert.ok(source, 'confirmed website must read back from this root');
    assert.equal(source.enabled, true);
    assert.equal(counts(ai.rootPath).items, before.items, 'confirmed website must still have no source item before scanning');
    const duplicateBefore = counts(ai.rootPath);
    const duplicate = await page.evaluate(async ({ inputText, candidate, trialRead }) => {
      try { await window.wmb.prepareIntelligenceChannelProposal({ requestId: crypto.randomUUID(), changes: [{ action: 'add', module: 'official_web', inputText, candidate, trialRead }] }); return { ok: true }; }
      catch (error) { return { ok: false, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) }; }
    }, queued);
    assert.equal(duplicate.ok, false, 'canonical duplicate must be rejected');
    assert.match(duplicate.message, /来源已存在/);
    const duplicateAfter = counts(ai.rootPath);
    assert.deepEqual(duplicateAfter, duplicateBefore, 'canonical duplicate must write zero rows');
    const unreadable = await page.evaluate(() => window.wmb.trialReadWebsite({ url: 'https://www.gov.uk/wmb-2107-not-found' }));
    assert.equal(unreadable.readable, false);
    assert.ok(unreadable.errorCode && unreadable.errorMessage, 'unreadable public URL must preserve a reason');
    const scanned = await page.evaluate((input) => window.wmb.scanIntelligenceChannel(input), {
      module: source.module, sourceId: source.sourceId, expectedRevision: source.revision
    });
    assert.equal(scanned.receipt.status, 'succeeded');
    return { canonicalUrl: queued.canonicalUrl, sourceId: source.sourceId, duplicateCanonical: { rejected: true, transportCode: duplicate.code, message: duplicate.message, countsBefore: duplicateBefore, countsAfter: duplicateAfter }, unreadable: { code: unreadable.errorCode, message: unreadable.errorMessage }, scan: scanned.receipt, beforeItems: before.items, afterItems: counts(ai.rootPath).items };
  });

  const today = await evaluate('EVAL-022', async () => {
    await goToday(page);
    const selection = page.locator('.today-channel-selection');
    await selection.waitFor();
    const boxes = selection.locator('input[type="checkbox"]');
    assert.equal(await boxes.count(), 2);
    assert.deepEqual(await boxes.evaluateAll((items) => items.map((item) => item.checked)), [true, true]);
    assert.match(await selection.innerText(), /请先在设置中配置 Pi API。/);
    await boxes.nth(1).click();
    assert.equal(await boxes.nth(1).isChecked(), false);
    await page.evaluate(() => window.wmb.savePiConfig({ name: 'WMB-2107 仅预检', baseUrl: 'https://example.invalid/v1', model: 'acceptance-only', api: 'openai-responses', apiKey: 'not-used' }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selection.waitFor();
    const afterConfig = selection.locator('input[type="checkbox"]');
    await afterConfig.nth(0).click();
    await afterConfig.nth(1).click();
    assert.match(await selection.innerText(), /请至少选择一个情报模块。/);
    assert.equal(await page.locator('.today-command-actions > .primary-button').isDisabled(), true);
    await page.screenshot({ path: path.join(shotBase, 'wmb-2107-today-preflight-1100x760.png') });
    receipt.screenshots.push(path.join(shotBase, 'wmb-2107-today-preflight-1100x760.png'));
    const emptyPayload = await page.evaluate(() => window.wmb.startDailyIntelligence({ businessDate: '2026-08-23', modules: [] }));
    assert.equal(emptyPayload.ok, true);
    assert.equal(emptyPayload.data.task.status, 'needs_user');
    assert.deepEqual(emptyPayload.data.task.contextRefs.intelligenceChannels.modules, []);
    const production = await productionDailyEvidence();
    return { uiDefaultModules: ['official_web', 'x_lists'], uiDeselected: true, uiPreflight: '请至少选择一个情报模块。', packagePayloadModules: emptyPayload.data.task.contextRefs.intelligenceChannels.modules, production };
  });

  if (xProbe.ok) {
    await evaluate('EVAL-021', async () => exerciseRealXViaUi({ page, rootPath: ai.rootPath, counts, goChannels, confirmFirstProposal }));
  }

  const mcpEvidence = await evaluate('EVAL-023', async () => {
    const mcp = await page.evaluate(() => window.wmb.getSettings().then((value) => value.mcp.url));
    const initialized = await mcpRequest(mcp, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-2107', version: '1' } });
    const listed = await mcpRequest(mcp, 'tools/list', {}, initialized.sessionId);
    const names = listed.data.tools.map((tool) => tool.name);
    assert.equal(names.includes('intelligence_channels.proposals.prepare'), true);
    assert.equal(names.some((name) => /^intelligence_channels\..*confirm/i.test(name)), false);
    const prepared = await prepareViaMcp(mcp, initialized.sessionId, 'https://www.gov.uk/browse/visas-immigration');
    const pending = await page.evaluate(() => window.wmb.listIntelligenceChannelProposals());
    const entry = pending.find((item) => item.proposal.id === prepared.id);
    assert.ok(entry, 'MCP prepared exact diff must be visible to packaged UI');
    const before = counts(ai.rootPath);
    const stale = await page.evaluate(async (binding) => {
      try { await window.wmb.confirmIntelligenceChannelProposal({ ...binding, workspaceId: 'stale-workspace' }); return { ok: true }; }
      catch (error) { return { ok: false, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) }; }
    }, entry.binding);
    assert.equal(stale.ok, false);
    assert.match(stale.message, /来源变更确认已失效/);
    const staleAfter = counts(ai.rootPath);
    assert.deepEqual(staleAfter, before, 'stale channel confirmation must write zero');
    await goChannels(page);
    await confirmFirstProposal(page);
    const confirmed = await page.evaluate(() => window.wmb.getIntelligenceChannels());
    assert.equal(confirmed.summary.sources.some((item) => item.canonicalUrl === prepared.canonicalUrl), true);
    return { mcpUrl: mcp, prepareTool: true, confirmTools: names.filter((name) => /^intelligence_channels\..*confirm/i.test(name)), staleConfirmation: { expectedCode: 'CONFIRMATION_STALE', transportCode: stale.code, rejected: true, message: stale.message, countsBefore: before, countsAfter: staleAfter }, uiConfirmedCanonicalUrl: prepared.canonicalUrl };
  });

  await launched.close();
  launched = null;
  const xFixtures = await fixtureXIsolation(ai, uk);
  const ukRun = await launch({ workspace: uk, registry, port: 29612 });
  try {
    const ukPage = ukRun.page;
    await goChannels(ukPage);
    const missingBefore = counts(uk.rootPath);
    const missing = await ukPage.evaluate(async () => {
      try { return { ok: true, value: await window.wmb.resolveXListCandidates({ inputText: '2082851520417255750' }) }; }
      catch (error) { return { ok: false, code: error?.code ?? 'BROWSER_NEEDS_USER', message: error instanceof Error ? error.message : String(error) }; }
    });
    assert.equal(missing.ok, false, 'an unconfigured root must not resolve a current-account X List');
    assert.deepEqual(counts(uk.rootPath), missingBefore, 'missing X login/configuration must write zero rows');
    packagedMissingLogin = { rejected: true, transportCode: missing.code, message: missing.message, countsBefore: missingBefore, countsAfter: counts(uk.rootPath) };
    const queued = await queueWebsiteFromUi(ukPage, 'https://www.gov.uk/government/news');
    await confirmFirstProposal(ukPage);
    const channels = await ukPage.evaluate(() => window.wmb.getIntelligenceChannels());
    const source = channels.summary.sources.find((item) => item.module === 'official_web' && item.canonicalUrl === queued.canonicalUrl);
    assert.ok(source);
    const scanned = await ukPage.evaluate((input) => window.wmb.scanIntelligenceChannel(input), { module: source.module, sourceId: source.sourceId, expectedRevision: source.revision });
    assert.equal(scanned.receipt.status, 'succeeded');
    receipt.ukWebsite = { canonicalUrl: queued.canonicalUrl, sourceId: source.sourceId, receipt: scanned.receipt };
  } finally { await ukRun.close(); }

  const coldAi = await launch({ workspace: ai, registry, port: 29613 });
  let aiState;
  try {
    const aiChannels = await coldAi.page.evaluate(() => window.wmb.getIntelligenceChannels());
    aiState = isolatedState(ai.rootPath, aiChannels);
  } finally { await coldAi.close(); }
  const coldUk = await launch({ workspace: uk, registry, port: 29614 });
  try {
    const ukChannels = await coldUk.page.evaluate(() => window.wmb.getIntelligenceChannels());
    const ukState = isolatedState(uk.rootPath, ukChannels);
    assert.notEqual(aiState.websiteSourceId, ukState.websiteSourceId);
    assert.notEqual(aiState.xBindingId, ukState.xBindingId);
    assert.equal(aiState.itemIds.some((id) => ukState.itemIds.includes(id)), false);
    assert.equal(aiState.receiptIds.some((id) => ukState.receiptIds.includes(id)), false);
    receipt.evaluations['EVAL-023'] = { status: xProbe.ok ? 'pass' : 'partial', evidence: { ...mcpEvidence, coldAi: aiState, coldUk: ukState, xFixture: xFixtures, realX: xProbe.ok ? receipt.evaluations['EVAL-021']?.evidence?.currentAccount : 'blocked: 127.0.0.1:9334 unavailable' } };
  } finally { await coldUk.close(); }

  if (xProbe.ok && receipt.evaluations['EVAL-021']?.status === 'pass') {
    receipt.evaluations['EVAL-021'].evidence.packagedMissingLogin = packagedMissingLogin;
    receipt.evaluations['EVAL-021'].evidence.fixture = xFixtures;
  } else if (!xProbe.ok) {
    receipt.evaluations['EVAL-021'] = { status: 'blocked', reason: '127.0.0.1:9334 is not reachable; no authorized current-root X account can be read.', evidence: { probe: xProbe, packagedMissingLogin, fixture: xFixtures } };
  }
  const todayEvaluation = receipt.evaluations['EVAL-022'];
  try {
    const layout = await runTodayLayoutCheck();
    assert.equal(layout.failure, null, 'Today layout package check failed');
    assert.equal(layout.result?.readable, true, 'Today layout package check was not readable');
    if (todayEvaluation?.status === 'pass') {
      todayEvaluation.evidence.layout = { output: layout.output, result: layout.result, viewportReports: layout.viewportReports, screenshots: layout.screenshots };
      receipt.screenshots.push(...layout.screenshots);
    }
  } catch (error) {
    receipt.evaluations['EVAL-022'] = { status: 'fail', prior: todayEvaluation, error: serializeError(error) };
  }
  if (!receipt.evaluations['EVAL-023']) receipt.evaluations['EVAL-023'] = { status: 'fail', error: 'EVAL-023 did not reach cold-root readback.' };
} catch (error) {
  receipt.fatal = serializeError(error);
} finally {
  if (launched) await launched.close().catch(() => {});
  receipt.finishedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

if (receipt.fatal || Object.values(receipt.evaluations).some((item) => item.status === 'fail')) process.exitCode = 1;

async function evaluate(id, action) {
  try {
    const evidence = await action();
    receipt.evaluations[id] = { status: 'pass', evidence };
    return evidence;
  } catch (error) {
    receipt.evaluations[id] = { status: 'fail', error: serializeError(error) };
    return null;
  }
}

async function verifyPackagedExtension() {
  const extensionRoot = path.join(appRoot, 'resources', 'extensions', 'wmb-mcp');
  const required = ['index.ts', 'wmb-mcp-tools-workspaces.ts', 'wmb-mcp-tools-intelligence-channels.ts'];
  for (const name of required) assert.equal(existsSync(path.join(extensionRoot, name)), true, `missing packaged extension resource ${name}`);
  const extension = (await import(`${pathToFileURL(path.join(extensionRoot, 'index.ts')).href}?wmb2107=${Date.now()}`)).default;
  const names = [];
  extension({ registerTool(tool) { names.push(tool.name); } });
  assert.equal(names.includes('wmb_get_current_workspace'), true);
  assert.equal(names.includes('wmb_prepare_intelligence_channel_changes'), true);
  return { root: extensionRoot, required, toolCount: names.length, prepareOnly: !names.some((name) => /confirm.*intelligence|intelligence.*confirm/i.test(name)) };
}

async function runTodayLayoutCheck() {
  const phase = 'final-current';
  const output = path.join(process.cwd(), '.ai', `wmb-2107-today-layout-${phase}.json`);
  await execFileAsync(process.execPath, ['.ai/wmb-2107-today-layout-check.mjs'], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, WMB_2107_PACKAGE_DIR: packageRoot, WMB_2107_LAYOUT_PHASE: phase, WMB_2107_LAYOUT_EXPECT: 'readable' }
  });
  return { output, ...JSON.parse(await readFile(output, 'utf8')) };
}

async function launch({ workspace, registry, port }) {
  await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
  const child = spawn(executable, [], { cwd: appRoot, env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore', windowsHide: true });
  const browser = await waitForBrowser(port);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root', { timeout: 30_000 });
  return { page, close: async () => { await browser.close().catch(() => {}); await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}); } };
}

async function goChannels(page) {
  await page.evaluate(() => localStorage.setItem('wmb.view', 'discover'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.intelligence-channels', { timeout: 20_000 });
}

async function goToday(page) {
  await page.evaluate(() => localStorage.setItem('wmb.view', 'today'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.today-channel-selection', { timeout: 20_000 });
}

async function queueWebsiteFromUi(page, inputText) {
  const form = page.locator('[aria-labelledby="add-website-title"]');
  await form.locator('input').fill(inputText);
  await form.getByRole('button', { name: '识别网站', exact: true }).click();
  await page.locator('[aria-label="官网候选"]').waitFor({ timeout: 20_000 });
  await form.getByRole('button', { name: '试读所选网站', exact: true }).click();
  const add = form.getByRole('button', { name: '加入待确认清单', exact: true });
  await add.waitFor({ timeout: 30_000 });
  const selected = await page.evaluate(async (value) => {
    const candidates = await window.wmb.resolveWebsiteCandidates({ inputText: value });
    const candidate = candidates[0];
    return { inputText: value, candidate, trialRead: await window.wmb.trialReadWebsite({ url: candidate.url }), canonicalUrl: candidate.canonicalUrl };
  }, inputText);
  assert.equal(selected.trialRead.readable, true);
  await add.click();
  try { await page.locator('.channel-proposal-list').waitFor({ timeout: 15_000 }); }
  catch {
    const note = await page.locator('.channel-note').allTextContents();
    throw new Error(`官网待确认清单未出现：${note.join(' | ') || '无界面提示'}`);
  }
  return { ...selected, candidateCanonicalUrl: selected.canonicalUrl, canonicalUrl: selected.trialRead.url };
}

async function confirmFirstProposal(page) {
  const button = page.locator('.channel-proposal-list button').first();
  await button.waitFor({ timeout: 15_000 });
  await button.click();
  await page.waitForFunction(() => !document.querySelector('.channel-proposal-list'));
}

async function capturePendingProposal(page) {
  const proposal = page.locator('.channel-proposal-list');
  await proposal.scrollIntoViewIfNeeded();
  const files = [];
  for (const { width, height } of [{ width: 1672, height: 982 }, { width: 1366, height: 768 }, { width: 1100, height: 760 }]) {
    await page.setViewportSize({ width, height });
    await proposal.scrollIntoViewIfNeeded();
    const file = path.join(shotBase, `wmb-2107-channels-pending-${width}x${height}.png`);
    await page.screenshot({ path: file });
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('.channel-proposal-list button')].map((item) => { const box = item.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }) }));
    assert.equal(layout.scrollWidth <= layout.width, true, `${width}px channel view overflows horizontally`);
    assert.equal(layout.buttons.every((box) => box.left >= 0 && box.right <= layout.width && box.bottom > 0 && box.top < height), true, `${width}px confirm hit target is clipped`);
    files.push(file);
  }
  return files;
}

async function prepareViaMcp(url, sessionId, inputText) {
  const resolved = mcpText(await mcpRequest(url, 'tools/call', { name: 'intelligence_channels.resolve_website', arguments: { input_text: inputText } }, sessionId));
  assert.equal(resolved.ok, true);
  const candidate = resolved.data[0];
  const trial = mcpText(await mcpRequest(url, 'tools/call', { name: 'intelligence_channels.trial_website', arguments: { url: candidate.url } }, sessionId));
  assert.equal(trial.ok, true);
  assert.equal(trial.data.readable, true);
  const prepared = mcpText(await mcpRequest(url, 'tools/call', { name: 'intelligence_channels.proposals.prepare', arguments: { request_id: randomUUID(), changes: [{ action: 'add', module: 'official_web', input_text: inputText, candidate, trial_read: trial.data }] } }, sessionId));
  assert.equal(prepared.ok, true);
  return { id: prepared.data.id, canonicalUrl: trial.data.url, candidateCanonicalUrl: candidate.canonicalUrl, displayedDiff: prepared.data.displayedDiff };
}

async function productionDailyEvidence() {
  const zero = await dailyScenario('zero', async (database, workspaceId, source) => {
    const run = await startDailyChannelRun(database, { businessDate: '2026-08-24', workspaceId, profileRevision: 1, modules: ['official_web'] }, { scanWebsite: async (_db, input) => recordSourceScanReceipt(database, { taskId: input.taskId, workspaceId: input.workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId, status: 'succeeded', candidateCount: 0, savedCount: 0 }) });
    savePlanReadback(database, run.task, '2026-08-24');
    const completed = completeAgentTask(database, run.task.id);
    assert.equal(run.aggregation.status, 'succeeded'); assert.equal(completed.data.status, 'succeeded'); assert.equal(completed.data.resultRefs.opportunityCount, 0);
    return { status: completed.data.status, receipts: run.aggregation.receipts.length, opportunities: completed.data.resultRefs.opportunityCount };
  });
  const partial = await dailyScenario('partial', async (database, workspaceId, source) => {
    const bad = createWebsiteSource(database, { inputText: 'https://example.com/bad', name: 'Bad', canonicalUrl: 'https://example.com/bad', resolutionStatus: 'ready', trialRead: { title: 'Bad', url: 'https://example.com/bad', readable: true } });
    const run = await startDailyChannelRun(database, { businessDate: '2026-08-25', workspaceId, profileRevision: 1 }, { scanWebsite: async (_db, input) => {
      if (input.sourceId === bad.id) throw Object.assign(new Error('fixture upstream failed'), { code: 'WEBSITE_TRIAL_FAILED' });
      upsertSource(database, { feedId: source.sourceFeedId, originalUrl: 'https://example.com/good/item', title: 'Committed item' });
      recordSourceScanReceipt(database, { taskId: input.taskId, workspaceId: input.workspaceId, module: 'official_web', sourceId: source.id, sourceFeedId: source.sourceFeedId, status: 'succeeded', candidateCount: 1, savedCount: 1 });
    } });
    savePlanReadback(database, run.task, '2026-08-25');
    const completed = completeAgentTask(database, run.task.id);
    assert.equal(run.aggregation.status, 'partial'); assert.equal(completed.data.status, 'partial'); assert.equal(countsForDatabase(database).items, 1);
    return { status: completed.data.status, receipts: run.aggregation.receipts.map((item) => item.status), itemCount: countsForDatabase(database).items };
  });
  const blocked = await blockedScenario();
  const noReceipt = await dailyScenario('no-receipt', async (database, workspaceId) => {
    const run = await startDailyChannelRun(database, { businessDate: '2026-08-26', workspaceId, profileRevision: 1, modules: ['official_web'] }, { scanWebsite: async () => {} });
    assert.equal(run.task.status, 'failed'); assert.equal(run.aggregation.missingReceiptCount, 1);
    return { status: run.task.status, missingReceiptCount: run.aggregation.missingReceiptCount };
  });
  return { zero, partial, allBlocked: blocked, noTrustworthyReceipt: noReceipt, fixture: true };
}

async function dailyScenario(name, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), `wmb-2107-${name}-`));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const workspaceId = `workspace-${name}`;
  try {
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
    const source = createWebsiteSource(database, { inputText: 'https://example.com/good', name: 'Good', canonicalUrl: 'https://example.com/good', resolutionStatus: 'ready', trialRead: { title: 'Good', url: 'https://example.com/good', readable: true } });
    return await action(database, workspaceId, source);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

async function blockedScenario() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-2107-blocked-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const workspaceId = 'workspace-blocked';
  try {
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, now, now);
    insertWorkspaceProfile(database, { profileId: 'profile.test.uk', revision: 1, officialTemplateId: null, officialTemplateVersion: null, displayName: '英国生活', audience: '在英华人', contentGoal: '生活信息', editorialBrief: '实用优先', intelligencePackId: 'uk-life-content-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x'] });
    const binding = bindXList(database, { accountKey: '@owner', list: { listId: '101', canonicalUrl: 'https://x.com/i/lists/101', ownerHandle: '@owner', name: 'blocked', kind: 'owned' } });
    assert.equal(binding.ok, true);
    let starts = 0;
    const result = await startWorkspaceDailyIntelligence({ dataRootPath: root, businessDate: '2026-08-27', mcpUrl: 'http://127.0.0.1:1/mcp' }, { uk: async () => { starts += 1; throw new Error('lane must not start'); } });
    assert.equal(result.task.status, 'needs_user'); assert.equal(starts, 0);
    const receipts = database.prepare('SELECT status FROM source_scan_receipts').all().map((item) => item.status);
    assert.deepEqual(receipts, ['needs_user']);
    assert.equal(existsSync(path.join(root, 'pi-agent', 'models.json')), false);
    return { status: result.task.status, laneStarts: starts, receipts, piModelsCreated: false };
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

function savePlanReadback(database, task, planDate) {
  saveCurrentPlan(database, { planDate, timezone: 'Asia/Shanghai', summary: '今日没有新增机会', items: [] });
  database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run('plans.save', agentRequestId(task.id, 'plan'), '{}', new Date().toISOString());
}

async function fixtureXIsolation(ai, uk) {
  const index = { accountKey: '@Owner', observation: { capturedAt: '2026-08-03T00:00:00.000Z', pageUrl: 'https://x.com/owner/lists', fingerprint: 'wmb-2107-fixture', visibleText: 'AI Sources' }, lists: [
    { listId: '300', canonicalUrl: 'https://x.com/i/lists/300', name: 'AI Sources', ownerHandle: '@Second', kind: 'following' },
    { listId: '100', canonicalUrl: 'https://x.com/i/lists/100', name: 'ＡＩ Sources', ownerHandle: '@First', kind: 'owned' },
    { listId: '222', canonicalUrl: 'https://x.com/i/lists/222', name: 'Other List', ownerHandle: '@Third', kind: 'member' }
  ] };
  const [one, two] = await Promise.all([seedFixtureX(ai, index), seedFixtureX(uk, index)]);
  assert.deepEqual(one.nameIds, ['100', '300']); assert.deepEqual(one.urlIds, ['222']); assert.deepEqual(one.idIds, ['222']);
  assert.equal(one.bindingId === two.bindingId, false);
  return { fixture: true, ai: one, uk: two };
}

async function seedFixtureX(workspace, index) {
  const database = migrateDatabase(path.join(workspace.rootPath, 'wmb.db'));
  try {
    const config = { id: 'fixture', cdpUrl: 'http://127.0.0.1:9334', workspaceId: workspace.id };
    const reader = async () => index;
    const [name, url, id] = await Promise.all([
      resolveXListCandidates(database, config, { inputText: 'AI Sources' }, reader),
      resolveXListCandidates(database, config, { inputText: 'https://x.com/i/lists/222?fixture=1' }, reader),
      resolveXListCandidates(database, config, { inputText: '222' }, reader)
    ]);
      assert.equal(name.ok && url.ok && id.ok, true);
      const first = await confirmResolvedXList(database, config, { resolution: name.data, candidate: name.data.candidates[0] }, reader);
      const replay = await confirmResolvedXList(database, config, { resolution: name.data, candidate: name.data.candidates[0] }, reader);
      assert.equal(first.ok && replay.ok, true); assert.equal(first.data.id, replay.data.id);
      const before = countsForDatabase(database);
      const changed = await confirmResolvedXList(database, config, { resolution: name.data, candidate: name.data.candidates[0] }, async () => ({ ...index, accountKey: '@Other' }));
      assert.equal(changed.ok, false); assert.equal(changed.error.code, 'ACCOUNT_MISMATCH'); assert.deepEqual(countsForDatabase(database), before);
      recordSourceScanReceipt(database, { taskId: `fixture-${workspace.id}`, workspaceId: workspace.id, module: 'x_lists', sourceId: first.data.id, sourceFeedId: first.data.sourceFeedId, status: 'needs_user', errorCode: 'BROWSER_NEEDS_USER', errorMessage: 'fixture only; real X CDP unavailable' });
      const item = upsertSource(database, { feedId: first.data.sourceFeedId, originalUrl: 'https://x.com/owner/status/2107', title: 'fixture X item' });
    return { nameIds: name.data.candidates.map((item) => item.listId), urlIds: url.data.candidates.map((item) => item.listId), idIds: id.data.candidates.map((item) => item.listId), bindingId: first.data.id, feedId: first.data.sourceFeedId, itemId: item.id, staleCode: changed.error.code };
  } finally { database.close(); }
}

function isolatedState(rootPath, channels) {
  const database = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true });
  try {
    const web = channels.summary.sources.find((item) => item.module === 'official_web');
    const x = channels.summary.sources.find((item) => item.module === 'x_lists');
    return { workspaceId: channels.summary.workspaceId, websiteSourceId: web?.sourceId ?? null, xBindingId: x?.sourceId ?? null, itemIds: database.prepare('SELECT id FROM source_items ORDER BY id').all().map((item) => item.id), receiptIds: database.prepare('SELECT id FROM source_scan_receipts ORDER BY id').all().map((item) => item.id), counts: countsForDatabase(database) };
  } finally { database.close(); }
}

function counts(rootPath) { const database = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true }); try { return countsForDatabase(database); } finally { database.close(); } }
function countsForDatabase(database) { return database.prepare('SELECT (SELECT COUNT(*) FROM website_sources) websites, (SELECT COUNT(*) FROM x_list_bindings) bindings, (SELECT COUNT(*) FROM source_feeds) feeds, (SELECT COUNT(*) FROM source_items) items, (SELECT COUNT(*) FROM source_scan_receipts) receipts').get(); }
async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
function mcpText(response) { return JSON.parse(response.data.content[0].text); }
async function mcpRequest(url, method, params, sessionId) { const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); assert.equal(response.ok, true); const body = await response.text(); const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body); if (message.error) throw new Error(message.error.message); return { data: message.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId }; }
async function waitForBrowser(port) { for (let attempt = 0; attempt < 120; attempt += 1) { try { const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); if (browser.contexts()[0]?.pages()[0]) return browser; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`packaged CDP ${port} did not start`); }
async function probeCdp(port) { return new Promise((resolve) => { const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (response) => { response.resume(); response.on('end', () => resolve({ ok: response.statusCode === 200, statusCode: response.statusCode ?? null })); }); request.on('timeout', () => { request.destroy(); resolve({ ok: false, reason: 'timeout' }); }); request.on('error', (error) => resolve({ ok: false, reason: error.code ?? error.message })); }); }
function serializeError(error) { return { code: error?.code ?? null, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null }; }
