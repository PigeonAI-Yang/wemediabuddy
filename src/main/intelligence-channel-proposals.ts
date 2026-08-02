import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeUrl } from './sources.ts';
import { intelligenceModules, type IntelligenceChannelSource, type IntelligenceChannelsSummary, type IntelligenceModule, type WebsiteTrialRead } from './intelligence-channels.ts';
import type { WebsiteCandidate } from './website-channel.ts';
import type { XListCandidate, XListResolution } from './x-list-channel.ts';

export type ChannelProposalAction = 'add' | 'enable' | 'disable' | 'remove';
export type ChannelProposalInput = { requestId: string; changes: ChannelProposalChangeInput[] };
export type ChannelProposalChangeInput =
  | { action: 'add'; module: 'official_web'; inputText: string; candidate: WebsiteCandidate; trialRead: WebsiteTrialRead }
  | { action: 'add'; module: 'x_lists'; resolution: XListResolution; candidate: XListCandidate }
  | { action: Exclude<ChannelProposalAction, 'add'>; module: IntelligenceModule; sourceId: string; expectedRevision: number };

export type PreparedChannelChange =
  | { action: 'add'; module: 'official_web'; stableIdentity: string; inputText: string; candidate: WebsiteCandidate; trialRead: WebsiteTrialRead }
  | { action: 'add'; module: 'x_lists'; stableIdentity: string; resolution: XListResolution; candidate: XListCandidate }
  | { action: Exclude<ChannelProposalAction, 'add'>; module: IntelligenceModule; stableIdentity: string; sourceId: string; expectedRevision: number };

export type ChannelProposalDiff = {
  action: ChannelProposalAction;
  module: IntelligenceModule;
  stableIdentity: string;
  sourceId: string | null;
  beforeRevision: number | null;
  display: { title: string; details: string[] };
};

export type IntelligenceChannelProposal = {
  id: string;
  revision: 1;
  workspaceId: string;
  profileRevision: number;
  normalizedHash: string;
  changes: PreparedChannelChange[];
  displayedDiff: ChannelProposalDiff[];
};

export type IntelligenceChannelProposalBinding = {
  proposalId: string;
  proposalRevision: number;
  normalizedHash: string;
  workspaceId: string;
  profileRevision: number;
  displayedDiff: ChannelProposalDiff[];
};

export type ChannelProposalContext = {
  workspaceId: string;
  profileRevision: number;
  channels: IntelligenceChannelsSummary;
};

export class IntelligenceChannelProposalStore {
  private readonly proposals = new Map<string, IntelligenceChannelProposal>();
  private readonly requests = new Map<string, { inputHash: string; proposal: IntelligenceChannelProposal }>();

  prepare(input: ChannelProposalInput, context: ChannelProposalContext): IntelligenceChannelProposal {
    const normalized = normalizeInput(input, context);
    const fingerprint = normalized.map(changeFingerprint);
    const inputHash = hash({ workspaceId: context.workspaceId, profileRevision: context.profileRevision, changes: fingerprint });
    const replay = this.requests.get(input.requestId.trim());
    if (replay) {
      if (replay.inputHash !== inputHash) throw proposalError('CONFIRMATION_STALE', 'request_id 已绑定其他来源变更。');
      return structuredClone(replay.proposal);
    }
    const proposal: IntelligenceChannelProposal = {
      id: randomUUID(), revision: 1, workspaceId: context.workspaceId, profileRevision: context.profileRevision,
      normalizedHash: hash({ workspaceId: context.workspaceId, profileRevision: context.profileRevision, changes: fingerprint }),
      changes: normalized,
      displayedDiff: normalized.map((change) => diffFor(change, context.channels))
    };
    this.proposals.set(proposal.id, proposal);
    this.requests.set(input.requestId.trim(), { inputHash, proposal });
    return structuredClone(proposal);
  }

  validateConfirmation(binding: IntelligenceChannelProposalBinding, context: ChannelProposalContext): IntelligenceChannelProposal {
    const proposal = this.proposals.get(binding.proposalId);
    if (!proposal || proposal.workspaceId !== context.workspaceId || proposal.profileRevision !== context.profileRevision
      || binding.proposalRevision !== proposal.revision || binding.normalizedHash !== proposal.normalizedHash
      || binding.workspaceId !== proposal.workspaceId || binding.profileRevision !== proposal.profileRevision
      || !sameJson(binding.displayedDiff, proposal.displayedDiff)) {
      throw proposalError('CONFIRMATION_STALE', '来源变更确认已失效，请重新准备。');
    }
    validateProposalState(proposal, context.channels);
    return structuredClone(proposal);
  }

  list(): Array<{ proposal: IntelligenceChannelProposal; binding: IntelligenceChannelProposalBinding }> {
    return [...this.proposals.values()].map((proposal) => ({ proposal: structuredClone(proposal), binding: channelProposalBinding(proposal) }));
  }

  listForContext(context: Pick<ChannelProposalContext, 'workspaceId' | 'profileRevision'>): Array<{ proposal: IntelligenceChannelProposal; binding: IntelligenceChannelProposalBinding }> {
    return this.list().filter(({ proposal }) => proposal.workspaceId === context.workspaceId && proposal.profileRevision === context.profileRevision);
  }

