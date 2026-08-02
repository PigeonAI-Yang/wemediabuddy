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

    const result = await startWorkspaceDailyIntelligence({ dataRootPath: root, businessDate: '2026-08-02', mcpUrl: 'http://127.0.0.1:1/mcp' });
    assert.equal(result.task.id, prestarted.data.id);
    assert.equal(result.reused, true);
    assert.equal(result.task.status, 'needs_user');
    assert.equal(result.task.phase, 'needs_user');
    assert.equal(result.task.errorCode, 'PI_CONFIG_REQUIRED');
    assert.equal(result.task.errorMessage, '请先在设置中配置 Pi API。');
    assert.deepEqual(result.task.contextRefs, { planDate: '2026-08-02', workspaceProfileId: 'profile.test.game', workspaceProfileRevision: 1, workspaceId: 'workspace-game' });
    const repeatedDaily = await startWorkspaceDailyIntelligence({ dataRootPath: root, businessDate: '2026-08-02', mcpUrl: 'http://127.0.0.1:1/mcp' });
    assert.equal(repeatedDaily.task.id, result.task.id);
    assert.equal(repeatedDaily.reused, true);

    const firstDraft = await startStudioDraft({ dataRootPath: root, businessDate: '2026-08-02', projectId: 'project-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp' });
    const secondDraft = await startStudioDraft({ dataRootPath: root, businessDate: '2026-08-02', projectId: 'project-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp' });
    assert.equal(firstDraft.task.status, 'needs_user'); assert.equal(secondDraft.task.id, firstDraft.task.id); assert.equal(secondDraft.reused, true);
    const firstReview = await startResultsReview({ dataRootPath: root, businessDate: '2026-08-02', publicationId: 'publication-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp' });
    const secondReview = await startResultsReview({ dataRootPath: root, businessDate: '2026-08-02', publicationId: 'publication-needs-user', mcpUrl: 'http://127.0.0.1:1/mcp' });
    assert.equal(firstReview.task.status, 'needs_user'); assert.equal(secondReview.task.id, firstReview.task.id); assert.equal(secondReview.reused, true);

    const reopened = migrateDatabase(path.join(root, 'wmb.db'));
    const persisted = reopened.prepare('SELECT status,phase,error_code AS errorCode,error_message AS errorMessage FROM agent_tasks WHERE id=?').get(result.task.id);
    assert.deepEqual({ ...persisted }, { status: 'needs_user', phase: 'needs_user', errorCode: 'PI_CONFIG_REQUIRED', errorMessage: '请先在设置中配置 Pi API。' });
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM app_meta WHERE key='pi-api-config'").get().count, 0);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE status='needs_user'").get().count, 3);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch((error) => {
      if (error.code !== 'EBUSY') throw error;
    });
  }
});
