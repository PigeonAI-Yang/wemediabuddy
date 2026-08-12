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
      clientLabel: params.clientLabel ? String(params.clientLabel) : 'WMB built-in Pi'
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
      clientLabel: { type: 'string' }
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

export const coreTools = [getWorkbench, getAgentTask, getTaskGrant, listTaskGrants, reportAgentProgress, searchSources, getSource, saveSource, savePlan, getKnowledgeContext, suggestKnowledge, judgeSources, restoreSource, updateSourceStatus];
