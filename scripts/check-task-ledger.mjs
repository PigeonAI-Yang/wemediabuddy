import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const LEDGER_PATH = path.join(ROOT, 'TASKS.md');
const RECEIPT_ROOT = path.join(ROOT, '.ai', 'task-receipts');
const VALID_STATUSES = new Set(['todo', 'doing', 'blocked', 'done']);
const EXPLICIT_ENFORCED_TASKS = new Set([
  'WMB-5374',
  'WMB-5385',
  'WMB-5386',
  'WMB-5387',
  'WMB-5388',
  'WMB-5324'
]);
const NUMERIC_WATERLINE = 5391;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function parseRows(markdown) {
  const rows = [];
  for (const line of markdown.split(/\r?\n/u)) {
    if (!/^\| WMB-[^|]+\|/u.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 7) fail('LEDGER_ROW_SHAPE_INVALID', line);
    rows.push({
      taskId: cells[0],
      milestone: cells[1],
      capability: cells[2],
      status: cells[3],
      dependsOn: cells[4],
      deliverable: cells[5],
      evidence: cells[6],
      owner: cells[7] ?? '',
      line
    });
  }
  return rows;
}

function taskNumber(taskId) {
  const match = /^WMB-(\d+)$/u.exec(taskId);
  return match ? Number(match[1]) : null;
}

function isEnforced(taskId) {
  const number = taskNumber(taskId);
  return EXPLICIT_ENFORCED_TASKS.has(taskId) || (number !== null && number >= NUMERIC_WATERLINE);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function readReceipt(taskId) {
  const receiptPath = path.join(RECEIPT_ROOT, `${taskId}.json`);
  if (!existsSync(receiptPath)) fail('TASK_DONE_WITHOUT_RECEIPT', `${taskId} requires ${path.relative(ROOT, receiptPath)}`);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    fail('TASK_RECEIPT_INVALID_JSON', `${taskId}: ${error.message}`);
  }
  return { receipt, receiptPath };
}

function verifyReceipt(row) {
  const { receipt, receiptPath } = readReceipt(row.taskId);
  if (receipt.taskId !== row.taskId) fail('TASK_RECEIPT_ID_MISMATCH', `${row.taskId}: ${receipt.taskId}`);
  if (typeof receipt.implementationCommit !== 'string' || !/^[0-9a-f]{7,40}$/iu.test(receipt.implementationCommit)) {
    fail('TASK_COMMIT_INVALID', `${row.taskId}: implementationCommit missing or malformed`);
  }
  if (typeof receipt.upstream !== 'string' || !receipt.upstream) fail('TASK_UPSTREAM_MISSING', row.taskId);
  if (!Array.isArray(receipt.changedPaths) || receipt.changedPaths.length === 0) fail('TASK_PATHS_MISSING', row.taskId);
  if (!receipt.verification || receipt.verification.exitCode !== 0 || typeof receipt.verification.command !== 'string' || !receipt.verification.command) {
    fail('TASK_VERIFICATION_MISSING', row.taskId);
  }
  if (typeof receipt.verification.log !== 'string' || !receipt.verification.log) fail('TASK_VERIFICATION_LOG_MISSING', row.taskId);
  const verificationLogPath = path.join(ROOT, receipt.verification.log);
  if (!existsSync(verificationLogPath) || readFileSync(verificationLogPath, 'utf8').trim().length === 0) {
    fail('TASK_VERIFICATION_LOG_EMPTY', `${row.taskId}: ${receipt.verification.log}`);
  }

  try {
    git(['cat-file', '-e', `${receipt.implementationCommit}^{commit}`]);
  } catch {
    fail('TASK_COMMIT_NOT_FOUND', `${row.taskId}: ${receipt.implementationCommit}`);
  }

  const subject = git(['show', '-s', '--format=%s', receipt.implementationCommit]);
  if (!subject.includes(row.taskId)) fail('TASK_COMMIT_ID_MISSING', `${row.taskId}: commit subject must contain task id`);

  try {
    git(['rev-parse', '--verify', receipt.upstream]);
    execFileSync('git', ['merge-base', '--is-ancestor', receipt.implementationCommit, receipt.upstream], {
      cwd: ROOT,
      stdio: 'ignore'
    });
  } catch {
    fail('TASK_COMMIT_NOT_PUSHED', `${row.taskId}: ${receipt.implementationCommit} is not reachable from ${receipt.upstream}`);
  }
  const relativeReceipt = path.relative(ROOT, receiptPath).replaceAll('\\', '/');
  const closureCommit = git(['log', '-1', '--format=%H', '--', relativeReceipt]);
  if (!closureCommit) fail('TASK_CLOSURE_COMMIT_NOT_FOUND', row.taskId);
  const closureSubject = git(['show', '-s', '--format=%s', closureCommit]);
  if (!closureSubject.includes(`close ${row.taskId}`)) fail('TASK_CLOSURE_COMMIT_INVALID', `${row.taskId}: ${closureSubject}`);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', closureCommit, receipt.upstream], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    fail('TASK_CLOSURE_NOT_PUSHED', `${row.taskId}: closure ${closureCommit} is not reachable from ${receipt.upstream}`);
  }

  const actualPaths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', receipt.implementationCommit])
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!sameStrings(actualPaths, receipt.changedPaths)) {
    fail('TASK_PATH_SET_MISMATCH', `${row.taskId}: receipt=${sorted(receipt.changedPaths).join(',')} commit=${sorted(actualPaths).join(',')}`);
  }

  if (!row.evidence.includes(relativeReceipt)) fail('TASK_RECEIPT_NOT_LINKED', `${row.taskId}: evidence must name ${relativeReceipt}`);
}

