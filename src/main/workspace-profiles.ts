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
  intelligencePackId: 'wemedia-intelligence-engine' | 'uk-life-content-radar';
  intelligencePackVersion: number;
  creationPackId: 'wmb-core-creation';
  creationPackVersion: number;
  platforms: Array<'x' | 'xiaohongshu' | 'wechat'>;
};

export const OFFICIAL_WORKSPACE_TEMPLATES: Record<OfficialTemplateId, Omit<WorkspaceProfileV1, 'revision'>> = {
  'official.ai': {
    profileId: 'profile.ai.official', officialTemplateId: 'official.ai', officialTemplateVersion: 1, displayName: 'AI',
    audience: '关注 AI 工具、行业、开发和商业机会的中文受众', contentGoal: '持续发现并做出有判断、有证据、可执行的 AI 内容',
    editorialBrief: '优先官方发布、真实实测和受众正在遇到的问题；机会按 SSS 至 F 保留全部合格结果。',
    intelligencePackId: 'wemedia-intelligence-engine', intelligencePackVersion: 1,
    creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x', 'xiaohongshu', 'wechat']
  },
  'official.uk': {
    profileId: 'profile.uk.official', officialTemplateId: 'official.uk', officialTemplateVersion: 1, displayName: '英国生活',
    audience: '在英国生活、学习、工作或准备赴英的中国人', contentGoal: '把英国政策与生活信息转化为有来源、可执行的中文内容',
    editorialBrief: '政策、签证、金融、劳动和合同结论回到当前官方来源；区分事实、专业解释与个案。',
    intelligencePackId: 'uk-life-content-radar', intelligencePackVersion: 1,
    creationPackId: 'wmb-core-creation', creationPackVersion: 1, platforms: ['x', 'xiaohongshu']
  }
};

export const AI_ONLY_ROUTE_IDS = [
  'ai.intelligence.skill',
  'ai.intelligence.x_lists',
  'ai.intelligence.release_sources',
  'ai.intelligence.topic_routes',
  'ai.library.rankings',
  'ai.x_lists.workspace'
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
  if (existing) return existing;
  const profile = { ...OFFICIAL_WORKSPACE_TEMPLATES[templateId], revision: 1 };
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO workspace_profiles (id, profile_id, revision, official_template_id, official_template_version,
    display_name, audience, content_goal, editorial_brief, intelligence_pack_id, intelligence_pack_version,
    creation_pack_id, creation_pack_version, platforms_json, created_at, updated_at)
    VALUES ('effective', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      profile.profileId, profile.officialTemplateId, profile.officialTemplateVersion, profile.displayName, profile.audience,
      profile.contentGoal, profile.editorialBrief, profile.intelligencePackId, profile.intelligencePackVersion,
      profile.creationPackId, profile.creationPackVersion, JSON.stringify(profile.platforms), now, now
    );
  return profile;
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
