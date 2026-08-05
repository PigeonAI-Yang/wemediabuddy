#!/usr/bin/env node
// check-ledger.mjs — task ledger traceability, receipt and CAP-eval waterline checks.
//
// Migrated from the inline "task traceability" section of scripts/check.ps1, with
// the harness contract additions: per-owner doing rule, WMB-4810 waterline receipts
// (evidence path, Pi operator Skill impact, Independent review) and CAP eval gates.
//
// Usage:
//   node scripts/check-ledger.mjs [root]
//
// Root defaults to the repository root (parent of this script's directory).
// All failures are collected and printed to stderr; the process exits 1 when any
// failure exists, otherwise a PASS summary is printed and the process exits 0.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(scriptDir, '..'));

// Waterline: receipt and CAP-eval rules only bind done tasks numbered >= WATERLINE.
const WATERLINE = 4810;
const STATUSES = new Set(['todo', 'doing', 'blocked', 'done']);
const CAP_RE = /\bCAP-\d{3}\b/g;
const REQUIREMENT_RE = /\b(?:REQ|AC)-\d{3}[a-z]?\b/g;
const TASK_ROW_RE = /^\|\s*WMB-(\d{4})\s*\|/;
const WMB_RE = /WMB-\d{4}/g;
const PATH_TOKEN_RE = /[\w@.+-]+(?:\/[\w@.+-]+)+\.[A-Za-z0-9]{1,10}/g;
const SKILL_IMPACT_RE = /Pi operator Skill impact:\s*(updated|no change)\s*—\s*\S/u;
const REVIEW_NOT_REQUIRED_RE =
  /Independent review:\s*not required\s*—\s*(docs-only|test-only|evidence-only|copy-only)/u;
const REVIEW_NAMED_RE = /Independent review:\s*\S+\s*—\s*\S+/u;

const errors = [];
const passes = [];

const fail = (message) => errors.push(message);
const pass = (message) => passes.push(message);

function readText(relativePath) {
  const fullPath = join(root, relativePath);
  if (!existsSync(fullPath)) {
    fail(`Missing ledger document: ${relativePath}`);
    return null;
  }
  return readFileSync(fullPath, 'utf8');
}

// Runs one check section; records a PASS line only when the section added no failures.
function section(label, body) {
  const before = errors.length;
  body();
  if (errors.length === before) pass(label);
}

function reportAndExit() {
  for (const message of errors) console.error(`ERROR: ${message}`);
  for (const message of passes) console.log(`PASS: ${message}`);
  if (errors.length > 0) {
    console.error(`${errors.length} ledger check(s) failed.`);
    process.exit(1);
  }
  console.log(
    `WMB task ledger checks passed (${tasks.length} task rows across TASKS.md and TASKS.archive.md).`
  );
}

console.log(`> checking task ledger (root: ${root})`);

const prdText = readText('PRD.md');
const specText = readText('SPEC.md');
const planText = readText('PLAN.md');
const tasksText = readText('TASKS.md');
// The ledger is split into TASKS.md (active) + TASKS.archive.md (archived).
// The archive may not exist yet; traceability and row checks read the union.
const tasksArchiveText = existsSync(join(root, 'TASKS.archive.md'))
  ? readText('TASKS.archive.md')
  : '';
const tasksUnionText = `${tasksText}\n${tasksArchiveText}`;
const activeLines = tasksText.split(/\r?\n/);
if (activeLines[activeLines.length - 1] === '') activeLines.pop(); // trailing terminator
const activeLineCount = activeLines.length;
if (errors.length > 0) reportAndExit();

console.log(
  `> ledger files: TASKS.md ${activeLineCount} lines${
    tasksArchiveText ? ' + TASKS.archive.md' : ''
  }`
);

// --- Traceability: every SPEC CAP id must map to PLAN and TASKS text ---
const capabilityIds = [...new Set(specText.match(CAP_RE) ?? [])];
section(`CAP traceability (${capabilityIds.length} CAP ids from SPEC)`, () => {
  for (const capabilityId of capabilityIds) {
    if (!planText.includes(capabilityId)) fail(`Capability has no plan mapping: ${capabilityId}`);
    if (!tasksUnionText.includes(capabilityId)) fail(`Capability has no task mapping: ${capabilityId}`);
  }
});

// --- Traceability: every SPEC REQ/AC id (letter suffixes allowed) must appear in PRD ---
const requirementIds = [...new Set(specText.match(REQUIREMENT_RE) ?? [])];
section(`REQ/AC traceability (${requirementIds.length} requirement ids from SPEC)`, () => {
  for (const requirementId of requirementIds) {
    if (!prdText.includes(requirementId)) {
      fail(`SPEC references unknown PRD requirement: ${requirementId}`);
    }
  }
});

// --- Task rows: 8-cell shape, status enum, done evidence, dependency closure ---
// Rows are parsed from the union of TASKS.md (active) and TASKS.archive.md
// (archived); an id present in both files is an error.
const taskRows = [];
for (const { text, source } of [
  { text: tasksText, source: 'active' },
  { text: tasksArchiveText, source: 'archived' },
]) {
  for (const line of text.split(/\r?\n/)) {
    if (TASK_ROW_RE.test(line)) taskRows.push({ line, source });
  }
}
const taskIds = new Set();
const activeIds = new Set();
const archivedIds = new Set();
const tasks = [];

