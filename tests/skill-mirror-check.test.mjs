import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { skillRevision } from '../scripts/check-skill-mirrors.mjs';

const execFileAsync = promisify(execFile);

const scriptPath = path.join(process.cwd(), 'scripts', 'check-skill-mirrors.mjs');

async function runVerifier(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

async function makeCanonical(parent) {
  const canonical = path.join(parent, 'canonical');
  await mkdir(path.join(canonical, 'agents'), { recursive: true });
  await writeFile(path.join(canonical, 'SKILL.md'), '# Skill\n', 'utf8');
  await writeFile(path.join(canonical, 'agents', 'openai.yaml'), 'model: x\n', 'utf8');
  const revision = await skillRevision(canonical);
  return { canonical, revision };
}

async function makeMirror(parent, canonical, revision, name = 'mirror') {
  const mirror = path.join(parent, name);
  await mkdir(path.join(mirror, 'agents'), { recursive: true });
  await writeFile(path.join(mirror, 'SKILL.md'), await readFile(path.join(canonical, 'SKILL.md'), 'utf8'), 'utf8');
  await writeFile(path.join(mirror, 'agents', 'openai.yaml'), await readFile(path.join(canonical, 'agents', 'openai.yaml'), 'utf8'), 'utf8');
  await writeFile(path.join(mirror, '.wmb-install.json'), `${JSON.stringify({ name: 'fixture', revision })}\n`, 'utf8');
  return mirror;
}

test('WMB-5167: fresh mirror passes byte-identical check', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-mirror-fresh-'));
  try {
    const { canonical, revision } = await makeCanonical(parent);
    const mirror = await makeMirror(parent, canonical, revision);
    const result = await runVerifier(['--canonical', canonical, '--mirror', mirror, '--require-existing']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('WMB-5167: stale SKILL.md fails with the exact path', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-mirror-stale-'));
  try {
    const { canonical, revision } = await makeCanonical(parent);
    const mirror = await makeMirror(parent, canonical, revision);
    await writeFile(path.join(mirror, 'SKILL.md'), '# Changed\n', 'utf8');
    const result = await runVerifier(['--canonical', canonical, '--mirror', mirror, '--require-existing']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /STALE FILE/);
    assert.ok(result.stderr.includes(path.join(mirror, 'SKILL.md')), 'must report the exact stale path');
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('WMB-5167: stale .wmb-install.json revision fails with the exact path', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-mirror-rev-'));
  try {
    const { canonical } = await makeCanonical(parent);
    const mirror = await makeMirror(parent, canonical, '0'.repeat(64));
    const result = await runVerifier(['--canonical', canonical, '--mirror', mirror, '--require-existing']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /STALE revision/);
    assert.ok(result.stderr.includes(path.join(mirror, '.wmb-install.json')), 'must report the exact install manifest path');
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('WMB-5167: missing mirror skips by default, fails with --require-existing', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-mirror-missing-'));
  try {
    const { canonical } = await makeCanonical(parent);
    const missing = path.join(parent, 'no-mirror');
    const skip = await runVerifier(['--canonical', canonical, '--mirror', missing]);
    assert.equal(skip.code, 0);
    assert.match(skip.stdout, /skip \(mirror missing\)/);

    const fail = await runVerifier(['--canonical', canonical, '--mirror', missing, '--require-existing']);
    assert.equal(fail.code, 1);
    assert.match(fail.stderr, /MISSING/);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('WMB-5167: extra file in mirror fails closed', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-mirror-extra-'));
  try {
    const { canonical, revision } = await makeCanonical(parent);
    const mirror = await makeMirror(parent, canonical, revision);
    await writeFile(path.join(mirror, 'unexpected.txt'), 'x', 'utf8');
    const result = await runVerifier(['--canonical', canonical, '--mirror', mirror, '--require-existing']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /EXTRA FILE/);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('WMB-5167: multiple mirrors are each verified independently', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-mirror-multi-'));
  try {
    const { canonical, revision } = await makeCanonical(parent);
    const fresh = await makeMirror(parent, canonical, revision, 'fresh-mirror');
    const stale = await makeMirror(parent, canonical, revision, 'stale-mirror');
    await writeFile(path.join(stale, 'SKILL.md'), '# Changed\n', 'utf8');
    const result = await runVerifier(['--canonical', canonical, '--mirror', fresh, '--mirror', stale, '--require-existing']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /PASS: .*fresh-mirror/);
    assert.match(result.stderr, /STALE FILE.*stale-mirror/);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('WMB-5240: real installed operator images are byte-identical to canonical (data roots)', async () => {
  const canonical = path.join(process.cwd(), 'skills', 'wemedia-buddy-operator');
  const roots = ['data/gamedata', 'data/ukcontentdata'];
  for (const root of roots) {
    const mirror = path.join(process.cwd(), root, 'pi-agent', 'skills', 'wemedia-buddy-operator');
    const result = await runVerifier(['--canonical', canonical, '--mirror', mirror, '--require-existing']);
    assert.equal(result.code, 0, `${root} mirror mismatch:\n${result.stderr}`);
  }
});
