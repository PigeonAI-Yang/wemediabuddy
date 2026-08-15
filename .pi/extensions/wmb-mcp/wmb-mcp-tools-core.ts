import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

const authorityProperties = {
  requestId: { type: 'string' },
  taskId: { type: 'string' },
  grantId: { type: 'string' },
  workerLeaseId: { type: 'string' }
};
const authorityPayload = (params: Record<string, unknown>) => ({
  request_id: String(params.requestId ?? ''),
  task_id: String(params.taskId ?? ''),
  grant_id: String(params.grantId ?? ''),
  worker_lease_id: params.workerLeaseId ? String(params.workerLeaseId) : undefined
});

const getWorkbench: ToolDefinition = {
  name: 'wmb_get_workbench',
  label: '读取 WMB 工作台',
  description: '通过 WMB MCP 读取今日工作台：资料、当前方案和待办。只读，不写数据库。',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  async execute() {
    return textResult(await callTool('context.get_workbench', {}));
  }
};
const getAgentTask: ToolDefinition = {
  name: 'wmb_get_agent_task',
  label: '读取情报任务',
  description: '读取任务检查点、进度和用户控制；每个来源开始前必须调用。',
  parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  async execute(_toolCallId, params) {
    return textResult(await callTool('agent_tasks.get', { task_id: String(params.taskId) }));
  }
};

const getTaskGrant: ToolDefinition = {
  name: 'wmb_get_task_grant',
  label: '读取任务授权',
  description: '按 grantId 读取当前工作空间的任务授权。只读，不能签发或撤销。',
  parameters: { type: 'object', properties: { grantId: { type: 'string' } }, required: ['grantId'], additionalProperties: false },
  async execute(_toolCallId, params) {
    return textResult(await callTool('task_grants.get', { grant_id: String(params.grantId) }));
  }
};

const listTaskGrants: ToolDefinition = {
  name: 'wmb_list_task_grants',
  label: '列出任务授权',
  description: '按 taskId 列出当前工作空间的任务授权。只读，不能签发或撤销。',
  parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  async execute(_toolCallId, params) {
    return textResult(await callTool('task_grants.list', { task_id: String(params.taskId) }));
  }
};
const reportAgentProgress: ToolDefinition = {
  name: 'wmb_report_agent_progress',
  label: '汇报情报进度',
  description: '在来源开始、完成、失败、跳过以及机会形成时写入持久检查点。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      phase: { type: 'string' }, currentSource: { type: 'string' },
      planned: { type: 'number' }, processed: { type: 'number' }, failed: { type: 'number' },
      verified: { type: 'number' }, saved: { type: 'number' }, opportunityCount: { type: 'number' },
      checkpoint: { type: 'object' }, message: { type: 'string' }, level: { type: 'string' }, clearControl: { type: 'boolean' }
    },
    required: ['requestId', 'taskId', 'grantId'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('agent_tasks.report_progress', {
      ...authorityPayload(params),
      phase: params.phase, current_source: params.currentSource,
      planned: params.planned, processed: params.processed, failed: params.failed, verified: params.verified,
      saved: params.saved, opportunity_count: params.opportunityCount, checkpoint: params.checkpoint,
      message: params.message, level: params.level, clear_control: params.clearControl
    }));
  }
};

const searchSources: ToolDefinition = {
  name: 'wmb_search_sources',
  label: '搜索 WMB 资料',
  description: '通过 WMB MCP 搜索已入库资料。只读。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' }
    },
    required: ['query'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('sources.search', {
      query: String(params.query ?? ''),
      limit: typeof params.limit === 'number' ? params.limit : 20
    }));
  }
};

const getSource: ToolDefinition = {
  name: 'wmb_get_source',
  label: '读取 WMB 资料',
  description: '通过 WMB MCP 按 ID 读取一条完整资料。只读。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' }
    },
    required: ['id'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('sources.get', { id: String(params.id ?? '') }));
  }
};

/**
 * WMB-5172 / CAP-028 §6.4：wmb_save_source 证据写回载荷构造（纯函数，测试可注入）。
 * 扩展可选字段 publishedAt / excerpt / clientLabel（非研究任务不强制）：
 * - clientLabel='WMB research' 标记研究写回 → categories 标「研究补料」、author 必填、
 *   执行信封（taskId/grantId/workerLeaseId/requestId）必全（precise:false 仅免 Owner UI 型确认，
 *   不豁免既有交集约束）；其余调用保持既有语义零改动。
 * - excerpt 折入 evidence JSON（`{"excerpt": "<verbatim>"}`，既有 source_items.evidence 字段承载）。
 * - 无 feedId 通道：研究证据禁止挂渠道 feed（对象边界断言放行路径）。
 */
