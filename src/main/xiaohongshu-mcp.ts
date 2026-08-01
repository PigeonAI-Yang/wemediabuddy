import { createServer } from 'node:http';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type XhsReadiness =
  | 'not_started'
  | 'starting'
  | 'ready'
  | 'needs_user'
  | 'process_failed'
  | 'tool_mismatch';

export type XhsMcpStatus = {
  status: XhsReadiness;
  url: string | null;
  port: number | null;
  pid: number | null;
  runtimeDir: string | null;
  binaryPath: string | null;
  loginBinaryPath: string | null;
  cookiesPath: string | null;
  tools: string[];
  requiredToolsPresent: boolean;
  lastError: string | null;
  lastExitCode: number | null;
  lastStderr: string | null;
  updatedAt: string;
};

export type XhsMcpRuntime = {
  status: () => XhsMcpStatus;
  ensureReady: () => Promise<XhsMcpStatus>;
  stop: () => Promise<void>;
  startLogin: () => Promise<{ ok: boolean; pid?: number; error?: string }>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  getUrl: () => string | null;
};

export const XHS_REQUIRED_TOOLS = [
  'check_login_status',
  'search_feeds',
  'get_feed_detail',
  'user_profile'
] as const;

export const XHS_FORBIDDEN_TOOLS = [
  'publish_content',
  'publish_with_video',
  'post_comment_to_feed',
  'reply_comment_in_feed',
  'like_feed',
  'favorite_feed',
  'delete_cookies',
  'get_login_qrcode'
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function defaultVendorDir(): string {
  try {
    // Lazy require keeps unit tests free of Electron named-export loading.
    const electron = require('electron') as { app?: { isPackaged: boolean; getAppPath(): string } };
    if (electron.app?.isPackaged) return path.join(process.resourcesPath, 'xiaohongshu-mcp');
    if (electron.app?.getAppPath) return path.join(electron.app.getAppPath(), 'resources', 'xiaohongshu-mcp');
  } catch {
    // plain node tests / scripts
  }
  return path.join(process.cwd(), 'resources', 'xiaohongshu-mcp');
}

export function xhsRuntimeDir(dataRootPath: string): string {
  return path.join(dataRootPath, 'xiaohongshu-mcp');
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('无法分配 loopback 端口。'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function mcpRequest(
  url: string,
  method: string,
  params?: unknown,
  sessionId?: string | null
): Promise<{ data: unknown; sessionId: string | null }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  });
  if (!response.ok) throw new Error(`XHS MCP ${method} failed: HTTP ${response.status}`);
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split(/\r?\n/).find((line) => line.startsWith('data: '))!.slice(6))
    : JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message || `${method} error`);
  return {
    data: payload.result,
    sessionId: response.headers.get('mcp-session-id') ?? sessionId ?? null
  };
}

