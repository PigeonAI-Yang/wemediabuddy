import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { clearAgentTaskControl, getAgentTask, reportAgentTaskProgress } from './agent-tasks.ts';
import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import { getAsset, linkProjectAsset, markdownImageForAsset, registerStagedAsset, stageAssetBytes } from './assets.ts';
import { createContentProjectWithVersion, getContentProject, saveCoreVersion, savePlatformVersion, type SavedCoreVersion, type SavedPlatformVersion } from './content.ts';
import { finalizeDerivativeVersionInternal, saveDerivativeVersionInternal } from './content-derivative.ts';
import { submitPlanItemForReview, transitionPlanItem } from './planning-stage.ts';
import { ensurePlannerTask } from './planning-stage-intake.ts';
import { advanceApprovedPlanItem } from './daily-content-article.ts';
import { mergeSimilarCarryItems, upsertCarryFromPlanItem } from './ferment.ts';
import { shanghaiDate } from './ferment.ts';
import { isRoleId } from '../shared/agent-capabilities.ts';
function getTaskRole(database: import("node:sqlite").DatabaseSync, taskId?: string): string | null {
  if (!taskId) return null;
  try {
    const t = getAgentTask(database, taskId) as unknown as Record<string, unknown>;
    if (!t) return null;
    const ctxRole = (t as { contextRefs?: Record<string, unknown> }).contextRefs?.roleId as string | undefined;
    if (ctxRole && isRoleId(ctxRole)) return ctxRole;
    if ((t as { intent?: string }).intent === 'daily_judge') return 'planner';
    if ((t as { intent?: string }).intent === 'daily_scan') return 'reporter';
    if ((t as { intent?: string }).intent === 'research') return 'reporter';
    if ((t as { intent?: string }).intent === 'studio_draft') return 'writer';
    if ((t as { intent?: string }).intent === 'page_library') return 'librarian';
    return null;
  } catch { return null; }
}
function assertPlannerScoped(database: import("node:sqlite").DatabaseSync, callerTaskId: string | undefined, planItemId: string){
  if (!callerTaskId) return;
  const role = getTaskRole(database, callerTaskId);
  if (!role) throw Object.assign(new Error('TASK_SCOPE_BROADENED: planner task role not found'), { code: 'TASK_SCOPE_BROADENED' });
  if (role === 'desk') return;
  if (role !== 'planner') throw Object.assign(new Error('TASK_SCOPE_BROADENED: only planner scoped to its planItem can submit/request'), { code: 'TASK_SCOPE_BROADENED' });
  const task = getAgentTask(database, callerTaskId) as unknown as Record<string, unknown> | null;
  if (!task) throw Object.assign(new Error('TASK_SCOPE_BROADENED: planner task not found'), { code: 'TASK_SCOPE_BROADENED' });
  const refs = (task as { contextRefs?: Record<string, unknown> }).contextRefs ?? {};
  const ctxPlan = (refs as Record<string, unknown>).planItemId ?? (refs as Record<string, unknown>).plan_item_id ?? null;
  if (!ctxPlan || String(ctxPlan) !== String(planItemId)) {
    throw Object.assign(new Error('TASK_SCOPE_BROADENED: planner not scoped to this planItem'), { code: 'TASK_SCOPE_BROADENED' });
  }
}
function assertDeskOrOwner(database: import("node:sqlite").DatabaseSync, callerTaskId: string | undefined, actorType: string){
  if (actorType === 'owner_ui' || actorType === 'scheduler' || actorType === 'browser_adapter') return;
  if (!callerTaskId) throw Object.assign(new Error('TASK_SCOPE_BROADENED: desk required'), { code: 'TASK_SCOPE_BROADENED' });
  const role = getTaskRole(database, callerTaskId);
  if (role !== 'desk') throw Object.assign(new Error('TASK_SCOPE_BROADENED: only desk or Owner UI can approve/reject/rework/advance'), { code: 'TASK_SCOPE_BROADENED' });
}

