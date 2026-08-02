import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { openDataRoot } from '../src/main/data-root.ts';
import { confirmIntelligenceChannelProposal, readChannelProposalContext } from '../src/main/intelligence-channel-confirmation.ts';
import { IntelligenceChannelProposalStore, channelProposalBinding } from '../src/main/intelligence-channel-proposals.ts';
import { createWebsiteSource, getWebsiteSource, updateWebsiteSourceResolution } from '../src/main/intelligence-channels.ts';
import { resolveXListCandidates } from '../src/main/x-list-channel.ts';
import { upsertSource } from '../src/main/sources.ts';
import { ensureOfficialWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { WorkspaceProposalStore } from '../src/main/workspace-proposals.ts';
import { enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';
import { startMcp } from '../src/main/mcp.ts';

const observation = { capturedAt: '2026-08-03T12:00:00.000Z', pageUrl: 'https://x.com/owner/lists', fingerprint: 'fixture-index', visibleText: 'UK creators' };
const index = { accountKey: '@Owner', observation, lists: [{ listId: '700', canonicalUrl: 'https://x.com/i/lists/700', name: 'UK creators', ownerHandle: '@Owner', kind: 'owned' }] };
const websiteCandidate = { inputText: 'Example', name: 'Example', url: 'https://example.com/', canonicalUrl: 'https://example.com/', origin: 'direct' };
const websiteTrial = { title: 'Example', url: 'https://example.com/', requestedUrl: 'https://example.com/', readable: true, itemCount: 0 };

async function makeRoot(workspaceId = 'workspace-a') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-channel-proposal-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)").run(workspaceId, now, now);
  ensureOfficialWorkspaceProfile(database, 'official.ai');
  return { root, database, workspaceId };
}

function xContext(root, workspaceId, accountKey = '@Owner', currentIndex = index) {
  return { root: { path: root, isNew: false }, workspaceId, browserId: 'fixture', accountKey, config: { id: 'fixture', cdpUrl: 'http://127.0.0.1:9334', workspaceId, accountKey }, index: currentIndex };
}

function state(database) {
  return JSON.stringify(database.prepare(`SELECT
    (SELECT COUNT(*) FROM website_sources) AS websites,
    (SELECT COUNT(*) FROM x_list_bindings) AS bindings,
    (SELECT COUNT(*) FROM source_feeds) AS feeds,
    (SELECT COUNT(*) FROM source_items) AS items`).get());
}

async function resolvedX(database, workspaceId) {
  const result = await resolveXListCandidates(database, { id: 'fixture', cdpUrl: 'http://127.0.0.1:9334', workspaceId }, { inputText: 'UK creators' }, async () => index);
  assert.equal(result.ok, true);
  return { resolution: result.data, candidate: result.data.candidates[0] };
}

