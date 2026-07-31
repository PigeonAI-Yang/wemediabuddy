import { app } from 'electron';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const files = ['index.ts', 'wmb-mcp-client.ts', 'wmb-mcp-tools-core.ts', 'wmb-mcp-tools-content.ts', 'wmb-mcp-tools-x-lists.ts'];
const staleFlatFiles = ['wmb-mcp.ts', 'wmb-mcp-client.ts', 'wmb-mcp-tools-core.ts', 'wmb-mcp-tools-content.ts', 'wmb-mcp-tools-x-lists.ts'];

// Pi 会把 agentDir/extensions 顶层的每个 .ts 都当作独立扩展加载;
// 因此整个 WMB 扩展必须是一个带子目录(index.ts + 同目录库文件)的包,
// 库文件不能平铺在 extensions 顶层,否则会被当成无工厂函数的坏扩展。
export async function preparePiExtension(agentDir: string): Promise<string> {
  const sourceRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'extensions', 'wmb-mcp')
    : path.join(app.getAppPath(), '.pi', 'extensions', 'wmb-mcp');
  const targetRoot = path.join(agentDir, 'extensions');
  const targetDir = path.join(targetRoot, 'wmb-mcp');
  await mkdir(targetDir, { recursive: true });
  await Promise.all(staleFlatFiles.map((name) => rm(path.join(targetRoot, name), { force: true })));
  await Promise.all(files.map((name) => copyFile(path.join(sourceRoot, name), path.join(targetDir, name))));
  return path.join(targetDir, 'index.ts');
}
