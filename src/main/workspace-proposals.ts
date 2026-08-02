import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_WORKSPACE_TEMPLATES, type WorkspaceProfileV1 } from './workspace-profiles.ts';

export const WORKSPACE_CATALOG = {
  version: 2,
  templates: Object.values(OFFICIAL_WORKSPACE_TEMPLATES),
  intelligencePacks: [
    { id: 'wemedia-intelligence-engine', version: 1, label: 'AI 情报' },
    { id: 'uk-life-content-radar', version: 1, label: '英国生活情报' },
    { id: 'game-news-radar', version: 1, label: '游戏资讯情报' }
  ],
  creationPacks: [{ id: 'wmb-core-creation', version: 1, label: 'WMB 文字创作' }],
  platforms: ['x', 'xiaohongshu', 'wechat']
} as const;

export type WorkspaceProposalInput = {
  requestId: string;
  target: 'current' | 'new';
  purpose: 'self_media';
  displayName: string;
  audience: string;
  contentGoal: string;
  editorialBrief: string;
  intelligencePackId: WorkspaceProfileV1['intelligencePackId'];
  intelligencePackVersion: number;
  creationPackId: WorkspaceProfileV1['creationPackId'];
  creationPackVersion: number;
  platforms: WorkspaceProfileV1['platforms'];
};

export type ProfileDiff = { field: keyof WorkspaceProfileV1; before: unknown; after: unknown };
export type WorkspaceProposal = {
  id: string;
  revision: 1;
  target: 'current' | 'new';
  targetWorkspaceId: string | null;
  normalizedHash: string;
  baseProfileRevision: number | null;
  catalogVersion: number;
  profile: WorkspaceProfileV1;
  displayedDiff: ProfileDiff[];
};
export type WorkspaceProposalBinding = {
  proposalId: string;
  proposalRevision: number;
  normalizedHash: string;
  baseProfileRevision: number | null;
  catalogVersion: number;
  intelligencePackId: string;
  intelligencePackVersion: number;
  creationPackId: string;
  creationPackVersion: number;
  platforms: string[];
  displayedDiff: ProfileDiff[];
};

type ProposalContext = { workspaceId: string | null; currentProfile: WorkspaceProfileV1 | null };

export class WorkspaceProposalStore {
  private readonly proposals = new Map<string, WorkspaceProposal>();
  private readonly requests = new Map<string, { inputHash: string; proposal: WorkspaceProposal }>();
  private readonly packAvailable: (packId: WorkspaceProfileV1['intelligencePackId']) => boolean;
  constructor(packAvailable: (packId: WorkspaceProfileV1['intelligencePackId']) => boolean = packagedIntelligencePackAvailable) { this.packAvailable = packAvailable; }

  prepare(input: WorkspaceProposalInput, context: ProposalContext): WorkspaceProposal {
    const normalized = normalizeInput(input);
    if (normalized.target === 'current' && (!context.workspaceId || !context.currentProfile)) throw workspaceError('PROFILE_STALE', '当前工作空间配方不存在。');
    if (normalized.target === 'current' && normalized.displayName !== context.currentProfile?.displayName) throw workspaceError('VALIDATION_ERROR', '当前阶段不支持重命名工作空间。');
    if (normalized.target === 'new' && (context.workspaceId || context.currentProfile)) throw workspaceError('PROFILE_STALE', '新工作空间提案不能绑定现有配方。');
    requireCatalogEntry(normalized, this.packAvailable);
    const inputHash = hash({ normalized, workspaceId: context.workspaceId, baseProfileRevision: context.currentProfile?.revision ?? null });
    const replay = this.requests.get(normalized.requestId);
    if (replay) {
      if (replay.inputHash !== inputHash) throw workspaceError('PROFILE_STALE', 'request_id 已绑定其他提案内容。');
      return replay.proposal;
    }
    const profileFields = {
      displayName: normalized.displayName, audience: normalized.audience, contentGoal: normalized.contentGoal,
      editorialBrief: normalized.editorialBrief, intelligencePackId: normalized.intelligencePackId,
      intelligencePackVersion: normalized.intelligencePackVersion, creationPackId: normalized.creationPackId,
      creationPackVersion: normalized.creationPackVersion, platforms: normalized.platforms
    };
    const profile: WorkspaceProfileV1 = {
      profileId: context.currentProfile?.profileId ?? `profile.custom.${hash(profileFields).slice(0, 16)}`,
      revision: (context.currentProfile?.revision ?? 0) + 1,
      officialTemplateId: null,
      officialTemplateVersion: null,
      ...profileFields
    };
    const proposal: WorkspaceProposal = {
      id: randomUUID(), revision: 1, target: normalized.target,
      targetWorkspaceId: context.workspaceId,
      normalizedHash: hash({ targetWorkspaceId: context.workspaceId, profile }),
      baseProfileRevision: context.currentProfile?.revision ?? null,
      catalogVersion: WORKSPACE_CATALOG.version,
      profile,
      displayedDiff: diffProfiles(context.currentProfile, profile)
    };
    this.proposals.set(proposal.id, proposal);
    this.requests.set(normalized.requestId, { inputHash, proposal });
    return proposal;
  }

