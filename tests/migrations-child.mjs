import assert from 'node:assert/strict';
import path from 'node:path';
import {migrateDatabase} from '../src/main/db/migrations.ts';

const databasePath=path.join(process.env.WMB_TEST_DIRECTORY,'wmb.db');
const first=migrateDatabase(databasePath);
assert.equal(first.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,34);
first.close();
const second=migrateDatabase(databasePath);
assert.equal(second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,34);
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get());
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ranking_cache'").get());
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='x_list_operations'").get());
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='x_list_index_cache'").get());
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='x_list_timeline_cache'").get());
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_body_cache'").get());
assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_carry_items'").get());
assert.ok(second.prepare("SELECT 1 FROM pragma_table_info('source_feeds') WHERE name='registry_id'").get());
second.close();
