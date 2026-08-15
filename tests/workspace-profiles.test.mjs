import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dispatchStartAgentTask } from '../src/main/agent-task-commands.ts';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { agentRequestId, completeAgentTask, getAgentTask } from '../src/main/agent-tasks.ts';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { dispatchIssueTaskGrant } from '../src/main/task-grants.ts';
import { ActiveWorkspaceRuntime } from '../src/main/workspace-runtime.ts';
import { openBrowserProfileRegistry, readBrowserProfileRegistry } from '../src/main/browser-config.ts';
import { readWorkspaceBrowserBinding } from '../src/main/workspace-browser-binding.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createOfficialWorkspace, enrollAiWorkspace } from '../src/main/workspaces.ts';
import { AI_ONLY_ROUTE_IDS, assertAiOnlyRoute, readWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';
import { WorkspaceProposalStore } from '../src/main/workspace-proposals.ts';
import { createWebsiteSource } from '../src/main/intelligence-channels.ts';

test('official AI and UK profiles isolate one linked text chain without AI-only routes', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-profiles-'));
  let ukMcp, ukRuntime;
  try {
    const registryPath = path.join(parent, 'user-data', 'workspace-registry.json');
    const browserConfigPath = path.join(parent, 'user-data', 'browser-config.json');
    const browserRegistry = openBrowserProfileRegistry(browserConfigPath);
    const aiRoot = await openDataRoot(path.join(parent, 'ai'));
    migrateDatabase(path.join(aiRoot.path, 'wmb.db')).close();
    await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path, defaultProfileId: browserRegistry.defaultProfileId });
    const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(parent, 'uk'), templateId: 'official.uk', defaultProfileId: browserRegistry.defaultProfileId });
    const ukRoot = { path: uk.rootPath };

    const aiDb = migrateDatabase(path.join(aiRoot.path, 'wmb.db'));
    const ukDb = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
    try {
      assert.equal(readWorkspaceProfile(aiDb).officialTemplateId, 'official.ai');
      const ukProfile = readWorkspaceProfile(ukDb);
      assert.equal(ukProfile.officialTemplateId, 'official.uk');
      assert.equal(ukProfile.intelligencePackId, 'uk-life-content-radar');
      assert.equal(ukDb.prepare("SELECT value FROM app_meta WHERE key='pi-api-config'").get(), undefined);
      await access(path.join(process.cwd(), 'skills', 'uk-life-content-radar', 'SKILL.md'));

      const aiChain = createTextChain(aiDb, 'https://www.gov.uk/example-update', '2026-08-02', 'AI 根同值链');
      const ukChain = createTextChain(ukDb, 'https://www.gov.uk/example-update', '2026-08-02', 'UK 根同值链');
      assert.notEqual(aiChain.sourceId, ukChain.sourceId);
      assert.equal(aiDb.prepare('SELECT original_url AS url FROM source_items WHERE id=?').get(aiChain.sourceId).url, 'https://www.gov.uk/example-update');
      assert.equal(ukDb.prepare('SELECT original_url AS url FROM source_items WHERE id=?').get(ukChain.sourceId).url, 'https://www.gov.uk/example-update');
      assert.equal(ukDb.prepare('SELECT plan_item_id AS planItemId FROM content_projects WHERE id=?').get(ukChain.projectId).planItemId, ukChain.planItemId);
      assert.deepEqual(
        ukDb.prepare('SELECT source_id AS id FROM content_project_sources WHERE project_id=? ORDER BY source_id')
          .all(ukChain.projectId)
          .map((row) => row.id),
        [ukChain.sourceId]
      );
      assert.deepEqual(
        { ...ukDb.prepare('SELECT platform, format, body FROM platform_versions WHERE id=?').get(ukChain.platformVersionId) },
        { platform: 'x', format: 'text', body: '英国生活 X 纯文字版本' }
      );

      for (const routeId of AI_ONLY_ROUTE_IDS) assert.throws(() => assertAiOnlyRoute(ukDb, routeId), { code: 'OFFICIAL_PACK_UNAVAILABLE' });
      assert.equal(ukDb.prepare('SELECT COUNT(*) AS count FROM ranking_cache').get().count, 0);
      assert.equal(ukDb.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count, 0);
      assert.equal(ukDb.prepare('SELECT COUNT(*) AS count FROM source_feeds WHERE registry_id IS NOT NULL').get().count, 0);
    } finally { aiDb.close(); ukDb.close(); }

    ukRuntime = ActiveWorkspaceRuntime.open(ukRoot.path, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-epoch-uk' });
    const mcpTask = (await dispatchStartAgentTask(ukRuntime, { intent: 'studio_draft', businessDate: '2026-08-02', contextRefs: { workspaceId: ukRuntime.identity.workspaceId } }, { actor: { type: 'owner_ui', id: 'renderer', label: 'Owner UI' }, requestId: 'workspace-profile-mcp-task' })).task;
    const mcpGrant = await dispatchIssueTaskGrant(ukRuntime, {
      requestId: 'workspace-profile-mcp-grant', taskId: mcpTask.id, ownerGoal: '验证 UK 工作空间 MCP 边界',
      allowedCommands: ['x_lists.operation_execute'], workers: [{ type: 'external_agent', id: 'mcp' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(mcpGrant.ok, true);
    ukMcp = await startMcp(ukRoot.path, ukRuntime.gate, { listWorkspaces: async () => ({ activeWorkspaceId: uk.id, workspaces: [uk] }), proposals: new WorkspaceProposalStore(() => true), runtimeEpoch: 'runtime-epoch-uk' }, ukRuntime);
    try {
      const initialized = await mcpRequest(ukMcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-profile-test', version: '1' } });
      const listed = await mcpRequest(ukMcp.url, 'tools/list', {}, initialized.sessionId);
      const names = new Set(listed.data.tools.map((tool) => tool.name));
      assert.deepEqual([...names].filter((name) => name.startsWith('x_lists.')).sort(), [
        'x_lists.collect_timeline', 'x_lists.create', 'x_lists.get_operation', 'x_lists.list_bindings',
        'x_lists.members_add', 'x_lists.members_remove', 'x_lists.observation_get', 'x_lists.observation_start', 'x_lists.observation_stop',
        'x_lists.post_metric_snapshots_list', 'x_lists.post_trend_get', 'x_lists.prepare',
        'x_lists.read_detail', 'x_lists.read_index', 'x_lists.read_members', 'x_lists.read_timeline'
      ]);
      assert.equal(names.has('x_lists.confirm'), false);
      assert.equal(names.has('sources.wire_health_get'), false);
      assert.equal([...names].some((name) => /browser[-_.]?(?:profile|binding).*(?:create|rebind|verify|migrate)/i.test(name)), false);
      const beforeUnknownDatabase = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
      const beforeUnknownBinding = beforeUnknownDatabase.prepare("SELECT * FROM workspace_browser_bindings WHERE id='effective'").get();
      beforeUnknownDatabase.close();
      const beforeUnknownRegistry = await readFile(browserConfigPath, 'utf8');
      await assert.rejects(
        () => mcpRequest(ukMcp.url, 'tools/call', { name: 'browser_profiles.create', arguments: {} }, initialized.sessionId),
        /Tool browser_profiles\.create not found/
      );
      const afterUnknownDatabase = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
      assert.deepEqual(afterUnknownDatabase.prepare("SELECT * FROM workspace_browser_bindings WHERE id='effective'").get(), beforeUnknownBinding);
      afterUnknownDatabase.close();
      assert.equal(await readFile(browserConfigPath, 'utf8'), beforeUnknownRegistry);
      const current = await mcpRequest(ukMcp.url, 'tools/call', { name: 'workspaces.get_current', arguments: {} }, initialized.sessionId);
      const snapshot = JSON.parse(current.data.content[0].text);
      assert.equal(snapshot.id, uk.id);
      assert.equal(snapshot.runtimeEpoch, 'runtime-epoch-uk');
      assert.equal(snapshot.profile.intelligencePackId, 'uk-life-content-radar');
      assert.deepEqual(snapshot.capabilities, { xLists: true, aiIntelligence: false, fixedAiLists: false, rankings: false, sourceWire: false, publishingPlatforms: ['x', 'xiaohongshu'] });
      const bindings = await mcpRequest(ukMcp.url, 'tools/call', { name: 'x_lists.list_bindings', arguments: {} }, initialized.sessionId);
      assert.deepEqual(JSON.parse(bindings.data.content[0].text), []);
      const rejected = await mcpRequest(ukMcp.url, 'tools/call', { name: 'x_lists.prepare', arguments: { request_id: 'missing-login', task_id: mcpTask.id, grant_id: mcpGrant.data.id, account_key: '@wrong', kind: 'update', list_id: 'missing-list', name: 'must-not-write' } }, initialized.sessionId);
      const failure = JSON.parse(rejected.data.content[0].text);
      assert.equal(failure.error.code, 'BROWSER_NEEDS_USER');
      assert.equal(failure.error.details.state, 'needs_user');
      const check = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM x_list_operations').get().count, 0);
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM x_list_bindings').get().count, 0);
      check.close();
    } finally { await ukMcp.close(); ukMcp=undefined; await ukRuntime.stop({ drain: false }); ukRuntime=undefined; }
    const aiMcp = await startMcp(aiRoot.path);
    try {
      const initialized = await mcpRequest(aiMcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-ai-profile-test', version: '1' } });
      const listed = await mcpRequest(aiMcp.url, 'tools/list', {}, initialized.sessionId);
      const names = new Set(listed.data.tools.map((tool) => tool.name));
      assert.equal(names.has('sources.wire_health_get'), true);
      assert.equal(names.has('x_lists.read_index'), true);
      assert.equal(names.has('x_lists.confirm'), false);
    } finally { await aiMcp.close(); }
    const profiles = readBrowserProfileRegistry(browserConfigPath).profiles;
    const sharedProfile = profiles.find((profile) => profile.id === browserRegistry.defaultProfileId);
    assert.equal(sharedProfile.userDataDir, path.join(parent, 'user-data', 'browser-profiles', browserRegistry.defaultProfileId));
    const aiBindingDb = migrateDatabase(path.join(aiRoot.path, 'wmb.db'));
    const ukBindingDb = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
    try {
      const aiBinding = readWorkspaceBrowserBinding(aiBindingDb);
      const ukBinding = readWorkspaceBrowserBinding(ukBindingDb);
      assert.equal(aiBinding.profileId, sharedProfile.id);
      assert.equal(ukBinding.profileId, sharedProfile.id);
      assert.notEqual(aiBinding.createdAt, undefined);
      assert.notEqual(ukBinding.createdAt, undefined);
    } finally { aiBindingDb.close(); ukBindingDb.close(); }

    const channelDb = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
    const channelSource = createWebsiteSource(channelDb, {
      inputText: 'https://example.com/uk-daily', name: 'UK daily source', canonicalUrl: 'https://example.com/uk-daily', resolutionStatus: 'ready',
      trialRead: { title: 'UK daily source', url: 'https://example.com/uk-daily', readable: true, summary: 'A readable UK workspace source used for shared daily routing.' }
    });
    channelDb.close();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html><head><title>UK updates</title></head><body><p>Readable shared channel page with no new links today.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const calls = { ai: 0, uk: 0 };
    try {
      const result = await startWorkspaceDailyIntelligence({ dataRootPath: ukRoot.path, businessDate: '2026-08-02', mcpUrl: 'http://127.0.0.1:1/mcp' }, {
        ai: async () => { calls.ai += 1; throw new Error('AI route must stay zero'); },
        uk: async () => {
          calls.uk += 1;
          const database = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
          try {
            const taskRow = database.prepare("SELECT id FROM agent_tasks WHERE intent IN ('daily_intelligence','daily_scan','daily_judge') AND business_date=? ORDER BY created_at DESC").get('2026-08-02');
            assert.ok(taskRow, 'channel task must exist before judgment runner');
            const task = getAgentTask(database, taskRow.id);
            assert.ok(task);
            assert.deepEqual(task.contextRefs.intelligenceChannels, {
              workspaceId: uk.id, profileRevision: 1, modules: ['official_web', 'x_lists'],
              sources: [{ module: 'official_web', sourceId: channelSource.id, sourceFeedId: channelSource.sourceFeedId, revision: channelSource.revision }]
            });
            saveCurrentPlan(database, { planDate: '2026-08-02', timezone: 'Asia/Shanghai', summary: '今日没有新增机会', items: [] });
            database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run('plans.save', agentRequestId(task.id, 'plan'), '{}', new Date().toISOString());
            const completed = completeAgentTask(database, task.id);
            assert.equal(completed.ok, true);
            return { task: completed.data, reused: false };
          } finally { database.close(); }
        }
      });
      assert.equal(result.task.status, 'succeeded');
    } finally { globalThis.fetch = originalFetch; }
    assert.deepEqual(calls, { ai: 0, uk: 1 });
  } finally {
    await ukMcp?.close();
    if (ukRuntime?.isActive) await ukRuntime.stop({ drain: false });
    await rm(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

function createTextChain(database, url, planDate, title) {
  const source = upsertSource(database, { originalUrl: url, title, summary: '同值隔离资料', recommendedPlatforms: ['x'], recommendedFormats: ['text'], verificationStatus: 'verified' });
  const plan = saveCurrentPlan(database, { planDate, timezone: 'Asia/Shanghai', summary: `${title}方案`, items: [{
    title, priority: 2, whyNow: '当前官方信息已更新', timeliness: '本周', targetAudience: '在英中国人', angle: '解释行动步骤', pointOfView: '先核验再行动',
    platforms: ['x'], formats: ['text'], titleGuidance: title, openingGuidance: '先说影响', structureGuidance: '变化、影响、行动', effortEstimate: '30 分钟', sourceIds: [source.id]
  }] });
  const planItemId = database.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(plan.id).id;
  const project = createContentProjectWithVersion(database, { title, body: '英国生活核心正文', planItemId, sourceIds: [source.id] });
  const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'text', body: '英国生活 X 纯文字版本' });
  assert.equal(platform.ok, true);
  return { sourceId: source.id, planItemId, projectId: project.id, platformVersionId: platform.data.id };
}