  validateConfirmation(binding: WorkspaceProposalBinding, context: ProposalContext): WorkspaceProposal {
    const proposal = this.proposals.get(binding.proposalId);
    if (!proposal || proposal.targetWorkspaceId !== context.workspaceId || proposal.baseProfileRevision !== (context.currentProfile?.revision ?? null)
      || binding.proposalRevision !== proposal.revision || binding.normalizedHash !== proposal.normalizedHash
      || binding.baseProfileRevision !== proposal.baseProfileRevision || binding.catalogVersion !== WORKSPACE_CATALOG.version
      || binding.intelligencePackId !== proposal.profile.intelligencePackId || binding.intelligencePackVersion !== proposal.profile.intelligencePackVersion
      || binding.creationPackId !== proposal.profile.creationPackId || binding.creationPackVersion !== proposal.profile.creationPackVersion
      || JSON.stringify(binding.platforms) !== JSON.stringify(proposal.profile.platforms)
      || JSON.stringify(binding.displayedDiff) !== JSON.stringify(proposal.displayedDiff)) {
      throw workspaceError('PROFILE_STALE', '工作空间提案确认绑定已失效。');
    }
    requireCatalogEntry(proposal.profile, this.packAvailable);
    return proposal;
  }

  list(): Array<{ proposal: WorkspaceProposal; binding: WorkspaceProposalBinding }> {
    return [...this.proposals.values()].map((proposal) => ({ proposal: structuredClone(proposal), binding: proposalBinding(proposal) }));
  }

  get(proposalId: string): WorkspaceProposal | null { return this.proposals.get(proposalId) ?? null; }
  consume(proposalId: string): void { this.proposals.delete(proposalId); }
}

export function proposalBinding(proposal: WorkspaceProposal): WorkspaceProposalBinding {
  return {
    proposalId: proposal.id, proposalRevision: proposal.revision, normalizedHash: proposal.normalizedHash,
    baseProfileRevision: proposal.baseProfileRevision, catalogVersion: proposal.catalogVersion,
    intelligencePackId: proposal.profile.intelligencePackId, intelligencePackVersion: proposal.profile.intelligencePackVersion,
    creationPackId: proposal.profile.creationPackId, creationPackVersion: proposal.profile.creationPackVersion,
    platforms: [...proposal.profile.platforms], displayedDiff: structuredClone(proposal.displayedDiff)
  };
}

function normalizeInput(input: WorkspaceProposalInput): WorkspaceProposalInput {
  if (input.purpose !== 'self_media') throw workspaceError('VALIDATION_ERROR', '只支持有固定内容产物的自媒体目标。');
  const text = (value: string, name: string) => { const normalized = value?.trim(); if (!normalized) throw workspaceError('VALIDATION_ERROR', `${name}不能为空。`); return normalized; };
  const platforms = WORKSPACE_CATALOG.platforms.filter((platform) => input.platforms?.includes(platform));
  if (!platforms.length || platforms.length !== new Set(input.platforms ?? []).size) throw workspaceError('VALIDATION_ERROR', '必须选择一个或多个受支持平台。');
  return { ...input, requestId: text(input.requestId, 'request_id'), displayName: text(input.displayName, '显示名称'), audience: text(input.audience, '受众'), contentGoal: text(input.contentGoal, '内容目标'), editorialBrief: text(input.editorialBrief, '编辑简报'), platforms };
}

function requireCatalogEntry(input: Pick<WorkspaceProposalInput, 'intelligencePackId' | 'intelligencePackVersion' | 'creationPackId' | 'creationPackVersion'>, available: (id: WorkspaceProfileV1['intelligencePackId']) => boolean): void {
  const intelligence = WORKSPACE_CATALOG.intelligencePacks.find((entry) => entry.id === input.intelligencePackId && entry.version === input.intelligencePackVersion);
  const creation = WORKSPACE_CATALOG.creationPacks.find((entry) => entry.id === input.creationPackId && entry.version === input.creationPackVersion);
  if (!intelligence || !creation || !available(input.intelligencePackId)) throw workspaceError('OFFICIAL_PACK_UNAVAILABLE', '提案引用的官方能力包不可用。');
}

function diffProfiles(before: WorkspaceProfileV1 | null, after: WorkspaceProfileV1): ProfileDiff[] {
  return (Object.keys(after) as Array<keyof WorkspaceProfileV1>).filter((field) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before?.[field] ?? null, after: after[field] }));
}

function packagedIntelligencePackAvailable(packId: WorkspaceProfileV1['intelligencePackId']): boolean {
  const local = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../skills/${packId}/SKILL.md`);
  try {
    const electron = createRequire(import.meta.url)('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) return existsSync(path.join(process.resourcesPath, 'skills', packId, 'SKILL.md'));
  } catch {}
  return existsSync(local);
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function workspaceError(code: 'VALIDATION_ERROR' | 'PROFILE_STALE' | 'OFFICIAL_PACK_UNAVAILABLE', message: string): Error { return Object.assign(new Error(message), { code }); }
