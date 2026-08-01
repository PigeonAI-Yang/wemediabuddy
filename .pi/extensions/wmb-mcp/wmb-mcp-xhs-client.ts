function xhsMcpUrl(): string {
  const url = process.env.WMB_XHS_MCP_URL;
  if (!url) throw new Error('WMB_XHS_MCP_URL is required for Xiaohongshu tools.');
  return url;
}

async function request(method: string, params?: unknown, sessionId?: string): Promise<{ data: unknown; sessionId?: string }> {
  const response = await fetch(xhsMcpUrl(), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  });
  if (!response.ok) throw new Error(`XHS MCP ${method} failed: ${response.status}`);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: '))!.slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message || `${method} failed`);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

const ALLOWED = new Set([
  'check_login_status',
  'search_feeds',
  'get_feed_detail',
  'user_profile'
]);

export async function callXhsTool(name: string, args: unknown = {}): Promise<unknown> {
  if (!ALLOWED.has(name)) throw new Error(`Xiaohongshu tool not allowed: ${name}`);
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wmb-pi-xhs', version: '0.1.0' }
  });
  await fetch(xhsMcpUrl(), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(initialized.sessionId ? { 'mcp-session-id': initialized.sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }).catch(() => null);
  return (await request('tools/call', { name, arguments: args }, initialized.sessionId)).data;
}
