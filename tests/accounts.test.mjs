import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { readAccount } from '../src/main/accounts.ts';
import {
  assertWorkspaceBrowserIdentity,
  initializeWorkspaceBrowserBinding,
  markWorkspaceBrowserBindingVerified,
  readWorkspaceBrowserBinding,
  rebindWorkspaceBrowserProfile
} from '../src/main/workspace-browser-binding.ts';


test('binding revisions distinguish stale profile and account mismatches with zero stale writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-account-binding-'));
  const databasePath = path.join(directory, 'wmb.db');
  try {
    const database = migrateDatabase(databasePath);
    initializeWorkspaceBrowserBinding(database, 'profile-a');
    const verified = markWorkspaceBrowserBindingVerified(database, {
      profileId: 'profile-a',
      expectedBindingRevision: 1,
      account: { platform: 'x', accountKey: 'owner', displayName: 'Owner', loginState: 'authenticated' }
    });
    assert.equal(verified.bindingRevision, 2);
    assert.equal(readAccount(database, 'x').browserProfileId, 'profile-a');
    assert.equal(readAccount(database, 'x').browserBindingRevision, 2);
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, { profileId: 'profile-a', bindingRevision: 1, platform: 'x', accountKey: 'owner' }),
      { code: 'PROFILE_STALE' }
    );
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, { profileId: 'profile-b', bindingRevision: 2, platform: 'x', accountKey: 'owner' }),
      { code: 'BROWSER_PROFILE_MISMATCH' }
    );
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, { profileId: 'profile-a', bindingRevision: 2, platform: 'x', accountKey: 'other' }),
      { code: 'ACCOUNT_MISMATCH' }
    );
    const before = database.prepare("SELECT * FROM workspace_browser_bindings WHERE id='effective'").get();
    assert.throws(
      () => rebindWorkspaceBrowserProfile(database, { profileId: 'profile-b', expectedBindingRevision: 1 }),
      { code: 'PROFILE_STALE' }
    );
    assert.deepEqual(database.prepare("SELECT * FROM workspace_browser_bindings WHERE id='effective'").get(), before);
    database.close();

    const reopened = migrateDatabase(databasePath);
    assert.equal(readWorkspaceBrowserBinding(reopened).bindingRevision, 2);
    assert.equal(readWorkspaceBrowserBinding(reopened).expectedAccountSnapshot.x.accountKey, 'owner');
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('rebind clears every platform snapshot and snapshot metadata cannot authorize a runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-account-rebind-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    initializeWorkspaceBrowserBinding(database, 'profile-a');
    const xVerified = markWorkspaceBrowserBindingVerified(database, {
      profileId: 'profile-a', expectedBindingRevision: 1,
      account: { platform: 'x', accountKey: 'x-owner', displayName: 'X Owner', loginState: 'authenticated' }
    });
    const wechatVerified = markWorkspaceBrowserBindingVerified(database, {
      profileId: 'profile-a', expectedBindingRevision: xVerified.bindingRevision,
      account: { platform: 'wechat', accountKey: 'wx-owner', displayName: 'WeChat Owner', loginState: 'authenticated' }
    });
    assert.equal(wechatVerified.expectedAccountSnapshot.x, undefined);
    assert.equal(wechatVerified.expectedAccountSnapshot.wechat.browserBindingRevision, wechatVerified.bindingRevision);
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, { profileId: 'profile-a', bindingRevision: wechatVerified.bindingRevision, platform: 'x', accountKey: 'x-owner' }),
      { code: 'ACCOUNT_MISMATCH' }
    );
    const staleProfileSnapshot = { ...xVerified.expectedAccountSnapshot.x, browserProfileId: 'profile-b', browserBindingRevision: wechatVerified.bindingRevision };
    database.prepare("UPDATE workspace_browser_bindings SET expected_account_snapshot_json=? WHERE id='effective'")
      .run(JSON.stringify({ ...wechatVerified.expectedAccountSnapshot, x: staleProfileSnapshot }));
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, { profileId: 'profile-a', bindingRevision: wechatVerified.bindingRevision, platform: 'x', accountKey: 'x-owner' }),
      { code: 'BROWSER_PROFILE_MISMATCH' }
    );
    database.prepare("UPDATE workspace_browser_bindings SET expected_account_snapshot_json=? WHERE id='effective'")
      .run(JSON.stringify(wechatVerified.expectedAccountSnapshot));
    const rebound = rebindWorkspaceBrowserProfile(database, { profileId: 'profile-b', expectedBindingRevision: wechatVerified.bindingRevision });
    assert.deepEqual(rebound.expectedAccountSnapshot, {});
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, { profileId: 'profile-b', bindingRevision: rebound.bindingRevision, platform: 'wechat', accountKey: 'wx-owner' }),
      { code: 'ACCOUNT_MISMATCH' }
    );
    database.close();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test('read-only live identity accepts absent platform markers but preserves binding and mismatch guards', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-account-read-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    initializeWorkspaceBrowserBinding(database, 'profile-a');
    const binding = markWorkspaceBrowserBindingVerified(database, {
      profileId: 'profile-a', expectedBindingRevision: 1,
      account: { platform: 'x', accountKey: '@owner', displayName: 'Owner', loginState: 'authenticated' }
    });
    for (const platform of ['x', 'wechat', 'zhihu']) {
      assert.doesNotThrow(() => assertWorkspaceBrowserIdentity(database, {
        profileId: 'profile-a', bindingRevision: binding.bindingRevision, platform, accountKey: platform === 'x' ? '@owner' : `${platform}-live`,
        allowMissingExpectedAccount: true
      }));
    }
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, {
        profileId: 'profile-a', bindingRevision: binding.bindingRevision, platform: 'x', accountKey: '@other', allowMissingExpectedAccount: true
      }),
      { code: 'ACCOUNT_MISMATCH' }
    );
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, {
        profileId: 'profile-b', bindingRevision: binding.bindingRevision, platform: 'wechat', accountKey: 'wechat-live', allowMissingExpectedAccount: true
      }),
      { code: 'BROWSER_PROFILE_MISMATCH' }
    );
    assert.throws(
      () => assertWorkspaceBrowserIdentity(database, {
        profileId: 'profile-a', bindingRevision: binding.bindingRevision - 1, platform: 'zhihu', accountKey: 'zhihu-live', allowMissingExpectedAccount: true
      }),
      { code: 'PROFILE_STALE' }
    );
    database.close();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
