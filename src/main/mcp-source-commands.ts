import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { dispatchSourceUpsertBatch, dispatchLaneGate, dispatchLaneRestore } from './source-commands.ts';
import { updateKnowledgeSource } from './knowledge.ts';
import { readWorkspaceProfile } from './workspace-profiles.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { createCommandEnvelope } from './command-dispatcher.ts';
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


  server.registerTool('sources.lane_gate', {
    description: '赛道判定/移出资料库（soft archive）。judged_by=agent；irrelevant 必须 reason。返回 CommandReceiptV1。',
    inputSchema: {
      request_id: z.string(),
      judgments: z.array(z.object({
        sourceId: z.string(),
        decision: z.enum(['relevant', 'irrelevant']),
        reasonCode: z.enum(['off_lane_content','lifestyle_noise','ad_promotion','out_of_scope_region','duplicate_series','edge_ai_adjacent','official_source','editor_override','lane_relevant']),
        reason: z.string().optional(),
        expectedRevision: z.number().int(),
        confidence: z.number().optional()
      })).min(1),
      task_id: z.string(),
      grant_id: z.string(),
      worker_lease_id: z.string().optional(),
      workspace_lane: z.string().optional()
    }
  }, async ({ request_id, judgments, task_id, grant_id, worker_lease_id, workspace_lane }) => {
    try {
      const profile = readWorkspaceProfile(runtime.database);
      const lane = workspace_lane || profile?.intelligencePackId;
      if (!lane) throw Object.assign(new Error('工作空间尚未配置有效配方。'), { code: 'OFFICIAL_PACK_UNAVAILABLE' });
      const result = await dispatchLaneGate(runtime, {
        requestId: request_id,
        actor: worker_lease_id
          ? { type: 'pi', id: 'pi', label: 'Pi worker' }
          : { type: 'external_agent', id: 'mcp', label: 'External MCP Agent' },
        workspaceLane: lane,
        judgedBy: 'agent',
        judgments,
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

  server.registerTool('sources.lane_restore', {
    description: '恢复已移出资料（archived→active）。返回 CommandReceiptV1。',
    inputSchema: {
      request_id: z.string(),
      source_id: z.string(),
      expected_revision: z.number().int(),
      reason: z.string().optional(),
      task_id: z.string(),
      grant_id: z.string(),
      worker_lease_id: z.string().optional(),
      workspace_lane: z.string().optional()
    }
  }, async ({ request_id, source_id, expected_revision, reason, task_id, grant_id, worker_lease_id, workspace_lane }) => {
    try {
      const profile = readWorkspaceProfile(runtime.database);
      const lane = workspace_lane || profile?.intelligencePackId;
      if (!lane) throw Object.assign(new Error('工作空间尚未配置有效配方。'), { code: 'OFFICIAL_PACK_UNAVAILABLE' });
      const result = await dispatchLaneRestore(runtime, {
        requestId: request_id,
        actor: worker_lease_id
          ? { type: 'pi', id: 'pi', label: 'Pi worker' }
          : { type: 'external_agent', id: 'mcp', label: 'External MCP Agent' },
        sourceId: source_id,
        workspaceLane: lane,
        expectedRevision: expected_revision,
        reason,
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

  server.registerTool('sources.update_status', {
    description: '更新资料核验/管理状态（不改主题）。返回 CommandReceiptV1。',
    inputSchema: {
      request_id: z.string(),
      id: z.string(),
      expected_revision: z.number().int(),
      verification_status: z.enum(['pending', 'verified', 'disputed', 'rejected']).optional(),
      management_status: z.enum(['active', 'watching', 'expired', 'archived']).optional(),
      task_id: z.string(),
      grant_id: z.string(),
      worker_lease_id: z.string().optional()
    }
  }, async ({ request_id, id, expected_revision, verification_status, management_status, task_id, grant_id, worker_lease_id }) => {
    try {
      const envelope = createCommandEnvelope({
        workspaceId: runtime.identity.workspaceId,
        runtimeEpoch: runtime.identity.runtimeEpoch,
        command: 'sources.update_status',
        requestId: request_id,
        input: { id, expectedRevision: expected_revision, verificationStatus: verification_status, managementStatus: management_status },
        boundIdentity: { entityType: 'source_item', entityId: id },
        actor: worker_lease_id
          ? { type: 'pi', id: 'pi', label: 'Pi worker' }
          : { type: 'external_agent', id: 'mcp', label: 'External MCP Agent' },
        taskId: task_id,
        workerLeaseId: worker_lease_id,
        grantId: grant_id
      });
      const receipt = await runtime.dispatchCommand(envelope, () => {
        const data = updateKnowledgeSource(runtime.database, {
          id,
          expectedRevision: expected_revision,
          verificationStatus: verification_status,
          managementStatus: management_status
        }, false);
        return { data, entityType: 'source_item', entityId: id, afterRevision: data.revision, readback: data };
      });
      if (receipt.ok) broadcastDataChanged({ scopes: ['sources', 'library'], reason: 'source.update_status' });
      return text(receipt);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'COMMAND_FAILED';
      return text({ ok: false, data: null, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

}