export function buildSaveSourcePayload(params: Record<string, unknown>): Record<string, unknown> {
  const research = params.clientLabel === 'WMB research';
  const author = params.author ? String(params.author) : undefined;
  if (research) {
    if (!author) throw new Error('RESEARCH_EVIDENCE_FIELDS_REQUIRED: 研究证据必须携带 title/originalUrl/summary/author 四项可核验字段。');
    if (!String(params.requestId ?? '').trim() || !String(params.taskId ?? '').trim()
      || !String(params.grantId ?? '').trim() || !String(params.workerLeaseId ?? '').trim()) {
      throw new Error('RESEARCH_ENVELOPE_REQUIRED: 研究写回必须携带完整执行信封（taskId/grantId/workerLeaseId/requestId）。');
    }
  }
  const excerpt = params.excerpt ? String(params.excerpt) : undefined;
  // WMB-5244 §7.4：可选结构化远程媒体候选（研究/记者保存时冻结发现的图片/视频槽位）。
  // 只透传数组形状；URL/scheme/限额的最终校验在服务端（sources.upsert_batch）执行，
  // 拒绝 file:/wmb-asset:/本地路径等非 http(s) 身份。空数组按「无候选」处理。
  const mediaCandidates = Array.isArray(params.mediaCandidates)
    ? (params.mediaCandidates as Array<Record<string, unknown>>).map((candidate) => {
        const mapped: Record<string, unknown> = {
          kind: candidate.kind,
          url: candidate.url
        };
        if (candidate.postKind !== undefined) mapped.postKind = candidate.postKind;
        if (candidate.parentUrl !== undefined) mapped.parentUrl = candidate.parentUrl;
        if (candidate.ordinal !== undefined) mapped.ordinal = candidate.ordinal;
        if (candidate.captionHint !== undefined) mapped.captionHint = candidate.captionHint;
        if (candidate.surroundingText !== undefined) mapped.surroundingText = candidate.surroundingText;
        return mapped;
      })
    : undefined;
  return {
    request_id: String(params.requestId ?? ''),
    task_id: String(params.taskId ?? ''),
    grant_id: String(params.grantId ?? ''),
    worker_lease_id: params.workerLeaseId ? String(params.workerLeaseId) : undefined,
    items: [{
      title: String(params.title ?? ''),
      originalUrl: String(params.originalUrl ?? ''),
      summary: String(params.summary ?? ''),
      author,
      publishedAt: params.publishedAt ? String(params.publishedAt) : undefined,
      evidence: excerpt ? JSON.stringify({ excerpt }) : undefined,
      categories: research ? ['研究补料'] : ['Pi 协作'],
      keywords: research ? ['research'] : ['Pi', 'WMB', 'MCP'],
      priority: 1,
      clientLabel: params.clientLabel ? String(params.clientLabel) : 'WMB built-in Pi',
      ...(mediaCandidates && mediaCandidates.length > 0 ? { mediaCandidates } : {})
    }]
  };
}

const saveSource: ToolDefinition = {
  name: 'wmb_save_source',
  label: '保存 WMB 资料',
  description: '通过 WMB MCP 保存一条可追溯资料。只能写 WMB 业务对象，不能写本地文件或数据库。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      title: { type: 'string' },
      originalUrl: { type: 'string' },
      summary: { type: 'string' },
      author: { type: 'string' },
      taskId: { type: 'string' },
      grantId: { type: 'string' },
      workerLeaseId: { type: 'string' },
      publishedAt: { type: 'string' },
      excerpt: { type: 'string' },
      clientLabel: { type: 'string' },
      mediaCandidates: {
        type: 'array',
        maxItems: 24,
        description: '可选结构化远程媒体候选（http(s) URL；服务端重新验证并拒绝 file:/wmb-asset:/本地路径）',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['image', 'video', 'video_poster'] },
            url: { type: 'string', maxLength: 2048 },
            postKind: { type: 'string', enum: ['tweet', 'repost', 'quote', 'web'] },
            parentUrl: { type: 'string', maxLength: 2048 },
            ordinal: { type: 'number', minimum: 0, maximum: 255 },
            captionHint: { type: 'string', maxLength: 500 },
            surroundingText: { type: 'string', maxLength: 2000 }
          },
          required: ['kind', 'url'],
          additionalProperties: false
        }
      }
    },
    required: ['requestId', 'taskId', 'grantId', 'workerLeaseId', 'title', 'originalUrl', 'summary'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('sources.upsert_batch', buildSaveSourcePayload(params)));
  }
};


