import type { DatabaseSync } from 'node:sqlite';
import type { ContentProjectStatus } from './content.ts';

export type ContentProjectStatusSummary = {
  total: number;
  byStatus: Record<ContentProjectStatus, number>;
  archived: number;
  updatedWithin7Days: number;
};

type StatusCountRow = { status: ContentProjectStatus; count: number };
type CountRow = { count: number };

export function getContentProjectStatusSummary(database: DatabaseSync): ContentProjectStatusSummary {
  const byStatus: Record<ContentProjectStatus, number> = { idea: 0, drafting: 0, review: 0, ready: 0, completed: 0 };
  const rows = database.prepare('SELECT status, COUNT(*) AS count FROM content_projects WHERE archived_at IS NULL GROUP BY status')
    .all() as StatusCountRow[];
  for (const row of rows) if (row.status in byStatus) byStatus[row.status] = row.count;
  // node:sqlite .get() is untyped; COUNT(*) queries always return exactly one row.
  const archivedRow = database.prepare('SELECT COUNT(*) AS count FROM content_projects WHERE archived_at IS NOT NULL').get() as CountRow;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentRow = database.prepare('SELECT COUNT(*) AS count FROM content_projects WHERE archived_at IS NULL AND updated_at >= ?').get(weekAgo) as CountRow;
  return {
    total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    byStatus,
    archived: archivedRow.count,
    updatedWithin7Days: recentRow.count
  };
}
