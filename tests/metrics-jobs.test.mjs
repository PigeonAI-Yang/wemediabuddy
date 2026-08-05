import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { dispatchSchedulePublishedPublicationMetricJobs } from '../src/main/metric-commands.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import {
  claimDueMetricJobs,
  completeMetricJob,
  listMetricJobs,
  listPublicationMetricSnapshots,
  recoverRunningMetricJobs,
  schedulePublicationMetricJobs
} from '../src/main/metrics.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-metrics-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedPublished(database, id = 'pub-1') {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision)
    VALUES (?, 'x', '@test', 'test', 'authenticated', 'https://x.com/test', ?, ?, 1)`).run('acc-1', now, now);
  database.prepare(`INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES (?, 'p', ?, ?, 1)`).run('proj-1', now, now);
  database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, 'body', 1, ?)`).run('cv-1', 'proj-1', now);
  database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
    VALUES (?, ?, ?, 'x', 'text', 't', 'b', '[]', ?, ?, 1)`).run('pv-1', 'proj-1', 'cv-1', now, now);
  database.prepare(`INSERT INTO publications (
    id, platform_version_id, platform_version_revision, platform, account_id, account_key, status, revision,
    prepared_title, prepared_body, prepared_assets_json, prepared_evidence_url,
    external_url, external_id, published_at, created_at, updated_at
  ) VALUES (?, 'pv-1', 1, 'x', 'acc-1', '@test', 'published', 1, 't', 'b', '[]', 'https://x.com/compose', ?, 'ext-1', ?, ?, ?)`).run(
    id,
    'https://x.com/test/status/1',
    '2026-07-28T00:00:00.000Z',
    now,
    now
  );
}

test('metric jobs create four windows and are idempotent', async () => {
  await withDb((database) => {
    seedPublished(database);
    const first = schedulePublicationMetricJobs(database, {
      publicationId: 'pub-1',
      publishedAt: '2026-07-28T00:00:00.000Z',
      sourceUrl: 'https://x.com/test/status/1',
      platform: 'x'
    });
    assert.equal(first.ok, true);
    assert.equal(first.data.created, 4);
    assert.equal(first.data.jobs.length, 4);
    const firstLogCount = database.prepare("SELECT COUNT(*) AS count FROM operation_log WHERE command='metrics.schedule'").get().count;
    const second = schedulePublicationMetricJobs(database, {
      publicationId: 'pub-1',
      publishedAt: '2026-07-28T00:00:00.000Z',
      sourceUrl: 'https://x.com/test/status/1',
      platform: 'x'
    });
    assert.equal(second.ok, true);
    assert.equal(second.data.created, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_log WHERE command='metrics.schedule'").get().count, firstLogCount);
    assert.equal(listMetricJobs(database, 'pub-1').length, 4);
    const dues = first.data.jobs.map((job) => job.dueAt).sort();
    assert.deepEqual(dues, [
      '2026-07-28T01:00:00.000Z',
      '2026-07-28T06:00:00.000Z',
      '2026-07-29T00:00:00.000Z',
      '2026-07-31T00:00:00.000Z'
    ]);
  });
});

test('overdue capture writes real captured_at and does not overwrite snapshot', async () => {
  await withDb((database) => {
    seedPublished(database);
    schedulePublicationMetricJobs(database, {
      publicationId: 'pub-1',
      publishedAt: '2026-07-28T00:00:00.000Z',
      sourceUrl: 'https://x.com/test/status/1',
      platform: 'x'
    });
    const claimed = claimDueMetricJobs(database, '2026-07-28T02:00:00.000Z');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].payload.window, '1h');
    const firstCapture = completeMetricJob(database, {
      jobId: claimed[0].id,
      publicationId: 'pub-1',
      scheduledFor: claimed[0].dueAt,
      sourceUrl: 'https://x.com/test/status/1',
      capturedAt: '2026-07-28T02:05:00.000Z',
      normalized: { views: { status: 'value', value: 4 } },
      raw: { views: { status: 'value', value: 4, rawLabel: '4' } }
    });
    assert.equal(firstCapture.ok, true);
    assert.equal(firstCapture.data.capturedAt, '2026-07-28T02:05:00.000Z');

    // Force job back to pending and claim again — existing snapshot must win.
    database.prepare(`UPDATE jobs SET status = 'pending', finished_at = NULL WHERE id = ?`).run(claimed[0].id);
    const claimedAgain = claimDueMetricJobs(database, '2026-07-28T03:00:00.000Z');
    assert.equal(claimedAgain.length, 1);
    const secondCapture = completeMetricJob(database, {
      jobId: claimedAgain[0].id,
      publicationId: 'pub-1',
      scheduledFor: claimedAgain[0].dueAt,
      sourceUrl: 'https://x.com/test/status/1',
      capturedAt: '2026-07-28T03:00:00.000Z',
      normalized: { views: { status: 'value', value: 99 } },
      raw: { views: { status: 'value', value: 99, rawLabel: '99' } }
    });
    assert.equal(secondCapture.ok, true);
    assert.equal(secondCapture.data.capturedAt, '2026-07-28T02:05:00.000Z');
    assert.equal(secondCapture.data.normalized.views.value, 4);
    assert.equal(listPublicationMetricSnapshots(database, 'pub-1').length, 1);
  });
});

test('running metric jobs return to pending on recovery', async () => {
  await withDb((database) => {
    seedPublished(database);
    schedulePublicationMetricJobs(database, {
      publicationId: 'pub-1',
      publishedAt: '2026-07-28T00:00:00.000Z',
      sourceUrl: 'https://x.com/test/status/1',
      platform: 'x'
    });
    const claimed = claimDueMetricJobs(database, '2026-07-28T10:00:00.000Z');
    assert.equal(claimed.length >= 1, true);
    assert.equal(claimed.every((job) => job.status === 'running'), true);
    assert.equal(recoverRunningMetricJobs(database) >= 1, true);
    const pending = listMetricJobs(database, 'pub-1').filter((job) => job.status === 'pending');
    assert.equal(pending.length >= 1, true);
  });
});

test('startup metric scheduling stays idempotent across a restart with a new runtime epoch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-metrics-restart-'));
  await openDataRoot(root);
  const runtimes = [];
  try {
    const seed = migrateDatabase(path.join(root, 'wmb.db'));
    const seedNow = new Date().toISOString();
    seed.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('ws-metrics-restart', seedNow, seedNow);
    seedPublished(seed);
    seed.close();

    const bootOne = ActiveWorkspaceRuntime.open(root, { createEpoch: () => 'epoch-boot-1', openDatabase: migrateDatabase });
    runtimes.push(bootOne);
    const first = await dispatchSchedulePublishedPublicationMetricJobs(bootOne);
    assert.equal(first, 4);
    await bootOne.stop({ drain: false });

    // Second boot: same database, new runtimeEpoch. The deterministic
    // publication:*:metrics-schedule requestIds already have receipts, so the
    // startup pass must recognize the jobs exist instead of re-dispatching
    // into a REQUEST_REPLAY_CONFLICT that aborts app boot before window creation.
    const bootTwo = ActiveWorkspaceRuntime.open(root, { createEpoch: () => 'epoch-boot-2', openDatabase: migrateDatabase });
    runtimes.push(bootTwo);
    const second = await dispatchSchedulePublishedPublicationMetricJobs(bootTwo);
    assert.equal(second, 0);
    assert.equal(listMetricJobs(bootTwo.database, 'pub-1').length, 4);
    const receiptCount = bootTwo.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE request_id LIKE '%:metrics-schedule'").get().count;
    assert.equal(receiptCount, 1);

    // Window drift: a job row is lost while its schedule receipt survives
    // (e.g. after a future WINDOWS_MS change). The recorded receipt must still
    // suppress re-dispatch, because replay across epochs throws.
    await bootTwo.stop({ drain: false });
    const drift = migrateDatabase(path.join(root, 'wmb.db'));
    drift.prepare("DELETE FROM jobs WHERE dedupe_key = 'metric:pub-1:72h'").run();
    drift.close();

    const bootThree = ActiveWorkspaceRuntime.open(root, { createEpoch: () => 'epoch-boot-3', openDatabase: migrateDatabase });
    runtimes.push(bootThree);
    const third = await dispatchSchedulePublishedPublicationMetricJobs(bootThree);
    assert.equal(third, 0);
    assert.equal(listMetricJobs(bootThree.database, 'pub-1').length, 3);
    await bootThree.stop({ drain: false });
  } finally {
    for (const runtime of runtimes) { try { await runtime.stop({ drain: false }); } catch { /* already stopped */ } }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
