import type { DatabaseSync } from 'node:sqlite';

export type XListIndexValue = {
  accountKey: string;
  lists: Array<{
    listId: string;
    canonicalUrl: string;
    name: string;
    ownerHandle: string | null;
    kind: 'owned' | 'following' | 'member' | 'unknown';
  }>;
  observation: {
    capturedAt: string;
    pageUrl: string;
    fingerprint: string;
    visibleText: string;
  };
};

export function readXListIndexCache(database: DatabaseSync): XListIndexValue | null {
  const row = database.prepare('SELECT account_key, payload_json, fetched_at FROM x_list_index_cache WHERE id = 1').get() as
    | { account_key: string; payload_json: string; fetched_at: string }
    | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.payload_json) as XListIndexValue;
    if (!value || typeof value !== 'object' || !Array.isArray(value.lists)) return null;
    if (typeof value.accountKey !== 'string' || !value.accountKey) value.accountKey = row.account_key;
    if (!value.observation || typeof value.observation !== 'object') {
      value.observation = { capturedAt: row.fetched_at, pageUrl: '', fingerprint: '', visibleText: '' };
    } else if (!value.observation.capturedAt) {
      value.observation.capturedAt = row.fetched_at;
    }
    return value;
  } catch {
    return null;
  }
}

export function writeXListIndexCache(database: DatabaseSync, value: XListIndexValue): void {
  const fetchedAt = value.observation?.capturedAt || new Date().toISOString();
  database.prepare(`
    INSERT INTO x_list_index_cache (id, account_key, payload_json, fetched_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      account_key = excluded.account_key,
      payload_json = excluded.payload_json,
      fetched_at = excluded.fetched_at
  `).run(value.accountKey, JSON.stringify(value), fetchedAt);
}
