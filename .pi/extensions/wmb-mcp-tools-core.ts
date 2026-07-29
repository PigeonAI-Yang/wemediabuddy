import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

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
const reportAgentProgress: ToolDefinition = {
  name: 'wmb_report_agent_progress',
  label: '汇报情报进度',
  description: '在来源开始、完成、失败、跳过以及机会形成时写入持久检查点。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string' }, phase: { type: 'string' }, currentSource: { type: 'string' },
      planned: { type: 'number' }, processed: { type: 'number' }, failed: { type: 'number' },
      verified: { type: 'number' }, saved: { type: 'number' }, opportunityCount: { type: 'number' },
      checkpoint: { type: 'object' }, message: { type: 'string' }, level: { type: 'string' }, clearControl: { type: 'boolean' }
    },
    required: ['taskId'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('agent_tasks.report_progress', {
      task_id: String(params.taskId), phase: params.phase, current_source: params.currentSource,
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
      author: { type: 'string' }
    },
    required: ['requestId', 'title', 'originalUrl', 'summary'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    const result = await callTool('sources.upsert_batch', {
      request_id: String(params.requestId ?? ''),
      items: [{
        title: String(params.title ?? ''),
        originalUrl: String(params.originalUrl ?? ''),
        summary: String(params.summary ?? ''),
        author: params.author ? String(params.author) : undefined,
        categories: ['Pi 协作'],
        keywords: ['Pi', 'WMB', 'MCP'],
        priority: 1,
        clientLabel: 'WMB built-in Pi'
      }]
    });
    return textResult(result);
  }
};


const savePlan: ToolDefinition = {
  name: 'wmb_save_plan',
  label: '保存 WMB 今日方案',
  description: '通过 WMB MCP 保存当日全部合格内容机会。每个机会必须引用已存在的 sourceIds，并按 SSS 到 F 评级。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
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
    required: ['requestId', 'planDate', 'summary', 'items'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('plans.save', {
      request_id: String(params.requestId ?? ''),
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
      requestId: { type: 'string' },
      canvasId: { type: 'string' },
      kind: { type: 'string', enum: ['node', 'relation'] },
      payload: { type: 'object' }
    },
    required: ['requestId', 'canvasId', 'kind', 'payload'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('knowledge.suggestion_create', {
      request_id: String(params.requestId ?? ''),
      canvas_id: String(params.canvasId ?? ''),
      kind: params.kind,
      payload: params.payload
    }));
  }
};

export const coreTools = [getWorkbench, getAgentTask, reportAgentProgress, searchSources, getSource, saveSource, savePlan, getKnowledgeContext, suggestKnowledge];
