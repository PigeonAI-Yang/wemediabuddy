import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';

export type AccountIdentity = { platform: 'x' | 'xiaohongshu' | 'wechat'; accountKey: string; displayName: string; loginState: 'authenticated' | 'unauthenticated' | 'challenge' | 'unknown'; evidenceUrl?: string };

export function saveAccount(database: DatabaseSync, input: AccountIdentity): { id: string; revision: number } {
  const current = database.prepare('SELECT id, revision FROM platform_accounts WHERE platform = ?').get(input.platform) as { id: string; revision: number } | undefined;
  const now = new Date().toISOString();
  if (!current) { const id = randomUUID(); database.prepare('INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(id, input.platform, input.accountKey, input.displayName, input.loginState, input.evidenceUrl ?? null, now, now); return { id, revision: 1 }; }
  database.prepare('UPDATE platform_accounts SET account_key=?, display_name=?, login_state=?, evidence_url=?, updated_at=?, revision=? WHERE id=?').run(input.accountKey, input.displayName, input.loginState, input.evidenceUrl ?? null, now, current.revision + 1, current.id);
  return { id: current.id, revision: current.revision + 1 };
}

export function verifyAccount(database: DatabaseSync, input: Pick<AccountIdentity, 'platform' | 'accountKey'>): CommandResult<{ accountKey: string }> {
  const account = database.prepare('SELECT account_key AS accountKey FROM platform_accounts WHERE platform = ?').get(input.platform) as { accountKey: string } | undefined;
  if (!account || account.accountKey !== input.accountKey) return failure('ACCOUNT_MISMATCH', '当前浏览器账号与保存账号不一致。', { expected: account?.accountKey ?? null, actual: input.accountKey });
  return success(account);
}