import { reviewInvestigationResearch, saveInvestigationDirection, saveInvestigationOutline } from './project-investigation.ts';
import {
  createContentProjectFromBrief,
  createCreativeBrief,
  createKnowledgeSuggestion,
  updateCreativeBrief
} from './knowledge-canvas.ts';
import { createKnowledgeDomain, linkTopicSources, recordKnowledgeBatch, updateKnowledgeDomain } from './knowledge.ts';
import { wakePersistentKnowledgeJobs } from './knowledge-compile-trigger.ts';
import { createTopicMaintenanceProposal } from './topic-maintenance.ts';
import { saveCurrentPlan, type PlanItemInput } from './planning.ts';
import { saveReview } from './reviews.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { assertPublishingPlatforms } from './workspace-profiles.ts';
import { recordCreativeBriefUsage } from './knowledge-usage-integration.ts';
import { confirmMediaType } from './media-archive-fetch.ts';
import type { ContentMediaBindingDraft } from '../shared/media-bindings.ts';

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

/** First-pass Studio writers may only hand off research; no content/image mutation is permitted. Exempt via verified prohibited context only. */
export function assertStudioDraftResearchReady(runtime: Pick<ActiveWorkspaceRuntime, 'database'>, taskId: string, projectId?: string): void {
  const task = getAgentTask(runtime.database, taskId);
  if (!task) return;
  const refs = task.contextRefs as Record<string, unknown>;
  const gate = refs.researchGate as string | undefined;
  const mode = (refs.researchMode ?? refs.research_mode) as string | undefined;
  const intent = task.intent;
  const roleId = refs.roleId as string | undefined;
  if (gate === 'exempt') {
    const projectOk = !projectId || refs.projectId === projectId;
    const valid = intent === 'studio_draft' && roleId === 'writer' && mode === 'prohibited' && projectOk;
    if (!valid) {
      throw Object.assign(new Error('RESEARCH_GATE_EXEMPT_INVALID: 豁免上下文不匹配，禁止保存。'), {
        code: 'RESEARCH_GATE_EXEMPT_INVALID'
      });
    }
    return;
  }
  if (gate === 'required') {
    throw Object.assign(new Error('RESEARCH_REQUIRED: 当前核心初稿必须先完成外部研究交接，禁止保存正文或导入配图。'), {
      code: 'RESEARCH_REQUIRED'
    });
  }
}

const MAX_PROJECT_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg'
});

function decodeStrictBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('图片数据不是合法的 base64。');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.byteLength === 0 || bytes.toString('base64') !== compact) throw new Error('图片数据不是合法的 base64。');
  return bytes;
}

