import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createWebsiteSource } from '../src/main/intelligence-channels.ts';
import { enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const phase = process.env.WMB_2107_LAYOUT_PHASE ?? 'after';
const expectation = process.env.WMB_2107_LAYOUT_EXPECT ?? 'readable';
const packageRoot = process.env.WMB_2107_PACKAGE_DIR ?? path.join(os.tmpdir(), 'wmb-2107-package-redirect-fixed');
const appRoot = path.join(packageRoot, 'WeMediaBuddy-win32-x64');
const executable = path.join(appRoot, 'WeMediaBuddy.exe');
const output = path.join(process.cwd(), '.ai', `wmb-2107-today-layout-${phase}.json`);
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-2107-today-layout-'));
const userData = path.join(temp, 'user-data');
const registryPath = path.join(userData, 'workspace-registry.json');
const port = 29700 + (process.pid % 700);
const result = { task: 'WMB-2107', phase, expectation, package: { root: packageRoot, executable }, viewportReports: [], screenshots: [], failure: null };
let launched = null;

try {
  assert.equal(existsSync(executable), true, `packaged executable missing: ${executable}`);
  await mkdir(userData, { recursive: true });
  const root = await openDataRoot(path.join(temp, 'ai'));
  const database = migrateDatabase(path.join(root.path, 'wmb.db'));
  try {
    createWebsiteSource(database, {
      inputText: 'https://example.com/today-layout',
      name: 'Today layout source',
      canonicalUrl: 'https://example.com/today-layout',
      resolutionStatus: 'ready',
      trialRead: { title: 'Today layout source', url: 'https://example.com/today-layout', readable: true }
    });
  } finally {
    database.close();
  }
  const workspace = await enrollAiWorkspace({ registryPath, rootPath: root.path });
  const registry = await readWorkspaceRegistry(registryPath);
  launched = await launch({ workspace, registry });
  const { page } = launched;
  await page.evaluate(() => localStorage.setItem('wmb.view', 'today'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.today-channel-selection');
  await page.evaluate(() => window.wmb.savePiConfig({ name: 'WMB-2107 layout only', baseUrl: 'https://example.invalid/v1', model: 'layout-only', api: 'openai-responses', apiKey: 'not-used' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  const selection = page.locator('.today-channel-selection');
  await selection.waitFor();
  const boxes = selection.locator('input[type="checkbox"]');
  assert.equal(await boxes.count(), 2);
  if (await boxes.nth(1).isChecked()) await boxes.nth(1).click();
  if (await boxes.nth(0).isChecked()) await boxes.nth(0).click();
  await page.waitForFunction(() => document.querySelector('.today-channel-selection > p')?.textContent?.includes('请至少选择一个情报模块。') ?? false);
  const primary = page.locator('.today-command-actions > .primary-button');
  assert.equal(await primary.isDisabled(), true, 'no-module preflight must disable the primary button');
  await boxes.nth(0).click();
  assert.equal(await primary.isDisabled(), false, 'a ready official website module must re-enable the primary button');
  await boxes.nth(0).click();
  await page.waitForFunction(() => document.querySelector('.today-channel-selection > p')?.textContent?.includes('请至少选择一个情报模块。') ?? false);

  for (const viewport of [{ width: 1672, height: 982 }, { width: 1366, height: 768 }, { width: 1100, height: 760 }]) {
    await page.setViewportSize(viewport);
    await page.locator('.today-command').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = path.join(process.cwd(), '.ai', `wmb-2107-today-preflight-${phase}-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot });
    result.screenshots.push(screenshot);
    result.viewportReports.push(await page.evaluate(inspectLayout, viewport));
  }
  const unreadable = result.viewportReports.filter((report) => !report.readable);
  result.result = { unreadable: unreadable.map((report) => report.viewport), readable: unreadable.length === 0 };
  if (expectation === 'broken') {
    assert.equal(unreadable.some((report) => report.viewport.width === 1100), true, '1100px package view unexpectedly did not reproduce the unreadable command layout');
  } else {
    assert.deepEqual(unreadable, [], `unreadable packaged Today command layout: ${JSON.stringify(unreadable)}`);
  }
} catch (error) {
  result.failure = serializeError(error);
} finally {
  if (launched) await launched.close().catch(() => {});
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

console.log(JSON.stringify(result));
if (result.failure) process.exitCode = 1;

async function launch({ workspace, registry }) {
  await writeFile(registryPath, JSON.stringify({ ...registry, activeWorkspaceId: workspace.id, switchJournal: null }), 'utf8');
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
  const child = spawn(executable, [], {
    cwd: appRoot,
    env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' },
    stdio: 'ignore',
    windowsHide: true
  });
  const browser = await waitForBrowser(port);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#root', { timeout: 30_000 });
  return {
    page,
    close: async () => {
      await browser.close().catch(() => {});
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    }
  };
}

function inspectLayout(viewport) {
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  };
  const lineBoxes = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].map((box) => ({ left: box.left, top: box.top, width: box.width, height: box.height }));
  };
  const visible = (box) => box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  const text = (element) => ({
    value: element.textContent?.trim() ?? '',
    box: rect(element),
    lineBoxes: lineBoxes(element),
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  });
  const lineCount = (textReport) => new Set(textReport.lineBoxes.map((box) => Math.round(box.top))).size;
  const command = document.querySelector('.today-command');
  const selection = document.querySelector('.today-channel-selection');
  const primary = document.querySelector('.today-command-actions > .primary-button');
  const title = selection.querySelector(':scope > div > strong');
  const preflight = selection.querySelector(':scope > p');
  const labels = [...selection.querySelectorAll(':scope > label')].map((label) => ({
    box: rect(label),
    title: text(label.querySelector('b')),
    status: text(label.querySelector('small')),
    source: text(label.querySelector('em')),
    checkbox: rect(label.querySelector('input'))
  }));
  const report = {
    viewport,
    document: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
    command: { box: rect(command), display: getComputedStyle(command).display, flexWrap: getComputedStyle(command).flexWrap },
    selection: { box: rect(selection), gridTemplateColumns: getComputedStyle(selection).gridTemplateColumns },
    title: text(title),
    labels,
    preflight: text(preflight),
    primary: { box: rect(primary), text: primary.textContent?.trim() ?? '', disabled: primary.disabled },
    readable: false
  };
  report.readable = report.document.scrollWidth <= report.document.width
    && visible(report.command.box)
    && visible(report.selection.box)
    && visible(report.title.box)
    && report.title.lineBoxes.length === 1
    && labels.length === 2
    && labels.every((label) => label.box.width >= 150 && visible(label.box) && visible(label.checkbox)
      && lineCount(label.title) === 1 && label.status.scrollWidth <= label.status.clientWidth
      && lineCount(label.status) <= 3 && lineCount(label.source) <= 3)
    && visible(report.preflight.box) && report.preflight.value === '请至少选择一个情报模块。'
    && visible(report.primary.box) && report.primary.box.width >= 100 && report.primary.box.height >= 40 && report.primary.disabled;
  return report;
}

async function waitForBrowser(cdpPort) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      if (browser.contexts()[0]?.pages()[0]) return browser;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`packaged CDP ${cdpPort} did not start`);
}

function serializeError(error) {
  return { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null };
}
