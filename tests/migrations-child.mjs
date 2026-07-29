import assert from 'node:assert/strict';
import path from 'node:path';
import {migrateDatabase} from '../src/main/db/migrations.ts';

const databasePath=path.join(process.env.WMB_TEST_DIRECTORY,'wmb.db');
const first=migrateDatabase(databasePath);
assert.equal(first.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,26);
first.close();
const second=migrateDatabase(databasePath);
assert.equal(second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,26);
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get());
second.close();
