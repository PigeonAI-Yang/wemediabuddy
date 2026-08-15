import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findFlattenedSourceArtifacts } from '../scripts/check-source-root-artifacts.mjs';

test('source root rejects only flattened zero-byte renderer/shared artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-source-root-'));
  try {
    await mkdir(path.join(root, 'renderer'));
    await mkdir(path.join(root, 'shared'));
    await writeFile(path.join(root, 'renderer', 'main.tsx'), '', 'utf8');
    await writeFile(path.join(root, 'shared', 'types.ts'), '', 'utf8');
    await writeFile(path.join(root, 'renderer-real.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(root, 'rendererflattened.tsx'), '', 'utf8');
    await writeFile(path.join(root, 'sharedflattened.ts'), '', 'utf8');
    await writeFile(path.join(root, 'other-empty.ts'), '', 'utf8');
    assert.deepEqual(
      (await findFlattenedSourceArtifacts(root)).map((filePath) => path.basename(filePath)),
      ['rendererflattened.tsx', 'sharedflattened.ts']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real source root contains no flattened zero-byte artifacts', async () => {
  assert.deepEqual(await findFlattenedSourceArtifacts(path.join(process.cwd(), 'src')), []);
});
