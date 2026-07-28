const url = process.env.WMB_MCP_URL;
if (!url) throw new Error('WMB_MCP_URL is required.');

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
};

async function request(method: string, params?: unknown, sessionId?: string): Promise<{ data: unknown; sessionId?: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  });
  if (!response.ok) throw new Error(`WMB MCP ${method} failed: ${response.status}`);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: '))!.slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

async function callTool(name: string, args: unknown): Promise<unknown> {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wmb-pi', version: '0.1.0' }
  });
  return (await request('tools/call', { name, arguments: args }, initialized.sessionId)).data;
}

function textResult(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
}

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
  description: '通过 WMB MCP 保存当日运营方案与 1-3 个内容机会。每个机会必须引用已存在的 sourceIds。',
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
            priority: { type: 'number' },
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

const saveCoreVersion: ToolDefinition = {
  name: 'wmb_save_core_version',
  label: '保存 WMB 核心初稿',
  description: '通过 WMB MCP 为内容项目保存一个核心正文版本。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      projectId: { type: 'string' },
      body: { type: 'string' }
    },
    required: ['requestId', 'projectId', 'body'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('content.save_version', {
      request_id: String(params.requestId ?? ''),
      project_id: String(params.projectId ?? ''),
      body: String(params.body ?? '')
    }));
  }
};
const getContent: ToolDefinition = {
  name: 'wmb_get_content',
  label: '读取 WMB 创作项目',
  description: '通过 WMB MCP 读取内容项目与版本。只读。',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  async execute() {
    return textResult(await callTool('content.get', {}));
  }
};

const getMetrics: ToolDefinition = {
  name: 'wmb_get_metrics',
  label: '读取发布指标快照',
  description: '通过 WMB MCP 读取指定发布记录的指标快照。只读。',
  parameters: {
    type: 'object',
    properties: { publicationId: { type: 'string' } },
    required: ['publicationId'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('metrics.get', { publication_id: String(params.publicationId ?? '') }));
  }
};

const getReviews: ToolDefinition = {
  name: 'wmb_get_reviews',
  label: '读取复盘',
  description: '通过 WMB MCP 读取发布复盘与方法结论。只读。',
  parameters: {
    type: 'object',
    properties: {
      publicationId: { type: 'string' },
      finalOnly: { type: 'boolean' }
    },
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('reviews.get', {
      publication_id: params.publicationId ? String(params.publicationId) : undefined,
      final_only: params.finalOnly === true
    }));
  }
};

const saveReview: ToolDefinition = {
  name: 'wmb_save_review',
  label: '保存复盘',
  description: '通过 WMB MCP 保存或定稿复盘。最终复盘必须引用真实 metricSnapshotIds，并包含 Keep/Stop/Change。',
  parameters: {
    type: 'object',
    properties: {
      requestId: { type: 'string' },
      publicationId: { type: 'string' },
      metricSnapshotIds: { type: 'array', items: { type: 'string' } },
      keep: { type: 'array', items: { type: 'string' } },
      stop: { type: 'array', items: { type: 'string' } },
      change: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      status: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' }
          },
          required: ['title', 'body'],
          additionalProperties: false
        }
      }
    },
    required: ['requestId', 'publicationId', 'metricSnapshotIds', 'keep', 'stop', 'change', 'status'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('reviews.save', {
      request_id: String(params.requestId ?? ''),
      publication_id: String(params.publicationId ?? ''),
      metric_snapshot_ids: params.metricSnapshotIds,
      keep: params.keep,
      stop: params.stop,
      change: params.change,
      summary: params.summary ? String(params.summary) : undefined,
      status: params.status === 'final' ? 'final' : 'draft',
      findings: params.findings
    }));
  }
};

export default function (pi: { registerTool(tool: ToolDefinition): void }) {
  pi.registerTool(getWorkbench);
  pi.registerTool(searchSources);
  pi.registerTool(getSource);
  pi.registerTool(saveSource);
  pi.registerTool(savePlan);
  pi.registerTool(saveCoreVersion);
  pi.registerTool(getContent);
  pi.registerTool(getMetrics);
  pi.registerTool(getReviews);
  pi.registerTool(saveReview);
}
