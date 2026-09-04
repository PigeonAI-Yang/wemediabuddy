import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { getTodayOverviewMetrics } = await import('../src/main/workbench.ts');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-fix-'));
  try { return work(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}


test('CTA: deriveTodayRunView produces open_manager for waiting approval', async () => {
  const { deriveTodayRunView } = await import('../src/renderer/today-run-view.ts');
  const view = deriveTodayRunView({
    task: { status: 'needs_user', errorCode: 'MANAGER_WAITING_APPROVAL', id: 't1', phase: 'waiting' },
    localStarting: false,
    hasTodayPlan: true,
    hasRecentPlan: false,
    opportunityCount: 3,
    sssCount: 0,
    sourcesTotal: 5,
    studioActive: 0,
    piConfigured: true,
    channelsSummary: null,
    controlPending: false,
  });
  assert.equal(view.primaryCta.kind, 'open_manager');
  assert.equal(view.primaryCta.label, '查看待确认选题');
});

// --- Metrics IPC/query ---
test('metrics: empty DB returns 0 not null', () => withTempDir((dir) => {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  try {
    const m = getTodayOverviewMetrics(db, '2026-08-23');
    for (const key of ['sources','opportunities','projects','publications']) {
      assert.equal(typeof m[key].value, 'number', `${key} should be number not null`);
      assert.equal(Number.isFinite(m[key].value), true);
      assert.equal(m[key].series.length, 7, `${key} series length 7`);
      assert.equal(Array.isArray(m[key].series), true);
    }
    assert.equal(m.sources.value, 0);
    assert.equal(m.projects.pending, 0);
    // changeText for zero should be — neutral
    assert.equal(m.sources.changeText, '—');
  } finally { db.close(); }
}));

test('metrics: caller-provided Today asOf is preserved across the IPC snapshot', () => withTempDir((dir) => {
  const db = migrateDatabase(path.join(dir, 'wmb.db'));
  try {
    const asOf = new Date('2026-08-28T08:00:00.000Z');
    const metrics = getTodayOverviewMetrics(db, '2026-08-28', { now: asOf });
    assert.equal(metrics.updatedAt, asOf.toISOString());
    const renderer = fs.readFileSync('j:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx', 'utf8');
    assert.match(renderer, /recommendation\?\.context\.asOf/);
    assert.match(renderer, /getTodayOverviewMetrics\(requestPlanDate, asOf\)/);
  } finally { db.close(); }
}));

test('metrics: real DB 2026-08-25 returns numbers not —', () => {
  const realPath = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
  if (!fs.existsSync(realPath)) {
    console.log('skip real DB test, no file');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-fix-real-'));
  const tmpPath = path.join(tmpDir, 'wmb.db');
  try {
    fs.copyFileSync(realPath, tmpPath);
    const db = new DatabaseSync(tmpPath, { readOnly: false });
    try {
      const m = getTodayOverviewMetrics(db, '2026-08-25');
      console.log('real metrics 2026-08-25', JSON.stringify(m, null, 2));
      for (const key of ['sources','opportunities','projects','publications']) {
        assert.notEqual(m[key].value, null, `${key} should not be null`);
        assert.equal(typeof m[key].value, 'number', `${key} number`);
        assert.ok(m[key].value >= 0, `${key} >=0`);
        assert.equal(m[key].series.length, 7);
        // each series entry is number or null, but at least plausible
        assert.ok(m[key].series.every(v => v === null || typeof v === 'number'));
      }
      // Specific expectations for 2026-08-25: opportunities approved=0, publications 1; sources/projects vary with ingestion (preserve contract, not exact snapshot)
      assert.equal(m.opportunities.value, 0);
      assert.equal(m.publications.value, 1);
      assert.ok(m.projects.pending !== null && typeof m.projects.pending === 'number');
      assert.ok(m.sources.value >= 0 && m.sources.value <= 5000, 'sources plausible');
      assert.ok(m.projects.value >= 0 && m.projects.value <= 5000, 'projects plausible');
    } finally { db.close(); }
  } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

test('metrics: projects pending truthful', () => withTempDir((dir) => {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  try {
    // empty DB pending 0
    const m0 = getTodayOverviewMetrics(db, '2026-08-23');
    assert.equal(m0.projects.pending, 0);
    // insert a project idea
    db.prepare(`INSERT INTO content_projects (id, title, status, created_at, updated_at, revision) VALUES ('p1','t','idea','2026-08-23T06:00:00Z','2026-08-23T06:00:00Z',1)`).run();
    const m1 = getTodayOverviewMetrics(db, '2026-08-23');
    assert.equal(m1.projects.value, 1);
    assert.equal(m1.projects.pending, 1);
    // completed should not count as active but also not pending
    db.prepare(`INSERT INTO content_projects (id, title, status, created_at, updated_at, revision) VALUES ('p2','t2','completed','2026-08-23T07:00:00Z','2026-08-23T07:00:00Z',1)`).run();
    const m2 = getTodayOverviewMetrics(db, '2026-08-23');
    assert.equal(m2.projects.value, 1, 'completed not counted as active');
  } finally { db.close(); }
}));

test('metrics: publication 7-day window', () => withTempDir((dir) => {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  try {
    // Need platform and accounts setup for publications FK
    db.prepare(`INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, created_at, updated_at, revision) VALUES ('acc1','x','k1','d','unknown','2026-08-20T00:00:00Z','2026-08-20T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO content_projects (id, title, status, created_at, updated_at, revision) VALUES ('proj1','t','drafting','2026-08-20T00:00:00Z','2026-08-20T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('cv1','proj1','b',1,'2026-08-20T00:00:00Z')`).run();
    db.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision) VALUES ('pv1','proj1','cv1','x','article','t','b','[]','2026-08-20T00:00:00Z','2026-08-20T00:00:00Z',1)`).run();
    // published within 7 days window for 2026-08-25 (2026-08-19 to 2026-08-25)
    db.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status, prepared_assets_json, published_at, created_at, updated_at, revision) VALUES ('pub1','pv1',1,'x','acc1','k1','published','[]','2026-08-24T10:00:00Z','2026-08-24T10:00:00Z','2026-08-24T10:00:00Z',1)`).run();
    // outside window (older than 7 days)
    db.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status, prepared_assets_json, published_at, created_at, updated_at, revision) VALUES ('pub2','pv1',1,'x','acc1','k1','published','[]','2026-08-10T10:00:00Z','2026-08-10T10:00:00Z','2026-08-10T10:00:00Z',1)`).run();
    const m = getTodayOverviewMetrics(db, '2026-08-25');
    assert.equal(m.publications.value, 1, 'only pub within 7d window counts');
    assert.equal(m.publications.series.length, 7);
    // check series for that day has 1
    // find index for 2026-08-24 (should be 5 from end? 19:0,20:1,21:2,22:3,23:4,24:5,25:6)
    assert.equal(m.publications.series[5], 1);
  } finally { db.close(); }
}));

test('renderer: preserves previous metrics on refresh failure (no silent null)', () => {
  const src = fs.readFileSync('j:/PigeonYang/WeMediaBuddy/src/renderer/today-view.tsx', 'utf8');
  // ensure we do NOT clear on planDate change to null before refresh
  assert.doesNotMatch(src, /setOverviewMetrics\(null\)/, 'should not clear metrics to null before refresh');
  // ensure catch preserves previous (does not set null)
  const catchBlock = src.match(/\.catch\(\(\)\s*=>\s*\{[\s\S]{0,400}\}\)/);
  assert.ok(catchBlock, 'catch block exists');
  assert.doesNotMatch(catchBlock[0], /setOverviewMetrics\(null\)/, 'catch should not wipe metrics');
  // ensure we handle seq race
  assert.match(src, /overviewSeqRef\.current/, 'seq guard present');
  // ensure filteredOverviewMetrics preserves previous when opportunities stale (shows approvedCount)
  assert.match(src, /filteredOverviewMetrics/, 'filteredOverviewMetrics exists');
});

// IPC serialization: ensure returned object is JSON serializable and numbers not BigInt
test('IPC serialization: metrics are plain JSON numbers', () => withTempDir((dir) => {
  const dbPath = path.join(dir, 'wmb.db');
  const db = migrateDatabase(dbPath);
  try {
    const m = getTodayOverviewMetrics(db, '2026-08-25');
    const json = JSON.stringify(m);
    const parsed = JSON.parse(json);
    assert.equal(typeof parsed.sources.value, 'number');
    assert.equal(typeof parsed.projects.value, 'number');
    assert.equal(typeof parsed.publications.value, 'number');
    assert.ok(!json.includes('n}'), 'no BigInt serialization');
  } finally { db.close(); }
}));
