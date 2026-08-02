import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const files = [
  'index.ts',
  'wmb-mcp-client.ts',
  'wmb-mcp-xhs-client.ts',
  'wmb-mcp-tools-core.ts',
  'wmb-mcp-tools-content.ts',
  'wmb-mcp-tools-workspaces.ts',
  'wmb-mcp-tools-x-lists.ts',
  'wmb-mcp-tools-xhs.ts'
];
const staleFlatFiles = [
  'wmb-mcp.ts',
  'wmb-mcp-client.ts',
  'wmb-mcp-xhs-client.ts',
  'wmb-mcp-tools-core.ts',
  'wmb-mcp-tools-content.ts',
  'wmb-mcp-tools-workspaces.ts',
  'wmb-mcp-tools-x-lists.ts',
  'wmb-mcp-tools-xhs.ts'
];

function resolveExtensionSourceRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.resolve(here, '../../.pi/extensions/wmb-mcp');
  try {
    // Lazy require so plain Node runners can import this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { isPackaged?: boolean; getAppPath?: () => string } };
    const app = electron?.app;
    if (app?.isPackaged) {
      return path.join(process.resourcesPath, 'extensions', 'wmb-mcp');
    }
  } catch {
    // Fall through to repo path.
  }
  return local;
}

// Pi 会把 agentDir/extensions 顶层的每个 .ts 都当作独立扩展加载;
// 因此整个 WMB 扩展必须是一个带子目录(index.ts + 同目录库文件)的包,
// 库文件不能平铺在 extensions 顶层,否则会被当成无工厂函数的坏扩展。
export async function preparePiExtension(agentDir: string): Promise<string> {
  const sourceRoot = resolveExtensionSourceRoot();
  const targetRoot = path.join(agentDir, 'extensions');
  const targetDir = path.join(targetRoot, 'wmb-mcp');
  await mkdir(targetDir, { recursive: true });
  await Promise.all(staleFlatFiles.map((name) => rm(path.join(targetRoot, name), { force: true })));
  await Promise.all(files.map((name) => copyFile(path.join(sourceRoot, name), path.join(targetDir, name))));
  return path.join(targetDir, 'index.ts');
}
