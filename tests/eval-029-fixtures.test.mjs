import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { captureStrictState } from '../scripts/eval-029-fixtures-readback.mjs';
import { resolveFixturePaths } from '../scripts/eval-029-fixtures-shared.mjs';

const execFileAsync = promisify(execFile);
const repoPath = process.cwd();
const scriptPath = path.join(repoPath, 'scripts', 'eval-029-fixtures.mjs');
const fixturePath = path.join(repoPath, 'tests', 'fixtures', 'eval-029-workspaces.v1.json');

test('EVAL-029 fixture survives two bounded cold processes without changing its complete parent', async () => {
  const workspace = await createFixtureWorkspace();
  try {
    const materializedProcess = await runBoundedChild(['materialize', '--parent', workspace.parent], workspace, true);
    const materialized = parseResult(materializedProcess.stdout);
    assert.deepEqual(
      { ok: materialized.ok, command: materialized.command, manifestPath: materialized.manifestPath },
      { ok: true, command: 'materialize', manifestPath: path.join(workspace.parent, 'eval-029-materialization.v1.json') }
    );

    const manifest = JSON.parse(await readFile(materialized.manifestPath, 'utf8'));
    assert.equal(manifest.schema, 'wmb.eval-029-materialization.v1');
    assert.equal(manifest.semanticSha256, materialized.semanticSha256);
    assert.match(manifest.strict.parentTreeSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.semanticProjection.registry.workspaces.length, 2);
    assert.notEqual(manifest.semanticProjection.roots.ai.workspaceId, manifest.semanticProjection.roots.uk.workspaceId);
    assert.notEqual(manifest.semanticProjection.roots.ai.profileId, manifest.semanticProjection.roots.uk.profileId);
    assert.equal(manifest.semanticProjection.schemaVersion, 58);
    assert.equal(manifest.semanticProjection.version, 3);
    assert.deepEqual(manifest.semanticProjection.deliveredAuthorities.map(({ id, table, expectedRowsPerRoot }) => ({ id, table, expectedRowsPerRoot })), [
      { id: 'business-command-receipt', table: 'command_receipts', expectedRowsPerRoot: 0 },
      { id: 'task-grant', table: 'task_grants', expectedRowsPerRoot: 0 },
      { id: 'precise-execution-grant', table: 'execution_grants', expectedRowsPerRoot: 0 },
      { id: 'immutable-publication-snapshot', table: 'publication_snapshots', expectedRowsPerRoot: 0 }
    ]);
    for (const root of Object.values(manifest.semanticProjection.roots)) {
      assert.equal(root.migrationVersions.at(-1), 58);
      for (const authority of Object.values(root.authorityState)) {
        assert.deepEqual(authority.rows, []);
        assert.equal(authority.columns.includes('runtime_epoch'), true);
      }
      assert.equal(root.tableRows.agent_tasks.length, 1);
      assert.equal(root.tableRows.agent_tasks[0].status, 'running');
      assert.equal(root.legacyConversation.pointer.sessionFile, 'pi-agent/legacy-session.jsonl');
      assert.equal(root.legacyConversation.session[0].type, 'session');
      assert.equal(root.legacyConversation.session[1].message.content[0].text, '这条历史消息必须可由 canonical migration 回读。');
    }
    const declaredFixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    for (const [rootKey, rootFixture] of Object.entries(declaredFixture.roots)) {
      const rootPath = path.join(workspace.parent, rootFixture.directoryName);
      const pointer = JSON.parse(await readFile(path.join(rootPath, declaredFixture.legacySentinels.conversationPointerRelativePath), 'utf8'));
      const session = await readFile(path.join(rootPath, declaredFixture.legacySentinels.conversationSessionRelativePath), 'utf8');
      assert.equal(pointer.id, rootFixture.ids.legacyConversation, `${rootKey} legacy pointer identity`);
      assert.equal(pointer.sessionId, rootFixture.ids.legacySession, `${rootKey} legacy session identity`);
      assert.match(session, new RegExp(rootFixture.ids.legacySession));
      assert.match(session, /canonical migration/);
    }

    const verifiedProcess = await runBoundedChild(
      ['verify', '--parent', workspace.parent, '--manifest', materialized.manifestPath],
      workspace,
      false
    );
    assert.deepEqual(parseResult(verifiedProcess.stdout), {
      ok: true,
      command: 'verify',
      semanticSha256: materialized.semanticSha256,
      strictUnchanged: true
    });
    const readBack = JSON.parse(await readFile(materialized.manifestPath, 'utf8'));
    assert.equal(readBack.strict.parentTreeSha256, manifest.strict.parentTreeSha256);
  } finally {
    await cleanup(workspace.outer);
  }
});

