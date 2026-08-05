import { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { getTaskGrant, listTaskGrants } from './task-grants.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export function registerTaskGrantMcp(
  server: McpServer,
  database: () => DatabaseSync,
  runtime?: ActiveWorkspaceRuntime
): void {
  server.registerTool('task_grants.get', {
    description: '读取当前根的 TaskGrantV1 worker-visible 引用、范围和状态；不能签发或撤销。',
    inputSchema: { grant_id: z.string() }
  }, async ({ grant_id }) => withDatabase(database, runtime, (db) => getTaskGrant(db, grant_id, new Date(), runtime?.identity)));
  server.registerTool('task_grants.list', {
    description: '按 task_id 读取当前根的 TaskGrantV1；不能签发或撤销。',
    inputSchema: { task_id: z.string() }
  }, async ({ task_id }) => withDatabase(database, runtime, (db) => listTaskGrants(db, task_id, new Date(), runtime?.identity)));
}

function withDatabase<T>(database: () => DatabaseSync, runtime: ActiveWorkspaceRuntime | undefined, read: (db: DatabaseSync) => T) {
  if (runtime) return text(read(runtime.database));
  const db = database();
  try { return text(read(db)); }
  finally { db.close(); }
}
