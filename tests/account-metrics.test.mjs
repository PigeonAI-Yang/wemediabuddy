import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { listAccountMetricSnapshots, saveAccountMetricSnapshot } from '../src/main/metrics.ts';
import { parseMetricValue } from '../src/main/platforms/metric-value.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-account-metrics-'));
  await openDataRoot(root);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('account metric snapshots store follower values and read back', async () => {
  await withDb((database) => {
    const account = saveAccount(database, {
      platform: 'x',
      accountKey: '@KimbomArtist',
      displayName: 'Kimbom',
      loginState: 'authenticated',
      evidenceUrl: 'https://x.com/KimbomArtist'
    });
    const saved = saveAccountMetricSnapshot(database, {
      accountId: account.id,
      platform: 'x',
      sourceUrl: 'https://x.com/KimbomArtist',
      capturedAt: '2026-07-28T12:00:00.000Z',
      normalized: { followers: { status: 'value', value: 1234, rawLabel: '1,234 Followers' } },
      raw: { followers: { status: 'value', value: 1234, rawLabel: '1,234 Followers' } }
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.accountId, account.id);
    assert.equal(saved.data.normalized.followers.value, 1234);

    const listed = listAccountMetricSnapshots(database, account.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sourceUrl, 'https://x.com/KimbomArtist');
    assert.equal(listed[0].normalized.followers.status, 'value');
    assert.equal(listed[0].normalized.followers.value, 1234);
  });
});

test('account metric snapshot rejects unknown account and platform mismatch', async () => {
  await withDb((database) => {
    const missing = saveAccountMetricSnapshot(database, {
      accountId: 'missing',
      platform: 'x',
      sourceUrl: 'https://x.com/test',
      capturedAt: new Date().toISOString(),
      normalized: { followers: { status: 'unavailable' } },
      raw: {}
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'NOT_FOUND');

    const account = saveAccount(database, {
      platform: 'x',
      accountKey: '@test',
      displayName: 'test',
      loginState: 'authenticated'
    });
    const mismatch = saveAccountMetricSnapshot(database, {
      accountId: account.id,
      platform: 'wechat',
      sourceUrl: 'https://mp.weixin.qq.com/',
      capturedAt: new Date().toISOString(),
      normalized: { followers: { status: 'unavailable' } },
      raw: {}
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, 'ACCOUNT_MISMATCH');
  });
});

test('follower labels parse through shared metric value helper', () => {
  assert.equal(parseMetricValue('1,234 Followers'), 1234);
  assert.equal(parseMetricValue('1.2万 位关注者'), 12000);
  assert.equal(parseMetricValue('no number'), null);
});
