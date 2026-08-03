import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePiExtension } from '../src/main/pi-extension.ts';
import { intelligenceChannelTools } from '../.pi/extensions/wmb-mcp/wmb-mcp-tools-intelligence-channels.ts';

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

  const xListTools = await readFile('.pi/extensions/wmb-mcp/wmb-mcp-tools-x-lists.ts', 'utf8');
  assert.match(xListTools, /wmb_list_x_post_metric_snapshots/);
  assert.match(xListTools, /x_lists\.post_metric_snapshots_list/);
  assert.match(xListTools, /wmb_get_x_post_trend/);
  assert.match(xListTools, /wmb_start_x_list_observation/);
  assert.match(xListTools, /wmb_get_x_list_observation/);
  assert.match(xListTools, /wmb_stop_x_list_observation/);
  assert.match(xListTools, /x_lists\.post_trend_get/);

  const ipc = await readFile('src/main/ipc-x-lists.ts', 'utf8');
  const preload = await readFile('src/preload/preload.ts', 'utf8');
  for (const channel of ['x-lists:list-post-metric-snapshots', 'x-lists:get-post-trend']) {
    assert.match(ipc, new RegExp(channel));
    assert.match(preload, new RegExp(channel));
  }
});

test('channel proposal schema exposes every website field required by Main validation', () => {
  const tool = intelligenceChannelTools.find((item) => item.name === 'wmb_prepare_intelligence_channel_changes');
  assert.ok(tool);
  const change = tool.parameters.properties.changes.items;
  assert.deepEqual(change.properties.candidate.required, ['inputText', 'name', 'url', 'canonicalUrl', 'origin']);
  assert.deepEqual(change.properties.trialRead.required, ['title', 'url', 'readable']);
});