async function notifyInitialized(url: string, sessionId: string | null): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }).catch(() => null);
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError = 'not started';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { method: 'GET' });
      if (response.ok) return;
      lastError = `health HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`XHS MCP health timeout: ${lastError}`);
}

function toolNames(listResult: unknown): string[] {
  const tools = (listResult as { tools?: Array<{ name?: string }> } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => String(tool?.name || '')).filter(Boolean);
}

function interpretLoginPayload(data: unknown): boolean {
  const text = JSON.stringify(data ?? {});
  if (/未登录|not logged|login required|needs.?login|请先登录|no cookies|未检测到登录/i.test(text)) return false;
  if (/已登录|logged.?in|isLoggedIn\"?\s*:\s*true|login.?success/i.test(text)) return true;
  return false;
}

export async function startXhsMcp(
  dataRootPath: string,
  options: { vendorDir?: string } = {}
): Promise<XhsMcpRuntime> {
  const runtimeDir = xhsRuntimeDir(dataRootPath);
  await mkdir(path.join(runtimeDir, 'logs'), { recursive: true });
  const vendor = options.vendorDir || defaultVendorDir();
  const binaryPath = path.join(vendor, 'xiaohongshu-mcp-windows-amd64.exe');
  const loginBinaryPath = path.join(vendor, 'xiaohongshu-login-windows-amd64.exe');
  const cookiesPath = path.join(runtimeDir, 'cookies.json');
  if (!(await pathExists(binaryPath))) throw new Error(`缺少小红书 MCP 二进制：${binaryPath}`);
  if (!(await pathExists(loginBinaryPath))) throw new Error(`缺少小红书登录二进制：${loginBinaryPath}`);

  let child: ChildProcess | null = null;
  let port: number | null = null;
  let url: string | null = null;
  let tools: string[] = [];
  let status: XhsReadiness = 'not_started';
  let lastError: string | null = null;
  let lastExitCode: number | null = null;
  let lastStderr = '';
  let stopping = false;

  const snapshot = (): XhsMcpStatus => ({
    status,
    url,
    port,
    pid: child?.pid ?? null,
    runtimeDir,
    binaryPath,
    loginBinaryPath,
    cookiesPath,
    tools: [...tools],
    requiredToolsPresent: XHS_REQUIRED_TOOLS.every((name) => tools.includes(name)),
    lastError,
    lastExitCode,
    lastStderr: lastStderr.slice(-4000) || null,
    updatedAt: nowIso()
  });

  const stopChild = async (): Promise<void> => {
    stopping = true;
    const current = child;
    child = null;
    if (!current || current.exitCode !== null) {
      url = null;
      port = null;
      if (status === 'ready' || status === 'needs_user' || status === 'starting') status = 'not_started';
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { current.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 3000);
      current.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try { current.kill(); } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    url = null;
    port = null;
    if (status === 'ready' || status === 'needs_user' || status === 'starting') status = 'not_started';
  };

  const boot = async (): Promise<void> => {
    await stopChild();
    stopping = false;
    status = 'starting';
    lastError = null;
    tools = [];
    port = await reserveLoopbackPort();
    url = `http://127.0.0.1:${port}/mcp`;
    const logPath = path.join(runtimeDir, 'logs', `xhs-mcp-${Date.now()}.log`);
    const started = spawn(binaryPath, ['-port', `127.0.0.1:${port}`, '-headless=true'], {
      cwd: runtimeDir,
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = started;
    lastStderr = '';
    const append = (chunk: Buffer) => {
      lastStderr = `${lastStderr}${chunk.toString('utf8')}`.slice(-12000);
      void writeFile(logPath, lastStderr, 'utf8').catch(() => {});
    };
    started.stdout?.on('data', append);
    started.stderr?.on('data', append);
    started.once('exit', (code) => {
      lastExitCode = code;
      if (stopping) return;
      status = 'process_failed';
      lastError = `小红书 MCP 进程退出（code=${code ?? 'null'}）`;
      child = null;
      url = null;
      port = null;
    });

    try {
      await waitForHealth(port, 20_000);
      const initialized = await mcpRequest(url, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'wemedia-buddy', version: '0.1.0' }
      });
      await notifyInitialized(url, initialized.sessionId);
      const listed = await mcpRequest(url, 'tools/list', {}, initialized.sessionId);
      tools = toolNames(listed.data);
      const missing = XHS_REQUIRED_TOOLS.filter((name) => !tools.includes(name));
      if (missing.length) {
        status = 'tool_mismatch';
        lastError = `缺少固定读取工具：${missing.join(', ')}`;
        return;
      }
      try {
        const login = await Promise.race([
          mcpRequest(url, 'tools/call', { name: 'check_login_status', arguments: {} }, initialized.sessionId),
          delay(10_000).then(() => {
            throw new Error('check_login_status timeout');
          })
        ]);
        status = interpretLoginPayload(login.data) ? 'ready' : 'needs_user';
        if (status === 'needs_user') lastError = '小红书需要用户登录。';
      } catch (error) {
        status = 'needs_user';
        lastError = error instanceof Error ? error.message : String(error);
      }
    } catch (error) {
      status = 'process_failed';
      lastError = error instanceof Error ? error.message : String(error);
      await stopChild();
    }
  };

  await boot();

  return {
    status: snapshot,
    getUrl: () => url,
    ensureReady: async () => {
      if (child && (status === 'ready' || status === 'needs_user' || status === 'tool_mismatch')) {
        return snapshot();
      }
      await boot();
      return snapshot();
    },
    stop: stopChild,
    startLogin: async () => {
      try {
        await mkdir(runtimeDir, { recursive: true });
        const login = spawn(loginBinaryPath, [], {
          cwd: runtimeDir,
          env: { ...process.env },
          windowsHide: false,
          detached: true,
          stdio: 'ignore'
        });
        login.unref();
        status = 'needs_user';
        lastError = '已启动小红书登录程序，请完成登录后重试检查。';
        return { ok: true, pid: login.pid };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      if ((XHS_FORBIDDEN_TOOLS as readonly string[]).includes(name)) {
        throw new Error(`禁止调用小红书写工具：${name}`);
      }
      if (!(XHS_REQUIRED_TOOLS as readonly string[]).includes(name)) {
        throw new Error(`仅允许四个固定读取工具，收到：${name}`);
      }
      if (!(child && (status === 'ready' || status === 'needs_user'))) {
        await boot();
      }
      const current = snapshot();
      if (!current.url) throw new Error(current.lastError || '小红书 MCP 未就绪。');
      if (current.status === 'process_failed') throw new Error(current.lastError || '小红书 MCP 进程失败。');
      if (current.status === 'tool_mismatch') throw new Error(current.lastError || '小红书 MCP 工具不匹配。');
      const initialized = await mcpRequest(current.url, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'wemedia-buddy', version: '0.1.0' }
      });
      await notifyInitialized(current.url, initialized.sessionId);
      const result = await mcpRequest(
        current.url,
        'tools/call',
        { name, arguments: args },
        initialized.sessionId
      );
      return result.data;
    }
  };
}
