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

// 历史 v2 配方快照：v2 模板被 v3 取代后，此快照作为「存量 v2 根」升级/跳过测试的 fixture（与 v1 fixture 同样保持不再变化）。
const V2_OFFICIAL_AI_FIXTURE = {
  displayName: 'AI × 商业化成长',
  audience: '已在用 AI 干活、想靠「内容→信任→付费」独立收入的中文创作者与独立开发者；要可复现实验与真实卡点，不要躺赚话术',
  contentGoal: '公开用 AI 做内容、跑实验、沉淀方法，把一个人靠内容和产品活下去的路径讲清楚并持续兑现',
  editorialBrief: '编辑使命=公开用 AI 把自己做成能靠内容和产品活下去的人。五维=认知/技能/表达/获客/产品化。优先：真实实验与公开开发回执、可复现用法、受众重复问题、可变现/可产品化信号。降权：纯公告搬运、宏大综述、无观点热点、无法验证的赚钱承诺。栏目骨架：实验日志/开发日志/原则卡/机会判断/周复盘/变现实验。机会按 SSS 至 F 保留全部合格结果。发布是夜灯（X 主战场；小红书客户端人工发）。'
};
const NEW_AI_AUDIENCE = '正在寻找 AI 商业化方向、愿意完成真实项目并获取反馈的中文读者';

test('new official.ai root gets template v5 with de-anchored audience and Zhihu publishing', async () => {
  await withDb((database) => {
    const profile = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(profile.displayName, 'AI × 商业化成长');
    assert.equal(profile.officialTemplateVersion, 5);
    assert.equal(profile.revision, 1);
    assert.equal(profile.audience, NEW_AI_AUDIENCE);
    assert.match(profile.contentGoal, /真实项目/);
    assert.match(profile.editorialBrief, /五维=时代认知/);
    assert.match(profile.editorialBrief, /迷茫诊断/);
    assert.match(profile.editorialBrief, /受众描述只用于内部选题判断/);
    assert.doesNotMatch(profile.audience, /普通人/);
    assert.ok(profile.platforms.includes('zhihu'));
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
    assert.equal(upgraded.officialTemplateVersion, 5);
    assert.equal(upgraded.revision, 2);
    assert.equal(upgraded.displayName, 'AI × 商业化成长');
    assert.equal(upgraded.audience, NEW_AI_AUDIENCE);
    const again = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(again.revision, 2);
    assert.equal(again.officialTemplateVersion, 5);
  });
});

test('official.ai lineage with existing v2 profile upgrades to v5 on ensure', async () => {
  await withDb((database) => {
    const stale = {
      ...OFFICIAL_WORKSPACE_TEMPLATES['official.ai'],
      ...V2_OFFICIAL_AI_FIXTURE,
      officialTemplateVersion: 2,
      revision: 2
    };
    insertWorkspaceProfile(database, stale);
    const upgraded = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(upgraded.officialTemplateVersion, 5);
    assert.equal(upgraded.revision, 3);
    assert.equal(upgraded.displayName, 'AI × 商业化成长');
    assert.equal(upgraded.audience, NEW_AI_AUDIENCE);
    assert.match(upgraded.editorialBrief, /时代认知/);
    assert.doesNotMatch(upgraded.editorialBrief, /内容→信任→付费/);
    const again = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(again.revision, 3);
    assert.equal(again.officialTemplateVersion, 5);
    assert.equal(readWorkspaceProfile(database)?.revision, 3);
  });
});

test('official.ai v3 workspace upgrades to v5 and enables Zhihu', async () => {
  await withDb((database) => {
    insertWorkspaceProfile(database, {
      ...OFFICIAL_WORKSPACE_TEMPLATES['official.ai'],
      officialTemplateVersion: 3,
      platforms: ['x', 'xiaohongshu', 'wechat'],
      revision: 3
    });
    const upgraded = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(upgraded.officialTemplateVersion, 5);
    assert.equal(upgraded.revision, 4);
    assert.deepEqual(upgraded.platforms, ['x', 'xiaohongshu', 'wechat', 'zhihu']);
  });
});

test('official.ai v4 workspace upgrades to v5 and removes title audience anchoring', async () => {
  await withDb((database) => {
    insertWorkspaceProfile(database, {
      ...OFFICIAL_WORKSPACE_TEMPLATES['official.ai'],
      officialTemplateVersion: 4,
      audience: '面对 AI 浪潮无所适从、想找到个人商业化方向并愿意完成真实项目的中文普通人',
      contentGoal: '帮中文普通人完成真实项目',
      editorialBrief: '无普通人行动意义的参数新闻降权',
      revision: 4
    });
    const upgraded = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(upgraded.officialTemplateVersion, 5);
    assert.equal(upgraded.revision, 5);
    assert.equal(upgraded.audience, NEW_AI_AUDIENCE);
    assert.doesNotMatch(upgraded.audience, /普通人/);
    assert.match(upgraded.editorialBrief, /标题必须从题材独有的问题、动作、对象或证据中产生/);
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

test('running agent task also skips existing v2 profile upgrade', async () => {
  await withDb((database) => {
    const stale = {
      ...OFFICIAL_WORKSPACE_TEMPLATES['official.ai'],
      ...V2_OFFICIAL_AI_FIXTURE,
      officialTemplateVersion: 2,
      revision: 3
    };
    insertWorkspaceProfile(database, stale);
    const started = startAgentTask(database, { intent: 'daily_intelligence', businessDate: '2026-08-07' });
    assert.equal(started.ok, true);
    assert.equal(started.data.status, 'running');
    const skipped = ensureOfficialWorkspaceProfile(database, 'official.ai');
    assert.equal(skipped.displayName, 'AI × 商业化成长');
    assert.equal(skipped.revision, 3);
    assert.equal(skipped.officialTemplateVersion, 2);
    assert.match(skipped.audience, /内容→信任→付费/);
    assert.equal(readWorkspaceProfile(database)?.officialTemplateVersion, 2);
  });
});
