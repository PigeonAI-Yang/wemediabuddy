import type { DatabaseSync } from 'node:sqlite';

export type OfficialTemplateId = 'official.ai' | 'official.uk';
export type WorkspaceProfileV1 = {
  profileId: string;
  revision: number;
  officialTemplateId: OfficialTemplateId | null;
  officialTemplateVersion: number | null;
  displayName: string;
  audience: string;
  contentGoal: string;
  editorialBrief: string;
  intelligencePackId: 'wemedia-intelligence-engine' | 'uk-life-content-radar' | 'game-news-radar';
  intelligencePackVersion: number;
  creationPackId: 'wmb-core-creation';
  creationPackVersion: number;
  platforms: Array<'x' | 'xiaohongshu' | 'wechat' | 'zhihu'>;
};

export const OFFICIAL_WORKSPACE_TEMPLATES: Record<OfficialTemplateId, Omit<WorkspaceProfileV1, 'revision'>> = {
  'official.ai': {
    profileId: 'profile.ai.official',
    officialTemplateId: 'official.ai',
    officialTemplateVersion: 5,
    displayName: 'AI × 商业化成长',
    audience: '正在寻找 AI 商业化方向、愿意完成真实项目并获取反馈的中文读者',
    contentGoal: '帮助目标读者从迷茫走向明确：找到个人商业化方向，完成第一个真实项目并拿到真实反馈；不承诺收入',
    editorialBrief: '编辑使命=帮助正在寻找 AI 商业化方向、愿意完成真实项目并获取反馈的读者，从迷茫走向明确方向，完成第一个真实项目并拿到真实反馈；不承诺收入。受众描述只用于内部选题判断，不得机械复制进标题。标题必须从题材独有的问题、动作、对象或证据中产生，并避开近期固定前缀与句式。五维=时代认知/个人方向/AI 实践/公开验证/产品化。差异化=经典方法论 × 真实 AI 实践/案例。梯子=宽情绪/问题入口 → 经典方法论解读 → 真实 AI 项目/案例 → 合格对话/诊断/陪跑转化。证据=真实来源+本人实践/案例+具体动作；区分流量与合格线索。降权：纯模型公告、对目标读者没有可执行意义的参数/价格新闻、泛泛的书籍摘抄、励志口号、无法验证的收入承诺。栏目骨架：迷茫诊断/经典方法/AI 实战/项目日志/方向判断/商业化实验。机会按 SSS 至 F 保留全部合格结果。',
    intelligencePackId: 'wemedia-intelligence-engine',
    intelligencePackVersion: 1,
    creationPackId: 'wmb-core-creation',
    creationPackVersion: 1,
    // v5 去除受众身份词对标题的词面锚定，并保留 v4 启用的知乎发布面；ensure 仅升级官方谱系，
    // 自定义配方不受影响，运行中任务仍按既有保护跳过升级。
    platforms: ['x', 'xiaohongshu', 'wechat', 'zhihu']
  },
  'official.uk': {
    profileId: 'profile.uk.official',
    officialTemplateId: 'official.uk',
    officialTemplateVersion: 1,
    displayName: '英国生活',
    audience: '在英国生活、学习、工作或准备赴英的中国人',
    contentGoal: '把英国政策与生活信息转化为有来源、可执行的中文内容',
    editorialBrief: '政策、签证、金融、劳动和合同结论回到当前官方来源；区分事实、专业解释与个案。',
    intelligencePackId: 'uk-life-content-radar',
    intelligencePackVersion: 1,
    creationPackId: 'wmb-core-creation',
    creationPackVersion: 1,
    platforms: ['x', 'xiaohongshu']
  }
};

export function buildOfficialTemplateProfile(templateId: OfficialTemplateId, revision: number): WorkspaceProfileV1 {
  return { ...OFFICIAL_WORKSPACE_TEMPLATES[templateId], revision };
}

function isOfficialTemplateLineage(existing: WorkspaceProfileV1, templateId: OfficialTemplateId): boolean {
  const template = OFFICIAL_WORKSPACE_TEMPLATES[templateId];
  return existing.officialTemplateId === templateId
    && existing.profileId === template.profileId
    && existing.intelligencePackId === template.intelligencePackId;
}

export const AI_ONLY_ROUTE_IDS = [
  'ai.intelligence.skill',
  'ai.intelligence.x_lists',
  'ai.intelligence.release_sources',
  'ai.intelligence.topic_routes',
  'ai.library.rankings'
] as const;

export function readWorkspaceProfile(database: DatabaseSync): WorkspaceProfileV1 | null {
  const row = database.prepare(`SELECT profile_id AS profileId, revision, official_template_id AS officialTemplateId,
    official_template_version AS officialTemplateVersion, display_name AS displayName, audience, content_goal AS contentGoal,
    editorial_brief AS editorialBrief, intelligence_pack_id AS intelligencePackId,
    intelligence_pack_version AS intelligencePackVersion, creation_pack_id AS creationPackId,
    creation_pack_version AS creationPackVersion, platforms_json AS platforms
    FROM workspace_profiles WHERE id='effective'`).get() as (Omit<WorkspaceProfileV1, 'platforms'> & { platforms: string }) | undefined;
  return row ? { ...row, platforms: JSON.parse(row.platforms) } : null;
}