function assertSafeSvg(svg: string): void {
  const trimmed = svg.trim();
  if (!/^<svg(?:\s|>)/i.test(trimmed)) throw new Error('SVG 必须以 <svg> 根元素开始。');
  if (/<(?:script|foreignObject|iframe|object|embed|audio|video)\b/i.test(trimmed)
    || /\son[a-z]+\s*=/i.test(trimmed)
    || /(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|file:|javascript:)/i.test(trimmed)
    || /<!DOCTYPE|<!ENTITY|@import|url\s*\(/i.test(trimmed)) {
    throw new Error('SVG 包含脚本、外部资源或不安全元素。');
  }
}

function projectImageBytes(input: { bytes_base64?: string; svg_text?: string; mime_type?: string; file_name?: string }): {
  bytes: Buffer; mimeType: string; fileName: string;
} {
  let bytes: Buffer;
  let declared = input.mime_type?.trim() || null;
  if (input.svg_text !== undefined) {
    assertSafeSvg(input.svg_text);
    bytes = Buffer.from(input.svg_text, 'utf8');
    declared = 'image/svg+xml';
  } else {
    bytes = decodeStrictBase64(input.bytes_base64 ?? '');
  }
  if (bytes.byteLength > MAX_PROJECT_IMAGE_BYTES) throw new Error('项目图片超过 20MB 大小上限。');
  const mimeType = confirmMediaType(bytes, 'image', declared);
  const extension = IMAGE_EXTENSION[mimeType];
  if (!extension) throw new Error(`不支持的项目图片格式：${mimeType}。`);
  const stem = (input.file_name?.trim() || 'project-image').replace(/\.[^.]+$/, '') || 'project-image';
  return { bytes, mimeType, fileName: `${stem}${extension}` };
}

export function readScopedPlanItem(
  database: import('node:sqlite').DatabaseSync,
  taskId: string,
  planItemId: string
): Record<string, unknown> {
  assertPlannerScoped(database, taskId, planItemId);
  const row = database.prepare('SELECT id, revision, planning_status, planning_provenance_json, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, score_reasons_json, topic_id, plan_id, sort_order, created_at, updated_at FROM plan_items WHERE id = ?').get(planItemId) as Record<string, unknown> | undefined;
  if (!row) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
  const parseJson = (value: unknown, fallback: unknown) => {
    try { return JSON.parse(String(value ?? (Array.isArray(fallback) ? '[]' : '{}'))); } catch { return fallback; }
  };
  return {
    id: row.id,
    revision: row.revision,
    planning_status: row.planning_status,
    planning_provenance: parseJson(row.planning_provenance_json, {}),
    title: row.title,
    priority: row.priority,
    why_now: row.why_now,
    timeliness: row.timeliness,
    target_audience: row.target_audience,
    angle: row.angle,
    point_of_view: row.point_of_view,
    platforms: parseJson(row.platforms_json, []),
    formats: parseJson(row.formats_json, []),
    title_guidance: row.title_guidance,
    opening_guidance: row.opening_guidance,
    structure_guidance: row.structure_guidance,
    effort_estimate: row.effort_estimate,
    source_ids: parseJson(row.source_ids_json, []),
    available_materials: parseJson(row.available_materials_json, []),
    missing_materials: parseJson(row.missing_materials_json, []),
    score_reasons: parseJson(row.score_reasons_json, {}),
    topic_id: row.topic_id,
    plan_id: row.plan_id,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}


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
        const data = createCreativeBrief(database, normalized) as { id: string; revision: number; contextNodeIds?: string[] };
        // WMB-5215：简报与固定知识血缘同一事务（usage 失败整体回滚）。
        recordCreativeBriefUsage(database, { briefId: data.id, contextNodeIds: data.contextNodeIds ?? [], reason: 'creative_brief_create' });
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
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'knowledge.record_batch', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { items }, boundIdentity: { entityType: 'knowledge_batch' }, entityType: 'knowledge_batch',
      execute: (database, normalized) => {
        const data = recordKnowledgeBatch(database, normalized, false);
        return { data, readback: data };
      }
    });
    if (receipt.ok) wakePersistentKnowledgeJobs();
    return text(receipt);
  });

  server.registerTool('knowledge.topic_maintenance_propose', {
    description: '资料员只创建冻结的主题整理提案；不会修改正式主题或关联。返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, supersedes_proposal_id: z.string().optional(), title: z.string(), reason: z.string(), changes: z.array(z.object({
      kind: z.enum(['create', 'update', 'merge', 'archive', 'reassign']), topicId: z.string().optional(), retainedTopicId: z.string().optional(), mergedTopicId: z.string().optional(),
      sourceId: z.string().optional(), fromTopicId: z.string().optional(), toTopicId: z.string().optional(), relation: z.string().optional(),
      after: z.object({ title: z.string(), canonicalKey: z.string().optional(), kind: z.enum(['theme', 'event']).optional(), summary: z.string().nullable().optional(), status: z.enum(['active', 'watching', 'dormant', 'archived']).optional() }).optional()
    })).min(1) }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, supersedes_proposal_id, ...commandInput } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.topic_maintenance_propose', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { ...commandInput, supersedesProposalId: supersedes_proposal_id, taskId: task_id }, boundIdentity: { entityType: 'topic_maintenance_proposal' }, entityType: 'topic_maintenance_proposal',
      execute: (database, normalized) => { const data = createTopicMaintenanceProposal(database, normalized as Parameters<typeof createTopicMaintenanceProposal>[1]); return { data, entityId: data.id, afterRevision: data.revision, readback: data }; }
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
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'plans.save', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planDate: plan_date, timezone: 'Asia/Shanghai', summary, items: items as PlanItemInput[] },
      boundIdentity: { planDate: plan_date }, entityType: 'plan',
      execute: (database, normalized) => {
        assertPublishingPlatforms(database, normalized.items.flatMap((item) => item.platforms));
        const data = saveCurrentPlan(database, normalized, false);
        return { data, entityId: data.id, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) wakePersistentKnowledgeJobs();
    return text(receipt);
  });

  // WMB-5351 plan_item.* commands
  server.registerTool('plan_item.request_planning', {
    description: '为草稿确保一项 Planner 工单；幂等复用活动任务',
    inputSchema: { ...authoritySchema, plan_item_id: z.string(), expected_revision: z.number().int().optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_item_id } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'plan_item.request_planning', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planItemId: plan_item_id }, boundIdentity: { planItemId: plan_item_id }, entityType: 'plan_item',
      execute: (database, normalized) => {
        assertPlannerScoped(database, task_id, normalized.planItemId);
        const row = database.prepare('SELECT id, planning_status, source_ids_json FROM plan_items WHERE id=?').get(normalized.planItemId) as { id:string; planning_status:string; source_ids_json:string }|undefined;
        if (!row) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
        if (row.planning_status !== 'draft' && row.planning_status !== 'rejected') throw Object.assign(new Error('conflict: only draft/rejected can request planning'), { code: 'conflict' });
        let sourceIds: string[] = [];
        try { sourceIds = JSON.parse(row.source_ids_json || '[]') as string[]; } catch {}
        const result = ensurePlannerTask(database, { planItemId: normalized.planItemId, sourceIds, requestId: request_id });
        return { data: { planItemId: normalized.planItemId, taskId: result.taskId, jobId: result.jobId, reused: !result.created }, entityId: normalized.planItemId, readback: { taskId: result.taskId, jobId: result.jobId, reused: !result.created } };
      }
    }));
  });

  server.registerTool('plan_item.get', {
    description: '只读获取当前 Planner 任务精确绑定的冻结 plan_item；不需要写授权，不产生业务写入。',
    inputSchema: { task_id: z.string(), plan_item_id: z.string() }
  }, async ({ task_id, plan_item_id }) => text(readScopedPlanItem(runtime.database, task_id, plan_item_id)));

  server.registerTool('plan_item.submit', {
    description: '提交既有草稿/驳回项为待审',
    inputSchema: { ...authoritySchema, plan_item_id: z.string(), expected_revision: z.number().int(), title: z.string().optional(), why_now: z.string().optional(), timeliness: z.string().optional(), target_audience: z.string().optional(), angle: z.string().optional(), point_of_view: z.string().optional(), platforms: z.array(z.string()).optional(), formats: z.array(z.string()).optional(), opening_guidance: z.string().optional(), structure_guidance: z.string().optional(), source_ids: z.array(z.string()).optional(), available_materials: z.array(z.string()).optional(), missing_materials: z.array(z.string()).optional(), score_reasons: z.record(z.string(), z.unknown()).optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_item_id, expected_revision, ...rest } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'plan_item.submit', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planItemId: plan_item_id, expectedRevision: expected_revision, item: rest }, boundIdentity: { planItemId: plan_item_id }, entityType: 'plan_item',
      execute: (database, normalized) => {
        const command = normalized as { planItemId: string; expectedRevision: number };
        assertPlannerScoped(database, task_id, command.planItemId);
        const existing = database.prepare('SELECT * FROM plan_items WHERE id=?').get(command.planItemId) as Record<string, unknown> | undefined;
        if (!existing) throw Object.assign(new Error('plan_item_not_found'), { code: 'NOT_FOUND' });
        const item: Parameters<typeof submitPlanItemForReview>[1]['item'] = {
          title: rest.title ?? existing.title as string,
          whyNow: rest.why_now ?? existing.why_now as string,
          timeliness: rest.timeliness ?? existing.timeliness as string,
          targetAudience: rest.target_audience ?? existing.target_audience as string,
          angle: rest.angle ?? existing.angle as string,
          pointOfView: rest.point_of_view ?? existing.point_of_view as string,
          platforms: rest.platforms ?? JSON.parse((existing.platforms_json as string) || '[]'),
          formats: rest.formats ?? JSON.parse((existing.formats_json as string) || '[]'),
          titleGuidance: existing.title_guidance as string ?? '',
          openingGuidance: rest.opening_guidance ?? existing.opening_guidance as string,
          structureGuidance: rest.structure_guidance ?? existing.structure_guidance as string,
          effortEstimate: existing.effort_estimate as string ?? '',
          sourceIds: rest.source_ids ?? JSON.parse((existing.source_ids_json as string) || '[]'),
          availableMaterials: rest.available_materials ?? JSON.parse((existing.available_materials_json as string) || '[]'),
          missingMaterials: rest.missing_materials ?? JSON.parse((existing.missing_materials_json as string) || '[]'),
          scoreReasons: rest.score_reasons ?? JSON.parse((existing.score_reasons_json as string) || '{}'),
          topicId: existing.topic_id as string | null ?? null,
          priority: existing.priority as number ?? 0
        };
        const submitBy = task_id ? (getTaskRole(database, task_id) || 'planner') : 'planner';
        const result = submitPlanItemForReview(database, { planItemId: command.planItemId, expectedRevision: command.expectedRevision, item, by: submitBy });
        return { data: result, entityId: command.planItemId, beforeRevision: command.expectedRevision, afterRevision: result.revision, readback: result };
      }
    }));
  });

  server.registerTool('plan_item.approve', {
    description: '内部批准策划',
    inputSchema: { ...authoritySchema, plan_item_id: z.string(), expected_revision: z.number().int(), reason: z.string().optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_item_id, expected_revision, reason } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'plan_item.approve', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planItemId: plan_item_id, expectedRevision: expected_revision, reason }, boundIdentity: { planItemId: plan_item_id }, entityType: 'plan_item',
      execute: (database, normalized) => {
        const command = normalized as { planItemId: string; expectedRevision: number; reason?: string };
        assertDeskOrOwner(database, task_id, task_id ? 'pi' : 'owner_ui');
        const byActor = task_id ? (getTaskRole(database, task_id) || 'desk') : 'owner_ui';
        const result = transitionPlanItem(database, { planItemId: command.planItemId, expectedRevision: command.expectedRevision, expectedStatus: 'ready_for_review', toStatus: 'approved', by: byActor, reason: command.reason ?? 'approve' });
        const item = database.prepare('SELECT topic_id, title, priority, timeliness, source_ids_json, plan_id FROM plan_items WHERE id=?').get(command.planItemId) as { topic_id:string|null; title:string; priority:number; timeliness:string; source_ids_json:string; plan_id:string }|undefined;
        if (item) {
          if (item.topic_id) {
            const sids = JSON.parse(item.source_ids_json || '[]') as string[];
            linkTopicSources(database, item.topic_id, sids, new Date().toISOString());
          }
          try {
            const plan = database.prepare('SELECT plan_date FROM plans WHERE id=?').get(item.plan_id) as { plan_date:string }|undefined;
            const planDate = plan?.plan_date ?? shanghaiDate();
            upsertCarryFromPlanItem(database, { planItemId: command.planItemId, title: item.title, priority: item.priority, timeliness: item.timeliness, topicId: item.topic_id ?? null, sourceIds: JSON.parse(item.source_ids_json || '[]') as string[], originPlanDate: planDate, reason: `已批准: ${item.title}` });
            mergeSimilarCarryItems(database);
          } catch {}
        }
        let advance: ReturnType<typeof advanceApprovedPlanItem> | null = null;
        try { advance = advanceApprovedPlanItem(database, command.planItemId); } catch {}
        const data = { ...result, advance };
        return { data, entityId: command.planItemId, beforeRevision: command.expectedRevision, afterRevision: result.revision, readback: data };
      }
    }));
  });

  server.registerTool('plan_item.reject', {
    description: '内部驳回策划',
    inputSchema: { ...authoritySchema, plan_item_id: z.string(), expected_revision: z.number().int(), reason: z.string().min(1) }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_item_id, expected_revision, reason } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'plan_item.reject', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planItemId: plan_item_id, expectedRevision: expected_revision, reason }, boundIdentity: { planItemId: plan_item_id }, entityType: 'plan_item',
      execute: (database, normalized) => {
        const command = normalized as { planItemId: string; expectedRevision: number; reason: string };
        assertDeskOrOwner(database, task_id, task_id ? 'pi' : 'owner_ui');
        if (!command.reason.trim()) throw Object.assign(new Error('validation_failed: reason_required'), { code: 'validation_failed' });
        const byActor = task_id ? (getTaskRole(database, task_id) || 'desk') : 'owner_ui';
        const result = transitionPlanItem(database, { planItemId: command.planItemId, expectedRevision: command.expectedRevision, expectedStatus: 'ready_for_review', toStatus: 'rejected', by: byActor, reason: command.reason });
        return { data: result, entityId: command.planItemId, beforeRevision: command.expectedRevision, afterRevision: result.revision, readback: result };
      }
    }));
  });

  server.registerTool('plan_item.rework', {
    description: '驳回后退回草稿',
    inputSchema: { ...authoritySchema, plan_item_id: z.string(), expected_revision: z.number().int(), reason: z.string().optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_item_id, expected_revision, reason } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'plan_item.rework', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planItemId: plan_item_id, expectedRevision: expected_revision, reason }, boundIdentity: { planItemId: plan_item_id }, entityType: 'plan_item',
      execute: (database, normalized) => {
        const command = normalized as { planItemId: string; expectedRevision: number; reason?: string };
        assertDeskOrOwner(database, task_id, task_id ? 'pi' : 'owner_ui');
        const byActor = task_id ? (getTaskRole(database, task_id) || 'desk') : 'owner_ui';
        const result = transitionPlanItem(database, { planItemId: command.planItemId, expectedRevision: command.expectedRevision, expectedStatus: 'rejected', toStatus: 'draft', by: byActor, reason: command.reason ?? 'rework' });
        return { data: result, entityId: command.planItemId, beforeRevision: command.expectedRevision, afterRevision: result.revision, readback: result };
      }
    }));
  });

  server.registerTool('plan_item.advance', {
    description: '统一生产推进（幂等）',
    inputSchema: { ...authoritySchema, plan_item_id: z.string() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, plan_item_id } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'plan_item.advance', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { planItemId: plan_item_id }, boundIdentity: { planItemId: plan_item_id }, entityType: 'plan_item',
      execute: (database, normalized) => {
        assertDeskOrOwner(database, task_id, task_id ? 'pi' : 'owner_ui');
        const data = advanceApprovedPlanItem(database, normalized.planItemId);
        return { data: data as unknown as Record<string, unknown>, entityId: normalized.planItemId, readback: data };
      }
    }));
  });

  server.registerTool('content.import_image', {
    description: '把外部生成或已有图片导入指定内容项目，返回 asset 与可插入正文的 Markdown；授权复用 content.save_version。',
    inputSchema: z.object({
      ...authoritySchema,
      project_id: z.string(),
      bytes_base64: z.string().max(28_000_000).optional(),
      svg_text: z.string().max(512_000).optional(),
      mime_type: z.string().optional(),
      file_name: z.string().optional(),
      alt: z.string().optional()
    }).strict().refine((input) => Number(input.bytes_base64 !== undefined) + Number(input.svg_text !== undefined) === 1, {
      message: 'bytes_base64 与 svg_text 必须且只能提供一个。'
    })
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, project_id } = input;
    assertStudioDraftResearchReady(runtime, task_id, project_id);
    const decoded = projectImageBytes(input);
    const staged = await stageAssetBytes(runtime.identity.rootPath, {
      bytes: decoded.bytes,
      mimeType: decoded.mimeType,
      origin: 'mcp-project-image'
    });
    const alt = (input.alt?.trim() || decoded.fileName).replace(/\.[^.]+$/, '') || '图片';
    const commandInput = { projectId: project_id, sha256: staged.sha256, fileName: decoded.fileName, alt };
    return text(await dispatchBusinessCommand<typeof commandInput, { asset: NonNullable<ReturnType<typeof getAsset>>; markdown: string; reused: boolean }>(runtime, {
      command: 'content.save_version', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: commandInput,
      boundIdentity: { projectId: project_id, sha256: staged.sha256 }, entityType: 'asset',
      execute: (database, normalized) => {
        if (!getContentProject(database, normalized.projectId)) throw new Error('内容项目不存在。');
        const imported = registerStagedAsset(database, staged);
        linkProjectAsset(database, normalized.projectId, imported.id);
        const asset = getAsset(database, imported.id);
        if (!asset) throw new Error('素材写入后读取失败。');
        const data = { asset, markdown: markdownImageForAsset(asset, normalized.alt), reused: imported.reused };
        return { data, entityId: asset.id, afterRevision: 1, readback: data };
      }
    }));
  });

  const contentBindingSchema = z.object({
    asset_id: z.string(),
    occurrence: z.number().int().nonnegative(),
    width_preset: z.enum(['small', 'medium', 'large', 'full']),
    align: z.enum(['left', 'center', 'right']),
    caption: z.string().nullable().optional(),
    link_url: z.string().nullable().optional(),
    media_kind: z.enum(['image', 'video', 'video_poster']).optional()
  }).strict();

  server.registerTool('content.save_version', {
    description: '保存核心或平台版本；核心版本可同时保存项目标题与图片绑定；返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, project_id: z.string(), body: z.string(), content_version_id: z.string().optional(), platform: z.enum(['x', 'xiaohongshu', 'wechat', 'zhihu']).optional(), format: z.string().optional(), expected_revision: z.number().optional(), version_id: z.string().optional(), title: z.string().optional(), media_bindings: z.array(contentBindingSchema).max(24).optional() }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, project_id, content_version_id, expected_revision, version_id, media_bindings, ...fields } = input;
    assertStudioDraftResearchReady(runtime, task_id, project_id);
    const commandInput = {
      ...fields,
      projectId: project_id,
      contentVersionId: content_version_id,
      expectedRevision: expected_revision,
      versionId: version_id,
      mediaBindings: media_bindings?.map((binding): ContentMediaBindingDraft => ({
        assetId: binding.asset_id,
        occurrence: binding.occurrence,
        widthPreset: binding.width_preset,
        align: binding.align,
        caption: binding.caption,
        linkUrl: binding.link_url,
        mediaKind: binding.media_kind
      }))
    };
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
          projectId: normalized.projectId, title: normalized.title, body: normalized.body,
          expectedRevision: normalized.expectedRevision!, mediaBindings: normalized.mediaBindings
        }, false));
        return { data, entityId: data.id, beforeRevision: normalized.expectedRevision, afterRevision: data.projectRevision, readback: data };
      }
    }));
  });

  const formatDecisionSchema = z.object({
    goal: z.string().min(1),
    audience: z.string().min(1),
    suitableForm: z.string().min(1),
    reason: z.string().min(12),
    durationRange: z.string().min(1).optional(),
    narrativeStructure: z.string().min(1),
    visualDensity: z.string().min(1),
    paceAndTone: z.string().min(1),
    needsPresence: z.boolean().optional(),
    needsDemo: z.boolean().optional()
  }).strict();

  server.registerTool('content_derivative.save_version', {
    description: '基于指定文章定稿版本保存并定稿一份视频文案；写入不可变衍生版本并返回 ready 版本。',
    inputSchema: {
      ...authoritySchema,
      project_id: z.string(),
      source_content_version_id: z.string(),
      title: z.string().min(1),
      body: z.string().min(1),
      format_decision: formatDecisionSchema,
      author: z.string().optional()
    }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, project_id, source_content_version_id, title, body, format_decision, author } = input;
    const commandInput = {
      projectId: project_id,
      sourceContentVersionId: source_content_version_id,
      title,
      body,
      formatDecisionJson: JSON.stringify(format_decision),
      author: author ?? 'ai'
    };
    return text(await dispatchBusinessCommand<typeof commandInput, Record<string, unknown>>(runtime, {
      command: 'content_derivative.save_version',
      requestId: request_id,
      ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: commandInput,
      boundIdentity: { projectId: project_id, sourceContentVersionId: source_content_version_id },
      entityType: 'content_derivative_version',
      execute: (database, normalized) => {
        const draft = saveDerivativeVersionInternal(database, normalized) as { version_number: number };
        const data = finalizeDerivativeVersionInternal(database, { projectId: normalized.projectId, expectedLatestVersionNumber: Number(draft.version_number) }) as Record<string, unknown>;
        return { data, entityId: String(data.id), readback: data };
      }
    }));
  });

  const investigationOutlineSchema = z.object({
    scope: z.string().min(1),
    exclusions: z.array(z.string()).default([]),
    known: z.array(z.string()).default([]),
    hypotheses: z.array(z.string()).default([]),
    questions: z.array(z.string()).min(1),
    dimensions: z.array(z.string()).default([]),
    material_requirements: z.array(z.string()).default([]),
    truth_risks: z.array(z.string()).default([]),
    disconfirming_conditions: z.array(z.string()).default([]),
    completion_criteria: z.array(z.string()).default([])
  }).strict();

  const investigationDirectionSchema = z.object({
    key_facts: z.array(z.string()).default([]),
    upheld: z.array(z.string()).default([]),
    changed: z.array(z.string()).default([]),
    discoveries: z.array(z.string()).default([]),
    unknowns: z.array(z.string()).default([]),
    recommendation: z.enum(['continue', 'adjust', 'redirect', 'stop']),
    core_question: z.string().min(1),
    audience_value: z.string().min(1),
    scope: z.string().min(1),
    constraints: z.array(z.string()).default([])
  }).strict();

  // WMB-5290：主管（desk）通过 MCP 保存调查提纲、验收资料包并保存写作方向草稿（读用 investigation.get；
  // 两次 Owner 审批保持 UI IPC，不暴露给外部 Agent）。
  server.registerTool('investigation.outline_save', {
    description: 'WMB-5290 主管保存调查提纲草稿（项目专项调查；每次保存形成新版本，审批前可反复修订；未经 Owner 确认不得派记者）。返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, project_id: z.string().min(1), expected_revision: z.number().int(), outline: investigationOutlineSchema }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, project_id, expected_revision, outline } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'investigation.outline_save', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: {
        projectId: project_id,
        expectedRevision: expected_revision,
        outline: {
          scope: outline.scope,
          exclusions: outline.exclusions,
          known: outline.known,
          hypotheses: outline.hypotheses,
          questions: outline.questions,
          dimensions: outline.dimensions,
          materialRequirements: outline.material_requirements,
          truthRisks: outline.truth_risks,
          disconfirmingConditions: outline.disconfirming_conditions,
          completionCriteria: outline.completion_criteria
        }
      },
      boundIdentity: { entityType: 'content_project', entityId: project_id }, entityType: 'project_investigation',
      execute: (database, normalized) => {
        const data = requireCommandResultData(saveInvestigationOutline(database, normalized));
        return { data, entityId: project_id, beforeRevision: expected_revision, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('investigation.review_research', {
    description: '主管验收已交付的专项调查资料包；accept 形成调查后写作方向并进入 Owner 第二次审批，资料不足或无法自行决策时用 defer 转为 needs_user 并等待 Owner。返回 CommandReceiptV1。',
    inputSchema: {
      ...authoritySchema,
      project_id: z.string().min(1),
      expected_revision: z.number().int(),
      decision: z.enum(['accept', 'defer']).default('accept'),
      direction: investigationDirectionSchema.optional(),
      summary: z.string().min(1).optional()
    }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, project_id, expected_revision, decision, direction, summary } = input;
    const reviewInput = decision === 'defer'
      ? {
        projectId: project_id,
        expectedRevision: expected_revision,
        decision: 'defer' as const,
        summary: summary ?? null,
        decidedBy: 'desk'
      }
      : {
        projectId: project_id,
        expectedRevision: expected_revision,
        decision: 'accept' as const,
        decidedBy: 'desk',
        direction: direction ? {
          keyFacts: direction.key_facts,
          upheld: direction.upheld,
          changed: direction.changed,
          discoveries: direction.discoveries,
          unknowns: direction.unknowns,
          recommendation: direction.recommendation,
          coreQuestion: direction.core_question,
          audienceValue: direction.audience_value,
          scope: direction.scope,
          constraints: direction.constraints
        } : undefined
      };
    return text(await dispatchBusinessCommand(runtime, {
      command: 'investigation.review_research', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: reviewInput,
      boundIdentity: { entityType: 'content_project', entityId: project_id }, entityType: 'project_investigation',
      execute: (database, normalized) => {
        const data = requireCommandResultData(reviewInvestigationResearch(database, normalized));
        return { data, entityId: project_id, beforeRevision: expected_revision, afterRevision: data.revision, readback: data };
      }
    }));
  });

  server.registerTool('investigation.direction_save', {
    description: 'WMB-5290 主管保存调查后写作方向草稿（资料包验收后形成；每次保存形成新版本；未经 Owner 确认不得派写手）。返回 CommandReceiptV1。',
    inputSchema: { ...authoritySchema, project_id: z.string().min(1), expected_revision: z.number().int(), direction: investigationDirectionSchema }
  }, async (input) => {
    const { request_id, task_id, grant_id, worker_lease_id, project_id, expected_revision, direction } = input;
    return text(await dispatchBusinessCommand(runtime, {
      command: 'investigation.direction_save', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: {
        projectId: project_id,
        expectedRevision: expected_revision,
        direction: {
          keyFacts: direction.key_facts,
          upheld: direction.upheld,
          changed: direction.changed,
          discoveries: direction.discoveries,
          unknowns: direction.unknowns,
          recommendation: direction.recommendation,
          coreQuestion: direction.core_question,
          audienceValue: direction.audience_value,
          scope: direction.scope,
          constraints: direction.constraints
        }
      },
      boundIdentity: { entityType: 'content_project', entityId: project_id }, entityType: 'project_investigation',
      execute: (database, normalized) => {
        const data = requireCommandResultData(saveInvestigationDirection(database, normalized));
        return { data, entityId: project_id, beforeRevision: expected_revision, afterRevision: data.revision, readback: data };
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
