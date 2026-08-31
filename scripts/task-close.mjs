import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LEDGER_PATH = path.join(ROOT, 'TASKS.md');
const RECEIPT_ROOT = path.join(ROOT, '.ai', 'task-receipts');
const ARCHIVE_ROOT = path.join(ROOT, '.ai', 'task-ledger', 'archive');

function stop(code, detail) {
  console.error(`${code}: ${detail}`);
  process.exit(1);
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    stop(options.code ?? 'GIT_COMMAND_FAILED', `${args.join(' ')}: ${detail}`);
  }
}

function parseArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0) stop('VERIFY_COMMAND_REQUIRED', 'usage: npm run task:close -- WMB-5385 <implementationCommit> [--upstream origin/master] -- <verification command>');
  const control = argv.slice(0, separator);
  const verify = argv.slice(separator + 1);
  if (control.length < 2 || verify.length === 0) stop('ARGUMENTS_INVALID', 'task id, implementation commit and verification command are required');
  const taskId = control[0];
  const implementationCommit = control[1];
  let upstream = 'origin/master';
  for (let index = 2; index < control.length; index += 1) {
    if (control[index] === '--upstream' && control[index + 1]) {
      upstream = control[index + 1];
      index += 1;
    } else {
      stop('ARGUMENTS_INVALID', `unknown option ${control[index]}`);
    }
  }
  if (!/^WMB-\d+$/u.test(taskId)) stop('TASK_ID_INVALID', taskId);
  return { taskId, implementationCommit, upstream, verify };
}

function findTaskLine(markdown, taskId) {
  const lines = markdown.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.startsWith(`| ${taskId} |`));
  if (index < 0) stop('TASK_NOT_FOUND', taskId);
  const cells = lines[index].split('|').slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 8) stop('LEDGER_ROW_SHAPE_INVALID', lines[index]);
  return { lines, index, cells };
}

const { taskId, implementationCommit, upstream, verify } = parseArguments(process.argv.slice(2));
const receiptPath = path.join(RECEIPT_ROOT, `${taskId}.json`);
const logPath = path.join(RECEIPT_ROOT, `${taskId}.verify.log`);
const archiveMonth = new Date().toISOString().slice(0, 7);
const archivePath = path.join(ARCHIVE_ROOT, `${archiveMonth}.md`);
const relativeReceipt = path.relative(ROOT, receiptPath).replaceAll('\\', '/');
const relativeLog = path.relative(ROOT, logPath).replaceAll('\\', '/');
const relativeArchive = path.relative(ROOT, archivePath).replaceAll('\\', '/');

if (!existsSync(LEDGER_PATH)) stop('LEDGER_MISSING', LEDGER_PATH);
if (existsSync(receiptPath) || existsSync(logPath)) stop('TASK_RECEIPT_ALREADY_EXISTS', taskId);
const protectedStatus = git(['status', '--porcelain=v1', '--', 'TASKS.md', relativeReceipt, relativeLog, relativeArchive]);
if (protectedStatus) stop('TASK_CLOSURE_FILES_DIRTY', protectedStatus);

const markdown = readFileSync(LEDGER_PATH, 'utf8');
const task = findTaskLine(markdown, taskId);
if (task.cells[3] !== 'doing') stop('TASK_NOT_DOING', `${taskId} status is ${task.cells[3]}`);

git(['cat-file', '-e', `${implementationCommit}^{commit}`], { code: 'TASK_COMMIT_NOT_FOUND' });
const subject = git(['show', '-s', '--format=%s', implementationCommit]);
if (!subject.includes(taskId)) stop('TASK_COMMIT_ID_MISSING', `commit subject must contain ${taskId}`);
git(['rev-parse', '--verify', upstream], { code: 'TASK_UPSTREAM_NOT_FOUND' });
try {
  execFileSync('git', ['merge-base', '--is-ancestor', implementationCommit, upstream], { cwd: ROOT, stdio: 'ignore' });
} catch {
  stop('TASK_COMMIT_NOT_PUSHED', `${implementationCommit} is not reachable from ${upstream}`);
}

