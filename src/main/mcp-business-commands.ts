import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { clearAgentTaskControl, getAgentTask, reportAgentTaskProgress } from './agent-tasks.ts';
import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import { createContentProjectWithVersion, saveCoreVersion, savePlatformVersion, type SavedCoreVersion, type SavedPlatformVersion } from './content.ts';
import {
  createContentProjectFromBrief,
  createCreativeBrief,
  createKnowledgeSuggestion,
  updateCreativeBrief
} from './knowledge-canvas.ts';
import { createKnowledgeDomain, recordKnowledgeBatch, updateKnowledgeDomain } from './knowledge.ts';
import { saveCurrentPlan, type PlanItemInput } from './planning.ts';
import { saveReview } from './reviews.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { assertPublishingPlatforms } from './workspace-profiles.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const actor = { type: 'external_agent' as const, id: 'mcp', label: 'External Agent' };
const authoritySchema = {
  request_id: z.string(),
  task_id: z.string(),
  grant_id: z.string(),
  worker_lease_id: z.string().optional()
};
type Authority = { request_id: string; task_id: string; grant_id: string; worker_lease_id?: string };
type SavedContentVersion = SavedCoreVersion | SavedPlatformVersion;
const authority = (input: Authority) => ({
  actor,
  taskId: input.task_id,
  grantId: input.grant_id,
  workerLeaseId: input.worker_lease_id
});

