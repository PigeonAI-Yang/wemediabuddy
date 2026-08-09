#!/usr/bin/env node
/**
 * Intake gate: doing/done tasks at/above INTAKE_WATERLINE must have a short
 * contract file with required headings. Design/Legislate must reference a
 * design path and contain an Owner lock.
 *
 * CONFIG only — copy into <project>/scripts/check-intake.mjs and edit values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- CONFIG: project-specific values. Edit when adopting this template. ----
const TASK_ID_PREFIX = 'WMB';
const LEDGER_FILE = 'TASKS.md';
const ARCHIVE_FILE = 'TASKS.archive.md';
/** Tasks with number >= this require contract files when doing/done. */
const INTAKE_WATERLINE = 5001;
const EVIDENCE_DIR = '.ai';
const REQUIRED_HEADINGS = [
  'Route',
  'Goal',
  'Acceptance',
  'Allowed paths',
  'Forbidden paths',
  'Non-goals',
  'Depends on',
  'Design / lock',
];
// ------------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const taskIdRe = new RegExp(
  `^${escapeRe(TASK_ID_PREFIX)}-(\\d{4})$`,
  'i',
);
const rowRe = new RegExp(
  `^\\|\\s*(${escapeRe(TASK_ID_PREFIX)}-\\d{4})\\s*\\|` +
    `([^|]*\\|){2}\\s*(todo|doing|blocked|done)\\s*\\|`,
  'i',
);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function read(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

function parseLedgerTasks(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(rowRe);
    if (!m) continue;
    out.push({ id: m[1].toUpperCase(), status: m[3].toLowerCase() });
  }
  return out;
}

function taskNumber(id) {
  const m = id.match(taskIdRe);
  return m ? Number(m[1]) : -1;
}

function contractRel(id) {
  return path.join(EVIDENCE_DIR, `${id.toLowerCase()}-contract.md`).replace(/\\/g, '/');
}

function hasHeading(md, title) {
  const re = new RegExp(`^##\\s+${escapeRe(title)}\\s*$`, 'im');
  return re.test(md);
}

function extractRoute(md) {
  const m = md.match(/^##\s+Route\s*\r?\n+([^\r\n#]+)/im);
  return m ? m[1].trim().toLowerCase() : '';
}

function extractDesignLockSection(md) {
  const m = md.match(
    /^##\s+Design \/ lock\s*\r?\n([\s\S]*?)(?=^##\s+|\s*$)/im,
  );
  return m ? m[1] : '';
}

function listedPathsExist(section, errors, id) {
  const pathLikes = section.match(
    /(?:docs\/[\w./-]+|\.ai\/[\w./-]+|[A-Za-z0-9_.-]+\/[\w./-]+\.md)/g,
  );
  if (!pathLikes) {
    errors.push(
      `${id}: Design/Legislate contract must reference a design path under docs/ or .ai/`,
    );
    return;
  }
  let any = false;
  for (const p of pathLikes) {
    const rel = p.replace(/^\.?\//, '');
    if (!rel.endsWith('.md')) continue;
    any = true;
    if (!fs.existsSync(path.join(root, rel))) {
      errors.push(`${id}: design path missing: ${rel}`);
    }
  }
  if (!any) {
    errors.push(`${id}: Design/Legislate contract has no .md design path`);
  }
}

function main() {
  const errors = [];
  const active = parseLedgerTasks(read(LEDGER_FILE));
  // Archive is not required to hold contracts for historical done rows below
  // waterline; still scan archive doing (should be rare/empty).
  const archived = parseLedgerTasks(read(ARCHIVE_FILE));
  const tasks = [...active, ...archived].filter((t) => {
    if (t.status !== 'doing' && t.status !== 'done') return false;
    return taskNumber(t.id) >= INTAKE_WATERLINE;
  });

  // De-dupe by id (prefer active status if duplicated).
  const byId = new Map();
  for (const t of tasks) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }

  for (const t of byId.values()) {
    const rel = contractRel(t.id);
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`${t.id} (${t.status}): missing contract ${rel}`);
      continue;
    }
    const md = fs.readFileSync(abs, 'utf8');
    for (const h of REQUIRED_HEADINGS) {
      if (!hasHeading(md, h)) {
        errors.push(`${t.id}: contract missing heading ## ${h}`);
      }
    }
    const route = extractRoute(md);
    if (!/^(patch|design|legislate)\b/.test(route)) {
      errors.push(
        `${t.id}: Route must start with Patch, Design, or Legislate (got ${JSON.stringify(route)})`,
      );
    }
    const designSec = extractDesignLockSection(md);
    if (/^design|^legislate/.test(route)) {
      if (!/owner\s*lock/i.test(designSec) && !/owner\s*lock/i.test(md)) {
        errors.push(`${t.id}: Design/Legislate contract must contain Owner lock`);
      }
      listedPathsExist(designSec || md, errors, t.id);
    }
  }

  if (errors.length) {
    console.error('check-intake failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `check-intake ok (${byId.size} doing/done task(s) at/above intake waterline ${INTAKE_WATERLINE})`,
  );
}

main();