for (const { line, source } of taskRows) {
  const number = Number(line.match(TASK_ROW_RE)[1]);
  const inner = line.trim().replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '');
  const cells = inner.split('|').map((cell) => cell.trim());
  if (cells.length !== 8) {
    fail(`Invalid task row (expected 8 cells, got ${cells.length}): ${line.slice(0, 100)}`);
    continue;
  }
  const task = {
    id: cells[0],
    number,
    capability: cells[2],
    status: cells[3],
    dependsOn: cells[4],
    deliverable: cells[5],
    evidence: cells[6],
    owner: cells[7] || 'main',
    source,
  };
  taskIds.add(task.id);
  (source === 'active' ? activeIds : archivedIds).add(task.id);
  tasks.push(task);
}

section(`task rows (${tasks.length} rows parsed across TASKS.md + TASKS.archive.md)`, () => {
  for (const task of tasks) {
    if (!STATUSES.has(task.status)) {
      fail(`Invalid task status '${task.status}' in ${task.id}`);
    }
    if (task.status === 'done' && (!task.deliverable || !task.evidence)) {
      fail(`Done task lacks deliverable or evidence: ${task.id}`);
    }
    for (const dependency of task.dependsOn.match(WMB_RE) ?? []) {
      if (!taskIds.has(dependency)) fail(`Unknown dependency ${dependency} in ${task.id}`);
    }
  }
});

// --- Cross-file id uniqueness: the same WMB id must not live in both files ---
section('cross-file id uniqueness', () => {
  for (const id of activeIds) {
    if (archivedIds.has(id)) {
      fail(`Task ${id} appears in both TASKS.md and TASKS.archive.md`);
    }
  }
});

// --- Active ledger size: TASKS.md must stay within the line budget ---
section('active ledger line budget', () => {
  if (activeLineCount > 120) {
    fail(
      `TASKS.md has ${activeLineCount} lines (> 120). Archive done rows with: node scripts/tasks-archive.mjs`
    );
  }
});

// --- Doing rule: at most one doing task per owner (empty owner counts as main) ---
section('per-owner doing rule', () => {
  const doingByOwner = new Map();
  for (const task of tasks) {
    if (task.status === 'doing') {
      doingByOwner.set(task.owner, (doingByOwner.get(task.owner) ?? 0) + 1);
    }
  }
  for (const [owner, count] of doingByOwner) {
    if (count > 1) fail(`Owner ${owner} has ${count} tasks doing; at most one allowed`);
  }
});

// --- Waterline receipts: done tasks numbered >= WATERLINE ---
const receiptRows = tasks.filter((task) => task.status === 'done' && task.number >= WATERLINE);
section(`waterline receipts (${receiptRows.length} done tasks >= WMB-${WATERLINE})`, () => {
  for (const task of receiptRows) {
    const pathTokens = task.evidence.match(PATH_TOKEN_RE) ?? [];
    const existingPaths = pathTokens.filter((token) => existsSync(join(root, token)));
    if (existingPaths.length === 0) {
      fail(
        `Receipt ${task.id}: evidence has no existing repo-relative path (tokens found: ${pathTokens.join(', ') || 'none'})`
      );
    }
    if (!SKILL_IMPACT_RE.test(task.evidence)) {
      fail(
        `Receipt ${task.id}: evidence must contain 'Pi operator Skill impact: (updated|no change) — <description>'`
      );
    }
    if (!REVIEW_NOT_REQUIRED_RE.test(task.evidence) && !REVIEW_NAMED_RE.test(task.evidence)) {
      fail(
        `Receipt ${task.id}: evidence must contain 'Independent review: <name> — <verdict>' or 'Independent review: not required — (docs-only|test-only|evidence-only|copy-only)'`
      );
    }
    // Fourth receipt: the Evidence cell itself must stay concise (<= 700 chars);
    // longer narrative belongs in `.ai/wmb-<id>-evidence.md`.
    if (task.evidence.length > 700) {
      fail(
        `Receipt ${task.id}: Evidence cell is ${task.evidence.length} characters (> 700); move narrative detail to .ai/wmb-${String(task.number).padStart(4, '0')}-evidence.md`
      );
    }
  }
});

// --- CAP eval gates: fully done CAP with max task >= WATERLINE needs an EVAL file ---
const tasksByCapability = new Map();
for (const task of tasks) {
  for (const capabilityId of task.capability.match(CAP_RE) ?? []) {
    if (!tasksByCapability.has(capabilityId)) tasksByCapability.set(capabilityId, []);
    tasksByCapability.get(capabilityId).push(task);
  }
}
section('CAP eval gates', () => {
  for (const capabilityId of capabilityIds) {
    const referencing = tasksByCapability.get(capabilityId) ?? [];
    if (referencing.length === 0) continue;
    const allDone = referencing.every((task) => task.status === 'done');
    const maxTaskNumber = Math.max(...referencing.map((task) => task.number));
    if (!allDone || maxTaskNumber < WATERLINE) continue;
    const digits = capabilityId.match(/\d{3}/)[0];
    const evalFile = join(root, '.ai', 'evals', `EVAL-CAP-${digits}.md`);
    if (!existsSync(evalFile)) {
      fail(
        `Capability ${capabilityId} is fully done (max task WMB-${maxTaskNumber}): missing .ai/evals/EVAL-CAP-${digits}.md`
      );
    }
  }
});

reportAndExit();
