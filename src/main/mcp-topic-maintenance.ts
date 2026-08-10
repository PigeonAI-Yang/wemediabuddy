import { McpServer } from '@modelcontextprotocol/server';
import type { DatabaseSync } from 'node:sqlite';
import * as z from 'zod';
import { getTopicMaintenanceProposal, listTopicMaintenanceProposals } from './topic-maintenance.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export function registerTopicMaintenanceReadMcp(server: McpServer, database: () => DatabaseSync): void {
  server.registerTool('knowledge.topic_maintenance_list', {
    description: '只读主题整理提案台账，供桌助呈报与资料员核对。',
    inputSchema: { status: z.enum(['proposed', 'approved', 'rejected', 'stale']).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional() }
  }, async (input) => { const db = database(); try { return text(listTopicMaintenanceProposals(db, input)); } finally { db.close(); } });
  server.registerTool('knowledge.topic_maintenance_get', {
    description: '只读一个冻结的主题整理提案及完整 before/after。', inputSchema: { proposal_id: z.string() }
  }, async ({ proposal_id }) => { const db = database(); try { return text(getTopicMaintenanceProposal(db, proposal_id)); } finally { db.close(); } });
}