test('fixture declaration repeats business values without inventing a BrowserProfile identity', async () => {
  const fixtureText = await readFile(fixturePath, 'utf8');
  const fixture = JSON.parse(fixtureText);
  assert.equal(fixture.schema, 'wmb.eval-029-workspaces.v1');
  assert.deepEqual(Object.keys(fixture.installation.physicalProfileFixture), ['label', 'relativePath', 'sentinelRelativePath', 'sentinel']);
  assert.equal(Object.hasOwn(fixture.installation.physicalProfileFixture, 'id'), false);
  assert.equal(fixtureText.includes('sharedBrowserProfile'), false);
  assert.equal(fixtureText.includes('sharedBrowserProfileId'), false);
  assert.equal(fixture.installation.physicalProfileFixture.label, 'shared-physical-login-fixture');
  assert.equal(fixture.sharedBusinessValues.sourceTitle, '完全相同的跨根业务标题');
  assert.equal(fixture.sharedBusinessValues.requestId, 'eval029.same-request-id');
  assert.notEqual(fixture.roots.ai.workspaceId, fixture.roots.uk.workspaceId);
  assert.notEqual(fixture.roots.ai.rootLocalId, fixture.roots.uk.rootLocalId);
  assert.notEqual(fixture.roots.ai.profile.profileId, fixture.roots.uk.profile.profileId);
  assert.deepEqual(Object.keys(fixture.roots.ai.ids), Object.keys(fixture.roots.uk.ids));
  assert.equal(fixture.legacySentinels.conversationPointerRelativePath, 'pi-agent/conversation.json');
  assert.equal(fixture.legacySentinels.conversationSessionRelativePath, 'pi-agent/legacy-session.jsonl');
  assert.equal(fixture.roots.ai.ids.agentTask, 'eval029.ai.agent-task');
  assert.notEqual(fixture.roots.ai.ids.legacyConversation, fixture.roots.uk.ids.legacyConversation);
  assert.notEqual(fixture.roots.ai.ids.legacySession, fixture.roots.uk.ids.legacySession);
  for (const key of Object.keys(fixture.roots.ai.ids)) {
    assert.notEqual(fixture.roots.ai.ids[key], fixture.roots.uk.ids[key], `${key} must be root-local`);
  }
  assert.deepEqual(
    fixture.currentVsTargetAbsent.map(({ id, currentAuthority, migrationOwner }) => ({ id, currentAuthority, migrationOwner })),
    [
      { id: 'installation.default-profile-id', currentAuthority: 'absent', migrationOwner: 'WMB-4802' },
      { id: 'root.browser-profile-binding-and-expected-account', currentAuthority: 'absent', migrationOwner: 'WMB-4802' },
      { id: 'active-workspace-runtime-epoch', currentAuthority: 'absent', migrationOwner: 'WMB-4803' }
    ]
  );
  assert.deepEqual(fixture.deliveredAuthorities.map(({ id, table, expectedRowsPerRoot }) => ({ id, table, expectedRowsPerRoot })), [
    { id: 'business-command-receipt', table: 'command_receipts', expectedRowsPerRoot: 0 },
    { id: 'task-grant', table: 'task_grants', expectedRowsPerRoot: 0 },
    { id: 'precise-execution-grant', table: 'execution_grants', expectedRowsPerRoot: 0 },
    { id: 'immutable-publication-snapshot', table: 'publication_snapshots', expectedRowsPerRoot: 0 }
  ]);
  assert.match(fixture.currentVsTargetAbsent[0].targetAuthority, /BrowserProfile registry/);
  assert.match(fixture.currentVsTargetAbsent[0].evidence, /defaultProfileId/);
});