const changedPaths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', implementationCommit])
  .split(/\r?\n/u)
  .map((value) => value.trim())
  .filter(Boolean);
if (changedPaths.length === 0) stop('TASK_COMMIT_EMPTY', implementationCommit);
for (const changedPath of changedPaths) {
  git(['ls-files', '--error-unmatch', '--', changedPath], { code: 'UNTRACKED_TASK_FILE' });
}

const verification = spawnSync(verify[0], verify.slice(1), {
  cwd: ROOT,
  encoding: 'utf8',
  shell: false,
  windowsHide: true
});
const output = `${verification.stdout ?? ''}${verification.stderr ?? ''}`;
mkdirSync(RECEIPT_ROOT, { recursive: true });
writeFileSync(logPath, output, 'utf8');
if (verification.error) stop('TASK_VERIFICATION_LAUNCH_FAILED', verification.error.message);
if (verification.status !== 0) stop('TASK_VERIFICATION_FAILED', `${verify.join(' ')} exited ${verification.status}; see ${relativeLog}`);

const receipt = {
  schemaVersion: 1,
  taskId,
  implementationCommit,
  upstream,
  changedPaths,
  verification: {
    command: verify.join(' '),
    exitCode: verification.status,
    log: relativeLog
  },
  closedAt: new Date().toISOString()
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

task.cells[3] = 'done';
const receiptEvidence = `Closure receipt: \`${relativeReceipt}\`.`;
if (!task.cells[6].includes(relativeReceipt)) task.cells[6] = `${task.cells[6]} ${receiptEvidence}`.trim();
const archivedRow = `| ${task.cells.join(' | ')} |`;
mkdirSync(ARCHIVE_ROOT, { recursive: true });
const archiveHeader = `# Task archive — ${archiveMonth}\n\n| Task | Milestone | Capability | Status | Depends on | Deliverable | Verification / evidence | Owner |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
const archiveContent = existsSync(archivePath) ? readFileSync(archivePath, 'utf8').replace(/\n*$/u, '\n') : archiveHeader;
writeFileSync(archivePath, `${archiveContent}${archivedRow}\n`, 'utf8');

task.lines.splice(task.index, 1);
const nextTodoLine = task.lines.find((line) => {
  if (!/^\| WMB-[^|]+\|/u.test(line)) return false;
  return line.split('|').slice(1, -1).map((cell) => cell.trim())[3] === 'todo';
});
const nextTodoId = nextTodoLine?.split('|')[1]?.trim() ?? null;
let nextLedger = task.lines.join('\n').replace(/\n+$/u, '');
if (nextTodoId) nextLedger = nextLedger.replace(/next ledger row is WMB-\d+/iu, `next ledger row is ${nextTodoId}`);
writeFileSync(LEDGER_PATH, `${nextLedger}\n`, 'utf8');

git(['add', '--', 'TASKS.md', relativeArchive, relativeReceipt, relativeLog]);
git(['commit', '-m', `chore: close ${taskId}`], { stdio: 'inherit', code: 'TASK_CLOSURE_COMMIT_FAILED' });

const upstreamMatch = /^(?<remote>[^/]+)\/(?<branch>.+)$/u.exec(upstream);
if (!upstreamMatch?.groups) stop('TASK_UPSTREAM_INVALID', `${upstream} must be remote/branch`);
git(['push', upstreamMatch.groups.remote, `HEAD:${upstreamMatch.groups.branch}`], { stdio: 'inherit', code: 'TASK_CLOSURE_PUSH_FAILED' });
git(['fetch', upstreamMatch.groups.remote, upstreamMatch.groups.branch], { stdio: 'inherit', code: 'TASK_CLOSURE_FETCH_FAILED' });

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-task-ledger.mjs')], { cwd: ROOT, stdio: 'inherit' });
console.log(`task-close PASS: ${taskId} verified, receipt committed, and closure pushed to ${upstream}.`);
