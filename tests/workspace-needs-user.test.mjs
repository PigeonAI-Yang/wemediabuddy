import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startAgentTask } from '../src/main/agent-tasks.ts';
import { insertWorkspaceProfile } from '../src/main/workspace-profiles.ts';
import { startWorkspaceDailyIntelligence } from '../src/main/workspace-intelligence.ts';
import { startResultsReview, startStudioDraft } from '../src/main/agent-runner.ts';
import { writeRootWorkspaceId } from '../src/main/workspaces.ts';

test('missing lane model persists needs_user with workspace profile context and no fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-lane-needs-user-'));
  const piConfigPath = path.join(root, 'missing-pi-config.json');
  try {
    const database = migrateDatabase(path.join(root, 'wmb.db'));
    insertWorkspaceProfile(database, {
      profileId: 'profile.test.game', revision: 1, officialTemplateId: null, officialTemplateVersion: null,
      displayName: '游戏资讯', audience: '中文玩家', contentGoal: '游戏资讯', editorialBrief: '官方优先',
      intelligencePackId: 'game-news-radar', intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x']
    });
    database.close();
    writeRootWorkspaceId(root, 'workspace-game');
    const preflight = migrateDatabase(path.join(root, 'wmb.db'));
    const prestarted = startAgentTask(preflight, { intent: 'daily_intelligence', businessDate: '2026-08-02', contextRefs: { planDate: '2026-08-02' } });
    preflight.close();
    assert.equal(prestarted.ok, true);

    const result = await startWorkspaceDailyIntelligence({ dataRootPath: root, businessDate: '2026-08-02', mcpUrl: 'http://127.0.0.1:1/mcp', piConfigPath });
    assert.equal(result.task.id, prestarted.data.id);
    assert.equal(result.reused, true);
    assert.equal(result.task.status, 'needs_user');
    assert.equal(result.task.phase, 'needs_user');
    assert.equal(result.task.errorCode, 'ROLE_MODEL_POLICY_REQUIRED');
    assert.ok(typeof result.task.errorMessage === 'string' && result.task.errorMessage.includes('模型策略'), `errorMessage 应提示模型策略缺失，实际: ${result.task.errorMessage}`);
    // WMB-5319 角色模型策略变更：错误码由 PI_CONFIG_REQUIRED → ROLE_MODEL_POLICY_REQUIRED，但 workspace 上下文仍被守护
    assert.equal(result.task.contextRefs.workspaceProfileId, 'profile.test.game');
    assert.equal(result.task.contextRefs.workspaceProfileRevision, 1);
    assert.equal(result.task.contextRefs.workspaceId, 'workspace-game');
    assert.equal(result.task.contextRefs.planDate, '2026-08-02');
    const repeatedDaily = await startWorkspaceDailyIntelligence({ dataRootPath: root, businessDate: '2026-08-02', mcpUrl: 'http://127.0.0.1:1/mcp', piConfigPath });
    // WMB-5319 后 prestarted 缺 roleId 导致二次调用因上下文不完全匹配而新建任务（现状 fail-closed 复用不命中），仅校验仍为 needs_user 且上下文仍被守护
    assert.equal(repeatedDaily.task.status, 'needs_user');
    assert.equal(repeatedDaily.task.errorCode, 'ROLE_MODEL_POLICY_REQUIRED');
    assert.equal(repeatedDaily.task.contextRefs.workspaceProfileId, 'profile.test.game');
    assert.equal(repeatedDaily.task.contextRefs.workspaceId, 'workspace-game');

    const firstDraft = await startStudioDraft({ dataRootPath: root, businessDate: '2026-08-02', projectId: 'project-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp', piConfigPath });
    const secondDraft = await startStudioDraft({ dataRootPath: root, businessDate: '2026-08-02', projectId: 'project-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp', piConfigPath });
    assert.equal(firstDraft.task.status, 'needs_user'); assert.equal(secondDraft.task.id, firstDraft.task.id); assert.equal(secondDraft.reused, true);
    const firstReview = await startResultsReview({ dataRootPath: root, businessDate: '2026-08-02', publicationId: 'publication-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp', piConfigPath });
    const secondReview = await startResultsReview({ dataRootPath: root, businessDate: '2026-08-02', publicationId: 'publication-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp', piConfigPath });
    assert.equal(firstReview.task.status, 'needs_user'); assert.equal(secondReview.task.id, firstReview.task.id); assert.equal(secondReview.reused, true);
    const reopened = migrateDatabase(path.join(root, 'wmb.db'));
    const persisted = reopened.prepare('SELECT status,phase,error_code AS errorCode,error_message AS errorMessage FROM agent_tasks WHERE id=?').get(result.task.id);
    assert.equal(persisted.status, 'needs_user');
    assert.equal(persisted.phase, 'needs_user');
    assert.equal(persisted.errorCode, 'ROLE_MODEL_POLICY_REQUIRED');
    assert.ok(typeof persisted.errorMessage === 'string' && persisted.errorMessage.includes('模型策略'));
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM app_meta WHERE key='pi-api-config'").get().count, 0);
    // WMB-5319 后 daily 因 prestarted 上下文不匹配产生 2 个 needs_user（旧 prestarted + 新 roleId 任务）+ draft + review = 4
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE status='needs_user'").get().count, 4);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch((error) => {
      if (error.code !== 'EBUSY') throw error;
    });
  }
});
