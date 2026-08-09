import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDataRoot } from '../src/main/data-root.ts';
import { loadRoot } from './eval-029-fixtures-data.mjs';
import { buildEvidence, captureStrictState } from './eval-029-fixtures-readback.mjs';
import {
  ROOT_KEYS,
  resolveContainedExistingPath,
  resolveFixturePaths,
  sha256,
  stableStringify,
  writeJson
} from './eval-029-fixtures-shared.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(SCRIPT_DIRECTORY, '../tests/fixtures/eval-029-workspaces.v1.json');
const MARKER_NAME = '.wmb-eval-029-fixture';
const MARKER_VALUE = Object.freeze({ schema: 'wmb.eval-029-fixture-marker.v1', owner: 'scripts/eval-029-fixtures.mjs' });
const EMPTY_PARENT_HASH = '0'.repeat(64);

await main();

async function main() {
  try {
    const { command, parent, manifest } = parseArguments(process.argv.slice(2));
    const fixtureText = await readFile(FIXTURE_PATH, 'utf8');
    const fixture = JSON.parse(fixtureText);
    assert.equal(fixture.schema, 'wmb.eval-029-workspaces.v1');
    assert.equal(fixture.schemaVersion, 50);
    assert.equal(fixture.semanticProjectionVersion, 3);
    assert.deepEqual(fixture.deliveredAuthorities.map(({ id, table, expectedRowsPerRoot }) => ({ id, table, expectedRowsPerRoot })), [
      { id: 'business-command-receipt', table: 'command_receipts', expectedRowsPerRoot: 0 },
      { id: 'task-grant', table: 'task_grants', expectedRowsPerRoot: 0 },
      { id: 'precise-execution-grant', table: 'execution_grants', expectedRowsPerRoot: 0 },
      { id: 'immutable-publication-snapshot', table: 'publication_snapshots', expectedRowsPerRoot: 0 }
    ]);
    const guardedParent = await resolveTemporaryParent(parent);
    const paths = await resolveFixturePaths(guardedParent, fixture, guardedParent);
    if (command === 'materialize') {
      await materialize(paths, fixture, fixtureText);
    } else {
      await verify(paths, manifest, fixture, fixtureText);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  const command = args.shift();
  if (command !== 'materialize' && command !== 'verify') throw new Error('Usage: eval-029-fixtures.mjs <materialize|verify> --parent <temp> [--manifest <path>]');
  const values = new Map();
  while (args.length > 0) {
    const key = args.shift();
    const value = args.shift();
    if ((key !== '--parent' && key !== '--manifest') || !value || values.has(key)) throw new Error(`Invalid argument: ${key ?? '<missing>'}`);
    values.set(key, value);
  }
  const parent = values.get('--parent');
  if (!parent) throw new Error('--parent is required');
  const manifest = values.get('--manifest');
  if (command === 'materialize' && manifest) throw new Error('materialize does not accept --manifest');
  if (command === 'verify' && !manifest) throw new Error('verify requires --manifest');
  return { command, parent, manifest };
}

async function resolveTemporaryParent(input) {
  const parent = await realpath(path.resolve(input));
  const temporaryRoot = await realpath(os.tmpdir());
  const relative = path.relative(temporaryRoot, parent);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('EVAL-029 fixture parent must be a child of os.tmpdir().');
  }
  if (!(await stat(parent)).isDirectory()) throw new Error('EVAL-029 fixture parent must be a directory.');
  return parent;
}

async function createMarker(paths) {
  await writeFile(paths.markerPath, `${stableStringify(MARKER_VALUE)}\n`, { encoding: 'utf8', flag: 'wx' });
  await validateMarker(paths.parent);
}

async function validateMarker(parent) {
  let marker;
  try {
    marker = JSON.parse(await readFile(path.join(parent, MARKER_NAME), 'utf8'));
  } catch {
    throw new Error(`EVAL-029 fixture marker ${MARKER_NAME} is missing or invalid.`);
  }
  assert.deepEqual(marker, MARKER_VALUE, 'EVAL-029 fixture marker is not owned by this script');
}

async function materialize(publishedPaths, fixture, fixtureText) {
  if ((await readdir(publishedPaths.parent)).length !== 0) throw new Error('materialize requires an empty temporary parent.');
  const stagingDirectory = path.join(publishedPaths.parent, `.wmb-eval-029-staging-${randomUUID()}`);
  const stagingPaths = await resolveFixturePaths(stagingDirectory, fixture, publishedPaths.parent);
  stagingPaths.markerPath = path.join(stagingDirectory, MARKER_NAME);
  const published = [];
  await mkdir(stagingDirectory);
  try {
    await createMarker(stagingPaths);
    await populateArtifacts(stagingPaths, publishedPaths, fixture);
    const evidence = await buildEvidence(stagingPaths, fixture, publishedPaths);
    const manifest = buildManifest(fixture, fixtureText, evidence, {
      schema: 'wmb.eval-029-strict-parent-state.v1',
      parentTreeSha256: EMPTY_PARENT_HASH
    });
    await writeJson(stagingPaths.manifestPath, manifest);
    manifest.strict = await captureStrictState(stagingPaths);
    await writeJson(stagingPaths.manifestPath, manifest);
    assert.deepEqual(await captureStrictState(stagingPaths), manifest.strict, 'staged parent hash is unstable');
    await publishArtifacts(stagingPaths.parent, publishedPaths.parent, published);
    console.log(JSON.stringify({
      ok: true,
      command: 'materialize',
      manifestPath: publishedPaths.manifestPath,
      semanticSha256: manifest.semanticSha256
    }));
  } catch (error) {
    for (const destination of published.reverse()) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function populateArtifacts(paths, publishedPaths, fixture) {
  const { migrateDatabase } = await import('../src/main/db/migrations.ts');
  await mkdir(paths.physicalProfileDirectory, { recursive: true });
  await writeJson(paths.physicalProfileSentinel, fixture.installation.physicalProfileFixture.sentinel);

  for (const rootKey of ROOT_KEYS) {
    const rootFixture = fixture.roots[rootKey];
    const root = await openDataRoot(paths.roots[rootKey].rootPath);
    assert.equal(root.isNew, true);
    const database = migrateDatabase(path.join(root.path, 'wmb.db'));
    try {
      loadRoot(database, rootFixture, fixture);
    } finally {
      database.close();
    }
    await writeJson(paths.roots[rootKey].legacyBrowserFile, fixture.legacySentinels.browserFileValue);
    const legacySession = [
      { type: 'session', version: 3, id: rootFixture.ids.legacySession, timestamp: fixture.fixedTime, cwd: path.join(publishedPaths.roots[rootKey].rootPath, 'pi-agent', 'workspace') },
      { type: 'message', id: `${rootFixture.ids.legacySession}.user`, parentId: null, timestamp: fixture.fixedTime, message: { role: 'user', content: [{ type: 'text', text: fixture.sharedBusinessValues.legacyConversationMessage }] } }
    ];
    await mkdir(path.dirname(paths.roots[rootKey].legacyConversationSession), { recursive: true });
    await writeFile(paths.roots[rootKey].legacyConversationSession, `${legacySession.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    await writeJson(paths.roots[rootKey].legacyConversationPointer, {
      id: rootFixture.ids.legacyConversation,
      title: fixture.sharedBusinessValues.legacyConversationTitle,
      sessionFile: publishedPaths.roots[rootKey].legacyConversationSession,
      sessionId: rootFixture.ids.legacySession,
      messages: [{ role: 'user', text: fixture.sharedBusinessValues.legacyConversationMessage }],
      createdAt: fixture.fixedTime,
      updatedAt: fixture.fixedTime
    });
    await writeJson(paths.roots[rootKey].rootIdentityFile, {
      schema: 'wmb.eval-029-root-identity.v1',
      id: rootFixture.rootLocalId
    });
  }

  await writeJson(paths.registryPath, {
    version: 1,
    activeWorkspaceId: fixture.roots.ai.workspaceId,
    workspaces: ROOT_KEYS.map((rootKey) => ({
      id: fixture.roots[rootKey].workspaceId,
      displayName: fixture.roots[rootKey].displayName,
      rootPath: publishedPaths.roots[rootKey].rootPath
    })),
    switchJournal: null
  });
}

async function publishArtifacts(stagingParent, parent, published) {
  const names = await readdir(stagingParent);
  names.sort((left, right) => {
    if (left === MARKER_NAME) return 1;
    if (right === MARKER_NAME) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const name of names) {
    const destination = path.join(parent, name);
    await rename(path.join(stagingParent, name), destination);
    published.push(destination);
  }
}

async function verify(paths, manifestInput, fixture, fixtureText) {
  await validateMarker(paths.parent);
  const manifestPath = await resolveContainedExistingPath(paths.parent, manifestInput, 'verify manifest');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const before = await captureStrictState(paths, manifestPath);
  assert.deepEqual(before, manifest.strict, 'complete fixture parent changed before read-only restart verification');
  const evidence = await buildEvidence(paths, fixture);
  const expectedManifest = buildManifest(fixture, fixtureText, evidence, before);
  assert.deepEqual(manifest, expectedManifest, 'materialization manifest contract changed');
  const after = await captureStrictState(paths, manifestPath);
  assert.equal(sha256(await readFile(manifestPath)), sha256(manifestBytes), 'read-only verification changed its manifest');
  assert.deepEqual(after, before, 'read-only verification changed the complete fixture parent');
  console.log(JSON.stringify({ ok: true, command: 'verify', semanticSha256: evidence.semanticSha256, strictUnchanged: true }));
}

function buildManifest(fixture, fixtureText, evidence, strict) {
  return {
    schema: 'wmb.eval-029-materialization.v1',
    version: 1,
    generatedFrom: fixture.generatedFrom,
    fixtureSchema: fixture.schema,
    fixtureSha256: sha256(fixtureText),
    fixedTime: fixture.fixedTime,
    registryRelativePath: fixture.installation.registryRelativePath,
    roots: Object.fromEntries(ROOT_KEYS.map((rootKey) => [rootKey, fixture.roots[rootKey].directoryName])),
    semanticProjectionVersion: fixture.semanticProjectionVersion,
    semanticProjection: evidence.projection,
    semanticSha256: evidence.semanticSha256,
    strict
  };
}
