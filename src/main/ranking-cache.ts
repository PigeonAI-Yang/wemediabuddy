import type { DatabaseSync } from 'node:sqlite';
import type { GitHubRankings } from './github-rankings';

export function readRankingCache(database: DatabaseSync): GitHubRankings | null {
  const row = database.prepare('SELECT payload_json, fetched_at FROM ranking_cache WHERE id = 1').get() as
    | { payload_json: string; fetched_at: string }
    | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.payload_json) as GitHubRankings;
    if (!value || typeof value !== 'object' || !Array.isArray(value.boards)) return null;
    return {
      fetchedAt: typeof value.fetchedAt === 'string' && value.fetchedAt ? value.fetchedAt : row.fetched_at,
      boards: value.boards
    };
  } catch {
    return null;
  }
}

export function writeRankingCache(database: DatabaseSync, value: GitHubRankings): void {
  database.prepare(`
    INSERT INTO ranking_cache (id, payload_json, fetched_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at
  `).run(JSON.stringify(value), value.fetchedAt);
}
