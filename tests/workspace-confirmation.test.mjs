import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { agentRequestId, completeAgentTask, failAgentTask, getAgentTask, startAgentTask } from '../src/main/agent-tasks.ts';
import { createContentProjectWithVersion, savePlatformVersion } from '../src/main/content.ts';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { createWorkspaceConfirmation } from '../src/main/workspace-confirmation.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';
import { readWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { createWebsiteSource } from '../src/main/intelligence-channels.ts';
import { proposalBinding, WorkspaceProposalStore } from '../src/main/workspace-proposals.ts';
import { createProposedWorkspace, enrollAiWorkspace, readWorkspaceRegistry } from '../src/main/workspaces.ts';

test('UI confirmation is exact, busy-safe, crash-recoverable and cold-readable', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'wmb-workspace-confirmation-'));
  const userData = path.join(parent, 'user-data');
  const registryPath = path.join(userData, 'workspace-registry.json');
  const aiRoot = await openDataRoot(path.join(parent, 'ai'));
  migrateDatabase(path.join(aiRoot.path, 'wmb.db')).close();
  const ai = await enrollAiWorkspace({ registryPath, rootPath: aiRoot.path });
  const store = new WorkspaceProposalStore(() => true);
  try {
    const aiDb = migrateDatabase(path.join(aiRoot.path, 'wmb.db'));
    const base = readWorkspaceProfile(aiDb);
    const running = startAgentTask(aiDb, { intent: 'studio_draft', businessDate: '2026-08-02', contextRefs: { projectId: 'profile-gate' } });
    assert.equal(running.ok, true);
    assert.equal(running.data.contextRefs.workspaceId, ai.id);
    assert.equal(running.data.contextRefs.workspaceProfileRevision, 1);
    aiDb.close();
    const currentProposal = store.prepare({ ...proposalInput('update-current'), target: 'current', displayName: base.displayName, contentGoal: '持续创作可复现的 AI 开发自媒体内容' }, { workspaceId: ai.id, currentProfile: base });
    let relaunches = 0;
    const currentConfirmation = createWorkspaceConfirmation({ userDataPath: () => userData, chooseDirectory: async () => { throw new Error('existing profile must not choose a root'); }, loadSelectedDataRoot: async () => aiRoot, relaunchCurrentWorkspace: async (apply) => { const result = await apply(); relaunches += 1; return result; }, proposals: store });
    const durableBefore = await profileState(registryPath, aiRoot.path);
    await assert.rejects(() => currentConfirmation.confirm(proposalBinding(currentProposal)), { code: 'WORKSPACE_BUSY' });
    assert.equal(await profileState(registryPath, aiRoot.path), durableBefore);
    const releaseDb = migrateDatabase(path.join(aiRoot.path, 'wmb.db'));
    failAgentTask(releaseDb, running.data.id, 'TEST_RELEASE', '释放配方门禁');
    releaseDb.close();
    const updated = await currentConfirmation.confirm(proposalBinding(currentProposal));
    assert.equal(updated.profile.revision, 2);
    assert.equal(updated.profile.contentGoal, '持续创作可复现的 AI 开发自媒体内容');
    assert.equal(relaunches, 1);

    const activeId = (await readWorkspaceRegistry(registryPath)).activeWorkspaceId;
    for (const phase of ['root_ready', 'schema_ready', 'identity_ready', 'profile_ready', 'before_registry']) {
      const proposal = store.prepare({ ...proposalInput(`crash-${phase}`), displayName: `恢复-${phase}` }, { workspaceId: null, currentProfile: null });
      const rootPath = path.join(parent, `candidate-${phase}`);
      const before = await readWorkspaceRegistry(registryPath);
      await assert.rejects(() => createProposedWorkspace({ registryPath, rootPath, profile: proposal.profile, injectFailure(at) { if (at === phase) throw new Error(`crash:${phase}`); } }), new RegExp(`crash:${phase}`));
      const failed = await readWorkspaceRegistry(registryPath);
      assert.equal(failed.activeWorkspaceId, activeId);
      assert.equal(failed.workspaces.length, before.workspaces.length);
      const recovered = await createProposedWorkspace({ registryPath, rootPath, profile: proposal.profile });
      const reopened = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true });
      assert.equal(readWorkspaceProfile(reopened).profileId, proposal.profile.profileId);
      reopened.close();
      assert.equal((await readWorkspaceRegistry(registryPath)).workspaces.filter((item) => item.id === recovered.id).length, 1);
    }

    const afterProposal = store.prepare({ ...proposalInput('after-registry'), displayName: '提交后恢复' }, { workspaceId: null, currentProfile: null });
    const afterPath = path.join(parent, 'candidate-after-registry');
    await assert.rejects(() => createProposedWorkspace({ registryPath, rootPath: afterPath, profile: afterProposal.profile, injectFailure(phase) { if (phase === 'after_registry') throw new Error('crash:after_registry'); } }), /crash:after_registry/);
    const countAfterCommit = (await readWorkspaceRegistry(registryPath)).workspaces.length;
    await createProposedWorkspace({ registryPath, rootPath: afterPath, profile: afterProposal.profile });
    assert.equal((await readWorkspaceRegistry(registryPath)).workspaces.length, countAfterCommit);

    const newProposal = store.prepare({ ...proposalInput('ui-new'), displayName: '第三赛道测试' }, { workspaceId: null, currentProfile: null });
    const thirdRoot = path.join(parent, 'third');
    const confirmation = createWorkspaceConfirmation({ userDataPath: () => userData, chooseDirectory: async () => thirdRoot, loadSelectedDataRoot: async () => aiRoot, relaunchCurrentWorkspace: async (apply) => apply(), proposals: store });
    await confirmation.selectRoot(proposalBinding(newProposal));
    assert.equal(confirmation.list().find((item) => item.proposal.id === newProposal.id).selectedRootPath, thirdRoot);
    const created = await confirmation.confirm(proposalBinding(newProposal));
    assert.equal(created.workspace.rootPath, thirdRoot);
    assert.equal(confirmation.list().some((item) => item.proposal.id === newProposal.id), false);
    const registry = await readWorkspaceRegistry(registryPath);
    assert.equal(registry.activeWorkspaceId, activeId);
    assert.equal(registry.workspaces.some((item) => item.id === created.workspace.id), true);
    const cold = migrateDatabase(path.join(thirdRoot, 'wmb.db'));
    const chain = createTextChain(cold);
    assert.equal(readWorkspaceProfile(cold).profileId, newProposal.profile.profileId);
    assert.equal(cold.prepare('SELECT source_id FROM content_project_sources WHERE project_id=?').get(chain.projectId).source_id, chain.sourceId);
    assert.equal(cold.prepare('SELECT body FROM platform_versions WHERE id=?').get(chain.platformVersionId).body, '第三赛道 X 纯文字版本');
    cold.close();
    const channelDb = migrateDatabase(path.join(thirdRoot, 'wmb.db'));
    createWebsiteSource(channelDb, {
      inputText: 'https://example.com/game-daily', name: 'Game daily source', canonicalUrl: 'https://example.com/game-daily', resolutionStatus: 'ready',
      trialRead: { title: 'Game daily source', url: 'https://example.com/game-daily', readable: true, summary: 'A readable game workspace source used for shared daily routing.' }
    });
    channelDb.close();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html><head><title>Game updates</title></head><body><p>Readable shared channel page with no new links today.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const routes = { ai: 0, uk: 0, game: 0 };
    try {
      const routed = await startWorkspaceDailyIntelligence({ dataRootPath: thirdRoot, businessDate: '2026-08-02', mcpUrl: 'http://127.0.0.1:1/mcp' }, {
        ai: async () => { routes.ai += 1; throw new Error('AI route must stay zero'); },
        uk: async () => { routes.uk += 1; throw new Error('UK route must stay zero'); },
        game: async () => {
          routes.game += 1;
          const database = migrateDatabase(path.join(thirdRoot, 'wmb.db'));
          try {
            const task = getAgentTask(database, database.prepare("SELECT id FROM agent_tasks WHERE intent='daily_intelligence' AND business_date=?").get('2026-08-02').id);
            assert.ok(task);
            saveCurrentPlan(database, { planDate: '2026-08-02', timezone: 'Asia/Shanghai', summary: '今日没有新增机会', items: [] });
            database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run('plans.save', agentRequestId(task.id, 'plan'), '{}', new Date().toISOString());
            const completed = completeAgentTask(database, task.id);
            assert.equal(completed.ok, true);
            return { task: completed.data, reused: false };
          } finally { database.close(); }
        }
      });
      assert.equal(routed.task.status, 'succeeded');
    } finally { globalThis.fetch = originalFetch; }
    assert.deepEqual(routes, { ai: 0, uk: 0, game: 1 });

    const staleProposal = store.prepare({ ...proposalInput('stale-ui'), displayName: '过期提案' }, { workspaceId: null, currentProfile: null });
    let chooserCalls = 0;
    const staleConfirmation = createWorkspaceConfirmation({ userDataPath: () => userData, chooseDirectory: async () => { chooserCalls += 1; return path.join(parent, 'must-not-open'); }, loadSelectedDataRoot: async () => aiRoot, relaunchCurrentWorkspace: async (apply) => apply(), proposals: store });
    await assert.rejects(() => staleConfirmation.selectRoot({ ...proposalBinding(staleProposal), normalizedHash: 'changed' }), { code: 'PROFILE_STALE' });
    assert.equal(chooserCalls, 0);

    const occupiedRoot = await openDataRoot(path.join(parent, 'occupied'));
    const occupiedDb = migrateDatabase(path.join(occupiedRoot.path, 'wmb.db'));
    upsertSource(occupiedDb, { originalUrl: 'https://example.com/existing', title: '既有业务资料' });
    occupiedDb.close();
    const occupiedProposal = store.prepare({ ...proposalInput('occupied'), displayName: '不应创建' }, { workspaceId: null, currentProfile: null });
    const registryCount = (await readWorkspaceRegistry(registryPath)).workspaces.length;
    await assert.rejects(() => createProposedWorkspace({ registryPath, rootPath: occupiedRoot.path, profile: occupiedProposal.profile }), { code: 'VALIDATION_ERROR' });
    const occupiedRead = new DatabaseSync(path.join(occupiedRoot.path, 'wmb.db'), { readOnly: true });
    assert.equal(occupiedRead.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get(), undefined);
    assert.equal(readWorkspaceProfile(occupiedRead), null);
    occupiedRead.close();
    assert.equal((await readWorkspaceRegistry(registryPath)).workspaces.length, registryCount);
  } finally { await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

function proposalInput(requestId) {
  return { requestId, target: 'new', purpose: 'self_media', displayName: '游戏资讯', audience: '关注 PC、主机和热门跨平台游戏的中文玩家', contentGoal: '持续发现并创作有官方来源、能帮助玩家判断购买更新与参与时机的游戏资讯', editorialBrief: '先回到平台、开发商或发行商原文核对游戏、版本、日期和平台，再用简洁中文说明玩家影响；传闻与事实分开。', intelligencePackId: 'game-news-radar', intelligencePackVersion: 1, creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x'] };
}

async function profileState(registryPath, rootPath) {
  const db = new DatabaseSync(path.join(rootPath, 'wmb.db'), { readOnly: true });
  try { return JSON.stringify({ registry: await readFile(registryPath, 'utf8'), profile: readWorkspaceProfile(db) }); }
  finally { db.close(); }
}

function createTextChain(database) {
  const source = upsertSource(database, { originalUrl: 'https://www.gov.uk/third-lane', title: '第三赛道资料', summary: '可复现资料', verificationStatus: 'verified' });
  const plan = saveCurrentPlan(database, { planDate: '2026-08-02', timezone: 'Asia/Shanghai', summary: '第三赛道方案', items: [{ title: '第三赛道选题', priority: 2, whyNow: '信息已更新', timeliness: '本周', targetAudience: '中文受众', angle: '行动建议', pointOfView: '先核验', platforms: ['x'], formats: ['text'], titleGuidance: '明确结果', openingGuidance: '先说影响', structureGuidance: '变化、影响、行动', effortEstimate: '30 分钟', sourceIds: [source.id] }] });
  const planItemId = database.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(plan.id).id;
  const project = createContentProjectWithVersion(database, { title: '第三赛道内容', body: '第三赛道核心正文', planItemId, sourceIds: [source.id] });
  const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'text', body: '第三赛道 X 纯文字版本' });
  assert.equal(platform.ok, true);
  return { sourceId: source.id, projectId: project.id, platformVersionId: platform.data.id };
}
