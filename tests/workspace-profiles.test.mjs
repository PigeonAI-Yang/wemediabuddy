import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { agentRequestId, completeAgentTask, getAgentTask } from '../src/main/agent-tasks.ts';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { discoverBrowserProfiles } from '../src/main/browser-config.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createOfficialWorkspace, enrollAiWorkspace } from '../src/main/workspaces.ts';
import { AI_ONLY_ROUTE_IDS, assertAiOnlyRoute, readWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';
import { WorkspaceProposalStore } from '../src/main/workspace-proposals.ts';
import { createWebsiteSource } from '../src/main/intelligence-channels.ts';

test('official AI and UK profiles isolate one linked text chain without AI-only routes', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-profiles-'));
  try {
    const registryPath = path.join(parent, 'user-data', 'workspace-registry.json');
    const aiRoot = await openDataRoot(path.join(parent, 'ai'));
    migrateDatabase(path.join(aiRoot.path, 'wmb.db')).close();
    await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path });
    const uk = await createOfficialWorkspace({ registryPath, rootPath: path.join(parent, 'uk'), templateId: 'official.uk' });
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

    const mcp = await startMcp(ukRoot.path, undefined, { listWorkspaces: async () => ({ activeWorkspaceId: uk.id, workspaces: [uk] }), proposals: new WorkspaceProposalStore(() => true) });
    try {
      const initialized = await mcpRequest(mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-profile-test', version: '1' } });
      const listed = await mcpRequest(mcp.url, 'tools/list', {}, initialized.sessionId);
      const names = new Set(listed.data.tools.map((tool) => tool.name));
      assert.deepEqual([...names].filter((name) => name.startsWith('x_lists.')).sort(), [
        'x_lists.collect_timeline', 'x_lists.get_operation', 'x_lists.list_bindings',
        'x_lists.observation_get', 'x_lists.observation_start', 'x_lists.observation_stop',
        'x_lists.post_metric_snapshots_list', 'x_lists.post_trend_get', 'x_lists.prepare',
        'x_lists.read_detail', 'x_lists.read_index', 'x_lists.read_members', 'x_lists.read_timeline'
      ]);
      assert.equal(names.has('x_lists.confirm'), false);
      assert.equal(names.has('sources.wire_health_get'), false);
      const current = await mcpRequest(mcp.url, 'tools/call', { name: 'workspaces.get_current', arguments: {} }, initialized.sessionId);
      const snapshot = JSON.parse(current.data.content[0].text);
      assert.equal(snapshot.id, uk.id);
      assert.equal(snapshot.profile.intelligencePackId, 'uk-life-content-radar');
      assert.deepEqual(snapshot.capabilities, { xLists: true, aiIntelligence: false, fixedAiLists: false, rankings: false, sourceWire: false, publishingPlatforms: ['x', 'xiaohongshu'] });
      const bindings = await mcpRequest(mcp.url, 'tools/call', { name: 'x_lists.list_bindings', arguments: {} }, initialized.sessionId);
      assert.deepEqual(JSON.parse(bindings.data.content[0].text), []);
      const rejected = await mcpRequest(mcp.url, 'tools/call', { name: 'x_lists.prepare', arguments: { request_id: 'missing-login', account_key: '@wrong', kind: 'create', name: 'must-not-write' } }, initialized.sessionId);
      const failure = JSON.parse(rejected.data.content[0].text);
      assert.equal(failure.error.code, 'BROWSER_NEEDS_USER');
      assert.equal(failure.error.details.state, 'needs_user');
      const check = migrateDatabase(path.join(ukRoot.path, 'wmb.db'));
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM x_list_operations').get().count, 0);
      check.close();
    } finally { await mcp.close(); }
    const aiMcp = await startMcp(aiRoot.path);
    try {
      const initialized = await mcpRequest(aiMcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-ai-profile-test', version: '1' } });
      const listed = await mcpRequest(aiMcp.url, 'tools/list', {}, initialized.sessionId);
      const names = new Set(listed.data.tools.map((tool) => tool.name));
      assert.equal(names.has('sources.wire_health_get'), true);
      assert.equal(names.has('x_lists.read_index'), true);
      assert.equal(names.has('x_lists.confirm'), false);
    } finally { await aiMcp.close(); }
    const configPath = path.join(aiRoot.path, 'installation', 'browser-config.json');
    const aiBrowser = discoverBrowserProfiles(null, configPath)[0];
    const ukBrowser = discoverBrowserProfiles(null, configPath)[0];
    assert.equal(ukBrowser.userDataDir, path.join(aiRoot.path, 'installation', 'browser-profile'));
    assert.equal(ukBrowser.userDataDir, aiBrowser.userDataDir);
    assert.notEqual(ukBrowser.cdpUrl, 'http://127.0.0.1:9334');

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
            const task = getAgentTask(database, database.prepare("SELECT id FROM agent_tasks WHERE intent='daily_intelligence' AND business_date=?").get('2026-08-02').id);
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
  } finally { await rm(parent, { recursive: true, force: true, maxRetries: 3 }); }
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
