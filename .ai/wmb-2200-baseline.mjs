// WMB-2200: current real X metrics baseline and List response-isolation experiment.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readXListTimeline } from '../src/main/platforms/x-list-browser.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const workspaceId = 'a755adf2-4e8d-4abd-b616-4d7934f730f1';
const accountKey = '@KimbomArtist';
const targetListId = '2082851520417255750';
const controlListId = '2082177169078251627';
const cdpUrl = 'http://127.0.0.1:9334';
const receiptPath = path.join(process.cwd(), '.ai', 'wmb-2200-baseline.json');
const sourcePath = path.join(process.cwd(), 'src', 'main', 'platforms', 'x-list-browser.ts');

const contractChecks = [
  ['PRD.md', ['REQ-023', 'AC-019']],
  ['SPEC.md', ['CAP-022', 'EVAL-024', 'EVAL-025']],
  ['PLAN.md', ['M-2200', 'WMB-2200', 'WMB-2205']],
  ['TECHNICAL_DESIGN.md', ['x_post_metric_snapshots', '+15m', '+60m', '+180m']],
  ['docs/spark/2026-08-03-x-list-trend-opportunity-radar-design.md', ['data_insufficient', 'OBSERVATION_WINDOW_EXPIRED']]
].map(([file, markers]) => {
  const text = readFileSync(path.join(process.cwd(), file), 'utf8');
  const missing = markers.filter((marker) => !text.includes(marker));
  assert.deepEqual(missing, [], `${file} missing: ${missing.join(', ')}`);
  return { file, markers };
});

const config = {
  id: 'edge:pyaireader-default',
  cdpUrl,
  workspaceId,
  accountKey
};
const startedAt = new Date().toISOString();
const timeline = await readXListTimeline(config, targetListId, 20);
assert.equal(timeline.accountKey, accountKey);
assert.equal(timeline.detail.listId, targetListId);
assert.ok(timeline.posts.length > 0, 'real target List returned no posts');
const metricPosts = timeline.posts.filter((post) => Object.values(post.metrics).some((value) => value !== null));
assert.ok(metricPosts.length > 0, 'real target List returned no structured metrics');

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
assert.ok(context, 'CDP profile has no browser context');
const page = context.pages().find((candidate) => /^https:\/\/(?:www\.)?x\.com\b/i.test(candidate.url()))
  ?? await context.newPage();
const responses = [];
const onResponse = (response) => {
  const rawUrl = response.url();
  if (!rawUrl.includes('ListLatestTweetsTimeline')) return;
  const url = new URL(rawUrl);
  const variablesRaw = url.searchParams.get('variables');
  let variables = null;
  try { variables = variablesRaw ? JSON.parse(variablesRaw) : null; } catch {}
  responses.push({
    pageUrl: page.url(),
    operation: url.pathname.split('/').pop(),
    responseListId: variables?.listId ?? null,
    variableKeys: variables ? Object.keys(variables).sort() : []
  });
};

page.on('response', onResponse);
try {
  for (const listId of [targetListId, controlListId]) {
    await page.goto(`https://x.com/i/lists/${listId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_500);
    await page.mouse.wheel(0, 1_400);
    await page.waitForTimeout(800);
  }
} finally {
  page.off('response', onResponse);
  await browser.close();
}

const targetResponse = responses.find((item) => item.responseListId === targetListId);
const controlResponse = responses.find((item) => item.responseListId === controlListId);
assert.ok(targetResponse, 'target List response did not expose exact variables.listId');
assert.ok(controlResponse, 'control List response did not expose exact variables.listId');

const browserSource = readFileSync(sourcePath, 'utf8');
const ineffectiveGuard = /if \(!url\.includes\(listId\) && !url\.includes\(encodeURIComponent\(listId\)\)\)\s*\{\s*\/\/ Still accept if body contains this list; URL usually includes listId\.\s*\}/m.test(browserSource);
assert.equal(ineffectiveGuard, true, 'capture guard changed; reassess the isolation experiment');

const receipt = {
  taskId: 'WMB-2200',
  startedAt,
  finishedAt: new Date().toISOString(),
  contractChecks,
  realBaseline: {
    workspaceId,
    accountKey: timeline.accountKey,
    list: {
      listId: timeline.detail.listId,
      name: timeline.detail.name,
      pageUrl: timeline.detail.observation.pageUrl,
      capturedAt: timeline.detail.observation.capturedAt,
      fingerprint: timeline.detail.observation.fingerprint
    },
    postCount: timeline.posts.length,
    postsWithAnyStructuredMetric: metricPosts.length,
    samples: metricPosts.slice(0, 5).map((post) => ({
      url: post.url,
      postedAt: post.postedAt,
      metrics: post.metrics
    }))
  },
  isolationExperiment: {
    requestedListIds: [targetListId, controlListId],
    responses,
    exactResponseListIdentityAvailable: true,
    currentCaptureRejectsMismatchedListId: false,
    result: 'reproduced',
    rootCause: 'ListLatestTweetsTimeline responses expose variables.listId, but captureListLatestTweetsTimeline has a no-op mismatch branch and continues parsing the payload.'
  }
};

writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: true,
  taskId: receipt.taskId,
  postCount: receipt.realBaseline.postCount,
  postsWithAnyStructuredMetric: receipt.realBaseline.postsWithAnyStructuredMetric,
  isolationResult: receipt.isolationExperiment.result,
  receiptPath
}, null, 2));
// Direct CDP + TypeScript module loading can retain diagnostic handles on Windows.
process.exit(0);