  get(proposalId: string): IntelligenceChannelProposal | null { const proposal = this.proposals.get(proposalId); return proposal ? structuredClone(proposal) : null; }
  consume(proposalId: string): void { this.proposals.delete(proposalId); }
}

export function channelProposalBinding(proposal: IntelligenceChannelProposal): IntelligenceChannelProposalBinding {
  return {
    proposalId: proposal.id, proposalRevision: proposal.revision, normalizedHash: proposal.normalizedHash,
    workspaceId: proposal.workspaceId, profileRevision: proposal.profileRevision, displayedDiff: structuredClone(proposal.displayedDiff)
  };
}

export function validateProposalState(proposal: IntelligenceChannelProposal, channels: IntelligenceChannelsSummary): void {
  const seen = new Set<string>();
  for (const change of proposal.changes) {
    const key = `${change.module}\u0000${change.stableIdentity}`;
    if (seen.has(key)) throw proposalError('CONFIRMATION_STALE', '同一来源不能在一个确认中重复或冲突变更。');
    seen.add(key);
    const source = sourceFor(channels, change.module, change.stableIdentity);
    if (change.action === 'add') {
      if (source) throw proposalError('CONFIRMATION_STALE', '来源已存在，请重新准备变更。');
      continue;
    }
    if (!source || source.sourceId !== change.sourceId || source.revision !== change.expectedRevision) {
      throw proposalError('CONFIRMATION_STALE', '来源身份或 revision 已变化，请重新准备。');
    }
    if (change.action === 'enable' && source.enabled) throw proposalError('CONFIRMATION_STALE', '来源已启用，请重新准备。');
    if ((change.action === 'disable' || change.action === 'remove') && !source.enabled) throw proposalError('CONFIRMATION_STALE', '来源已停用或移除，请重新准备。');
  }
}

function normalizeInput(input: ChannelProposalInput, context: ChannelProposalContext): PreparedChannelChange[] {
  const requestId = input.requestId?.trim();
  if (!requestId) throw proposalError('VALIDATION_ERROR', 'request_id 不能为空。');
  if (!Array.isArray(input.changes) || !input.changes.length) throw proposalError('VALIDATION_ERROR', '至少需要一条来源变更。');
  const normalized = input.changes.map((change) => normalizeChange(change, context));
  const provisional: IntelligenceChannelProposal = {
    id: '', revision: 1, workspaceId: context.workspaceId, profileRevision: context.profileRevision,
    normalizedHash: '', changes: normalized, displayedDiff: []
  };
  validateProposalState(provisional, context.channels);
  return normalized;
}

function normalizeChange(change: ChannelProposalChangeInput, context: ChannelProposalContext): PreparedChannelChange {
  if (!change || !intelligenceModules.includes(change.module)) throw proposalError('VALIDATION_ERROR', '只支持官网或 X Lists 来源。');
  if (change.action === 'add' && change.module === 'official_web') {
    const inputText = change.inputText?.trim();
    const candidate = change.candidate;
    const trialRead = change.trialRead;
    if (!inputText || !candidate || !trialRead || candidate.inputText?.trim() !== inputText || !trialRead.readable || !trialRead.title?.trim()) {
      throw proposalError('VALIDATION_ERROR', '新增官网必须携带当前输入、候选和成功试读。');
    }
    const requested = canonicalizeUrl(trialRead.requestedUrl ?? trialRead.url);
    if (requested !== canonicalizeUrl(candidate.canonicalUrl) || requested !== canonicalizeUrl(candidate.url)) {
      throw proposalError('VALIDATION_ERROR', '官网候选与试读结果不一致。');
    }
    return { action: 'add', module: 'official_web', stableIdentity: canonicalizeUrl(trialRead.url), inputText, candidate: structuredClone(candidate), trialRead: structuredClone(trialRead) };
  }
  if (change.action === 'add' && change.module === 'x_lists') {
    const resolution = change.resolution;
    const candidate = change.candidate;
    if (!resolution || !candidate || resolution.workspaceId !== context.workspaceId || !sameAccount(resolution.accountKey, candidate.accountKey)
      || !resolution.candidates.some((item) => sameXCandidate(item, candidate))) {
      throw proposalError('CONFIRMATION_STALE', 'X List 候选不属于当前工作空间解析结果。');
    }
    return { action: 'add', module: 'x_lists', stableIdentity: xIdentity(candidate.accountKey, candidate.listId), resolution: structuredClone(resolution), candidate: structuredClone(candidate) };
  }
  if (change.action !== 'enable' && change.action !== 'disable' && change.action !== 'remove') throw proposalError('VALIDATION_ERROR', '来源变更类型不支持。');
  const source = context.channels.sources.find((item) => item.module === change.module && item.sourceId === change.sourceId);
  if (!source || !Number.isInteger(change.expectedRevision)) throw proposalError('CONFIRMATION_STALE', '来源已变化，请重新读取后准备。');
  return { action: change.action, module: change.module, stableIdentity: stableIdentity(source), sourceId: source.sourceId, expectedRevision: change.expectedRevision };
}