test('channel proposal prepare is zero-write, a mixed batch commits once, and replay is stale', async () => {
  const current = await makeRoot();
  try {
    const disabled = createWebsiteSource(current.database, { inputText: 'Old', name: 'Old', canonicalUrl: 'https://old.example/', resolutionStatus: 'ready', trialRead: { title: 'Old', url: 'https://old.example/', readable: true }, enabled: false });
    const x = await resolvedX(current.database, current.workspaceId);
    const store = new IntelligenceChannelProposalStore();
    const before = state(current.database);
    const proposal = store.prepare({ requestId: 'mixed', changes: [
      { action: 'add', module: 'official_web', inputText: 'Example', candidate: websiteCandidate, trialRead: websiteTrial },
      { action: 'add', module: 'x_lists', ...x },
      { action: 'enable', module: 'official_web', sourceId: disabled.id, expectedRevision: disabled.revision }
    ] }, readChannelProposalContext(current.database));
    assert.equal(state(current.database), before);
    assert.equal(store.prepare({ requestId: 'mixed', changes: proposal.changes.map((change) => change.action === 'add' ? change : { action: change.action, module: change.module, sourceId: change.sourceId, expectedRevision: change.expectedRevision }) }, readChannelProposalContext(current.database)).id, proposal.id);

    const result = await confirmIntelligenceChannelProposal(current.database, { store, binding: channelProposalBinding(proposal), xContext: xContext(current.root, current.workspaceId), trialWebsite: async () => websiteTrial });
    assert.equal(result.applied, 3);
    assert.equal(getWebsiteSource(current.database, disabled.id)?.enabled, true);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM website_sources').get().count, 2);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count, 1);
    const after = state(current.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(current.database, { store, binding: channelProposalBinding(proposal), xContext: xContext(current.root, current.workspaceId), trialWebsite: async () => websiteTrial }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(current.database), after);
  } finally { current.database.close(); await rm(current.root, { recursive: true, force: true }); }
});

test('proposal list stays scoped to the current workspace and profile, and cross-root confirmation writes zero', async () => {
  const [first, second] = await Promise.all([makeRoot('workspace-a'), makeRoot('workspace-b')]);
  try {
    const store = new IntelligenceChannelProposalStore();
    const oldProfile = store.prepare({ requestId: 'first-profile-1', changes: [{ action: 'add', module: 'official_web', inputText: 'Example', candidate: websiteCandidate, trialRead: websiteTrial }] }, readChannelProposalContext(first.database));
    const secondProposal = store.prepare({ requestId: 'second-profile-1', changes: [{ action: 'add', module: 'official_web', inputText: 'Example', candidate: websiteCandidate, trialRead: websiteTrial }] }, readChannelProposalContext(second.database));
    first.database.prepare("UPDATE workspace_profiles SET revision=revision+1 WHERE id='effective'").run();
    const currentProposal = store.prepare({ requestId: 'first-profile-2', changes: [{ action: 'add', module: 'official_web', inputText: 'Example', candidate: websiteCandidate, trialRead: websiteTrial }] }, readChannelProposalContext(first.database));

    assert.deepEqual(store.listForContext(readChannelProposalContext(first.database)).map(({ proposal }) => proposal.id), [currentProposal.id]);
    assert.deepEqual(store.listForContext(readChannelProposalContext(second.database)).map(({ proposal }) => proposal.id), [secondProposal.id]);
    assert.notEqual(oldProfile.id, currentProposal.id);

    const beforeCrossRoot = state(second.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(second.database, { store, binding: channelProposalBinding(currentProposal), trialWebsite: async () => websiteTrial }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(second.database), beforeCrossRoot);
  } finally {
    first.database.close();
    second.database.close();
    await Promise.all([rm(first.root, { recursive: true, force: true }), rm(second.root, { recursive: true, force: true })]);
  }
});

test('every stale binding, profile/source/workspace/account change rejects with zero proposal writes', async () => {
  const current = await makeRoot();
  try {
    const website = createWebsiteSource(current.database, { inputText: 'Keep', name: 'Keep', canonicalUrl: 'https://keep.example/', resolutionStatus: 'ready', trialRead: { title: 'Keep', url: 'https://keep.example/', readable: true }, enabled: false });
    const makeProposal = (requestId) => new IntelligenceChannelProposalStore().prepare({ requestId, changes: [{ action: 'enable', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, readChannelProposalContext(current.database));
    const tamperedStore = new IntelligenceChannelProposalStore();
    const tampered = tamperedStore.prepare({ requestId: 'tampered', changes: [{ action: 'enable', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, readChannelProposalContext(current.database));
    const beforeTamper = state(current.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(current.database, { store: tamperedStore, binding: { ...channelProposalBinding(tampered), displayedDiff: [] } }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(current.database), beforeTamper);

    const profileStore = new IntelligenceChannelProposalStore();
    const profileProposal = profileStore.prepare({ requestId: 'profile', changes: [{ action: 'enable', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, readChannelProposalContext(current.database));
    current.database.prepare("UPDATE workspace_profiles SET revision=revision+1 WHERE id='effective'").run();
    const beforeProfile = state(current.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(current.database, { store: profileStore, binding: channelProposalBinding(profileProposal) }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(current.database), beforeProfile);

    const sourceStore = new IntelligenceChannelProposalStore();
    const sourceProposal = sourceStore.prepare({ requestId: 'source', changes: [{ action: 'enable', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, readChannelProposalContext(current.database));
    current.database.prepare('UPDATE website_sources SET revision=revision+1 WHERE id=?').run(website.id);
    const beforeSource = state(current.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(current.database, { store: sourceStore, binding: channelProposalBinding(sourceProposal) }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(current.database), beforeSource);

    current.database.prepare('UPDATE website_sources SET revision=? WHERE id=?').run(website.revision, website.id);
    const workspaceStore = new IntelligenceChannelProposalStore();
    const workspaceProposal = workspaceStore.prepare({ requestId: 'workspace', changes: [{ action: 'enable', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, readChannelProposalContext(current.database));
    current.database.prepare("UPDATE app_meta SET value='workspace-b' WHERE key='workspace_id'").run();
    const beforeWorkspace = state(current.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(current.database, { store: workspaceStore, binding: channelProposalBinding(workspaceProposal) }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(current.database), beforeWorkspace);
  } finally { current.database.close(); await rm(current.root, { recursive: true, force: true }); }
});

test('X account change and an apply-time failure leave the whole batch untouched', async () => {
  const current = await makeRoot();
  try {
    const x = await resolvedX(current.database, current.workspaceId);
    const xStore = new IntelligenceChannelProposalStore();
    const xProposal = xStore.prepare({ requestId: 'x-account', changes: [{ action: 'add', module: 'x_lists', ...x }] }, readChannelProposalContext(current.database));
    const beforeAccount = state(current.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(current.database, { store: xStore, binding: channelProposalBinding(xProposal), xContext: xContext(current.root, current.workspaceId, '@Other', { ...index, accountKey: '@Other' }) }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(current.database), beforeAccount);

    const blocked = createWebsiteSource(current.database, { inputText: 'Blocked', name: 'Blocked', canonicalUrl: 'https://blocked.example/', resolutionStatus: 'ready', trialRead: { title: 'Blocked', url: 'https://blocked.example/', readable: true }, enabled: false });
    updateWebsiteSourceResolution(current.database, { id: blocked.id, expectedRevision: blocked.revision, resolutionStatus: 'failed', errorCode: 'WEBSITE_TRIAL_FAILED', errorMessage: 'fixture' });
    const currentBlocked = getWebsiteSource(current.database, blocked.id);
    const atomicStore = new IntelligenceChannelProposalStore();
    const atomicProposal = atomicStore.prepare({ requestId: 'atomic', changes: [
      { action: 'add', module: 'official_web', inputText: 'Example', candidate: websiteCandidate, trialRead: websiteTrial },
      { action: 'enable', module: 'official_web', sourceId: blocked.id, expectedRevision: currentBlocked.revision }
    ] }, readChannelProposalContext(current.database));
    const beforeAtomic = state(current.database);
    await assert.rejects(() => confirmIntelligenceChannelProposal(current.database, { store: atomicStore, binding: channelProposalBinding(atomicProposal), trialWebsite: async () => websiteTrial }), { code: 'CONFIRMATION_STALE' });
    assert.equal(state(current.database), beforeAtomic);
  } finally { current.database.close(); await rm(current.root, { recursive: true, force: true }); }
});

test('remove preserves existing source items and duplicate request/change is rejected without writes', async () => {
  const current = await makeRoot();
  try {
    const website = createWebsiteSource(current.database, { inputText: 'Keep history', name: 'Keep history', canonicalUrl: 'https://history.example/', resolutionStatus: 'ready', trialRead: { title: 'Keep history', url: 'https://history.example/', readable: true } });
    upsertSource(current.database, { feedId: website.sourceFeedId, originalUrl: 'https://history.example/item', title: 'Historical item' });
    const store = new IntelligenceChannelProposalStore();
    const context = readChannelProposalContext(current.database);
    const proposal = store.prepare({ requestId: 'remove', changes: [{ action: 'remove', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, context);
    const replay = store.prepare({ requestId: 'remove', changes: [{ action: 'remove', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, context);
    assert.equal(replay.id, proposal.id);
    assert.throws(() => store.prepare({ requestId: 'remove', changes: [{ action: 'disable', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }] }, context), { code: 'CONFIRMATION_STALE' });
    assert.throws(() => new IntelligenceChannelProposalStore().prepare({ requestId: 'duplicate', changes: [
      { action: 'disable', module: 'official_web', sourceId: website.id, expectedRevision: website.revision },
      { action: 'remove', module: 'official_web', sourceId: website.id, expectedRevision: website.revision }
    ] }, context), { code: 'CONFIRMATION_STALE' });
    await confirmIntelligenceChannelProposal(current.database, { store, binding: channelProposalBinding(proposal) });
    assert.equal(getWebsiteSource(current.database, website.id), null);
    assert.equal(current.database.prepare('SELECT COUNT(*) AS count FROM source_items WHERE feed_id=?').get(website.sourceFeedId).count, 1);
  } finally { current.database.close(); await rm(current.root, { recursive: true, force: true }); }
});

test('Pi extension and Discover expose prepare-only channel confirmation surfaces', async () => {
  const [extension, view, preload] = await Promise.all([
    import(`../.pi/extensions/wmb-mcp/index.ts?channels=${Date.now()}`),
    readFile('src/renderer/intelligence-channels-view.tsx', 'utf8'),
    readFile('src/preload/preload.ts', 'utf8')
  ]);
  const tools = new Map();
  extension.default({ registerTool(tool) { tools.set(tool.name, tool); } });
  for (const name of ['wmb_get_intelligence_channels', 'wmb_resolve_intelligence_website', 'wmb_trial_intelligence_website', 'wmb_resolve_intelligence_x_list', 'wmb_prepare_intelligence_channel_changes']) assert.equal(tools.has(name), true);
  assert.equal([...tools.keys()].some((name) => /confirm.*intelligence|intelligence.*confirm/i.test(name)), false);
  assert.match(view, /待确认的来源变更/);
  assert.match(view, /prepareIntelligenceChannelProposal/);
  assert.doesNotMatch(view, /confirmWebsiteSource|confirmResolvedXList|setIntelligenceChannelEnabled|removeIntelligenceChannel/);
  assert.match(view, /confirmIntelligenceChannelProposal/);
  assert.match(preload, /intelligence-channels:proposal-confirm/);
  assert.doesNotMatch(preload, /intelligence-channels:confirm-website|intelligence-channels:confirm-x-list|intelligence-channels:set-enabled|intelligence-channels:remove/);
});

test('MCP exposes channel reads and preparation but never a confirmation tool', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-channel-mcp-'));
  const registryPath = path.join(parent, 'user-data', 'workspace-registry.json');
  const root = await openDataRoot(path.join(parent, 'root'));
  migrateDatabase(path.join(root.path, 'wmb.db')).close();
  const workspace = await enrollAiWorkspace({ registryPath, rootPath: root.path });
  const store = new IntelligenceChannelProposalStore();
  const before = (() => { const database = migrateDatabase(path.join(root.path, 'wmb.db')); try { return state(database); } finally { database.close(); } })();
  const mcp = await startMcp(root.path, undefined, { listWorkspaces: () => readWorkspaceRegistry(registryPath), proposals: new WorkspaceProposalStore(() => true), channelProposals: store });
  try {
    const initialized = await mcpRequest(mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'channel-test', version: '1' } });
    const listed = await mcpRequest(mcp.url, 'tools/list', {}, initialized.sessionId);
    const names = listed.data.tools.map((tool) => tool.name);
    for (const name of ['intelligence_channels.get', 'intelligence_channels.receipts_list', 'intelligence_channels.resolve_website', 'intelligence_channels.trial_website', 'intelligence_channels.resolve_x_list', 'intelligence_channels.proposals.prepare']) assert.equal(names.includes(name), true);
    assert.equal(names.some((name) => name.startsWith('intelligence_channels.') && /confirm/i.test(name)), false);
    const current = await mcpRequest(mcp.url, 'tools/call', { name: 'intelligence_channels.get', arguments: {} }, initialized.sessionId);
    assert.equal(JSON.parse(current.data.content[0].text).data.id, workspace.id);
    const prepared = await mcpRequest(mcp.url, 'tools/call', { name: 'intelligence_channels.proposals.prepare', arguments: {
      request_id: 'mcp-prepare', changes: [{ action: 'add', module: 'official_web', input_text: 'Example', candidate: websiteCandidate, trial_read: websiteTrial }]
    } }, initialized.sessionId);
    assert.equal(JSON.parse(prepared.data.content[0].text).data.displayedDiff[0].action, 'add');
    process.env.WMB_MCP_URL = mcp.url;
    const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?mcp=${Date.now()}`)).default;
    const piTools = new Map(); extension({ registerTool(tool) { piTools.set(tool.name, tool); } });
    const piPrepared = await piTools.get('wmb_prepare_intelligence_channel_changes').execute('pi-prepare', { requestId: 'pi-prepare', changes: [{ action: 'add', module: 'official_web', inputText: 'Example', candidate: websiteCandidate, trialRead: websiteTrial }] });
    assert.equal(JSON.parse(piPrepared.details.content[0].text).data.displayedDiff[0].action, 'add');
    delete process.env.WMB_MCP_URL;
    const database = migrateDatabase(path.join(root.path, 'wmb.db'));
    try { assert.equal(state(database), before); } finally { database.close(); }
  } finally { delete process.env.WMB_MCP_URL; await mcp.close(); await rm(parent, { recursive: true, force: true }); }
});

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
