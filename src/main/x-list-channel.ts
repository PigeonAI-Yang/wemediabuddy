import type { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult, type ErrorCode } from './result.ts';
import { bindXList, type XListBinding } from './x-lists.ts';
import { parseXListId, type XListBrowserConfig, xListUrl } from './platforms/x-list-primitives.ts';
import { readXListIndex, type XListObservation, type XListRef } from './platforms/x-list-browser.ts';

type XListIndex = Awaited<ReturnType<typeof readXListIndex>>;
export type XListIndexReader = (config: XListBrowserConfig) => Promise<XListIndex>;

export type XListCandidate = {
  accountKey: string;
  listId: string;
  canonicalUrl: string;
  name: string;
  ownerHandle: string | null;
  kind: XListRef['kind'];
  observation: XListObservation;
};

export type XListResolution = {
  workspaceId: string;
  inputText: string;
  matchKind: 'name' | 'url' | 'id';
  accountKey: string;
  candidates: XListCandidate[];
  observation: XListObservation;
};

type ParsedInput = { inputText: string; matchKind: XListResolution['matchKind']; listId?: string; normalizedName?: string };

export async function resolveXListCandidates(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: { inputText: string },
  readIndex: XListIndexReader = readXListIndex
): Promise<CommandResult<XListResolution>> {
  const workspace = currentWorkspace(database, config);
  if (!workspace.ok) return workspace;
  const parsed = parseInput(input.inputText);
  if (!parsed.ok) return parsed;
  const index = await currentIndex(config, readIndex);
  if (!index.ok) return index;

  const candidates = matchingCandidates(index.data, parsed.data);
  if (!candidates.length) {
    return failure('X_LIST_UNKNOWN', '当前账号没有读到与输入匹配的 X List。');
  }
  return success({
    workspaceId: workspace.data,
    inputText: parsed.data.inputText,
    matchKind: parsed.data.matchKind,
    accountKey: index.data.accountKey,
    candidates,
    observation: index.data.observation
  });
}

export async function confirmResolvedXList(
  database: DatabaseSync,
  config: XListBrowserConfig,
  input: { resolution: XListResolution; candidate: XListCandidate; expectedRevision?: number },
  readIndex: XListIndexReader = readXListIndex
): Promise<CommandResult<XListBinding>> {
  const workspace = currentWorkspace(database, config);
  if (!workspace.ok) return workspace;
  if (input.resolution.workspaceId !== workspace.data || !sameAccount(input.resolution.accountKey, input.candidate.accountKey)
    || !input.resolution.candidates.some((candidate) => sameCandidate(candidate, input.candidate))) {
    return failure('CONFIRMATION_STALE', 'X List 候选已变化，请重新解析后确认。');
  }

  const index = await currentIndex(config, readIndex);
  if (!index.ok) return index;
  if (!sameAccount(index.data.accountKey, input.resolution.accountKey) || !sameAccount(index.data.accountKey, input.candidate.accountKey)) {
    return failure('ACCOUNT_MISMATCH', '当前浏览器账号已变化，请重新解析并确认 X List。');
  }
  const list = index.data.lists.find((item) => item.listId === input.candidate.listId);
  if (!list || xListUrl(list.listId) !== input.candidate.canonicalUrl) {
    return failure('CONFIRMATION_STALE', '当前账号不再包含这个 X List，请重新解析后确认。');
  }
  return bindXList(database, {
    accountKey: index.data.accountKey,
    list,
    observation: { index: index.data.observation },
    expectedRevision: input.expectedRevision
  });
}

function currentWorkspace(database: DatabaseSync, config: XListBrowserConfig): CommandResult<string> {
  const stored = database.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get() as { value?: string } | undefined;
  if (!stored?.value) return failure('WORKSPACE_NOT_FOUND', '当前数据根没有工作空间身份。');
  if (!config.workspaceId || config.workspaceId !== stored.value) {
    return failure('WORKSPACE_ID_MISMATCH', 'X List 浏览器上下文不属于当前工作空间。');
  }
  return success(stored.value);
}

function parseInput(value: string): CommandResult<ParsedInput> {
  const inputText = value.trim();
  if (!inputText) return failure('VALIDATION_ERROR', '请输入 X List 名称、URL 或 ID。');
  if (/^\d+$/.test(inputText)) return success({ inputText, matchKind: 'id', listId: inputText });

  const urlValue = listUrlValue(inputText);
  if (urlValue !== null) {
    const listId = parseXListId(urlValue);
    return listId
      ? success({ inputText, matchKind: 'url', listId })
      : failure('VALIDATION_ERROR', '请输入标准 X List URL。');
  }
  return success({ inputText, matchKind: 'name', normalizedName: normalizeName(inputText) });
}

function listUrlValue(inputText: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(inputText)) return inputText;
  if (/^(?:www\.)?x\.com\//i.test(inputText)) return `https://${inputText}`;
  return null;
}

async function currentIndex(config: XListBrowserConfig, readIndex: XListIndexReader): Promise<CommandResult<XListIndex>> {
  try {
    return success(await readIndex(config));
  } catch (error) {
    const code = errorCode(error);
    return failure(code, errorMessage(error));
  }
}

function matchingCandidates(index: XListIndex, parsed: ParsedInput): XListCandidate[] {
  const seen = new Set<string>();
  const candidates: XListCandidate[] = [];
  for (const list of index.lists) {
    if (!/^\d+$/.test(list.listId) || seen.has(list.listId)) continue;
    const matches = parsed.listId !== undefined
      ? list.listId === parsed.listId
      : normalizeName(list.name) === parsed.normalizedName;
    if (!matches) continue;
    seen.add(list.listId);
    candidates.push({
      accountKey: index.accountKey,
      listId: list.listId,
      canonicalUrl: xListUrl(list.listId),
      name: list.name,
      ownerHandle: list.ownerHandle,
      kind: list.kind,
      observation: index.observation
    });
  }
  return candidates.sort((left, right) => left.listId < right.listId ? -1 : left.listId > right.listId ? 1 : 0);
}

function normalizeName(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function sameCandidate(left: XListCandidate, right: XListCandidate): boolean {
  return sameAccount(left.accountKey, right.accountKey)
    && left.listId === right.listId
    && left.canonicalUrl === right.canonicalUrl
    && left.name === right.name
    && left.ownerHandle === right.ownerHandle
    && left.kind === right.kind
    && left.observation.capturedAt === right.observation.capturedAt
    && left.observation.pageUrl === right.observation.pageUrl
    && left.observation.fingerprint === right.observation.fingerprint;
}

function sameAccount(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function errorCode(error: unknown): ErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
  return code === 'ACCOUNT_MISMATCH' ? code : 'BROWSER_NEEDS_USER';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
