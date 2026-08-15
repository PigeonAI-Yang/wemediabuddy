/**
 * WMB-5240：Wiki 操作工具（Pi 扩展面，本 worker：ImplementPiWikiActionExecutor）。
 * 与 src/main/mcp-wiki-actions.ts 注册的 MCP 工具一一对应（wmb_wiki_* 公共名）；
 * 每个工具经 MCP callTool 调用，写工具携带 authority（requestId/taskId/grantId/workerLeaseId）。
 * 只读工具（status/report/search/log/report）不需要 authority。
 */

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

const maintenanceStart: ToolDefinition = {
  name: 'wmb_wiki_maintenance_start',
  label: '启动全库维护',
  description: '启动（或幂等复用）「维护整个 Wiki」run。写命令 knowledge.maintenance，需要 task grant；重复 start 返回既有 run。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      batchLimit: { type: 'number' },
      maxTopicsPerSource: { type: 'number' },
      stallLimit: { type: 'number' }
    },
    required: ['requestId', 'taskId', 'grantId', 'workerLeaseId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    const payload = {
      ...authorityPayload(params),
      ...(typeof params.batchLimit === 'number' ? { batch_limit: params.batchLimit } : {}),
      ...(typeof params.maxTopicsPerSource === 'number' ? { max_topics_per_source: params.maxTopicsPerSource } : {}),
      ...(typeof params.stallLimit === 'number' ? { stall_limit: params.stallLimit } : {})
    };
    return textResult(await callTool('wiki.maintenance_start', payload));
  }
};

const maintenanceStatus: ToolDefinition = {
  name: 'wmb_wiki_maintenance_status',
  label: '读取维护状态',
  description: '读取全库维护 run 的实时状态（阶段/进度/checkpoint 摘要）。只读。',
  parameters: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('wiki.maintenance_status', { request_id: String(params.requestId ?? '') }));
  }
};

const maintenancePause: ToolDefinition = {
  name: 'wmb_wiki_maintenance_pause',
  label: '暂停全库维护',
  description: '暂停全库维护 run（批次边界生效）。写命令 knowledge.maintenance，需要 task grant。',
  parameters: {
    type: 'object',
    properties: authorityProperties,
    required: ['requestId', 'taskId', 'grantId', 'workerLeaseId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('wiki.maintenance_pause', authorityPayload(params)));
  }
};

const maintenanceResume: ToolDefinition = {
  name: 'wmb_wiki_maintenance_resume',
  label: '继续全库维护',
  description: '继续已暂停/失败的全库维护 run（沿 checkpoint 续跑）。写命令 knowledge.maintenance，需要 task grant。',
  parameters: {
    type: 'object',
    properties: authorityProperties,
    required: ['requestId', 'taskId', 'grantId', 'workerLeaseId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('wiki.maintenance_resume', authorityPayload(params)));
  }
};

const maintenanceReport: ToolDefinition = {
  name: 'wmb_wiki_maintenance_report',
  label: '读取维护报告',
  description: '读取最近一次全库维护 run 的持久最终报告。只读；无报告时返回 no_op。',
  parameters: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('wiki.maintenance_report', { request_id: String(params.requestId ?? '') }));
  }
};

const ingest: ToolDefinition = {
  name: 'wmb_wiki_ingest',
  label: '摄取 Wiki 资料',
  description: '单条/批量摄取资料（1..50 条；逐项结果；requestId 幂等；feedId 禁入）。写命令 sources.upsert_batch，需要 task grant。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            originalUrl: { type: 'string' },
            author: { type: 'string' },
            publishedAt: { type: 'string' },
            summary: { type: 'string' },
            categories: { type: 'array', items: { type: 'string' } },
            keywords: { type: 'array', items: { type: 'string' } },
            valueJudgment: { type: 'string' },
            ipRelevance: { type: 'string' },
            creationAngles: { type: 'string' },
            recommendedPlatforms: { type: 'array', items: { type: 'string' } },
            recommendedFormats: { type: 'array', items: { type: 'string' } },
            timeliness: { type: 'string' },
            priority: { type: 'number' },
            evidence: { type: 'string' },
            expectedRevision: { type: 'number' }
          },
          required: ['title', 'originalUrl'],
          additionalProperties: false
        },
        minItems: 1,
        maxItems: 50
      }
    },
    required: ['requestId', 'taskId', 'grantId', 'workerLeaseId', 'items'],
    additionalProperties: false
  },
  async execute(_id, params) {
    const items = Array.isArray(params.items) ? params.items.map((item) => {
      const raw = item as Record<string, unknown>;
      const out: Record<string, unknown> = {
        title: raw.title,
        original_url: raw.originalUrl
      };
      for (const key of ['author', 'publishedAt', 'summary', 'valueJudgment', 'ipRelevance', 'creationAngles', 'timeliness', 'evidence']) {
        if (raw[key] !== undefined) out[key === 'publishedAt' ? 'published_at' : key === 'valueJudgment' ? 'value_judgment' : key === 'ipRelevance' ? 'ip_relevance' : key === 'creationAngles' ? 'creation_angles' : key] = raw[key];
      }
      for (const key of ['categories', 'keywords', 'recommendedPlatforms', 'recommendedFormats']) {
        if (Array.isArray(raw[key])) out[key === 'recommendedPlatforms' ? 'recommended_platforms' : key === 'recommendedFormats' ? 'recommended_formats' : key] = raw[key];
      }
      if (typeof raw.priority === 'number') out.priority = raw.priority;
      if (typeof raw.expectedRevision === 'number') out.expected_revision = raw.expectedRevision;
      return out;
    }) : [];
    return textResult(await callTool('wiki.ingest', { ...authorityPayload(params), items }));
  }
};