function diffFor(change: PreparedChannelChange, channels: IntelligenceChannelsSummary): ChannelProposalDiff {
  const source = sourceFor(channels, change.module, change.stableIdentity);
  if (change.action === 'add' && change.module === 'official_web') {
    return { action: 'add', module: change.module, stableIdentity: change.stableIdentity, sourceId: null, beforeRevision: null,
      display: { title: `新增官网：${change.trialRead.title.trim()}`, details: [change.stableIdentity, '启用并加入今日情报'] } };
  }
  if (change.action === 'add' && change.module === 'x_lists') {
    return { action: 'add', module: change.module, stableIdentity: change.stableIdentity, sourceId: null, beforeRevision: null,
      display: { title: `接入 X List：${change.candidate.name}`, details: [`${change.candidate.accountKey} · List ${change.candidate.listId}`, change.candidate.canonicalUrl, '启用并加入今日情报'] } };
  }
  if (!source) throw proposalError('CONFIRMATION_STALE', '来源已变化，请重新准备。');
  const actionText = change.action === 'enable' ? '启用' : change.action === 'disable' ? '停用' : source.module === 'x_lists' ? '移出发现' : '移除官网配置';
  return { action: change.action, module: change.module, stableIdentity: change.stableIdentity, sourceId: source.sourceId, beforeRevision: source.revision,
    display: { title: `${actionText}：${source.name}`, details: [source.canonicalUrl, source.module === 'x_lists' ? `${source.accountKey} · List ${source.listId}` : '历史资料保留'] } };
}

function sourceFor(channels: IntelligenceChannelsSummary, module: IntelligenceModule, identity: string): IntelligenceChannelSource | null {
  return channels.sources.find((source) => source.module === module && stableIdentity(source) === identity) ?? null;
}

export function stableIdentity(source: IntelligenceChannelSource): string {
  return source.module === 'official_web' ? canonicalizeUrl(source.canonicalUrl) : xIdentity(source.accountKey ?? '', source.listId ?? '');
}

function xIdentity(accountKey: string, listId: string): string {
  if (!accountKey.trim() || !/^\d+$/.test(listId)) throw proposalError('CONFIRMATION_STALE', 'X List 稳定身份缺失。');
  return `${accountKey.trim().toLowerCase()}:${listId}`;
}

function sameXCandidate(left: XListCandidate, right: XListCandidate): boolean {
  return sameAccount(left.accountKey, right.accountKey) && left.listId === right.listId && left.canonicalUrl === right.canonicalUrl
    && left.name === right.name && left.ownerHandle === right.ownerHandle && left.kind === right.kind
    && left.observation.capturedAt === right.observation.capturedAt && left.observation.pageUrl === right.observation.pageUrl
    && left.observation.fingerprint === right.observation.fingerprint;
}

function changeFingerprint(change: PreparedChannelChange): unknown {
  if (change.action === 'add' && change.module === 'official_web') return {
    action: change.action, module: change.module, stableIdentity: change.stableIdentity, inputText: change.inputText,
    candidate: { inputText: change.candidate.inputText, name: change.candidate.name, url: change.candidate.url, canonicalUrl: change.candidate.canonicalUrl, origin: change.candidate.origin },
    trialRead: { title: change.trialRead.title, url: change.trialRead.url, requestedUrl: change.trialRead.requestedUrl ?? null, readable: change.trialRead.readable, itemCount: change.trialRead.itemCount ?? null, summary: change.trialRead.summary ?? null, httpStatus: change.trialRead.httpStatus ?? null, contentType: change.trialRead.contentType ?? null }
  };
  if (change.action === 'add' && change.module === 'x_lists') return {
    action: change.action, module: change.module, stableIdentity: change.stableIdentity,
    resolution: { workspaceId: change.resolution.workspaceId, inputText: change.resolution.inputText, matchKind: change.resolution.matchKind, accountKey: change.resolution.accountKey, observation: observationFingerprint(change.resolution.observation), candidates: change.resolution.candidates.map(xCandidateFingerprint) },
    candidate: xCandidateFingerprint(change.candidate)
  };
  return { action: change.action, module: change.module, stableIdentity: change.stableIdentity, sourceId: change.sourceId, expectedRevision: change.expectedRevision };
}

function xCandidateFingerprint(candidate: XListCandidate) {
  return { accountKey: candidate.accountKey, listId: candidate.listId, canonicalUrl: candidate.canonicalUrl, name: candidate.name, ownerHandle: candidate.ownerHandle, kind: candidate.kind, observation: observationFingerprint(candidate.observation) };
}

function observationFingerprint(observation: XListCandidate['observation']) {
  return { capturedAt: observation.capturedAt, pageUrl: observation.pageUrl, fingerprint: observation.fingerprint, visibleText: observation.visibleText };
}

function sameAccount(left: string, right: string): boolean { return left.trim().toLowerCase() === right.trim().toLowerCase(); }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function proposalError(code: 'VALIDATION_ERROR' | 'CONFIRMATION_STALE', message: string): Error { return Object.assign(new Error(message), { code }); }