test('fixture-declared paths reject traversal and reparse-point escapes before materialization', async () => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'wmb-eval-029-paths-'));
  const parent = path.join(outer, 'parent');
  const outside = path.join(outer, 'outside');
  await mkdir(parent);
  await mkdir(outside);
  try {
    const baseline = JSON.parse(await readFile(fixturePath, 'utf8'));
    const invalidPaths = ['', '.', '..', 'safe/../escape', path.resolve(outside), 'C:\\absolute\\escape'];
    const declarations = [
      (fixture, value) => { fixture.roots.ai.directoryName = value; },
      (fixture, value) => { fixture.legacySentinels.browserFileRelativePath = value; },
      (fixture, value) => { fixture.legacySentinels.conversationPointerRelativePath = value; },
      (fixture, value) => { fixture.legacySentinels.conversationSessionRelativePath = value; },
      (fixture, value) => { fixture.legacySentinels.rootIdentityRelativePath = value; }
    ];
    for (const declare of declarations) {
      for (const invalidPath of invalidPaths) {
        const fixture = structuredClone(baseline);
        declare(fixture, invalidPath);
        await assert.rejects(resolveFixturePaths(parent, fixture, parent), /relative path|path segments|inside the EVAL-029 parent/);
      }
    }

    const linkPath = path.join(parent, 'escape-link');
    await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const reparsed = structuredClone(baseline);
    reparsed.roots.ai.directoryName = 'escape-link/ai-root';
    await assert.rejects(resolveFixturePaths(parent, reparsed, parent), /inside the EVAL-029 parent/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await cleanup(outer);
  }
});

test('verify rejects a manifest outside the marked parent', async () => {
  const workspace = await createFixtureWorkspace();
  try {
    const materialized = parseResult((await runChild(['materialize', '--parent', workspace.parent])).stdout);
    const outsideManifest = path.join(workspace.outer, 'outside-manifest.json');
    await writeFile(outsideManifest, await readFile(materialized.manifestPath));
    await assert.rejects(
      runChild(['verify', '--parent', workspace.parent, '--manifest', outsideManifest]),
      (error) => error.code === 1 && error.stderr.includes('must remain inside the EVAL-029 parent')
    );
  } finally {
    await cleanup(workspace.outer);
  }
});

test('verify deep-checks the stable manifest envelope even when its strict hash is recomputed', async () => {
  const workspace = await createFixtureWorkspace();
  try {
    const materialized = parseResult((await runChild(['materialize', '--parent', workspace.parent])).stdout);
    const manifest = JSON.parse(await readFile(materialized.manifestPath, 'utf8'));
    manifest.version = 2;
    manifest.generatedFrom = ['tampered'];
    manifest.unexpectedEnvelopeField = true;
    await writeFile(materialized.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const paths = await resolveFixturePaths(workspace.parent, fixture, workspace.parent);
    manifest.strict = await captureStrictState(paths);
    await writeFile(materialized.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      runChild(['verify', '--parent', workspace.parent, '--manifest', materialized.manifestPath]),
      (error) => error.code === 1 && error.stderr.includes('materialization manifest contract changed')
    );
  } finally {
    await cleanup(workspace.outer);
  }
});

test('complete parent hash rejects an unexpected parent-level sibling', async () => {
  const workspace = await createFixtureWorkspace();
  try {
    const materialized = parseResult((await runChild(['materialize', '--parent', workspace.parent])).stdout);
    await writeFile(path.join(workspace.parent, 'unexpected-sibling.txt'), 'must be detected');
    await assert.rejects(
      runChild(['verify', '--parent', workspace.parent, '--manifest', materialized.manifestPath]),
      (error) => error.code === 1 && error.stderr.includes('complete fixture parent changed')
    );
  } finally {
    await cleanup(workspace.outer);
  }
});

test('failed staged materialization restores an empty retryable parent', async () => {
  const workspace = await createFixtureWorkspace();
  const failurePreload = path.join(workspace.outer, 'fail-uk-root.cjs');
  await writeFile(failurePreload, failurePreloadSource());
  try {
    await assert.rejects(
      execFileAsync(process.execPath, ['--require', failurePreload, scriptPath, 'materialize', '--parent', workspace.parent], childOptions()),
      (error) => error.code === 1 && error.stderr.includes('injected materialization failure')
    );
    assert.deepEqual(await readdir(workspace.parent), []);
    const retried = parseResult((await runChild(['materialize', '--parent', workspace.parent])).stdout);
    assert.equal(retried.ok, true);
    assert.equal(retried.manifestPath, path.join(workspace.parent, 'eval-029-materialization.v1.json'));
  } finally {
    await cleanup(workspace.outer);
  }
});

test('fixture command rejects a non-temporary materialization parent', async () => {
  await assert.rejects(
    runChild(['materialize', '--parent', repoPath]),
    (error) => error.code === 1 && error.stderr.includes('must be a child of os.tmpdir()')
  );
});

test('fixture command rejects readback without its marker', async () => {
  const workspace = await createFixtureWorkspace();
  try {
    await assert.rejects(
      runChild(['verify', '--parent', workspace.parent, '--manifest', path.join(workspace.parent, 'missing.json')]),
      (error) => error.code === 1 && error.stderr.includes('.wmb-eval-029-fixture is missing or invalid')
    );
  } finally {
    await cleanup(workspace.outer);
  }
});

async function createFixtureWorkspace() {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'wmb-eval-029-test-'));
  const parent = path.join(outer, 'materialization');
  await mkdir(parent);
  return { outer, parent };
}