const lint: ToolDefinition = {
  name: 'wmb_wiki_lint',
  label: '全局 Lint',
  description: 'run=true 执行一步有界全局 Lint（写命令 knowledge.lint，需要 task grant）；缺省只读返回 checkpoint 与未解决 Issue 计数。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      taskId: { type: 'string' },
      grantId: { type: 'string' },
      workerLeaseId: { type: 'string' },
      run: { type: 'boolean' }
    },
    required: ['requestId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    const run = params.run === true;
    const payload: Record<string, unknown> = { request_id: String(params.requestId ?? '') };
    if (run) {
      payload.task_id = String(params.taskId ?? '');
      payload.grant_id = String(params.grantId ?? '');
      payload.worker_lease_id = params.workerLeaseId ? String(params.workerLeaseId) : undefined;
      payload.run = true;
    }
    return textResult(await callTool('wiki.lint', payload));
  }
};

const search: ToolDefinition = {
  name: 'wmb_wiki_search',
  label: '搜索 Wiki',
  description: '统一全文搜索 Wiki/Note/Entity/Topic/Source/固定版本引用（WMB-5238 索引）。只读；空查询返回空页。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
      objectTypes: { type: 'array', items: { type: 'string' } }
    },
    required: ['requestId', 'query'],
    additionalProperties: false
  },
  async execute(_id, params) {
    const payload: Record<string, unknown> = { request_id: String(params.requestId ?? ''), query: String(params.query ?? '') };
    if (typeof params.limit === 'number') payload.limit = params.limit;
    if (Array.isArray(params.objectTypes)) payload.object_types = params.objectTypes;
    return textResult(await callTool('wiki.search', payload));
  }
};

const log: ToolDefinition = {
  name: 'wmb_wiki_log',
  label: '读取全局日志',
  description: '读取全局知识时间日志（分页；limit ≤ 100；cursor 不透明）。只读。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      eventType: { type: 'string' },
      objectType: { type: 'string' },
      objectId: { type: 'string' },
      topicId: { type: 'string' },
      scope: { type: 'string' },
      limit: { type: 'number' },
      cursor: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' }
    },
    required: ['requestId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    const payload: Record<string, unknown> = { request_id: String(params.requestId ?? '') };
    for (const key of ['eventType', 'objectType', 'objectId', 'topicId', 'scope', 'limit', 'cursor', 'before', 'after']) {
      if (params[key] !== undefined) payload[key === 'eventType' ? 'event_type' : key === 'objectType' ? 'object_type' : key === 'objectId' ? 'object_id' : key === 'topicId' ? 'topic_id' : key] = params[key];
    }
    return textResult(await callTool('wiki.log', payload));
  }
};

const report: ToolDefinition = {
  name: 'wmb_wiki_report',
  label: '读取维护报告',
  description: '读取最近一次全库维护 run 的持久最终报告。只读；无报告时返回 no_op。',
  parameters: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false
  },
  async execute(_id, params) {
    return textResult(await callTool('wiki.report', { request_id: String(params.requestId ?? '') }));
  }
};

export const wikiTools = [
  maintenanceStart,
  maintenanceStatus,
  maintenancePause,
  maintenanceResume,
  maintenanceReport,
  ingest,
  lint,
  search,
  log,
  report
];
