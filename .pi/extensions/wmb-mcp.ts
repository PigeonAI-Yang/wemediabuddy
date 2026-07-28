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

export default function (pi: { registerTool(tool: ToolDefinition): void }) {
  pi.registerTool(getWorkbench);
  pi.registerTool(searchSources);
  pi.registerTool(getSource);
  pi.registerTool(saveSource);
  pi.registerTool(getContent);
}