async function runBoundedChild(args, workspace, expectWrites) {
  const flag = permissionModelFlag();
  if (flag) {
    return execFileAsync(process.execPath, [
      flag,
      `--allow-fs-read=${repoPath}`,
      `--allow-fs-read=${workspace.parent}`,
      `--allow-fs-write=${workspace.parent}`,
      scriptPath,
      ...args
    ], childOptions());
  }

  const recorderPath = path.join(workspace.outer, 'record-writes.cjs');
  await writeFile(recorderPath, writeRecorderSource());
  const result = await execFileAsync(process.execPath, ['--require', recorderPath, scriptPath, ...args], {
    ...childOptions(),
    env: { ...process.env, WMB_EVAL_029_WRITE_BOUNDARY: workspace.parent }
  });
  const recordLine = result.stderr.split(/\r?\n/).find((line) => line.startsWith('WMB_EVAL_029_WRITES='));
  assert.ok(recordLine, 'write-boundary preload must report observations');
  const record = JSON.parse(recordLine.slice('WMB_EVAL_029_WRITES='.length));
  assert.deepEqual(record.outside, []);
  if (expectWrites) assert.ok(record.observed > 0, 'materialize write recorder must observe writes');
  return result;
}

function permissionModelFlag() {
  if (process.allowedNodeEnvironmentFlags.has('--permission')) return '--permission';
  if (process.allowedNodeEnvironmentFlags.has('--experimental-permission')) return '--experimental-permission';
  return null;
}

function runChild(args) {
  return execFileAsync(process.execPath, [scriptPath, ...args], childOptions());
}

function childOptions() {
  return { cwd: repoPath, env: { ...process.env } };
}

function parseResult(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function writeRecorderSource() {
  return String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const boundary = path.resolve(process.env.WMB_EVAL_029_WRITE_BOUNDARY);
const outside = [];
let observed = 0;
function record(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) return;
  observed += 1;
  const absolute = path.resolve(value instanceof URL ? fileURLToPath(value) : value);
  const relative = path.relative(boundary, absolute);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) outside.push(absolute);
}
const targets = { writeFile: [0], appendFile: [0], mkdir: [0], rm: [0], unlink: [0], rmdir: [0], rename: [0, 1], copyFile: [1] };
for (const [name, indexes] of Object.entries(targets)) {
  if (typeof fs[name] === 'function') {
    const original = fs[name].bind(fs);
    fs[name] = (...args) => { for (const index of indexes) record(args[index]); return original(...args); };
  }
  if (typeof fs.promises[name] === 'function') {
    const original = fs.promises[name].bind(fs.promises);
    fs.promises[name] = (...args) => { for (const index of indexes) record(args[index]); return original(...args); };
  }
}
syncBuiltinESMExports();
process.on('exit', () => process.stderr.write('WMB_EVAL_029_WRITES=' + JSON.stringify({ outside: [...new Set(outside)], observed }) + '\n'));
`;
}

function failurePreloadSource() {
  return String.raw`
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.promises.mkdir.bind(fs.promises);
fs.promises.mkdir = async (target, ...args) => {
  if (String(target).includes('uk-root')) throw new Error('injected materialization failure');
  return original(target, ...args);
};
syncBuiltinESMExports();
`;
}

async function cleanup(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
