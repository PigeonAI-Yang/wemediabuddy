import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveAccount, verifyAccount } from '../src/main/accounts.ts';

test('stored account blocks a different browser identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-account-'));
  try {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    saveAccount(database, { platform: 'x', accountKey: 'owner', displayName: 'Owner', loginState: 'authenticated' });
    assert.equal(verifyAccount(database, { platform: 'x', accountKey: 'other' }).error?.code, 'ACCOUNT_MISMATCH');
    database.close();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
