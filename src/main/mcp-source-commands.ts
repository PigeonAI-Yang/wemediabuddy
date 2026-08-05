import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { dispatchSourceUpsertBatch } from './source-commands.ts';
import type { SourceInput } from './sources.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const sourceInput = z.object({
  title: z.string(), feedId: z.string().optional(), originalUrl: z.string().optional(), author: z.string().optional(),
  publishedAt: z.string().optional(), summary: z.string().optional(), categories: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(), valueJudgment: z.string().optional(), ipRelevance: z.string().optional(),
  creationAngles: z.string().optional(), recommendedPlatforms: z.array(z.string()).optional(),
  recommendedFormats: z.array(z.string()).optional(), timeliness: z.string().optional(), priority: z.number().optional(),
  evidence: z.string().optional(), clientLabel: z.string().optional(), expectedRevision: z.number().int().optional()
});

export function registerSourceMutationMcp(server: McpServer, runtime: ActiveWorkspaceRuntime): void {
  server.registerTool('sources.upsert_batch', {
    description: '新增或更新资料；返回 CommandReceiptV1。同一 request_id 和输入重放原回执，异输入冲突。',
    inputSchema: {
      request_id: z.string(),
      items: z.array(sourceInput),
      task_id: z.string().optional(),
      worker_lease_id: z.string().optional(),
      grant_id: z.string().optional()
    }
  }, async ({ request_id, items, task_id, worker_lease_id, grant_id }) => {
    try {
      const result = await dispatchSourceUpsertBatch(runtime, {
        requestId: request_id,
        actor: worker_lease_id
          ? { type: 'pi', id: 'pi', label: 'Pi worker' }
          : { type: 'external_agent', id: 'mcp', label: 'External MCP Agent' },
        items: items as SourceInput[],
        taskId: task_id,
        workerLeaseId: worker_lease_id,
        grantId: grant_id
      });
      return text(result);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'COMMAND_FAILED';
      return text({ ok: false, data: null, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });
}
