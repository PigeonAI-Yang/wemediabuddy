import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';


export type AccountIdentity = {
  platform: 'x' | 'xiaohongshu' | 'wechat';
  accountKey: string;
  displayName: string;
  loginState: 'authenticated' | 'unauthenticated' | 'challenge' | 'unknown';
  evidenceUrl?: string;
};
export type AccountBindingVerification = {
  browserProfileId: string;
  browserBindingRevision: number;
  verifiedAt?: string;
};
export type PlatformAccount = AccountIdentity & {
  id: string;
  revision: number;
  browserProfileId: string | null;
  browserBindingRevision: number | null;
  verifiedAt: string | null;
};

export function readAccount(database: DatabaseSync, platform: AccountIdentity['platform']): PlatformAccount | null {
  const row = database.prepare(`
    SELECT id, platform, account_key AS accountKey, display_name AS displayName, login_state AS loginState,
           evidence_url AS evidenceUrl, revision, browser_profile_id AS browserProfileId,
           browser_binding_revision AS browserBindingRevision, verified_at AS verifiedAt
    FROM platform_accounts WHERE platform = ?
  `).get(platform) as PlatformAccount | undefined;
  return row ?? null;
}

export function saveAccount(database: DatabaseSync, input: AccountIdentity, verification?: AccountBindingVerification): { id: string; revision: number } {
  const current = database.prepare('SELECT id, revision FROM platform_accounts WHERE platform = ?').get(input.platform) as { id: string; revision: number } | undefined;
  const now = new Date().toISOString();
  if (!current) {
    const id = randomUUID();
    database.prepare(`
      INSERT INTO platform_accounts (
        id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision,
        browser_profile_id, browser_binding_revision, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id, input.platform, input.accountKey, input.displayName, input.loginState, input.evidenceUrl ?? null, now, now,
      verification?.browserProfileId ?? null, verification?.browserBindingRevision ?? null, verification?.verifiedAt ?? (verification ? now : null)
    );
    return { id, revision: 1 };
  }
  const nextRevision = current.revision + 1;
  if (verification) {
    database.prepare(`
      UPDATE platform_accounts SET account_key=?, display_name=?, login_state=?, evidence_url=?, updated_at=?, revision=?,
        browser_profile_id=?, browser_binding_revision=?, verified_at=? WHERE id=?
    `).run(
      input.accountKey, input.displayName, input.loginState, input.evidenceUrl ?? null, now, nextRevision,
      verification.browserProfileId, verification.browserBindingRevision, verification.verifiedAt ?? now, current.id
    );
  } else {
    database.prepare('UPDATE platform_accounts SET account_key=?, display_name=?, login_state=?, evidence_url=?, updated_at=?, revision=? WHERE id=?')
      .run(input.accountKey, input.displayName, input.loginState, input.evidenceUrl ?? null, now, nextRevision, current.id);
  }
  return { id: current.id, revision: nextRevision };
}

export function saveVerifiedAccount(
  database: DatabaseSync,
  input: AccountIdentity,
  verification: AccountBindingVerification
): PlatformAccount {
  const existing = readAccount(database, input.platform);
  if (existing && existing.accountKey !== input.accountKey) {
    throw accountError('ACCOUNT_MISMATCH', '当前浏览器账号与保存账号不一致。', { expected: existing.accountKey, actual: input.accountKey });
  }
  saveAccount(database, input, verification);
  return readAccount(database, input.platform)!;
}


function accountError(code: 'ACCOUNT_MISMATCH', message: string, details: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, details });
}
