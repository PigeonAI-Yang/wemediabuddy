import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { clearAgentTaskControl, getAgentTask, reportAgentTaskProgress } from './agent-tasks.ts';
import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import { getAsset, linkProjectAsset, markdownImageForAsset, registerStagedAsset, stageAssetBytes } from './assets.ts';
import { createContentProjectWithVersion, getContentProject, saveCoreVersion, savePlatformVersion, type SavedCoreVersion, type SavedPlatformVersion } from './content.ts';
import { reviewInvestigationResearch, saveInvestigationDirection, saveInvestigationOutline } from './project-investigation.ts';
import {
  createContentProjectFromBrief,
  createCreativeBrief,
  createKnowledgeSuggestion,
  updateCreativeBrief
} from './knowledge-canvas.ts';
import { createKnowledgeDomain, recordKnowledgeBatch, updateKnowledgeDomain } from './knowledge.ts';
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

/** First-pass Studio writers may only hand off research; no content/image mutation is permitted. */
export function assertStudioDraftResearchReady(runtime: Pick<ActiveWorkspaceRuntime, 'database'>, taskId: string): void {
  const task = getAgentTask(runtime.database, taskId);
  if (task?.intent === 'studio_draft' && task.contextRefs.researchGate === 'required') {
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
    return text(await dispatchBusinessCommand(runtime, {
      command: 'knowledge.record_batch', requestId: request_id, ...authority({ request_id, task_id, grant_id, worker_lease_id }),
      input: { items }, boundIdentity: { entityType: 'knowledge_batch' }, entityType: 'knowledge_batch',
      execute: (database, normalized) => {
        const data = recordKnowledgeBatch(database, normalized, false);
        return { data, readback: data };
      }
    }));
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
      execute: (database, normalized) => { const data = createTopicMaintenanceProposal(database, normalized as any); return { data, entityId: data.id, afterRevision: data.revision, readback: data }; }
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
    assertStudioDraftResearchReady(runtime, task_id);
    const decoded = projectImageBytes(input);
    const staged = await stageAssetBytes(runtime.identity.rootPath, {
      bytes: decoded.bytes,
      fileName: decoded.fileName,
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
    assertStudioDraftResearchReady(runtime, task_id);
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
