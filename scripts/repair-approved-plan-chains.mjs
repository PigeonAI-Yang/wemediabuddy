import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { dispatchApprovedPlanItemChainRepair } from '../src/main/approved-plan-chain-repair-command.ts';
import { approvedPlanItemChainPreStateHash } from '../src/main/approved-plan-chain-repair.ts';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) { args.set(key, next); index += 1; }
  else args.set(key, true);
}
const dataRoot = path.resolve(String(args.get('--data-root') ?? 'J:/PigeonYang/WeMediaBuddyData'));
const databasePath = path.join(dataRoot, 'wmb.db');
const apply = args.has('--apply');
const runId = String(args.get('--run-id') ?? '').trim();
const attemptId = String(args.get('--attempt-id') ?? 'initial').trim();
const requestedPlanItemId = String(args.get('--plan-item-id') ?? '').trim();
const summaryOnly = args.has('--summary-only');
const thesisRepairPath = String(args.get('--thesis-repair') ?? '').trim();
if (thesisRepairPath && !requestedPlanItemId) throw new Error('--thesis-repair requires --plan-item-id for exact identity binding');
const thesisRepair = thesisRepairPath ? JSON.parse(readFileSync(path.resolve(thesisRepairPath), 'utf8')) : null;
const referenceBackupPath = String(args.get('--reference-backup') ?? '').trim();
const referenceSha256 = String(args.get('--reference-sha256') ?? '').trim().toUpperCase();
if ((referenceBackupPath && !referenceSha256) || (!referenceBackupPath && referenceSha256)) {
  throw new Error('--reference-backup and --reference-sha256 must be provided together');
}
if (apply && (!runId || !attemptId)) throw new Error('--apply requires non-empty --run-id and --attempt-id values for receipt replay safety');

async function sha256File(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex').toUpperCase();
}

async function createVerifiedBackup() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backupPath = `${databasePath}.approved-chain-repair-backup-${stamp}-${process.pid}.db`;
  const source = new DatabaseSync(databasePath);
  try {
    const checkpoint = source.prepare('PRAGMA wal_checkpoint(FULL)').get();
    if (!checkpoint || Number(checkpoint.busy) !== 0 || Number(checkpoint.log) !== Number(checkpoint.checkpointed)) {
      throw new Error(`backup checkpoint did not settle: ${JSON.stringify(checkpoint)}`);
    }
    source.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const check = copy.prepare('PRAGMA quick_check').get();
    if (!check || Object.values(check)[0] !== 'ok') throw new Error(`backup quick_check failed: ${JSON.stringify(check)}`);
  } finally {
    copy.close();
  }
  return {
    path: backupPath,
    sha256: await sha256File(backupPath)
  };
}

async function resolveVerifiedBackup() {
  if (!referenceBackupPath) return createVerifiedBackup();
  const resolvedPath = path.resolve(referenceBackupPath);
  const actualSha256 = await sha256File(resolvedPath);
  if (actualSha256 !== referenceSha256) throw new Error('reference backup sha256 mismatch');
  const copy = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    const check = copy.prepare('PRAGMA quick_check').get();
    if (!check || Object.values(check)[0] !== 'ok') throw new Error(`reference backup quick_check failed: ${JSON.stringify(check)}`);
  } finally {
    copy.close();
  }
  return { path: resolvedPath, sha256: actualSha256, provided: true };
}

function inventory(database) {
  const where = requestedPlanItemId ? 'AND pi.id=?' : '';
  const params = requestedPlanItemId ? [requestedPlanItemId] : [];
  return database.prepare(`SELECT pi.id AS planItemId, pi.revision, pi.title,
      json_extract(pi.planning_provenance_json, '$.thesis_lock.version') AS thesisLockVersion,
      (SELECT count(*) FROM content_projects cp WHERE cp.plan_item_id=pi.id) AS projectCount,
      (SELECT count(*) FROM content_versions cv JOIN content_projects cp ON cp.id=cv.project_id WHERE cp.plan_item_id=pi.id) AS versionCount,
      (SELECT count(*) FROM work_carry_items wc WHERE wc.object_type='plan_item' AND wc.object_id=pi.id) AS carryCount,
      (SELECT count(*) FROM work_carry_items wc WHERE wc.object_type='plan_item' AND wc.object_id=pi.id AND wc.state<>'done') AS nonDoneCarryCount
    FROM plan_items pi WHERE pi.planning_status='approved' ${where} ORDER BY pi.id`).all(...params);
}

if (!apply) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = inventory(database);
    console.log(JSON.stringify({ mode: 'dry-run', databasePath, count: rows.length, rows }, null, 2));
  } finally { database.close(); }
  process.exit(0);
}

const verifiedBackup = await resolveVerifiedBackup();
const runtime = ActiveWorkspaceRuntime.open(dataRoot, { openDatabase: migrateDatabase });
const referenceDatabase = new DatabaseSync(verifiedBackup.path, { readOnly: true });
let failed = 0;
try {
  const rows = inventory(runtime.database);
  const receipts = [];
  for (const row of rows) {
    const receipt = await dispatchApprovedPlanItemChainRepair(runtime, {
      planItemId: row.planItemId,
      expectedRevision: row.revision,
      requestId: `${runId}:${attemptId}:${row.planItemId}:${row.revision}`,
      rollbackBinding: {
        referenceSha256: verifiedBackup.sha256,
        preStateHash: approvedPlanItemChainPreStateHash(referenceDatabase, row.planItemId)
      },
      ...(thesisRepair ? { thesisRepair } : {})
    });
    receipts.push({
      planItemId: row.planItemId,
      title: row.title,
      ok: receipt.ok,
      receiptId: receipt.receiptId,
      data: receipt.data,
      error: receipt.error
    });
  }
  const report = {
    mode: 'apply', databasePath, runId, attemptId, backup: verifiedBackup, attempted: receipts.length,
    succeeded: receipts.filter((entry) => entry.ok).length,
    repaired: receipts.filter((entry) => entry.data?.repaired).length,
    failed: receipts.filter((entry) => !entry.ok).length,
    receipts
  };
  failed = report.failed;
  const retryInstruction = failed > 0
    ? `Retry failed repairs with a new attempt id: --run-id ${runId} --attempt-id retry-<unique-id>`
    : null;
  console.log(JSON.stringify(summaryOnly ? {
    ...report,
    retryInstruction,
    receipts: receipts.filter((entry) => !entry.ok),
    glmFlash: receipts.find((entry) => entry.planItemId === '66e77c11-8252-47d8-86f5-2e5515c022cb') ?? null
  } : { ...report, retryInstruction }, null, 2));
} finally {
  referenceDatabase.close();
  await runtime.stop({ drain: false });
}
if (failed > 0) process.exitCode = 2;
