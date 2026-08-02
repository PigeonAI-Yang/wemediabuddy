import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createOfficialWorkspace, enrollAiWorkspace } from '../src/main/workspaces.ts';
import { AI_ONLY_ROUTE_IDS, assertAiOnlyRoute, readWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';

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

    const mcp = await startMcp(ukRoot.path);
    try {
      const initialized = await mcpRequest(mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-profile-test', version: '1' } });
      const listed = await mcpRequest(mcp.url, 'tools/list', {}, initialized.sessionId);
      assert.equal(listed.data.tools.some((tool) => tool.name.startsWith('x_lists.')), false);
    } finally { await mcp.close(); }

    const calls = { ai: 0, uk: 0 };
    const result = await startWorkspaceDailyIntelligence({ dataRootPath: ukRoot.path, businessDate: '2026-08-02', mcpUrl: 'http://127.0.0.1:1/mcp' }, {
      ai: async () => { calls.ai += 1; throw new Error('AI route must stay zero'); },
      uk: async () => { calls.uk += 1; return { task: { id: 'uk-test' }, reused: false }; }
    });
    assert.equal(result.task.id, 'uk-test');
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