const savePlan: ToolDefinition = {
  name: 'wmb_save_plan',
  label: '保存 WMB 今日方案',
  description: '通过 WMB MCP 保存当日全部合格内容机会。每个机会必须引用已存在的 sourceIds，并按 SSS 到 F 评级。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      planDate: { type: 'string' },
      summary: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            priority: { type: 'number', minimum: 0, maximum: 7 },
            whyNow: { type: 'string' },
            timeliness: { type: 'string' },
            targetAudience: { type: 'string' },
            angle: { type: 'string' },
            pointOfView: { type: 'string' },
            platforms: { type: 'array', items: { type: 'string' } },
            formats: { type: 'array', items: { type: 'string' } },
            titleGuidance: { type: 'string' },
            openingGuidance: { type: 'string' },
            structureGuidance: { type: 'string' },
            effortEstimate: { type: 'string' },
            sourceIds: { type: 'array', items: { type: 'string' } },
            availableMaterials: { type: 'array', items: { type: 'string' } },
            missingMaterials: { type: 'array', items: { type: 'string' } }
          },
          required: ['title', 'priority', 'whyNow', 'timeliness', 'targetAudience', 'angle', 'pointOfView', 'platforms', 'formats', 'titleGuidance', 'openingGuidance', 'structureGuidance', 'effortEstimate', 'sourceIds'],
          additionalProperties: false
        }
      }
    },
    required: ['requestId', 'taskId', 'grantId', 'planDate', 'summary', 'items'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('plans.save', {
      ...authorityPayload(params),
      plan_date: String(params.planDate ?? ''),
      summary: String(params.summary ?? ''),
      items: params.items
    }));
  }
};

const getKnowledgeContext: ToolDefinition = {
  name: 'wmb_get_knowledge_context', label: '读取历史知识',
  description: '按主题、资料或关键词读取历史资料、机会、内容、发布和复盘。',
  parameters: { type: 'object', properties: { topicId: { type: 'string' }, sourceId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
  async execute(_toolCallId, params) {
    return textResult(await callTool('knowledge.get_context', { topic_id: params.topicId, source_id: params.sourceId, query: params.query, limit: params.limit }));
  }
};

/** WMB-5240：固定版本 Query 读面（「基于这些版本回答」的只读入口）。 */
const getFixedVersions: ToolDefinition = {
  name: 'wmb_get_fixed_versions', label: '读取固定版本知识',
  description: '按固定版本引用（wiki_page:<pageId>:<versionId> / knowledge_note:<noteId>:<versionId> / evidence:<id>）或版本 id 读取冻结 Wiki 页版本、Note 版本与 Evidence（只读；版本删除、归属漂移或跨 workspace 一律 fail-closed 返回错误，零部分结果）。用户说「基于这些版本回答」时先调用本工具冻结读取指定版本，再基于返回内容回答，并可按 wmb_query_writeback 协议写回。',
  parameters: {
    type: 'object',
    properties: {
      wikiVersionRefs: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      noteVersionRefs: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      evidenceRefs: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      wikiVersionIds: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      noteVersionIds: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      question: { type: 'string' }
    },
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('knowledge.fixed_versions_get', {
      wiki_version_refs: params.wikiVersionRefs,
      note_version_refs: params.noteVersionRefs,
      evidence_refs: params.evidenceRefs,
      wiki_version_ids: params.wikiVersionIds,
      note_version_ids: params.noteVersionIds,
      evidence_ids: params.evidenceIds,
      question: params.question
    }));
  }
};

const suggestKnowledge: ToolDefinition = {
  name: 'wmb_suggest_knowledge', label: '建议知识节点或关系',
  description: '只创建待用户逐条确认的画布节点或关系建议；不得把建议描述成正式知识。requestId 重试安全。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      canvasId: { type: 'string' },
      kind: { type: 'string', enum: ['node', 'relation'] },
      payload: { type: 'object' }
    },
    required: ['requestId', 'taskId', 'grantId', 'canvasId', 'kind', 'payload'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('knowledge.suggestion_create', {
      ...authorityPayload(params),
      canvas_id: String(params.canvasId ?? ''),
      kind: params.kind,
      payload: params.payload
    }));
  }
};


