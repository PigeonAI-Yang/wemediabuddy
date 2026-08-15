import { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { getExecutionGrant, listExecutionGrants, type PreciseExecutionGrant } from './execution-grants.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export function registerExecutionGrantMcp(
  server: McpServer,
  database: () => DatabaseSync,
  runtime?: ActiveWorkspaceRuntime
): void {
  server.registerTool('execution_grants.get', {
    description: '读取当前根的 PreciseExecutionGrantV1 目标、身份与状态；不能签发或撤销。',
    inputSchema: { execution_grant_id: z.string() }
  }, async ({ execution_grant_id }) => withDatabase(database, runtime,
    (db) => getExecutionGrant(db, execution_grant_id, new Date(), runtime?.identity)));
  server.registerTool('execution_grants.list', {
    description: '读取当前根的 PreciseExecutionGrantV1 列表；可按 task/status 过滤，不能签发或撤销。',
    inputSchema: {
      task_id: z.string().nullable().optional(),
      status: z.enum(['active', 'consumed', 'revoked', 'expired', 'stale']).optional()
    }
  }, async ({ task_id, status }) => withDatabase(database, runtime, (db) => listExecutionGrants(db, {
    ...(task_id !== undefined ? { taskId: task_id } : {}),
    ...(status ? { status: status as PreciseExecutionGrant['status'] } : {})
  }, new Date(), runtime?.identity)));
}

function withDatabase<T>(database: () => DatabaseSync, runtime: ActiveWorkspaceRuntime | undefined, read: (db: DatabaseSync) => T) {
  if (runtime) return text(read(runtime.database));
  const db = database();
  try { return text(read(db)); }
  finally { db.close(); }
}
