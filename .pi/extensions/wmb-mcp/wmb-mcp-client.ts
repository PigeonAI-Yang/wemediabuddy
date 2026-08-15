function mcpUrl(): string {
  const url = process.env.WMB_MCP_URL;
  if (!url) throw new Error('WMB_MCP_URL is required.');
  return url;
}

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
};

async function request(method: string, params?: unknown, sessionId?: string): Promise<{ data: unknown; sessionId?: string }> {
  const response = await fetch(mcpUrl(), {
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

export async function callTool(name: string, args: unknown): Promise<unknown> {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wmb-pi', version: '0.1.0' }
  });
  const params: Record<string, unknown> = { name, arguments: args };
  // WMB-5170 客户端身份接缝：只从环境派生 taskId+workerLeaseId（两者均非空才注入 _meta）。
  // callTool 只暴露 name/args，调用方无法覆盖 _meta；WMB-5172 执行器落地时负责设置这两个 env。
  const taskId = process.env.WMB_AGENT_TASK_ID;
  const workerLeaseId = process.env.WMB_WORKER_LEASE_ID;
  if (taskId && workerLeaseId) params._meta = { taskId, workerLeaseId };
  return (await request('tools/call', params, initialized.sessionId)).data;
}

export function textResult(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
}
