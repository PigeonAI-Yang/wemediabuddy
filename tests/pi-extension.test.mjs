import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePiExtension } from '../src/main/pi-extension.ts';

test('Pi extension copies every companion imported by index and starts with truthful unknown progress', async () => {
  const index = await readFile('.pi/extensions/wmb-mcp/index.ts', 'utf8');
  const companions = [...index.matchAll(/from\s+['\"](\.\/[^'\"]+\.ts)['\"]/g)]
    .map((match) => match[1].slice(2));
  assert.ok(companions.length > 0);

  const agentDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-extension-test-'));
  try {
    await preparePiExtension(agentDir);
    for (const companion of companions) {
      await access(path.join(agentDir, 'extensions', 'wmb-mcp', companion));
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }

  const todayView = await readFile('src/renderer/today-library-view.tsx', 'utf8');
  const progressExpression = todayView.match(/const progressRatio = ([^;]+);/)?.[1];
  assert.ok(progressExpression, 'progress ratio expression must exist');
  const calculateProgress = Function('planned', 'processed', 'running', `return ${progressExpression};`);
  assert.equal(calculateProgress(0, 0, true), 0);
  assert.equal(calculateProgress(4, 1, true), 0.25);
});
