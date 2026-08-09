import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startAgentTask } from '../src/main/agent-tasks.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import {
  ensureOfficialWorkspaceProfile,
  insertWorkspaceProfile,
  OFFICIAL_WORKSPACE_TEMPLATES,
  readWorkspaceProfile
} from '../src/main/workspace-profiles.ts';

async function withDb(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-profile-ensure-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    await work(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('new official.ai root gets template v2 commercial identity', async () => {
  await withDb((database) => {
    const profile = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(profile.displayName, 'AI × 商业化成长');
    assert.equal(profile.officialTemplateVersion, 2);
    assert.equal(profile.revision, 1);
    assert.match(profile.editorialBrief, /五维/);
    assert.match(profile.contentGoal, /内容和产品活下去/);
  });
});

test('official.ai lineage with template v1 upgrades on ensure', async () => {
  await withDb((database) => {
    const stale = {
      ...OFFICIAL_WORKSPACE_TEMPLATES['official.ai'],
      officialTemplateVersion: 1,
      displayName: 'AI',
      audience: '关注 AI 工具、行业、开发和商业机会的中文受众',
      contentGoal: '持续发现并做出有判断、有证据、可执行的 AI 内容',
      editorialBrief: '优先官方发布、真实实测和受众正在遇到的问题；机会按 SSS 至 F 保留全部合格结果。',
      revision: 1
    };
    insertWorkspaceProfile(database, stale);
    const upgraded = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(upgraded.officialTemplateVersion, 2);
    assert.equal(upgraded.revision, 2);
    assert.equal(upgraded.displayName, 'AI × 商业化成长');
    assert.match(upgraded.audience, /内容→信任→付费/);
    const again = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(again.revision, 2);
    assert.equal(again.officialTemplateVersion, 2);
  });
});

test('custom profile is not overwritten by ensure', async () => {
  await withDb((database) => {
    insertWorkspaceProfile(database, {
      profileId: 'profile.custom',
      revision: 1,
      officialTemplateId: null,
      officialTemplateVersion: null,
      displayName: '自定义',
      audience: '自定义受众',
      contentGoal: '自定义目标',
      editorialBrief: '自定义简报',
      intelligencePackId: 'wemedia-intelligence-engine',
      intelligencePackVersion: 1,
      creationPackId: 'wmb-core-creation',
      creationPackVersion: 1,
      platforms: ['x']
    });
    const kept = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(kept.displayName, '自定义');
    assert.equal(kept.profileId, 'profile.custom');
    assert.equal(kept.revision, 1);
  });
});

test('running agent task skips official template upgrade', async () => {
  await withDb((database) => {
    const stale = {
      ...OFFICIAL_WORKSPACE_TEMPLATES['official.ai'],
      officialTemplateVersion: 1,
      displayName: 'AI',
      audience: '旧受众',
      contentGoal: '旧目标',
      editorialBrief: '旧简报 SSS',
      revision: 3
    };
    insertWorkspaceProfile(database, stale);
    const started = startAgentTask(database, { intent: 'daily_intelligence', businessDate: '2026-08-07' });
    assert.equal(started.ok, true);
    assert.equal(started.data.status, 'running');
    const skipped = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(skipped.displayName, 'AI');
    assert.equal(skipped.revision, 3);
    assert.equal(skipped.officialTemplateVersion, 1);
    assert.equal(readWorkspaceProfile(database)?.displayName, 'AI');
  });
});
