import { app } from 'electron';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const files = ['wmb-mcp.ts', 'wmb-mcp-client.ts', 'wmb-mcp-tools-core.ts', 'wmb-mcp-tools-content.ts'];

export async function preparePiExtension(agentDir: string): Promise<string> {
  const sourceRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'extensions')
    : path.join(app.getAppPath(), '.pi', 'extensions');
  const targetRoot = path.join(agentDir, 'extensions');
  await mkdir(targetRoot, { recursive: true });
  await Promise.all(files.map((name) => copyFile(path.join(sourceRoot, name), path.join(targetRoot, name))));
  return path.join(targetRoot, 'wmb-mcp.ts');
}
