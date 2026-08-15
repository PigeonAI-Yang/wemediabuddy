import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePiExtension } from '../src/main/pi-extension.ts';
import { PI_AUTHORITY_SYSTEM_PROMPT } from '../src/main/pi-operator-skill.ts';
import { LANE_REASON_CODES } from '../src/main/lane-gate.ts';
import { coreTools } from '../.pi/extensions/wmb-mcp/wmb-mcp-tools-core.ts';
import { intelligenceChannelTools } from '../.pi/extensions/wmb-mcp/wmb-mcp-tools-intelligence-channels.ts';
import { xListTools as xListToolDefinitions } from '../.pi/extensions/wmb-mcp/wmb-mcp-tools-x-lists.ts';

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

  const todayRunView = await readFile('src/renderer/today-run-view.ts', 'utf8');
  const progressExpression = todayRunView.match(/const ratio = ([^;]+);/)?.[1];
  assert.ok(progressExpression, 'progress ratio expression must exist');
  const calculateProgress = Function('planned', 'processed', 'running', `return ${progressExpression};`);
  assert.equal(calculateProgress(0, 0, true), undefined);
  assert.equal(calculateProgress(4, 1, true), 0.25);

  const xListTools = await readFile('.pi/extensions/wmb-mcp/wmb-mcp-tools-x-lists.ts', 'utf8');
  assert.match(xListTools, /wmb_list_x_post_metric_snapshots/);
  assert.match(xListTools, /x_lists\.post_metric_snapshots_list/);
  assert.match(xListTools, /wmb_get_x_post_trend/);
  assert.match(xListTools, /wmb_start_x_list_observation/);
  assert.match(xListTools, /wmb_get_x_list_observation/);
  assert.match(xListTools, /wmb_stop_x_list_observation/);
  assert.match(xListTools, /x_lists\.post_trend_get/);
  for (const name of ['wmb_start_x_list_observation', 'wmb_stop_x_list_observation']) {
    const tool = xListToolDefinitions.find((item) => item.name === name);
    assert.ok(tool);
    assert.deepEqual(tool.parameters.required.slice(0, 3), ['requestId', 'taskId', 'grantId']);
    assert.equal(tool.parameters.properties.workerLeaseId.type, 'string');
  }

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

test('Pi task grant aliases register exact schemas and map to read-only MCP tools', async () => {
  const calls = [];
  const operator = await readFile('skills/wemedia-buddy-operator/SKILL.md', 'utf8');
  assert.match(operator, /wmb_get_task_grant/);
  assert.match(operator, /wmb_list_task_grants/);
  assert.doesNotMatch(operator, /`task_grants\.(?:get|list)\(\{/);
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    calls.push(payload);
    response.setHeader('content-type', 'application/json');
    if (payload.method === 'initialize') response.setHeader('mcp-session-id', 'pi-grant-test');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: payload.method === 'initialize' ? {} : { content: [] } }));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const priorUrl = process.env.WMB_MCP_URL;
  process.env.WMB_MCP_URL = `http://127.0.0.1:${address.port}`;
  try {
    const getGrant = coreTools.find((item) => item.name === 'wmb_get_task_grant');
    const listGrants = coreTools.find((item) => item.name === 'wmb_list_task_grants');
    assert.ok(getGrant);
    assert.ok(listGrants);
    assert.deepEqual(getGrant.parameters, { type: 'object', properties: { grantId: { type: 'string' } }, required: ['grantId'], additionalProperties: false });
    assert.deepEqual(listGrants.parameters, { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false });
    await getGrant.execute('get-call', { grantId: 'grant-029' });
    await listGrants.execute('list-call', { taskId: 'task-029' });
    assert.deepEqual(calls.filter((call) => call.method === 'tools/call').map((call) => call.params), [
      { name: 'task_grants.get', arguments: { grant_id: 'grant-029' } },
      { name: 'task_grants.list', arguments: { task_id: 'task-029' } }
    ]);
  } finally {
    if (priorUrl === undefined) delete process.env.WMB_MCP_URL;
    else process.env.WMB_MCP_URL = priorUrl;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('packaged Pi runtime pins and loads the upstream delegated vision extension', async () => {
  const [manifest, prepare, main, operator] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('scripts/prepare-pi-runtime.mjs', 'utf8'),
    readFile('src/main/index.ts', 'utf8'),
    readFile('skills/wemedia-buddy-operator/SKILL.md', 'utf8')
  ]);
  assert.equal(JSON.parse(manifest).dependencies['pi-vision-tool'], '1.3.7');
  assert.match(prepare, /path\.join\(modulesRoot, 'pi-vision-tool'\)/);
  assert.match(prepare, /bundledVision\.version === installedVision\.version/);
  assert.doesNotMatch(prepare, /readFile\(marker, 'utf8'\)[\s\S]{0,100}process\.exit/);
  assert.match(main, /piVisionExtensionFromRuntimeRoot\(runtimeRoot\)/);
  assert.match(main, /PI_VISION_MODEL: WMB_VISION_MODEL/);
  assert.match(operator, /describe_image/);
});

test('wmb_judge_sources reasonCode schema exposes exactly the Main LANE_REASON_CODES enum', () => {
  const tool = coreTools.find((item) => item.name === 'wmb_judge_sources');
  assert.ok(tool);
  const reasonCode = tool.parameters.properties.judgments.items.properties.reasonCode;
  assert.deepEqual(reasonCode, { type: 'string', enum: [...LANE_REASON_CODES] });
});

test('WMB-5121 T-20: PI_AUTHORITY_SYSTEM_PROMPT 要求 librarian no-op 围栏确认块', () => {
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('wmb_noop'), '主管提示词必须要求末条 ```json {"wmb_noop": true} 确认块');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('```json'), '主管提示词必须含 JSON 围栏指令');
  assert.ok(PI_AUTHORITY_SYSTEM_PROMPT.includes('no-op 确认'), '无可整理内容时必须回报 no-op 确认');
});

test('WMB-5121: operator SKILL.md 资料员 no-op 围栏要求（canonical Skill）', async () => {
  const operator = await readFile('skills/wemedia-buddy-operator/SKILL.md', 'utf8');
  assert.match(operator, /wmb_noop/);
  assert.match(operator, /资料员整理任务/);
  assert.match(operator, /```json/);
});
