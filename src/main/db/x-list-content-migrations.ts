import type { DatabaseSync } from 'node:sqlite';
import { backfillXListQuotedSourceBodies } from '../x-list-source-content.ts';

export const xListContentMigrations = [
  {
    version: 83,
    sql: '',
    run: (database: DatabaseSync): void => {
      backfillXListQuotedSourceBodies(database);
    }
  }
] as const;