export function registerBusinessMutationMcp(server: McpServer, runtime: ActiveWorkspaceRuntime): void {
  server.registerTool('agent_tasks.report_progress', {
    description: '在每个来源开始、成功、失败或跳过后持久化进度和检查点；返回 CommandReceiptV1。',
    inputSchema: {
      ...authoritySchema,
      phase: z.string().optional(),
      current_source: z.string().optional(),
      planned: z.number().int().nonnegative().optional(),
      processed: z.number().int().nonnegative().optional(),
      failed: z.number().int().nonnegative().optional(),
      verified: z.number().int().nonnegative().optional(),
      saved: z.number().int().nonnegative().optional(),
      opportunity_count: z.number().int().nonnegative().optional(),
      checkpoint: z.record(z.string(), z.unknown()).optional(),
      message: z.string().optional(),
      level: z.enum(['info', 'warning']).optional(),
      clear_control: z.boolean().optional()
    }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, ...commandInput } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'agent_tasks.report_progress', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: commandInput, boundIdentity: { taskId: task_id }, entityType: 'agent_task',
      execute: (database, normalized) => {
        const reported = requireCommandResultData(reportAgentTaskProgress(database, task_id, {
          phase: normalized.phase,
          progress: {
            currentSource: normalized.current_source, planned: normalized.planned, processed: normalized.processed,
            failed: normalized.failed, verified: normalized.verified, saved: normalized.saved,
            opportunityCount: normalized.opportunity_count
          },
          checkpoint: normalized.checkpoint,
          message: normalized.message,
          level: normalized.level
        }));
        if (normalized.clear_control) clearAgentTaskControl(database, task_id);
        const data = normalized.clear_control ? getAgentTask(database, task_id) ?? reported : reported;
        return { data, entityId: task_id, readback: data };
      }
    }));
  });

  server.registerTool('knowledge.domain_create', {
    description: '原子创建长期领域和明确主题成员；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, title: z.string(), description: z.string().optional(), status: z.enum(['active', 'watching', 'dormant']).optional(), topic_ids: z.array(z.string()).optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, topic_ids, ...fields } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.domain_create', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { ...fields, topicIds: topic_ids }, boundIdentity: { entityType: 'knowledge_domain' }, entityType: 'knowledge_domain',
      execute: (database, normalized) => {
        const data = createKnowledgeDomain(database, normalized, false) as { id: string; revision: number };
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('knowledge.domain_update', {
    description: '按 revision 原子更新或归档长期领域；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, id: z.string(), expected_revision: z.number().int(), title: z.string().optional(), description: z.string().optional(), status: z.enum(['active', 'watching', 'dormant']).optional(), topic_ids: z.array(z.string()).optional(), archived: z.boolean().optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, expected_revision, topic_ids, ...fields } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.domain_update', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { ...fields, expectedRevision: expected_revision, topicIds: topic_ids }, boundIdentity: { domainId: input.id }, entityType: 'knowledge_domain',
      execute: (database, normalized) => {
        const data = updateKnowledgeDomain(database, normalized, false) as { id: string; revision: number };
        return { data, entityId: data.id, beforeRevision: expected_revision, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('knowledge.suggestion_create', {
    description: 'Pi 只创建待用户确认的画布节点或关系建议；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, canvas_id: z.string(), kind: z.enum(['node', 'relation']), payload: z.record(z.string(), z.unknown()) }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, canvas_id, ...fields } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.suggestion_create', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { requestId: request_id, canvasId: canvas_id, ...fields }, boundIdentity: { canvasId: canvas_id }, entityType: 'knowledge_suggestion',
      execute: (database, normalized) => {
        const data = createKnowledgeSuggestion(database, normalized);
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('knowledge.creative_brief_create', {
    description: '只用当前页或直接选择的画布节点创建一份可编辑简报；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, canvas_id: z.string(), node_ids: z.array(z.string()).min(1), selection_mode: z.enum(['current_page', 'selected']), title: z.string(), core_judgment: z.string(), why_now: z.string(), structure: z.array(z.string()).min(1), evidence_node_ids: z.array(z.string()) }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, canvas_id, node_ids, selection_mode, core_judgment, why_now, evidence_node_ids, ...fields } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.creative_brief_create', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { ...fields, canvasId: canvas_id, nodeIds: node_ids, selectionMode: selection_mode, coreJudgment: core_judgment, whyNow: why_now, evidenceNodeIds: evidence_node_ids },
      boundIdentity: { canvasId: canvas_id }, entityType: 'creative_brief',
      execute: (database, normalized) => {
        const data = createCreativeBrief(database, normalized) as { id: string; revision: number };
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('knowledge.creative_brief_update', {
    description: '按 revision 更新已有创作简报；证据仍必须属于原静态包；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, id: z.string(), expected_revision: z.number().int(), title: z.string(), core_judgment: z.string(), why_now: z.string(), structure: z.array(z.string()).min(1), evidence_node_ids: z.array(z.string()), status: z.enum(['draft', 'confirmed']).optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, expected_revision, core_judgment, why_now, evidence_node_ids, ...fields } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.creative_brief_update', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { ...fields, expectedRevision: expected_revision, coreJudgment: core_judgment, whyNow: why_now, evidenceNodeIds: evidence_node_ids },
      boundIdentity: { briefId: input.id }, entityType: 'creative_brief',
      execute: (database, normalized) => {
        const data = updateCreativeBrief(database, normalized) as { id: string; revision: number };
        return { data, entityId: data.id, beforeRevision: expected_revision, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('knowledge.creative_brief_create_project', {
    description: '从已确认创作简报原子创建内容项目和首版正文；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, brief_id: z.string(), expected_revision: z.number().int() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, brief_id, expected_revision } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.creative_brief_create_project', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { briefId: brief_id, expectedRevision: expected_revision }, boundIdentity: { briefId: brief_id }, entityType: 'content_project',
      execute: (database, normalized) => {
        const data = createContentProjectFromBrief(database, normalized) as { project?: { id?: string; revision?: number } };
        return { data, entityId: data.project?.id, beforeRevision: expected_revision, afterRevision: data.project?.revision, readback: data };
      }
    }));
  });

  server.registerTool('knowledge.record_batch', {
    description: '把已入库资料归入稳定主题并更新核验/管理状态；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, items: z.array(z.object({
      sourceId: z.string(), topic: z.object({ canonicalKey: z.string().optional(), title: z.string(), kind: z.enum(['theme', 'event']).optional(), summary: z.string().optional() }),
      relation: z.enum(['primary', 'supporting', 'background', 'contradicting']).optional(),
      verificationStatus: z.enum(['pending', 'verified', 'disputed', 'rejected']).optional(),
      managementStatus: z.enum(['active', 'watching', 'expired', 'archived']).optional()
    })).min(1) }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, items } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.record_batch', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { items }, boundIdentity: { entityType: 'knowledge_batch' }, entityType: 'knowledge_batch',
      execute: (database, normalized) => {
        const data = recordKnowledgeBatch(database, normalized, false);
        return { data, readback: data };
      }
    }));
  });

  server.registerTool('content.create', {
    description: '原子创建内容项目和首个核心版本；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, title: z.string(), body: z.string(), plan_item_id: z.string().optional(), source_ids: z.array(z.string()).optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_item_id, source_ids, ...fields } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'content.create', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { ...fields, planItemId: plan_item_id, sourceIds: source_ids }, boundIdentity: { planItemId: plan_item_id ?? null }, entityType: 'content_project',
      execute: (database, normalized) => {
        const data = createContentProjectWithVersion(database, normalized, false);
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('plans.save', {
    description: '保存完整当日运营方案；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, plan_date: z.string(), summary: z.string(), items: z.array(z.object({
      title: z.string(), priority: z.number().int().min(0).max(7), whyNow: z.string(), timeliness: z.string(), targetAudience: z.string(),
      angle: z.string(), pointOfView: z.string(), platforms: z.array(z.string()), formats: z.array(z.string()),
      titleGuidance: z.string(), openingGuidance: z.string(), structureGuidance: z.string(), effortEstimate: z.string(),
      sourceIds: z.array(z.string()).min(1), availableMaterials: z.array(z.string()).optional(), missingMaterials: z.array(z.string()).optional(),
      reviewIds: z.array(z.string()).optional(), methodFindingIds: z.array(z.string()).optional(), topicId: z.string().optional()
    })) }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_date, summary, items } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'plans.save', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planDate: plan_date, timezone: 'Asia/Shanghai', summary, items: items as PlanItemInput[] },
      boundIdentity: { planDate: plan_date }, entityType: 'plan',
      execute: (database, normalized) => {
        assertPublishingPlatforms(database, normalized.items.flatMap((item) => item.platforms));
        const data = saveCurrentPlan(database, normalized, false);
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('content.save_version', {
    description: '保存核心或平台版本；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, project_id: z.string(), body: z.string(), content_version_id: z.string().optional(), platform: z.enum(['x', 'xiaohongshu', 'wechat']).optional(), format: z.string().optional(), expected_revision: z.number().optional(), version_id: z.string().optional(), title: z.string().optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, project_id, content_version_id, expected_revision, version_id, ...fields } = input;
    const commandInput = { ...fields, projectId: project_id, contentVersionId: content_version_id, expectedRevision: expected_revision, versionId: version_id };
    return text(await dispatchBusinessCommand<typeof commandInput, SavedContentVersion>(runtime, {
      command: 'content.save_version', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: commandInput,
      boundIdentity: { projectId: project_id, versionId: version_id ?? null }, entityType: 'content_version',
      execute: (database, normalized) => {
        if (normalized.platform) {
          assertPublishingPlatforms(database, [normalized.platform]);
          const data = requireCommandResultData(savePlatformVersion(database, {
            projectId: normalized.projectId, contentVersionId: normalized.contentVersionId!, platform: normalized.platform,
            format: normalized.format!, title: normalized.title, body: normalized.body,
            expectedRevision: normalized.expectedRevision, id: normalized.versionId
          }));
          return { data, entityId: data.id, beforeRevision: normalized.versionId ? normalized.expectedRevision : undefined, afterRevision: data.revision, readback: data };
        }
        if (typeof normalized.expectedRevision !== 'number') {
          requireCommandResultData({ ok: false, data: null, error: { code: 'VALIDATION_ERROR', message: '核心版本写入必须提供 expected_revision。' } });
        }
        const data = requireCommandResultData(saveCoreVersion(database, {
          projectId: normalized.projectId, body: normalized.body, expectedRevision: normalized.expectedRevision!
        }, false));
        return { data, entityId: data.id, beforeRevision: normalized.expectedRevision, afterRevision: data.projectRevision, readback: data };
      }
    }));
  });

  server.registerTool('reviews.save', {
    description: '保存或定稿复盘；最终复盘必须引用真实指标快照并包含 Keep/Stop/Change；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, publication_id: z.string(), metric_snapshot_ids: z.array(z.string()).min(1), keep: z.array(z.string()).optional(), stop: z.array(z.string()).optional(), change: z.array(z.string()).optional(), summary: z.string().optional(), status: z.enum(['draft', 'final']).optional(), expected_revision: z.number().int().optional(), id: z.string().optional(), findings: z.array(z.object({ id: z.string().optional(), title: z.string(), body: z.string() })).optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, publication_id, metric_snapshot_ids, expected_revision, ...fields } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'reviews.save', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { ...fields, publicationId: publication_id, metricSnapshotIds: metric_snapshot_ids, expectedRevision: expected_revision },
      boundIdentity: { publicationId: publication_id, reviewId: input.id ?? null }, entityType: 'review',
      execute: (database, normalized) => {
        const data = requireCommandResultData(saveReview(database, normalized, false));
        return { data, entityId: data.id, beforeRevision: normalized.id ? normalized.expectedRevision : undefined, afterRevision: data.revision, readback: data };
      }
    }));
  });
}
