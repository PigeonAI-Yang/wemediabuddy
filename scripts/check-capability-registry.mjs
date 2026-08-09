/**
 * Capability registry harness gate.
 * Design: docs/spark/2026-08-07-role-permission-design.md §5.4
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function extractFrozenStringArray(source, exportName) {
  const re = new RegExp(`export const ${exportName} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const\\)`);
  const match = source.match(re);
  if (!match) throw new Error(`Cannot parse ${exportName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

function extractPageWriteCommands(pageAuthoritySource) {
  const commands = new Set();
  const blockRe = /writeScope:\s*Object\.freeze\(\[([\s\S]*?)\] as const\)/g;
  for (const match of pageAuthoritySource.matchAll(blockRe)) {
    for (const item of match[1].matchAll(/'([^']+)'/g)) commands.add(item[1]);
  }
  return commands;
}

function extractAutomaticScopeCommands(taskGrantsSource) {
  const start = taskGrantsSource.indexOf('export const AUTOMATIC_TASK_GRANT_SCOPES');
  if (start < 0) throw new Error('AUTOMATIC_TASK_GRANT_SCOPES missing');
  const slice = taskGrantsSource.slice(start, start + 3500);
  const commands = new Set();
  for (const item of slice.matchAll(/'([a-z0-9_.]+)'/g)) {
    const value = item[1];
    if (value.startsWith('page_') || value === 'const') continue;
    if (value.includes('.')) commands.add(value);
  }
  // Drop intent-like tokens without dots already filtered; keep dotted commands only.
  return commands;
}

const registryUrl = pathToFileURL(path.join(root, 'src/shared/agent-capabilities.ts')).href;
const registry = await import(registryUrl);

const taskGrants = read('src/main/task-grants.ts');
const pageAuthority = read('src/shared/page-authority.ts');
const internalCommands = extractFrozenStringArray(taskGrants, 'TASK_INTERNAL_COMMANDS');
const pageCommands = extractPageWriteCommands(pageAuthority);
const automaticCommands = extractAutomaticScopeCommands(taskGrants);
const covered = registry.commandsCoveredByGrantableCapabilities();
const redline = registry.redlineCommandsFromRegistry();
const infra = new Set(registry.INFRA_GRANT_COMMANDS);

const errors = [];

// 1. Full coverage: every internal write command is grantable-covered or explicit redline/infra.
for (const command of internalCommands) {
  if (infra.has(command)) continue;
  if (redline.has(command)) continue;
  if (!covered.has(command)) {
    errors.push(`Unregistered writable command (not in grantable capabilities): ${command}`);
  }
}

// 2. Redline must not appear in automatic standing/page scopes (except we allow listing only if not in AUTOMATIC values).
for (const command of automaticCommands) {
  if (redline.has(command)) {
    errors.push(`Redline command appears in AUTOMATIC_TASK_GRANT_SCOPES projection: ${command}`);
  }
}

// PAGE scopes must not include redline either.
for (const command of pageCommands) {
  if (redline.has(command)) {
    errors.push(`Redline command appears in PAGE_TASK_GRANT_SCOPES: ${command}`);
  }
}

// 3. agentGrantable:false must not default-bind roles.
for (const cap of registry.AGENT_CAPABILITIES) {
  if (cap.agentGrantable) continue;
  const bound = Object.entries(cap.defaultRoleBindings || {}).filter(([, on]) => on);
  if (bound.length) {
    errors.push(`Redline capability ${cap.id} has default role bindings: ${bound.map(([k]) => k).join(',')}`);
  }
}

// 4. pageScopePassThrough only on cap.desk
const pass = registry.AGENT_CAPABILITIES.filter((cap) => cap.pageScopePassThrough);
if (pass.length !== 1 || pass[0].id !== 'cap.desk') {
  errors.push(`pageScopePassThrough must be unique on cap.desk; found ${pass.map((c) => c.id).join(',') || '(none)'}`);
}

// 5. Page commands covered by some grantable capability command set (or infra).
for (const command of pageCommands) {
  if (infra.has(command)) continue;
  if (!covered.has(command)) {
    errors.push(`PAGE scope command not covered by grantable capability: ${command}`);
  }
}

// 6. Registry commands must be subset of TASK_INTERNAL_COMMANDS (except empty redline placeholders).
const internalSet = new Set(internalCommands);
for (const cap of registry.AGENT_CAPABILITIES) {
  for (const command of cap.commands) {
    if (!internalSet.has(command)) {
      errors.push(`Capability ${cap.id} references unknown command: ${command}`);
    }
  }
}

// 7. Role write helpers sanity: writer has content, not lane_restore; librarian has lane_restore not plans.save
const writerCmds = new Set(registry.roleWriteCommands('writer'));
const librarianCmds = new Set(registry.roleWriteCommands('librarian'));
const reporterCmds = new Set(registry.roleWriteCommands('reporter'));
const plannerCmds = new Set(registry.roleWriteCommands('planner'));
assert.ok(writerCmds.has('content.save_version'), 'writer must write content');
assert.equal(writerCmds.has('sources.lane_restore'), false, 'writer must not organize library');
assert.equal(writerCmds.has('plans.save'), false, 'writer must not decide topics');
assert.ok(librarianCmds.has('sources.lane_restore'), 'librarian organizes');
assert.equal(librarianCmds.has('content.save_version'), false, 'librarian is not writer');
assert.equal(librarianCmds.has('plans.save'), false, 'librarian is not planner');
assert.ok(reporterCmds.has('sources.upsert_batch'), 'reporter collects');
assert.equal(reporterCmds.has('plans.save'), false, 'reporter does not plan');
assert.ok(plannerCmds.has('plans.save'), 'planner decides topics');
assert.deepEqual(registry.roleWriteCommands('desk'), [], 'desk standing write empty');

if (errors.length) {
  console.error('Capability registry check failed:');
  for (const line of errors) console.error(' -', line);
  process.exit(1);
}

console.log('Capability registry check passed.');
console.log(`  internal commands: ${internalCommands.length}`);
console.log(`  grantable covered: ${covered.size}`);
console.log(`  roles: ${Object.keys(registry.ROLE_CATALOG).join(', ')}`);
