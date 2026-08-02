import type { DatabaseSync } from 'node:sqlite';
import { broadcastDataChanged } from './data-changed.ts';
import { readIntelligenceChannelsSummary, removeWebsiteSource, setWebsiteSourceEnabled, type IntelligenceChannelSource } from './intelligence-channels.ts';
import { IntelligenceChannelProposalStore, stableIdentity, type ChannelProposalContext, type IntelligenceChannelProposalBinding, type PreparedChannelChange } from './intelligence-channel-proposals.ts';
import { bindXList, setXListBindingEnabled } from './x-lists.ts';
import { verifyResolvedXList, type VerifiedXListResolution } from './x-list-channel.ts';
import { confirmWebsiteSource, trialReadWebsite } from './website-channel.ts';
import { requireWorkspaceProfile } from './workspace-profiles.ts';
import type { CurrentXListContext } from './x-list-context.ts';
import { canonicalizeUrl } from './sources.ts';

export function readChannelProposalContext(database: DatabaseSync): ChannelProposalContext {
  const workspaceId = (database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined)?.value;
  if (!workspaceId) throw stale('当前工作空间身份缺失。');
  return { workspaceId, profileRevision: requireWorkspaceProfile(database).revision, channels: readIntelligenceChannelsSummary(database) };
}

export async function confirmIntelligenceChannelProposal(database: DatabaseSync, input: {
  store: IntelligenceChannelProposalStore;
  binding: IntelligenceChannelProposalBinding;
  xContext?: CurrentXListContext;
  trialWebsite?: typeof trialReadWebsite;
}): Promise<{ applied: number }> {
  let transaction = false;
  try {
    const initial = readChannelProposalContext(database);
    const proposal = input.store.validateConfirmation(input.binding, initial);
    const verifiedX = await verifyExternalState(database, proposal.changes, input.xContext, input.trialWebsite ?? trialReadWebsite);
    database.exec('BEGIN IMMEDIATE');
    transaction = true;
    const current = readChannelProposalContext(database);
    const confirmed = input.store.validateConfirmation(input.binding, current);
    validateXAccounts(confirmed.changes, current.channels.sources, input.xContext);
    for (const change of confirmed.changes) applyChange(database, change, current.channels.sources, verifiedX);
    database.exec('COMMIT');
    transaction = false;
    input.store.consume(confirmed.id);
    broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.channel-proposal.confirm' });
    return { applied: confirmed.changes.length };
  } catch (error) {
    if (transaction) try { database.exec('ROLLBACK'); } catch {}
    throw stale(error instanceof Error ? error.message : String(error));
  }
}

async function verifyExternalState(
  database: DatabaseSync,
  changes: PreparedChannelChange[],
  xContext: CurrentXListContext | undefined,
  readWebsite: typeof trialReadWebsite
): Promise<Map<string, VerifiedXListResolution>> {
  const verifiedX = new Map<string, VerifiedXListResolution>();
  const needsX = changes.some((change) => change.module === 'x_lists');
  if (needsX && !xContext) throw stale('当前 X 账号无法核验，请重新准备。');
  for (const change of changes) {
    if (change.action === 'add' && change.module === 'official_web') {
      const fresh = await readWebsite({ url: change.candidate.url });
      if (!sameWebsiteTrial(change, fresh)) throw stale('官网候选或试读结果已变化，请重新准备。');
      continue;
    }
    if (change.action === 'add' && change.module === 'x_lists') {
      const result = await verifyResolvedXList(database, xContext!.config, { resolution: change.resolution, candidate: change.candidate }, async () => xContext!.index);
      if (!result.ok) throw stale(result.error.message);
      verifiedX.set(change.stableIdentity, result.data);
    }
  }
  return verifiedX;
}

function validateXAccounts(changes: PreparedChannelChange[], sources: IntelligenceChannelSource[], xContext?: CurrentXListContext): void {
  for (const change of changes) {
    if (change.module !== 'x_lists') continue;
    if (!xContext) throw stale('当前 X 账号无法核验，请重新准备。');
    if (change.action === 'add') {
      if (!sameAccount(change.candidate.accountKey, xContext.accountKey)) throw stale('当前 X 账号已变化，请重新准备。');
      continue;
    }
    const source = sources.find((item) => item.module === change.module && item.sourceId === change.sourceId);
    if (!source?.accountKey || !sameAccount(source.accountKey, xContext.accountKey)) throw stale('当前 X 账号已变化，请重新准备。');
    if (!source.listId || !xContext.index.lists.some((item) => item.listId === source.listId && item.canonicalUrl === source.canonicalUrl)) {
      throw stale('当前账号的 X List 身份已变化，请重新准备。');
    }
  }
}

function applyChange(
  database: DatabaseSync,
  change: PreparedChannelChange,
  sources: IntelligenceChannelSource[],
  verifiedX: Map<string, VerifiedXListResolution>
): void {
  if (change.action === 'add' && change.module === 'official_web') {
    confirmWebsiteSource(database, { inputText: change.inputText, candidate: change.candidate, trialRead: change.trialRead, transaction: true, notify: false });
    return;
  }
  if (change.action === 'add' && change.module === 'x_lists') {
    const verified = verifiedX.get(change.stableIdentity);
    if (!verified) throw stale('X List 当前身份无法确认。');
    const result = bindXList(database, { accountKey: verified.accountKey, list: verified.list, observation: { index: verified.observation }, transaction: true, notify: false });
    if (!result.ok) throw stale(result.error.message);
    return;
  }
  const source = sources.find((item) => item.module === change.module && item.sourceId === change.sourceId);
  if (!source || stableIdentity(source) !== change.stableIdentity) throw stale('来源身份已变化，请重新准备。');
  if (source.module === 'official_web') {
    if (change.action === 'remove') removeWebsiteSource(database, { id: source.sourceId, expectedRevision: change.expectedRevision, notify: false });
    else setWebsiteSourceEnabled(database, { id: source.sourceId, enabled: change.action === 'enable', expectedRevision: change.expectedRevision, notify: false });
    return;
  }
  if (!source.accountKey || !source.listId) throw stale('X List 来源身份缺失。');
  const result = setXListBindingEnabled(database, { accountKey: source.accountKey, listId: source.listId, enabled: change.action === 'enable', expectedRevision: change.expectedRevision, notify: false });
  if (!result.ok) throw stale(result.error.message);
}

function sameWebsiteTrial(change: Extract<PreparedChannelChange, { action: 'add'; module: 'official_web' }>, fresh: Awaited<ReturnType<typeof trialReadWebsite>>): boolean {
  return fresh.readable && fresh.title.trim() === change.trialRead.title.trim()
    && canonicalizeUrl(fresh.requestedUrl ?? fresh.url) === canonicalizeUrl(change.candidate.canonicalUrl)
    && canonicalizeUrl(fresh.url) === change.stableIdentity;
}

function sameAccount(left: string, right: string): boolean { return left.trim().toLowerCase() === right.trim().toLowerCase(); }
function stale(message: string): Error { return Object.assign(new Error(message), { code: 'CONFIRMATION_STALE' }); }
