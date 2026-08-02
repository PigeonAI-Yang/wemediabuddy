import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { broadcastDataChanged } from './data-changed.ts';
import { canonicalizeUrl, createSourceFeed } from './sources.ts';
import { listXListBindings, type XListBinding } from './x-lists.ts';

export const intelligenceModules = ['official_web', 'x_lists'] as const;
export type IntelligenceModule = typeof intelligenceModules[number];
export type WebsiteResolutionStatus = 'ready' | 'unresolved' | 'unreadable' | 'needs_user' | 'failed';
export type SourceScanStatus = 'succeeded' | 'failed' | 'needs_user';

export type WebsiteTrialRead = {
  title: string;
  url: string;
  readable: boolean;
  details?: Record<string, unknown>;
};

export type WebsiteSource = {
  id: string;
  sourceFeedId: string;
  inputText: string;
  name: string;
  canonicalUrl: string;
  enabled: boolean;
  resolutionStatus: WebsiteResolutionStatus;
  trialRead: WebsiteTrialRead;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type SourceScanReceipt = {
  id: string;
  taskId: string;
  workspaceId: string;
  module: IntelligenceModule;
  sourceId: string;
  sourceFeedId: string;
  checkedAt: string;
  status: SourceScanStatus;
  candidateCount: number;
  savedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type IntelligenceChannelSource = {
  module: IntelligenceModule;
  sourceId: string;
  sourceFeedId: string;
  name: string;
  canonicalUrl: string;
  enabled: boolean;
  status: 'ready' | 'disabled' | 'needs_user' | 'failed';
  revision: number;
  accountKey?: string;
  listId?: string;
};

export type IntelligenceChannelReadiness = {
  module: IntelligenceModule;
  configuredCount: number;
  enabledCount: number;
  readyCount: number;
  blockedCount: number;
  status: 'ready' | 'needs_config' | 'needs_user' | 'partial';
};

export type IntelligenceChannelsSummary = {
  websites: WebsiteSource[];
  xLists: XListBinding[];
  sources: IntelligenceChannelSource[];
  readiness: IntelligenceChannelReadiness[];
};

type WebsiteRow = Omit<WebsiteSource, 'name' | 'enabled' | 'trialRead'> & {
  name: string;
  enabled: number;
  resolutionJson: string;
};
type ReceiptRow = Omit<SourceScanReceipt, never>;

const websiteSelect = `SELECT w.id, w.source_feed_id AS sourceFeedId, w.input_text AS inputText,
  f.name, w.canonical_url AS canonicalUrl, w.enabled, w.resolution_status AS resolutionStatus,
  w.resolution_json AS resolutionJson, w.last_error_code AS lastErrorCode,
  w.last_error_message AS lastErrorMessage, w.last_checked_at AS lastCheckedAt,
  w.created_at AS createdAt, w.updated_at AS updatedAt, w.revision
  FROM website_sources w JOIN source_feeds f ON f.id = w.source_feed_id`;
const receiptSelect = `SELECT id, task_id AS taskId, workspace_id AS workspaceId, module,
  source_id AS sourceId, source_feed_id AS sourceFeedId, checked_at AS checkedAt, status,
  candidate_count AS candidateCount, saved_count AS savedCount, error_code AS errorCode,
  error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt, revision
  FROM source_scan_receipts`;

export function createWebsiteSource(database: DatabaseSync, input: {
  inputText: string;
  name: string;
  canonicalUrl: string;
  sourceFeedId?: string;
  resolutionStatus: 'ready';
  trialRead: WebsiteTrialRead;
  enabled?: boolean;
}): WebsiteSource {
  const inputText = input.inputText.trim();
  const name = input.name.trim();
  if (!inputText) throw new Error('WEBSITE_INPUT_REQUIRED');
  if (!name) throw new Error('WEBSITE_NAME_REQUIRED');
  const canonicalUrl = canonicalizeUrl(input.canonicalUrl);
  const trialUrl = canonicalizeUrl(input.trialRead.url);
  if (trialUrl !== canonicalUrl || !input.trialRead.readable || !input.trialRead.title.trim()) throw new Error('WEBSITE_TRIAL_READ_REQUIRED');
  if (database.prepare('SELECT 1 FROM website_sources WHERE canonical_url=?').get(canonicalUrl)) throw new Error('WEBSITE_SOURCE_EXISTS');
  let sourceFeedId: string | null = null;
  if (input.sourceFeedId !== undefined) {
    const requestedFeedId = input.sourceFeedId.trim();
    const feed = database.prepare('SELECT id, url FROM source_feeds WHERE id=?').get(requestedFeedId) as { id: string; url: string | null } | undefined;
    if (!feed) throw new Error('SOURCE_FEED_NOT_FOUND');
    if (!feed.url || canonicalizeUrl(feed.url) !== canonicalUrl) throw new Error('SOURCE_FEED_URL_MISMATCH');
    sourceFeedId = feed.id;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  database.exec('BEGIN IMMEDIATE');
  try {
    const feedId = sourceFeedId ?? createSourceFeed(database, { name, url: canonicalUrl }).id;
    database.prepare(`INSERT INTO website_sources (id, source_feed_id, input_text, canonical_url, enabled,
      resolution_status, resolution_json, last_checked_at, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, 1)`).run(
      id, feedId, inputText, canonicalUrl, input.enabled === false ? 0 : 1,
      JSON.stringify(input.trialRead), now, now, now
    );
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.website.create' });
  return getWebsiteSource(database, id)!;
}

export function getWebsiteSource(database: DatabaseSync, id: string): WebsiteSource | null {
  const row = database.prepare(`${websiteSelect} WHERE w.id=?`).get(id) as WebsiteRow | undefined;
  return row ? parseWebsite(row) : null;
}

export function listWebsiteSources(database: DatabaseSync, input: { enabled?: boolean } = {}): WebsiteSource[] {
  const rows = input.enabled === undefined
    ? database.prepare(`${websiteSelect} ORDER BY w.updated_at DESC, w.id DESC`).all() as WebsiteRow[]
    : database.prepare(`${websiteSelect} WHERE w.enabled=? ORDER BY w.updated_at DESC, w.id DESC`).all(input.enabled ? 1 : 0) as WebsiteRow[];
  return rows.map(parseWebsite);
}

export function setWebsiteSourceEnabled(database: DatabaseSync, input: { id: string; enabled: boolean; expectedRevision?: number }): WebsiteSource {
  const current = getWebsiteSource(database, input.id);
  if (!current) throw new Error('WEBSITE_SOURCE_NOT_FOUND');
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) throw new Error('REVISION_CONFLICT');
  if (input.enabled && current.resolutionStatus !== 'ready') throw new Error('WEBSITE_SOURCE_NOT_READY');
  const now = new Date().toISOString();
  database.prepare('UPDATE website_sources SET enabled=?, updated_at=?, revision=revision+1 WHERE id=?').run(input.enabled ? 1 : 0, now, input.id);
  broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.website.enabled' });
  return getWebsiteSource(database, input.id)!;
}

export function updateWebsiteSourceResolution(database: DatabaseSync, input: {
  id: string;
  resolutionStatus: WebsiteResolutionStatus;
  trialRead?: WebsiteTrialRead;
  errorCode?: string | null;
  errorMessage?: string | null;
  expectedRevision?: number;
}): WebsiteSource {
  const current = getWebsiteSource(database, input.id);
  if (!current) throw new Error('WEBSITE_SOURCE_NOT_FOUND');
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) throw new Error('REVISION_CONFLICT');
  const trialRead = input.trialRead ?? current.trialRead;
  if (input.resolutionStatus === 'ready') {
    if (!trialRead.readable || !trialRead.title.trim() || canonicalizeUrl(trialRead.url) !== current.canonicalUrl) throw new Error('WEBSITE_TRIAL_READ_REQUIRED');
  }
  const now = new Date().toISOString();
  database.prepare(`UPDATE website_sources SET resolution_status=?, resolution_json=?, last_error_code=?,
    last_error_message=?, last_checked_at=?, updated_at=?, revision=revision+1 WHERE id=?`).run(
    input.resolutionStatus, JSON.stringify(trialRead), input.errorCode ?? null, input.errorMessage ?? null, now, now, input.id
  );
  broadcastDataChanged({ scopes: ['sources', 'today'], reason: 'intelligence.website.resolution' });
  return getWebsiteSource(database, input.id)!;
}

export function getSourceScanReceipt(database: DatabaseSync, input: { taskId: string; module: IntelligenceModule; sourceId: string }): SourceScanReceipt | null {
  const row = database.prepare(`${receiptSelect} WHERE task_id=? AND module=? AND source_id=?`).get(input.taskId, input.module, input.sourceId) as ReceiptRow | undefined;
  return row ? { ...row } : null;
}

export function recordSourceScanReceipt(database: DatabaseSync, input: {
  taskId: string;
  workspaceId: string;
  module: IntelligenceModule;
  sourceId: string;
  sourceFeedId: string;
  checkedAt?: string;
  status: SourceScanStatus;
  candidateCount?: number;
  savedCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}): SourceScanReceipt {
  const taskId = input.taskId.trim(); const workspaceId = input.workspaceId.trim();
  if (!taskId || !workspaceId || !input.sourceId.trim() || !input.sourceFeedId.trim()) throw new Error('RECEIPT_IDENTITY_REQUIRED');
  const storedWorkspace = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
  if (!storedWorkspace?.value) throw new Error('WORKSPACE_ID_REQUIRED');
  if (storedWorkspace.value !== workspaceId) throw new Error('WORKSPACE_ID_MISMATCH');
  const candidateCount = input.candidateCount ?? 0; const savedCount = input.savedCount ?? 0;
  if (!Number.isInteger(candidateCount) || candidateCount < 0 || !Number.isInteger(savedCount) || savedCount < 0) throw new Error('RECEIPT_COUNT_INVALID');
  if (!database.prepare('SELECT 1 FROM source_feeds WHERE id=?').get(input.sourceFeedId)) throw new Error('SOURCE_FEED_NOT_FOUND');
  const sourceTable = input.module === 'official_web' ? 'website_sources' : 'x_list_bindings';
  const sourceIdentity = database.prepare(`SELECT source_feed_id AS sourceFeedId FROM ${sourceTable} WHERE id=?`).get(input.sourceId) as { sourceFeedId?: string } | undefined;
  if (!sourceIdentity?.sourceFeedId || sourceIdentity.sourceFeedId !== input.sourceFeedId) throw new Error('SOURCE_IDENTITY_MISMATCH');
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const current = getSourceScanReceipt(database, input);
  if (current && current.workspaceId === workspaceId && current.sourceFeedId === input.sourceFeedId && current.checkedAt === checkedAt && current.status === input.status && current.candidateCount === candidateCount && current.savedCount === savedCount && current.errorCode === (input.errorCode ?? null) && current.errorMessage === (input.errorMessage ?? null)) return current;
  const now = new Date().toISOString();
  if (current) {
    database.prepare(`UPDATE source_scan_receipts SET workspace_id=?, source_feed_id=?, checked_at=?, status=?, candidate_count=?,
      saved_count=?, error_code=?, error_message=?, updated_at=?, revision=revision+1 WHERE id=?`).run(
      workspaceId, input.sourceFeedId, checkedAt, input.status, candidateCount, savedCount,
      input.errorCode ?? null, input.errorMessage ?? null, now, current.id
    );
  } else {
    database.prepare(`INSERT INTO source_scan_receipts (id, task_id, workspace_id, module, source_id, source_feed_id,
      checked_at, status, candidate_count, saved_count, error_code, error_message, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
      randomUUID(), taskId, workspaceId, input.module, input.sourceId, input.sourceFeedId, checkedAt, input.status,
      candidateCount, savedCount, input.errorCode ?? null, input.errorMessage ?? null, now, now
    );
  }
  broadcastDataChanged({ scopes: ['today', 'sources', 'agent'], reason: 'intelligence.receipt.record' });
  return getSourceScanReceipt(database, input)!;
}

export function listSourceScanReceipts(database: DatabaseSync, input: {
  taskId?: string; workspaceId?: string; module?: IntelligenceModule; sourceId?: string; limit?: number;
} = {}): SourceScanReceipt[] {
  const clauses: string[] = []; const args: Array<string | number> = [];
  if (input.taskId) { clauses.push('task_id=?'); args.push(input.taskId); }
  if (input.workspaceId) { clauses.push('workspace_id=?'); args.push(input.workspaceId); }
  if (input.module) { clauses.push('module=?'); args.push(input.module); }
  if (input.sourceId) { clauses.push('source_id=?'); args.push(input.sourceId); }
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  return (database.prepare(`${receiptSelect}${where} ORDER BY checked_at DESC, id DESC LIMIT ?`).all(...args, limit) as ReceiptRow[]).map((row) => ({ ...row }));
}

export function readIntelligenceChannelsSummary(database: DatabaseSync): IntelligenceChannelsSummary {
  const websites = listWebsiteSources(database);
  const xLists = listXListBindings(database);
  const xReady = hasCurrentBrowserConfig(database);
  const sources: IntelligenceChannelSource[] = [
    ...websites.map((website) => ({ module: 'official_web' as const, sourceId: website.id, sourceFeedId: website.sourceFeedId, name: website.name, canonicalUrl: website.canonicalUrl, enabled: website.enabled, status: website.enabled ? website.resolutionStatus === 'ready' ? 'ready' as const : website.resolutionStatus === 'needs_user' ? 'needs_user' as const : 'failed' as const : 'disabled' as const, revision: website.revision })),
    ...xLists.map((binding) => ({ module: 'x_lists' as const, sourceId: binding.id, sourceFeedId: binding.sourceFeedId, name: binding.name, canonicalUrl: binding.canonicalUrl, enabled: binding.enabled, status: binding.enabled ? xReady ? 'ready' as const : 'needs_user' as const : 'disabled' as const, revision: binding.revision, accountKey: binding.accountKey, listId: binding.listId }))
  ];
  const readiness = [readinessFor('official_web', sources), readinessFor('x_lists', sources)];
  return { websites, xLists, sources, readiness };
}

function readinessFor(module: IntelligenceModule, sources: IntelligenceChannelSource[]): IntelligenceChannelReadiness {
  const items = sources.filter((source) => source.module === module);
  const enabled = items.filter((source) => source.enabled);
  const ready = enabled.filter((source) => source.status === 'ready');
  const blocked = enabled.filter((source) => source.status === 'needs_user' || source.status === 'failed');
  return { module, configuredCount: items.length, enabledCount: enabled.length, readyCount: ready.length, blockedCount: blocked.length,
    status: ready.length ? blocked.length ? 'partial' : 'ready' : enabled.length ? blocked.length ? 'needs_user' : 'needs_config' : 'needs_config' };
}

export function readIntelligenceChannelReadiness(database: DatabaseSync): IntelligenceChannelReadiness[] {
  return readIntelligenceChannelsSummary(database).readiness;
}

function hasCurrentBrowserConfig(database: DatabaseSync): boolean {
  const row = database.prepare("SELECT value FROM app_meta WHERE key='browser.config'").get() as { value?: string } | undefined;
  if (!row?.value) return false;
  try {
    const config = JSON.parse(row.value) as { id?: unknown };
    return typeof config.id === 'string' && config.id.trim().length > 0;
  } catch { return false; }
}

function parseWebsite(row: WebsiteRow): WebsiteSource {
  return { ...row, enabled: row.enabled === 1, trialRead: JSON.parse(row.resolutionJson) as WebsiteTrialRead };
}
