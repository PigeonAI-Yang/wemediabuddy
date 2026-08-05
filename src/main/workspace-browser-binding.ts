import { DatabaseSync } from 'node:sqlite';
import { readAccount, saveVerifiedAccount, type AccountIdentity } from './accounts.ts';

export type BrowserBindingState = 'unverified' | 'verified' | 'needs_user';
export type ExpectedAccount = AccountIdentity & {
  accountRevision: number;
  browserProfileId: string;
  browserBindingRevision: number;
  verifiedAt: string;
};
export type ExpectedAccountSnapshot = Partial<Record<AccountIdentity['platform'], ExpectedAccount>>;
export type WorkspaceBrowserBinding = {
  profileId: string | null;
  bindingRevision: number;
  state: BrowserBindingState;
  expectedAccountSnapshot: ExpectedAccountSnapshot;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};

type BindingRow = {
  profileId: string | null;
  bindingRevision: number;
  state: BrowserBindingState;
  expectedAccountSnapshotJson: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export function readWorkspaceBrowserBinding(database: DatabaseSync): WorkspaceBrowserBinding | null {
  const row = readBindingRow(database);
  if (!row) return null;
  return {
    profileId: row.profileId,
    bindingRevision: row.bindingRevision,
    state: row.state,
    expectedAccountSnapshot: parseExpectedAccounts(row.expectedAccountSnapshotJson),
    error: row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? '' } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function initializeWorkspaceBrowserBinding(
  database: DatabaseSync,
  profileId: string,
  expectedAccountSnapshot: ExpectedAccountSnapshot = {}
): WorkspaceBrowserBinding {
  if (!profileId) throw bindingError('BROWSER_PROFILE_MISMATCH', '新工作空间必须显式绑定默认浏览器档案。');
  const current = readWorkspaceBrowserBinding(database);
  if (current) return current;
  const now = new Date().toISOString();
  const state: BrowserBindingState = Object.keys(expectedAccountSnapshot).length > 0 ? 'verified' : 'unverified';
  database.prepare(`
    INSERT INTO workspace_browser_bindings (
      id, profile_id, binding_revision, state, expected_account_snapshot_json,
      error_code, error_message, created_at, updated_at
    ) VALUES ('effective', ?, 1, ?, ?, NULL, NULL, ?, ?)
  `).run(profileId, state, JSON.stringify(expectedAccountSnapshot), now, now);
  return readWorkspaceBrowserBinding(database)!;
}

export function rebindWorkspaceBrowserProfile(database: DatabaseSync, input: {
  profileId: string;
  expectedBindingRevision: number;
}): WorkspaceBrowserBinding {
  return writeBindingCas(database, {
    profileId: input.profileId,
    expectedBindingRevision: input.expectedBindingRevision,
    state: 'unverified',
    expectedAccountSnapshot: {},
    error: null
  });
}

export function markWorkspaceBrowserBindingNeedsUser(database: DatabaseSync, input: {
  profileId: string | null;
  expectedBindingRevision: number;
  error: { code: string; message: string };
}): WorkspaceBrowserBinding {
  return writeBindingCas(database, {
    profileId: input.profileId,
    expectedBindingRevision: input.expectedBindingRevision,
    state: 'needs_user',
    error: input.error
  });
}

export function markWorkspaceBrowserBindingVerified(database: DatabaseSync, input: {
  profileId: string;
  expectedBindingRevision: number;
  account: AccountIdentity;
}): WorkspaceBrowserBinding {
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = readWorkspaceBrowserBinding(database);
    if (current?.profileId !== input.profileId) {
      throw bindingError('BROWSER_PROFILE_MISMATCH', '浏览器档案与当前工作空间绑定不一致。', { expected: current?.profileId ?? null, actual: input.profileId });
    }
    requireRevision(current, input.expectedBindingRevision);
    const priorExpected = current?.expectedAccountSnapshot[input.account.platform];
    if (priorExpected && priorExpected.accountKey !== input.account.accountKey) {
      throw bindingError('ACCOUNT_MISMATCH', '当前浏览器账号与绑定的预期账号不一致。', { expected: priorExpected.accountKey, actual: input.account.accountKey });
    }
    const persistedAccount = readAccount(database, input.account.platform);
    if (persistedAccount && persistedAccount.accountKey !== input.account.accountKey) {
      throw bindingError('ACCOUNT_MISMATCH', '当前浏览器账号与保存账号不一致。', { expected: persistedAccount.accountKey, actual: input.account.accountKey });
    }
    const nextRevision = input.expectedBindingRevision + 1;
    const verifiedAt = new Date().toISOString();
    const account = saveVerifiedAccount(database, input.account, {
      browserProfileId: input.profileId,
      browserBindingRevision: nextRevision,
      verifiedAt
    });
    const expectedAccount: ExpectedAccount = {
      ...input.account,
      accountRevision: account.revision,
      browserProfileId: input.profileId,
      browserBindingRevision: nextRevision,
      verifiedAt
    };
    upsertBinding(database, {
      profileId: input.profileId,
      bindingRevision: nextRevision,
      state: 'verified',
      expectedAccountSnapshot: { [input.account.platform]: expectedAccount },
      error: null,
      createdAt: current?.createdAt ?? verifiedAt,
      updatedAt: verifiedAt
    });
    database.exec('COMMIT');
    return readWorkspaceBrowserBinding(database)!;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function assertWorkspaceBrowserIdentity(database: DatabaseSync, input: {
  profileId: string;
  bindingRevision: number;
  platform: AccountIdentity['platform'];
  accountKey: string;
}): WorkspaceBrowserBinding {
  const binding = readWorkspaceBrowserBinding(database);
  requireRevision(binding, input.bindingRevision);
  if (binding?.profileId !== input.profileId) {
    throw bindingError('BROWSER_PROFILE_MISMATCH', '浏览器档案与当前工作空间绑定不一致。', { expected: binding?.profileId ?? null, actual: input.profileId });
  }
  const expected = binding.expectedAccountSnapshot[input.platform];
  if (!expected || expected.accountKey !== input.accountKey) {
    throw bindingError('ACCOUNT_MISMATCH', '浏览器账号与当前工作空间预期账号不一致。', { expected: expected?.accountKey ?? null, actual: input.accountKey });
  }
  if (expected.browserProfileId !== binding.profileId) {
    throw bindingError('BROWSER_PROFILE_MISMATCH', '预期账号快照属于其他浏览器档案。', { expected: binding.profileId, actual: expected.browserProfileId });
  }
  if (expected.browserBindingRevision !== binding.bindingRevision) {
    throw bindingError('PROFILE_STALE', '预期账号快照属于旧的浏览器 binding revision。', { expected: binding.bindingRevision, actual: expected.browserBindingRevision });
  }
  return binding;
}

function writeBindingCas(database: DatabaseSync, input: {
  profileId: string | null;
  expectedBindingRevision: number;
  state: BrowserBindingState;
  expectedAccountSnapshot?: ExpectedAccountSnapshot;
  error: { code: string; message: string } | null;
}): WorkspaceBrowserBinding {
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = readWorkspaceBrowserBinding(database);
    requireRevision(current, input.expectedBindingRevision);
    const now = new Date().toISOString();
    upsertBinding(database, {
      profileId: input.profileId,
      bindingRevision: input.expectedBindingRevision + 1,
      state: input.state,
      expectedAccountSnapshot: input.expectedAccountSnapshot ?? current?.expectedAccountSnapshot ?? {},
      error: input.error,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    });
    database.exec('COMMIT');
    return readWorkspaceBrowserBinding(database)!;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function upsertBinding(database: DatabaseSync, binding: WorkspaceBrowserBinding): void {
  database.prepare(`
    INSERT INTO workspace_browser_bindings (
      id, profile_id, binding_revision, state, expected_account_snapshot_json,
      error_code, error_message, created_at, updated_at
    ) VALUES ('effective', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      profile_id=excluded.profile_id,
      binding_revision=excluded.binding_revision,
      state=excluded.state,
      expected_account_snapshot_json=excluded.expected_account_snapshot_json,
      error_code=excluded.error_code,
      error_message=excluded.error_message,
      updated_at=excluded.updated_at
  `).run(
    binding.profileId,
    binding.bindingRevision,
    binding.state,
    JSON.stringify(binding.expectedAccountSnapshot),
    binding.error?.code ?? null,
    binding.error?.message ?? null,
    binding.createdAt,
    binding.updatedAt
  );
}

function readBindingRow(database: DatabaseSync): BindingRow | null {
  return (database.prepare(`
    SELECT profile_id AS profileId, binding_revision AS bindingRevision, state,
      expected_account_snapshot_json AS expectedAccountSnapshotJson,
      error_code AS errorCode, error_message AS errorMessage,
      created_at AS createdAt, updated_at AS updatedAt
    FROM workspace_browser_bindings WHERE id = 'effective'
  `).get() as BindingRow | undefined) ?? null;
}

function parseExpectedAccounts(value: string): ExpectedAccountSnapshot {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bindingError('BROWSER_PROFILE_MISMATCH', '预期账号快照无效。');
  return parsed as ExpectedAccountSnapshot;
}

function requireRevision(binding: WorkspaceBrowserBinding | null, expectedRevision: number): void {
  const actual = binding?.bindingRevision ?? 0;
  if (actual !== expectedRevision) throw bindingError('PROFILE_STALE', '浏览器档案绑定已变化。', { expected: expectedRevision, actual });
}

function bindingError(
  code: 'PROFILE_STALE' | 'BROWSER_PROFILE_MISMATCH' | 'ACCOUNT_MISMATCH',
  message: string,
  details: Record<string, unknown> = {}
): Error {
  return Object.assign(new Error(message), { code, details });
}
