#!/usr/bin/env node
// tasks-archive.mjs — move done task rows out of TASKS.md into TASKS.archive.md.
//
// Archive rule (ledger contract): a `done` row whose id is NOT referenced by
// any non-done row's "Depends on" cell is eligible for archiving. The ledger
// split is TASKS.md (active) + TASKS.archive.md (archived); check-ledger
// parses both as a union, so moving rows never weakens traceability.
//
// Usage:
//   node scripts/tasks-archive.mjs [--dry-run] [root]
//
// --dry-run only prints the ids that would move, plus statistics; nothing is
// written. A real run rewrites TASKS.md without the moved rows and appends
// them to TASKS.archive.md (created with a one-line header comment when it
// does not exist). Rows keep their exact line bytes (CRLF preserved) and are
// appended in original order, deduped by id against the archive. The header
// prose of TASKS.md is never touched. Re-running is a no-op (idempotent).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(scriptDir, '..'));

const TASK_ROW_RE = /^\|\s*WMB-(\d{4})\s*\|/;
const WMB_RE = /WMB-\d{4}/g;
const NOT_DONE = new Set(['todo', 'doing', 'blocked']);
const ARCHIVE_HEADER = '# Archived WMB task rows (moved by scripts/tasks-archive.mjs)';

const tasksPath = join(root, 'TASKS.md');
const archivePath = join(root, 'TASKS.archive.md');
if (!existsSync(tasksPath)) {
  console.error(`Missing TASKS.md at ${tasksPath}`);
  process.exit(1);
}

const text = readFileSync(tasksPath, 'utf8');
const terminator = text.includes('\r\n') ? '\r\n' : '\n';
const endsWithTerminator = /[\r\n]$/.test(text);
const lines = text.split(/\r?\n/);

// Parse task rows (keep the raw line for byte-exact moves).
const rows = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(TASK_ROW_RE);
  if (!m) continue;
  const inner = lines[i].trim().replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '');
  const cells = inner.split('|').map((c) => c.trim());
  rows.push({ id: `WMB-${m[1]}`, line: lines[i], index: i, cells });
}

// ids referenced by any non-done row's "Depends on" cell.
const referencedByNonDone = new Set();
for (const row of rows) {
  if (!NOT_DONE.has(row.cells[3] ?? '')) continue; // done (or unknown) rows never block archiving
  for (const dep of (row.cells[4] ?? '').match(WMB_RE) ?? []) referencedByNonDone.add(dep);
}

const candidates = rows.filter((row) => (row.cells[3] ?? '') === 'done' && !referencedByNonDone.has(row.id));

// ids already present in the archive (dedupe by id).
const archiveText = existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : '';
const archiveIds = new Set();
for (const m of archiveText.matchAll(/^\|\s*(WMB-\d{4})\s*\|/gm)) archiveIds.add(m[1]);

const alreadyArchived = candidates.filter((row) => archiveIds.has(row.id));
const toMove = candidates.filter((row) => !archiveIds.has(row.id));
const kept = rows.length - toMove.length;

if (dryRun) {
  console.log(`dry-run (${root}):`);
  for (const row of toMove) console.log(`- ${row.id}`);
  console.log(
    `summary: would move ${toMove.length}, keep ${kept} active row(s), already archived ${alreadyArchived.length}`
  );
  process.exit(0);
}

if (toMove.length === 0) {
  console.log(
    `no rows to move (${root}): keep ${kept} active row(s), already archived ${alreadyArchived.length}`
  );
  process.exit(0);
}

// Rewrite TASKS.md without the moved rows (header prose untouched, bytes preserved).
const moveIndexes = new Set(toMove.map((row) => row.index));
const keptLines = lines.filter((_, i) => !moveIndexes.has(i));
const nextTasksText = keptLines.join(terminator) + (endsWithTerminator ? terminator : '');
writeFileSync(tasksPath, nextTasksText, 'utf8');

// Append moved rows (original order) to TASKS.archive.md.
const movedLines = toMove.map((row) => row.line);
let nextArchiveText;
if (archiveText.length === 0) {
  nextArchiveText = `${ARCHIVE_HEADER}${terminator}${movedLines.join(terminator)}${terminator}`;
} else {
  const separator = /[\r\n]$/.test(archiveText) ? '' : terminator;
  nextArchiveText = archiveText + separator + movedLines.join(terminator) + terminator;
}
writeFileSync(archivePath, nextArchiveText, 'utf8');

console.log(
  `moved ${toMove.length} row(s) to TASKS.archive.md (${root}); keep ${kept} active row(s), already archived ${alreadyArchived.length}`
);
