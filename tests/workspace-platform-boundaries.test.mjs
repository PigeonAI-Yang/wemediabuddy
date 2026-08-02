import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { bindXList } from '../src/main/x-lists.ts';
import { upsertSource } from '../src/main/sources.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { assertPublishingPlatforms, insertWorkspaceProfile, OFFICIAL_WORKSPACE_TEMPLATES } from '../src/main/workspace-profiles.ts';
import { writeRootWorkspaceId } from '../src/main/workspaces.ts';

test('workspace publishing subsets reject new work while root-local List sources keep the X chain', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-platform-subsets-'));
  let mcp;
  const databases = [];
  try {
    const game = await lane(parent, 'game', 'workspace-game', {
      profileId: 'profile.game.test', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
      displayName: '游戏资讯', audience: '玩家', contentGoal: '游戏资讯', editorialBrief: '官方优先', intelligencePackId: 'game-news-radar', intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
    });
    const uk = await lane(parent, 'uk', 'workspace-uk', { ...OFFICIAL_WORKSPACE_TEMPLATES['official.uk'], revision: 1 });
    const ai = await lane(parent, 'ai', 'workspace-ai', { ...OFFICIAL_WORKSPACE_TEMPLATES['official.ai'], revision: 1 });
    databases.push(game.db, uk.db, ai.db);
    assert.throws(() => assertPublishingPlatforms(game.db, ['xiaohongshu', 'wechat']), { code: 'VALIDATION_ERROR' });
    assert.throws(() => assertPublishingPlatforms(uk.db, ['wechat']), { code: 'VALIDATION_ERROR' });
    assert.doesNotThrow(() => assertPublishingPlatforms(ai.db, ['x', 'xiaohongshu', 'wechat']));

    const gameChain = listChain(game.db, '@game', '1910001', '游戏 List 动态');
    const ukChain = listChain(uk.db, '@uk', '1910002', '英国 List 动态');
    assert.notEqual(gameChain.sourceId, ukChain.sourceId);
    assert.equal(game.db.prepare('SELECT COUNT(*) count FROM source_items WHERE id=?').get(ukChain.sourceId).count, 0);
    assert.equal(uk.db.prepare('SELECT COUNT(*) count FROM source_items WHERE id=?').get(gameChain.sourceId).count, 0);

    mcp = await startMcp(game.root);
    const initialized = await request(mcp.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'platform-boundary', version: '1' } });
    const before = counts(game.db);
    const deniedPlan = await request(mcp.url, 'tools/call', { name: 'plans.save', arguments: planInput(gameChain.sourceId, ['wechat']) }, initialized.sessionId);
    const deniedVersion = await request(mcp.url, 'tools/call', { name: 'content.save_version', arguments: { request_id: 'denied-version', project_id: gameChain.projectId, content_version_id: gameChain.contentVersionId, platform: 'xiaohongshu', format: 'text', body: 'denied' } }, initialized.sessionId);
    assert.match(JSON.stringify(deniedPlan.data), /未启用发布平台：wechat/);
    assert.match(JSON.stringify(deniedVersion.data), /未启用发布平台：xiaohongshu/);
    assert.deepEqual(counts(game.db), before);
    const allowedInput = { request_id: 'historical-x-version', project_id: gameChain.projectId, content_version_id: gameChain.contentVersionId, platform: 'x', format: 'text', body: 'historical X' };
    const allowed = await request(mcp.url, 'tools/call', { name: 'content.save_version', arguments: allowedInput }, initialized.sessionId);
    game.db.prepare("UPDATE workspace_profiles SET platforms_json='[\"xiaohongshu\"]' WHERE id='effective'").run();
    const replay = await request(mcp.url, 'tools/call', { name: 'content.save_version', arguments: allowedInput }, initialized.sessionId);
    const deniedFresh = await request(mcp.url, 'tools/call', { name: 'content.save_version', arguments: { ...allowedInput, request_id: 'fresh-disabled-x' } }, initialized.sessionId);
    assert.deepEqual(replay.data, allowed.data);
    assert.match(JSON.stringify(deniedFresh.data), /未启用发布平台：x/);
    assert.equal(game.db.prepare('SELECT COUNT(*) count FROM mcp_request_results WHERE tool=?').get('content.save_version').count, 1);
  } finally {
    await mcp?.close();
    for (const database of databases) database.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

async function lane(parent, name, workspaceId, profile) {
  const root = path.join(parent, name);
  await mkdir(root, { recursive: true });
  migrateDatabase(path.join(root, 'wmb.db')).close();
  await writeRootWorkspaceId(root, workspaceId);
  const db = migrateDatabase(path.join(root, 'wmb.db'));
  insertWorkspaceProfile(db, profile);
  return { root, db };
}

function listChain(db, accountKey, listId, title) {
  const binding = bindXList(db, { accountKey, list: { listId, canonicalUrl: `https://x.com/i/lists/${listId}`, ownerHandle: accountKey, name: title, kind: 'owned' }, observation: { source: 'test' } });
  assert.equal(binding.ok, true);
  const source = upsertSource(db, { feedId: binding.data.sourceFeedId, originalUrl: `https://x.com/${accountKey.slice(1)}/status/${listId}`, title, summary: `${title}正文` });
  const plan = saveCurrentPlan(db, { planDate: '2026-08-02', timezone: 'Asia/Shanghai', summary: title, items: [planItem(source.id, ['x'])] });
  const planItemId = db.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(plan.id).id;
  const project = createContentProjectWithVersion(db, { title, body: `${title}核心正文`, planItemId, sourceIds: [source.id] });
  const platform = savePlatformVersion(db, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'text', body: `${title} X 正文` });
  assert.equal(platform.ok, true);
  return { sourceId: source.id, projectId: project.id, contentVersionId: project.contentVersionId };
}

const planItem = (sourceId, platforms) => ({ title: '选题', priority: 1, whyNow: '当前更新', timeliness: '今天', targetAudience: '受众', angle: '角度', pointOfView: '判断', platforms, formats: ['text'], titleGuidance: '标题', openingGuidance: '开头', structureGuidance: '结构', effortEstimate: '30 分钟', sourceIds: [sourceId] });
const planInput = (sourceId, platforms) => ({ request_id: `plan-${platforms.join('-')}`, plan_date: '2026-08-03', summary: 'denied', items: [planItem(sourceId, platforms)] });
const counts = (db) => ({ plans: db.prepare('SELECT COUNT(*) count FROM plans').get().count, versions: db.prepare('SELECT COUNT(*) count FROM platform_versions').get().count, receipts: db.prepare('SELECT COUNT(*) count FROM mcp_request_results').get().count });

async function request(url, method, params, sessionId) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  assert.equal(response.ok, true);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
  return { data: payload.result ?? payload.error, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
