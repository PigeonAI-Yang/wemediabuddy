import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { readWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { proposalBinding, WorkspaceProposalStore } from '../src/main/workspace-proposals.ts';
import { enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

test('session proposals reject every stale binding and expose prepare-only MCP and Pi tools', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-proposals-'));
  const registryPath = path.join(parent, 'user-data', 'workspace-registry.json');
  const root = await openDataRoot(path.join(parent, 'ai'));
  migrateDatabase(path.join(root.path, 'wmb.db')).close();
  const workspace = await enrollAiWorkspace({ registryPath, rootPath: root.path });
  const db = new DatabaseSync(path.join(root.path, 'wmb.db'), { readOnly: true });
  const currentProfile = readWorkspaceProfile(db);
  db.close();
  const context = { workspaceId: workspace.id, currentProfile };
  const store = new WorkspaceProposalStore(() => true);
  try {
    const before = await durableState(registryPath, root.path);
    assert.throws(() => store.prepare({ ...validInput('not-media'), purpose: 'general_automation' }, { workspaceId: null, currentProfile: null }), { code: 'VALIDATION_ERROR' });
    assert.equal(store.prepare(validInput('not-media'), { workspaceId: null, currentProfile: null }).target, 'new');
    let packPresent = false;
    const unavailable = new WorkspaceProposalStore(() => packPresent);
    assert.throws(() => unavailable.prepare(validInput('missing-pack'), { workspaceId: null, currentProfile: null }), { code: 'OFFICIAL_PACK_UNAVAILABLE' });
    packPresent = true;
    assert.equal(unavailable.prepare(validInput('missing-pack'), { workspaceId: null, currentProfile: null }).target, 'new');
    assert.equal(await durableState(registryPath, root.path), before);

    const proposal = store.prepare({ ...validInput('current-proposal'), target: 'current' }, context);
    const normalized = store.prepare({ ...validInput('normalized-platforms'), platforms: ['xiaohongshu', 'x'] }, { workspaceId: null, currentProfile: null });
    assert.equal(store.prepare({ ...validInput('normalized-platforms'), platforms: ['x', 'xiaohongshu'] }, { workspaceId: null, currentProfile: null }).id, normalized.id);
    const binding = proposalBinding(proposal);
    const staleBindings = [
      { proposalId: 'missing' }, { proposalRevision: 2 }, { normalizedHash: 'changed' }, { baseProfileRevision: 2 }, { catalogVersion: 2 },
      { intelligencePackId: 'uk-life-content-radar' }, { intelligencePackVersion: 2 }, { creationPackId: 'missing' }, { creationPackVersion: 2 },
      { platforms: ['x'] }, { displayedDiff: [] }
    ];
    for (const mutation of staleBindings) {
      assert.throws(() => store.validateConfirmation({ ...binding, ...mutation }, context), { code: 'PROFILE_STALE' });
      assert.equal(await durableState(registryPath, root.path), before);
    }
    assert.throws(() => store.validateConfirmation(binding, { workspaceId: 'other', currentProfile }), { code: 'PROFILE_STALE' });
    assert.throws(() => store.validateConfirmation(binding, { workspaceId: workspace.id, currentProfile: { ...currentProfile, revision: 2 } }), { code: 'PROFILE_STALE' });
    assert.throws(() => new WorkspaceProposalStore(() => true).validateConfirmation(binding, context), { code: 'PROFILE_STALE' });
    assert.equal(await durableState(registryPath, root.path), before);

    let available = true;
    const changing = new WorkspaceProposalStore(() => available);
    const availableProposal = changing.prepare(validInput('availability'), { workspaceId: null, currentProfile: null });
    available = false;
    assert.throws(() => changing.validateConfirmation(proposalBinding(availableProposal), { workspaceId: null, currentProfile: null }), { code: 'OFFICIAL_PACK_UNAVAILABLE' });
    assert.equal(await durableState(registryPath, root.path), before);

    const mcp = await startMcp(root.path, undefined, { listWorkspaces: () => readWorkspaceRegistry(registryPath), proposals: store });
    try {
      const initialized = await mcpRequest(mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workspace-proposal-test', version: '1' } });
      const listed = await mcpRequest(mcp.url, 'tools/list', {}, initialized.sessionId);
      const names = listed.data.tools.map((tool) => tool.name);
      for (const name of ['workspaces.list', 'workspaces.get_current', 'workspaces.catalog', 'workspaces.proposals.prepare']) assert.equal(names.includes(name), true);
      assert.equal(names.some((name) => /confirm|activate|delete|path/i.test(name) && name.startsWith('workspaces.')), false);
      const current = await mcpRequest(mcp.url, 'tools/call', { name: 'workspaces.get_current', arguments: {} }, initialized.sessionId);
      assert.equal(JSON.parse(current.data.content[0].text).id, workspace.id);
      const catalog = await mcpRequest(mcp.url, 'tools/call', { name: 'workspaces.catalog', arguments: {} }, initialized.sessionId);
      assert.deepEqual(JSON.parse(catalog.data.content[0].text).templates.map((template) => template.officialTemplateId), ['official.ai', 'official.uk']);
      const invalidGoal = await callProposal(mcp.url, initialized.sessionId, { ...mcpInput('mcp-not-media'), purpose: 'general_automation' });
      assert.equal(invalidGoal.error.code, 'VALIDATION_ERROR');
      const missingPack = await callProposal(mcp.url, initialized.sessionId, { ...mcpInput('mcp-missing-pack'), intelligence_pack_version: 2 });
      assert.equal(missingPack.error.code, 'OFFICIAL_PACK_UNAVAILABLE');
      assert.equal(await durableState(registryPath, root.path), before);

      process.env.WMB_MCP_URL = mcp.url;
      const piTools = new Map();
      const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?workspace=${Date.now()}`)).default;
      extension({ registerTool(tool) { piTools.set(tool.name, tool); } });
      for (const name of ['wmb_list_workspaces', 'wmb_get_current_workspace', 'wmb_list_workspace_catalog', 'wmb_prepare_workspace_profile']) assert.equal(piTools.has(name), true);
      assert.equal([...piTools].some(([name]) => /^wmb_(confirm|activate|delete)_workspace/.test(name)), false);
      const prepared = await piTools.get('wmb_prepare_workspace_profile').execute('prepare', piInput('pi-new'));
      assert.equal(JSON.parse(prepared.details.content[0].text).data.target, 'new');
    } finally { await mcp.close(); delete process.env.WMB_MCP_URL; }
  } finally { await rm(parent, { recursive: true, force: true, maxRetries: 3 }); }
});

function validInput(requestId) {
  return { requestId, target: 'new', purpose: 'self_media', displayName: '开发者效率', audience: '使用 AI 编程工具的中文开发者', contentGoal: '持续创作有实测证据的自媒体内容', editorialBrief: '先复现问题，再写可执行结论。', intelligencePackId: 'wemedia-intelligence-engine', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x', 'xiaohongshu'] };
}

function piInput(requestId) {
  const input = validInput(requestId);
  return { requestId, target: input.target, purpose: input.purpose, displayName: input.displayName, audience: input.audience, contentGoal: input.contentGoal, editorialBrief: input.editorialBrief, intelligencePackId: input.intelligencePackId, intelligencePackVersion: 1, creationPackId: input.creationPackId, creationPackVersion: 1, platforms: input.platforms };
}

function mcpInput(requestId) {
  const input = piInput(requestId);
  return { request_id: input.requestId, target: input.target, purpose: input.purpose, display_name: input.displayName, audience: input.audience, content_goal: input.contentGoal, editorial_brief: input.editorialBrief, intelligence_pack_id: input.intelligencePackId, intelligence_pack_version: input.intelligencePackVersion, creation_pack_id: input.creationPackId, creation_pack_version: input.creationPackVersion, platforms: input.platforms };
}

async function callProposal(url, sessionId, input) {
  const result = await mcpRequest(url, 'tools/call', { name: 'workspaces.proposals.prepare', arguments: input }, sessionId);
  return JSON.parse(result.data.content[0].text);
}

async function durableState(registryPath, rootPath) {
  const registry = await readFile(registryPath, 'utf8');
  const db = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true });
  try { return JSON.stringify({ registry, profile: readWorkspaceProfile(db), counts: db.prepare('SELECT (SELECT COUNT(*) FROM source_items) AS sources, (SELECT COUNT(*) FROM content_projects) AS projects').get() }); }
  finally { db.close(); }
}

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
