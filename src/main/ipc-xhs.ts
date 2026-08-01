import { ipcMain } from 'electron';
import type { DataRoot } from './data-root.ts';
import { startXhsMcp, type XhsMcpRuntime, type XhsMcpStatus } from './xiaohongshu-mcp.ts';

const emptyStatus = (): XhsMcpStatus => ({
  status: 'not_started',
  url: null,
  port: null,
  pid: null,
  runtimeDir: null,
  binaryPath: null,
  loginBinaryPath: null,
  cookiesPath: null,
  tools: [],
  requiredToolsPresent: false,
  lastError: null,
  lastExitCode: null,
  lastStderr: null,
  updatedAt: new Date().toISOString()
});

export async function refreshXhsRuntime(
  dataRoot: DataRoot | null,
  current: XhsMcpRuntime | null
): Promise<XhsMcpRuntime | null> {
  await current?.stop().catch(() => {});
  if (!dataRoot) return null;
  try {
    return await startXhsMcp(dataRoot.path);
  } catch (error) {
    console.error('[xhs-mcp] start failed', error);
    return null;
  }
}

export function registerXhsIpc(input: {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  getXhs: () => XhsMcpRuntime | null;
  setXhs: (runtime: XhsMcpRuntime | null) => void;
  refreshXhs: (dataRoot: DataRoot | null) => Promise<XhsMcpRuntime | null>;
}): void {
  ipcMain.handle('xhs:status', async () => input.getXhs()?.status() ?? emptyStatus());
  ipcMain.handle('xhs:ensure', async () => {
    const dataRoot = await input.loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    let runtime = input.getXhs();
    if (!runtime) {
      runtime = await input.refreshXhs(dataRoot);
      input.setXhs(runtime);
    }
    if (!runtime) throw new Error('小红书 MCP 未能启动。');
    return runtime.ensureReady();
  });
  ipcMain.handle('xhs:start-login', async () => {
    const dataRoot = await input.loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    let runtime = input.getXhs();
    if (!runtime) {
      runtime = await input.refreshXhs(dataRoot);
      input.setXhs(runtime);
    }
    if (!runtime) throw new Error('小红书 MCP 未能启动。');
    return runtime.startLogin();
  });
}