export function ensureOfficialWorkspaceProfile(database: DatabaseSync, templateId: OfficialTemplateId): WorkspaceProfileV1 {
  const existing = readWorkspaceProfile(database);
  const template = OFFICIAL_WORKSPACE_TEMPLATES[templateId];
  if (!existing) {
    const profile = buildOfficialTemplateProfile(templateId, 1);
    insertWorkspaceProfile(database, profile);
    return profile;
  }
  const existingVersion = existing.officialTemplateVersion ?? 0;
  const templateVersion = template.officialTemplateVersion ?? 0;
  if (!isOfficialTemplateLineage(existing, templateId) || existingVersion >= templateVersion) return existing;
  if (database.prepare("SELECT 1 FROM agent_tasks WHERE status='running' LIMIT 1").get()) return existing;
  return activateWorkspaceProfile(database, buildOfficialTemplateProfile(templateId, existing.revision + 1), existing.revision);
}

export function insertWorkspaceProfile(database: DatabaseSync, profile: WorkspaceProfileV1): WorkspaceProfileV1 {
  const existing = readWorkspaceProfile(database);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(profile)) throw Object.assign(new Error('候选根已有不同的工作空间配方。'), { code: 'PROFILE_STALE' });
    return existing;
  }
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO workspace_profiles (id, profile_id, revision, official_template_id, official_template_version,
    display_name, audience, content_goal, editorial_brief, intelligence_pack_id, intelligence_pack_version,
    creation_pack_id, creation_pack_version, platforms_json, created_at, updated_at)
    VALUES ('effective', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      profile.profileId, profile.revision, profile.officialTemplateId, profile.officialTemplateVersion, profile.displayName, profile.audience,
      profile.contentGoal, profile.editorialBrief, profile.intelligencePackId, profile.intelligencePackVersion,
      profile.creationPackId, profile.creationPackVersion, JSON.stringify(profile.platforms), now, now
    );
  return profile;
}

export function activateWorkspaceProfile(database: DatabaseSync, profile: WorkspaceProfileV1, expectedRevision: number): WorkspaceProfileV1 {
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = requireWorkspaceProfile(database);
    if (current.revision !== expectedRevision || profile.revision !== expectedRevision + 1) throw Object.assign(new Error('有效配方已变化。'), { code: 'PROFILE_STALE' });
    if (database.prepare("SELECT 1 FROM agent_tasks WHERE status='running' LIMIT 1").get()) throw Object.assign(new Error('运行中的 Agent 任务仍绑定当前配方。'), { code: 'WORKSPACE_BUSY' });
    database.prepare(`UPDATE workspace_profiles SET profile_id=?, revision=?, official_template_id=?, official_template_version=?,
      display_name=?, audience=?, content_goal=?, editorial_brief=?, intelligence_pack_id=?, intelligence_pack_version=?,
      creation_pack_id=?, creation_pack_version=?, platforms_json=?, updated_at=? WHERE id='effective' AND revision=?`).run(
      profile.profileId, profile.revision, profile.officialTemplateId, profile.officialTemplateVersion, profile.displayName, profile.audience,
      profile.contentGoal, profile.editorialBrief, profile.intelligencePackId, profile.intelligencePackVersion,
      profile.creationPackId, profile.creationPackVersion, JSON.stringify(profile.platforms), new Date().toISOString(), expectedRevision
    );
    database.exec('COMMIT');
    return requireWorkspaceProfile(database);
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function requireWorkspaceProfile(database: DatabaseSync): WorkspaceProfileV1 {
  const profile = readWorkspaceProfile(database);
  if (!profile) throw Object.assign(new Error('工作空间尚未配置有效配方。'), { code: 'OFFICIAL_PACK_UNAVAILABLE' });
  return profile;
}

export function assertAiOnlyRoute(database: DatabaseSync, routeId: typeof AI_ONLY_ROUTE_IDS[number]): void {
  const profile = requireWorkspaceProfile(database);
  if (profile.intelligencePackId !== 'wemedia-intelligence-engine') throw Object.assign(new Error(`当前工作空间不允许 AI 专属路线：${routeId}`), { code: 'OFFICIAL_PACK_UNAVAILABLE' });
}

export function allowsAiOnlyRoutes(database: DatabaseSync): boolean {
  return requireWorkspaceProfile(database).intelligencePackId === 'wemedia-intelligence-engine';
}

export function assertPublishingPlatforms(database: DatabaseSync, platforms: readonly string[]): void {
  const allowed = new Set(requireWorkspaceProfile(database).platforms);
  const denied = [...new Set(platforms)].filter((platform) => !allowed.has(platform as WorkspaceProfileV1['platforms'][number]));
  if (denied.length) throw Object.assign(new Error(`当前工作空间未启用发布平台：${denied.join('、')}`), { code: 'VALIDATION_ERROR' });
}
