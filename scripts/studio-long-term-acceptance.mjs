import { createHash } from 'node:crypto';
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';

const [sourceRootArg, targetRootArg] = process.argv.slice(2);
if (!sourceRootArg || !targetRootArg) throw new Error('Usage: node scripts/studio-long-term-acceptance.mjs <source-root> <new-target-root>');
const sourceRoot = path.resolve(sourceRootArg);
const targetRoot = path.resolve(targetRootArg);
if (await exists(targetRoot)) throw new Error(`Target must not exist: ${targetRoot}`);

await mkdir(targetRoot, { recursive: true });
for (const name of ['browser-profile', 'logs', 'exports']) await mkdir(path.join(targetRoot, name));
await cp(path.join(sourceRoot, 'assets'), path.join(targetRoot, 'assets'), { recursive: true });

const databasePath = path.join(targetRoot, 'wmb.db');
const source = new DatabaseSync(path.join(sourceRoot, 'wmb.db'), { readOnly: true });
source.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
source.close();

const snapshot = new DatabaseSync(databasePath);
const before = audit(snapshot);
snapshot.exec(`
  DROP INDEX IF EXISTS content_projects_archive_updated;
  DROP INDEX IF EXISTS content_projects_status_archive_updated;
  ALTER TABLE content_projects DROP COLUMN archived_at;
  ALTER TABLE content_projects DROP COLUMN status;
  DELETE FROM schema_migrations WHERE version = 15;
`);
const preMigration = audit(snapshot);
const preColumns = snapshot.prepare('PRAGMA table_info(content_projects)').all().map(({ name }) => name);
snapshot.close();
if (preColumns.includes('status') || preColumns.includes('archived_at') || preMigration.migrationCount !== 14) {
  throw new Error('Could not construct the real-data v14 migration input');
}

const migrated = migrateDatabase(databasePath);
const postMigration = audit(migrated);
const postColumns = migrated.prepare('PRAGMA table_info(content_projects)').all().map(({ name }) => name);
if (!postColumns.includes('status') || !postColumns.includes('archived_at') || postMigration.migrationCount !== 15) {
  throw new Error('Migration 15 did not restore the lifecycle schema');
}
for (const key of ['projectCount', 'versionCount', 'platformVersionCount', 'coreBodyHash', 'platformBodyHash']) {
  if (before[key] !== postMigration[key]) throw new Error(`Migration changed ${key}: ${before[key]} -> ${postMigration[key]}`);
}

const needed = 1001 - postMigration.projectCount;
if (needed < 0) throw new Error(`Real data already exceeds 1001 projects: ${postMigration.projectCount}`);
const insertProject = migrated.prepare(`INSERT INTO content_projects
  (id, title, status, archived_at, created_at, updated_at, revision)
  VALUES (?, ?, 'drafting', NULL, ?, ?, 1)`);
const insertVersion = migrated.prepare(`INSERT INTO content_versions
  (id, project_id, body, version_number, created_at, author) VALUES (?, ?, ?, 1, ?, 'ai')`);
migrated.exec('BEGIN IMMEDIATE');
try {
  for (let index = 1; index <= needed; index += 1) {
    const suffix = String(index).padStart(4, '0');
    const projectId = `wmb-1106-scale-${suffix}`;
    const createdAt = new Date(Date.UTC(2020, 0, 1, 0, 0, 0, index)).toISOString();
    const marker = index === needed ? 'needle-wmb-1106-tail ' : `scale-${suffix} `;
    const body = marker + '字'.repeat(1500 - marker.length);
    insertProject.run(projectId, `WMB-1106 规模项目 ${suffix}`, createdAt, createdAt);
    insertVersion.run(`${projectId}-v1`, projectId, body, createdAt);
  }
  migrated.exec('COMMIT');
} catch (error) {
  migrated.exec('ROLLBACK');
  throw error;
}
const seeded = audit(migrated);
migrated.close();
if (seeded.projectCount !== 1001) throw new Error(`Seeded project count is ${seeded.projectCount}, expected 1001`);

const receipt = {
  sourceRoot,
  targetRoot,
  before,
  preMigration,
  postMigration,
  seeded,
  seededProjectCount: needed,
  migrationPreservedCountsAndHashes: true,
  generatedAt: new Date().toISOString()
};
await writeFile(path.join(targetRoot, 'wmb-1106-receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');
console.log(JSON.stringify(receipt));

function audit(database) {
  const projectCount = Number(database.prepare('SELECT COUNT(*) AS count FROM content_projects').get().count);
  const versionCount = Number(database.prepare('SELECT COUNT(*) AS count FROM content_versions').get().count);
  const platformVersionCount = Number(database.prepare('SELECT COUNT(*) AS count FROM platform_versions').get().count);
  const migrationCount = Number(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count);
  return {
    projectCount,
    versionCount,
    platformVersionCount,
    migrationCount,
    coreBodyHash: rowsHash(database.prepare('SELECT project_id AS projectId, version_number AS versionNumber, body FROM content_versions ORDER BY project_id, version_number').all()),
    platformBodyHash: rowsHash(database.prepare('SELECT project_id AS projectId, id, body FROM platform_versions ORDER BY project_id, id').all())
  };
}

function rowsHash(rows) {
  const hash = createHash('sha256');
  for (const row of rows) {
    const value = JSON.stringify(row);
    hash.update(String(Buffer.byteLength(value))).update(':').update(value);
  }
  return hash.digest('hex');
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}