function verifyLedger(markdown, rows) {
  const duplicateIds = rows.filter((row, index) => rows.findIndex((candidate) => candidate.taskId === row.taskId) !== index);
  if (duplicateIds.length) fail('DUPLICATE_TASK_ID', duplicateIds.map((row) => row.taskId).join(','));

  for (const row of rows) {
    if (!VALID_STATUSES.has(row.status)) fail('TASK_STATUS_INVALID', `${row.taskId}: ${row.status}`);
  }

  const doing = rows.filter((row) => row.status === 'doing');
  if (doing.length > 1) fail('MULTIPLE_ACTIVE_TASKS', doing.map((row) => row.taskId).join(','));

  const firstTodo = rows.find((row) => row.status === 'todo');
  const pointer = /next ledger row is (WMB-\d+)/iu.exec(markdown)?.[1] ?? null;
  if (pointer && firstTodo && pointer !== firstTodo.taskId) {
    fail('LEDGER_POINTER_MISMATCH', `summary=${pointer} firstTodo=${firstTodo.taskId}`);
  }

  const byId = new Map(rows.map((row) => [row.taskId, row]));
  for (const row of rows) {
    if (row.status === 'done' && isEnforced(row.taskId)) verifyReceipt(row);
    if (row.status !== 'doing') continue;
    const dependencies = row.dependsOn.match(/WMB-\d+/gu) ?? [];
    for (const dependency of dependencies) {
      const dependencyRow = byId.get(dependency);
      if (dependencyRow && dependencyRow.status !== 'done') {
        fail('TASK_DEPENDENCY_NOT_CLOSED', `${row.taskId} depends on ${dependency}=${dependencyRow.status}`);
      }
      if (isEnforced(dependency) && dependencyRow?.status === 'done') verifyReceipt(dependencyRow);
    }
  }
}

function selfTest() {
  const header = `| Task | Milestone | Capability | Status | Depends on | Deliverable | Verification / evidence | Owner |\n| --- | --- | --- | --- | --- | --- | --- | --- |`;
  const multiDoing = `${header}\n| WMB-6000 | M | CAP | doing | none | x | y | main |\n| WMB-6001 | M | CAP | doing | WMB-6000 | x | y | main |`;
  let multiDoingRejected = false;
  try {
    verifyLedger(multiDoing, parseRows(multiDoing));
  } catch (error) {
    multiDoingRejected = String(error.message).startsWith('MULTIPLE_ACTIVE_TASKS:');
  }
  if (!multiDoingRejected) fail('SELF_TEST_FAILED', 'fabricated multi-doing ledger was accepted');

  const falseDone = `${header}\n| WMB-6002 | M | CAP | done | none | x | claimed without receipt | main |`;
  let falseDoneRejected = false;
  try {
    verifyLedger(falseDone, parseRows(falseDone));
  } catch (error) {
    falseDoneRejected = String(error.message).startsWith('TASK_DONE_WITHOUT_RECEIPT:');
  }
  if (!falseDoneRejected) fail('SELF_TEST_FAILED', 'fabricated done row without receipt was accepted');
  console.log('check-task-ledger self-test PASS: multi-doing and receipt-less done states rejected.');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  if (!existsSync(LEDGER_PATH)) fail('LEDGER_MISSING', LEDGER_PATH);
  const markdown = readFileSync(LEDGER_PATH, 'utf8');
  const rows = parseRows(markdown);
  verifyLedger(markdown, rows);
  console.log(`check-task-ledger PASS: ${rows.length} rows; receipts enforced for explicit current tasks and WMB-${NUMERIC_WATERLINE}+. `);
}
