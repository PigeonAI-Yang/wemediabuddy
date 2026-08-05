#!/usr/bin/env node
// task-context.mjs — print the minimal sufficient context for one WMB task.
//
// Usage:
//   node scripts/task-context.mjs WMB-4804 [root]
//
// Output goes to stdout, in order:
//   a) TASKS.md header (everything before the first task row);
//   b) the target task row, verbatim (TASKS.md first, then TASKS.archive.md);
//   c) the task row of every WMB id in its "Depends on" cell (deduped, not recursive);
//   d) the SPEC.md section containing each CAP id in its "Capability" cell —
//      the minimal section (heading to the next same-or-higher-level heading);
//      when a CAP appears in several sections all of them are printed; if SPEC.md
//      has no heading structure, fall back to each mention ±20 lines, merged and deduped;
//   e) the PRD.md requirement-index rows for every REQ/AC id mentioned in (d);
//   f) a final "total lines: N" line (N counts every line printed before it,
//      including source annotation lines).
//
// Every section is prefixed with one machine-readable source annotation line;
// the excerpt is verbatim (no AI paraphrase). Exit code 1 for an unknown task id.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[3] ?? join(scriptDir, '..'));
const targetId = process.argv[2];

if (!targetId || !/^WMB-\d{4}$/.test(targetId)) {
  console.error('Usage: node scripts/task-context.mjs WMB-xxxx [root]');
  process.exit(2);
}

const TASK_ROW_RE = /^\|\s*WMB-(\d{4})\s*\|/;
const WMB_RE = /WMB-\d{4}/g;
const CAP_ID_RE = /\bCAP-\d{3}\b/g;
const REQ_ID_RE = /\b(?:REQ|AC)-\d{3}[a-z]?\b/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const PRD_INDEX_ROW_RE = /^\|\s*((?:REQ|AC)-\d{3}[a-z]?)\s*\|/;

const out = [];
const push = (...lines) => out.push(...lines);

const readText = (relativePath) => {
  const fullPath = join(root, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : null;
};

// id -> { source, line, cells }
function parseRows(text, source) {
  const rows = new Map();
  if (!text) return rows;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(TASK_ROW_RE);
    if (!m) continue;
    const inner = line.trim().replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '');
    rows.set(`WMB-${m[1]}`, { source, line, cells: inner.split('|').map((c) => c.trim()) });
  }
  return rows;
}

const tasksText = readText('TASKS.md');
const archiveText = readText('TASKS.archive.md');
const specText = readText('SPEC.md');
const prdText = readText('PRD.md');
if (!tasksText || !specText || !prdText) {
  console.error(`Missing ledger document under ${root} (need TASKS.md, SPEC.md and PRD.md).`);
  process.exit(1);
}

const activeRows = parseRows(tasksText, 'TASKS.md');
const archiveRows = parseRows(archiveText, 'TASKS.archive.md');
const findRow = (id) => activeRows.get(id) ?? archiveRows.get(id);

// a) TASKS.md header: everything before the first task row.
const tasksLines = tasksText.split(/\r?\n/);
const firstRowIndex = tasksLines.findIndex((line) => TASK_ROW_RE.test(line));
push('--- TASKS.md header ---');
push(...(firstRowIndex > 0 ? tasksLines.slice(0, firstRowIndex) : []));

// b) Target task row.
const target = findRow(targetId);
if (!target) {
  console.error(
    `Unknown task ${targetId}: not found in TASKS.md or TASKS.archive.md under ${root}.`
  );
  process.exit(1);
}
push(`--- ${target.source} task row ${targetId} ---`);
push(target.line);

// c) Direct dependencies (deduped, not recursive).
const depIds = [...new Set((target.cells[4] ?? '').match(WMB_RE) ?? [])];
for (const depId of depIds) {
  const dep = findRow(depId);
  push(`--- ${dep ? dep.source : 'MISSING'} task row ${depId} ---`);
  push(dep ? dep.line : `(dependency row not found: ${depId})`);
}

// d) SPEC.md sections per Capability cell CAP id.
const specLines = specText.split(/\r?\n/);
const headings = [];
specLines.forEach((line, i) => {
  const m = line.match(HEADING_RE);
  if (m) headings.push({ level: m[1].length, title: line, lineIndex: i });
});

// Minimal section for a mention at lineIndex: nearest preceding heading,
// extended to the next heading of the same or higher level.
const sectionForMention = (mentionIndex) => {
  let start = null;
  for (const h of headings) {
    if (h.lineIndex <= mentionIndex) start = h;
    else break;
  }
  if (!start) return null;
  let end = specLines.length;
  for (const h of headings) {
    if (h.lineIndex > start.lineIndex && h.level <= start.level) {
      end = h.lineIndex;
      break;
    }
  }
  return { start, end };
};

const specOut = [];
const capIds = [...new Set((target.cells[2] ?? '').match(CAP_ID_RE) ?? [])];

if (headings.length === 0) {
  // Fallback: no heading structure — ±20 lines around each mention, merged and deduped.
  for (const capId of capIds) {
    const re = new RegExp(`\\b${capId}\\b`);
    const ranges = [];
    specLines.forEach((line, i) => {
      if (re.test(line)) ranges.push([Math.max(0, i - 20), Math.min(specLines.length, i + 21)]);
    });
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of ranges) {
      if (merged.length > 0 && s <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    }
    for (const [s, e] of merged) {
      specOut.push(`--- SPEC.md fallback ±20 lines around ${capId} (lines ${s + 1}-${e}) ---`);
      specOut.push(...specLines.slice(s, e));
    }
  }
} else {
  for (const capId of capIds) {
    const re = new RegExp(`\\b${capId}\\b`);
    const sections = new Map(); // `${start.lineIndex}:${end}` -> section; insertion order kept
    specLines.forEach((line, i) => {
      if (!re.test(line)) return;
      const section = sectionForMention(i);
      if (section) sections.set(`${section.start.lineIndex}:${section.end}`, section);
    });
    for (const { start, end } of sections.values()) {
      specOut.push(
        `--- SPEC.md ${capId} section (lines ${start.lineIndex + 1}-${end}): ${start.title} ---`
      );
      specOut.push(...specLines.slice(start.lineIndex, end));
    }
  }
}
push(...specOut);

// e) PRD.md requirement-index rows for every REQ/AC id mentioned in (d).
const reqIds = [...new Set(specOut.join('\n').match(REQ_ID_RE) ?? [])];
const indexRowById = new Map();
for (const line of prdText.split(/\r?\n/)) {
  const m = line.match(PRD_INDEX_ROW_RE);
  if (m) indexRowById.set(m[1], line);
}
push('--- PRD.md requirement index ---');
for (const reqId of reqIds) {
  push(indexRowById.get(reqId) ?? `(no PRD index row for ${reqId})`);
}

// f) Total line count (excludes the total line itself).
push(`total lines: ${out.length}`);
process.stdout.write(`${out.join('\n')}\n`);
