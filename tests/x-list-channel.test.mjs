import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { confirmResolvedXList, resolveXListCandidates } from '../src/main/x-list-channel.ts';

const observation = {
  capturedAt: '2026-08-03T12:00:00.000Z',
  pageUrl: 'https://x.com/owner/lists',
  fingerprint: 'real-index-observation',
  visibleText: 'AI Sources'
};

const index = {
  accountKey: '@Owner',
  observation,
  lists: [
    { listId: '300', canonicalUrl: 'https://x.com/i/lists/300', name: 'ai sources', ownerHandle: '@Second', kind: 'following' },
    { listId: '100', canonicalUrl: 'https://x.com/i/lists/100', name: 'ＡＩ Sources', ownerHandle: '@First', kind: 'owned' },
    { listId: '222', canonicalUrl: 'https://x.com/i/lists/222', name: 'Other List', ownerHandle: '@Third', kind: 'member' }
  ]
};

async function makeRoot(workspaceId) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-x-list-channel-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision)
    VALUES ('workspace_id', ?, ?, ?, 1)`).run(workspaceId, now, now);
  return { root, database, config: { id: 'edge:pyaireader-workspace-test', cdpUrl: 'http://127.0.0.1:9334', workspaceId, accountKey: '@Forged' } };
}

test('X List resolver returns every same-name candidate and only exact URL or ID matches', async () => {
  const current = await makeRoot('workspace-a');
  try {
    const readIndex = async () => index;
    const byName = await resolveXListCandidates(current.database, current.config, { inputText: '  AI SOURCES  ' }, readIndex);
    assert.equal(byName.ok, true);
    assert.equal(byName.data.accountKey, '@Owner');
    assert.deepEqual(byName.data.candidates.map(({ accountKey, listId, canonicalUrl, name, ownerHandle, kind, observation: itemObservation }) => ({ accountKey, listId, canonicalUrl, name, ownerHandle, kind, fingerprint: itemObservation.fingerprint })), [
      { accountKey: '@Owner', listId: '100', canonicalUrl: 'https://x.com/i/lists/100', name: 'ＡＩ Sources', ownerHandle: '@First', kind: 'owned', fingerprint: 'real-index-observation' },
      { accountKey: '@Owner', listId: '300', canonicalUrl: 'https://x.com/i/lists/300', name: 'ai sources', ownerHandle: '@Second', kind: 'following', fingerprint: 'real-index-observation' }
    ]);

    const byUrl = await resolveXListCandidates(current.database, current.config, { inputText: 'https://x.com/i/lists/222?ref=fixture' }, readIndex);
    assert.equal(byUrl.ok, true);
    assert.deepEqual(byUrl.data.candidates.map((item) => item.listId), ['222']);
    const byId = await resolveXListCandidates(current.database, current.config, { inputText: '222' }, readIndex);
    assert.equal(byId.ok, true);
    assert.deepEqual(byId.data.candidates.map((item) => item.listId), ['222']);

    const missing = await resolveXListCandidates(current.database, current.config, { inputText: 'not present' }, readIndex);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'X_LIST_UNKNOWN');
    const unreadable = await resolveXListCandidates(current.database, current.config, { inputText: 'AI Sources' }, async () => { throw new Error('browser unavailable'); });
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.error.code, 'BROWSER_NEEDS_USER');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count, 0);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count, 0);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('X List confirmation revalidates the current account and reuses the existing binding', async () => {
  const current = await makeRoot('workspace-a');
  try {
    const readIndex = async () => index;
    const resolved = await resolveXListCandidates(current.database, current.config, { inputText: 'AI Sources' }, readIndex);
    assert.equal(resolved.ok, true);
    const candidate = resolved.data.candidates[0];
    const first = await confirmResolvedXList(current.database, current.config, { resolution: resolved.data, candidate }, readIndex);
    assert.equal(first.ok, true);
    assert.equal(first.data.accountKey, '@Owner');
    assert.equal(first.data.listId, '100');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count, 1);

    const replay = await confirmResolvedXList(current.database, current.config, { resolution: resolved.data, candidate }, readIndex);
    assert.equal(replay.ok, true);
    assert.equal(replay.data.id, first.data.id);
    assert.equal(replay.data.sourceFeedId, first.data.sourceFeedId);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count, 1);

    const fake = await confirmResolvedXList(current.database, current.config, {
      resolution: resolved.data,
      candidate: { ...candidate, ownerHandle: '@Forged' }
    }, readIndex);
    assert.equal(fake.ok, false);
    assert.equal(fake.error.code, 'CONFIRMATION_STALE');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count, 1);

    let calls = 0;
    const changedAccount = async () => calls++ === 0 ? index : { ...index, accountKey: '@Other' };
    const fresh = await resolveXListCandidates(current.database, current.config, { inputText: 'Other List' }, changedAccount);
    assert.equal(fresh.ok, true);
    const switched = await confirmResolvedXList(current.database, current.config, { resolution: fresh.data, candidate: fresh.data.candidates[0] }, changedAccount);
    assert.equal(switched.ok, false);
    assert.equal(switched.error.code, 'ACCOUNT_MISMATCH');
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count, 1);
  } finally {
    current.database.close();
    await rm(current.root, { recursive: true, force: true });
  }
});

test('X List resolutions cannot bind across roots or a mismatched browser context', async () => {
  const first = await makeRoot('workspace-a');
  const second = await makeRoot('workspace-b');
  try {
    const resolved = await resolveXListCandidates(first.database, first.config, { inputText: 'Other List' }, async () => index);
    assert.equal(resolved.ok, true);
    const beforeBindings = second.database.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count;
    const beforeFeeds = second.database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count;
    const crossRoot = await confirmResolvedXList(second.database, second.config, {
      resolution: resolved.data,
      candidate: resolved.data.candidates[0]
    }, async () => { throw new Error('reader must not run'); });
    assert.equal(crossRoot.ok, false);
    assert.equal(crossRoot.error.code, 'CONFIRMATION_STALE');
    assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count, beforeBindings);
    assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM source_feeds').get().count, beforeFeeds);

    const wrongContext = await resolveXListCandidates(first.database, { ...first.config, workspaceId: 'workspace-b' }, { inputText: 'Other List' }, async () => { throw new Error('reader must not run'); });
    assert.equal(wrongContext.ok, false);
    assert.equal(wrongContext.error.code, 'WORKSPACE_ID_MISMATCH');
  } finally {
    first.database.close(); second.database.close();
    await Promise.all([rm(first.root, { recursive: true, force: true }), rm(second.root, { recursive: true, force: true })]);
  }
});