const judgeSources: ToolDefinition = {
  name: 'wmb_judge_sources',
  label: '移出/判定资料',
  description: '赛道判定并软移出资料库（archived）。需 taskId/grantId/workerLeaseId。irrelevant 必须 reason。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      taskId: { type: 'string' },
      grantId: { type: 'string' },
      workerLeaseId: { type: 'string' },
      judgments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sourceId: { type: 'string' },
            decision: { type: 'string', enum: ['relevant', 'irrelevant'] },
            reasonCode: {
              type: 'string',
              enum: [
                'off_lane_content',
                'lifestyle_noise',
                'ad_promotion',
                'out_of_scope_region',
                'duplicate_series',
                'edge_ai_adjacent',
                'official_source',
                'editor_override',
                'lane_relevant'
              ]
            },
            reason: { type: 'string' },
            expectedRevision: { type: 'number' },
            confidence: { type: 'number' }
          },
          required: ['sourceId', 'decision', 'reasonCode', 'expectedRevision']
        }
      }
    },
    required: ['requestId', 'taskId', 'grantId', 'judgments'],
    additionalProperties: false
  },
  execute: async (_toolCallId, params) => textResult(await callTool('sources.lane_gate', {
    request_id: String(params.requestId ?? ''),
    task_id: String(params.taskId ?? ''),
    grant_id: String(params.grantId ?? ''),
    worker_lease_id: params.workerLeaseId ? String(params.workerLeaseId) : undefined,
    judgments: params.judgments
  }))
};

const restoreSource: ToolDefinition = {
  name: 'wmb_restore_source',
  label: '恢复资料',
  description: '恢复已移出资料。需 taskId/grantId/workerLeaseId 与 expectedRevision。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      taskId: { type: 'string' },
      grantId: { type: 'string' },
      workerLeaseId: { type: 'string' },
      sourceId: { type: 'string' },
      expectedRevision: { type: 'number' },
      reason: { type: 'string' }
    },
    required: ['requestId', 'taskId', 'grantId', 'sourceId', 'expectedRevision'],
    additionalProperties: false
  },
  execute: async (_toolCallId, params) => textResult(await callTool('sources.lane_restore', {
    request_id: String(params.requestId ?? ''),
    task_id: String(params.taskId ?? ''),
    grant_id: String(params.grantId ?? ''),
    worker_lease_id: params.workerLeaseId ? String(params.workerLeaseId) : undefined,
    source_id: String(params.sourceId ?? ''),
    expected_revision: Number(params.expectedRevision),
    reason: params.reason ? String(params.reason) : undefined
  }))
};

const updateSourceStatus: ToolDefinition = {
  name: 'wmb_update_source_status',
  label: '更新资料状态',
  description: '更新核验/管理状态（不改主题）。需 taskId/grantId/workerLeaseId。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      taskId: { type: 'string' },
      grantId: { type: 'string' },
      workerLeaseId: { type: 'string' },
      id: { type: 'string' },
      expectedRevision: { type: 'number' },
      verificationStatus: { type: 'string' },
      managementStatus: { type: 'string' }
    },
    required: ['requestId', 'taskId', 'grantId', 'id', 'expectedRevision'],
    additionalProperties: false
  },
  execute: async (_toolCallId, params) => textResult(await callTool('sources.update_status', {
    request_id: String(params.requestId ?? ''),
    task_id: String(params.taskId ?? ''),
    grant_id: String(params.grantId ?? ''),
    worker_lease_id: params.workerLeaseId ? String(params.workerLeaseId) : undefined,
    id: String(params.id ?? ''),
    expected_revision: Number(params.expectedRevision),
    verification_status: params.verificationStatus ? String(params.verificationStatus) : undefined,
    management_status: params.managementStatus ? String(params.managementStatus) : undefined
  }))
};

export const coreTools = [getWorkbench, getAgentTask, getTaskGrant, listTaskGrants, reportAgentProgress, searchSources, getSource, saveSource, savePlan, getKnowledgeContext, getFixedVersions, suggestKnowledge, judgeSources, restoreSource, updateSourceStatus];
