import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { failure, success, type CommandResult } from './result.ts';

export type PiRuntimeInfo = {
  version: string;
  root: string;
  source: 'bundled' | 'override';
  previousVersion: string | null;
  stagingVersion: string | null;
};

function appPaths(): { isPackaged: boolean; resourcesPath: string; appPath: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { isPackaged: boolean; getAppPath(): string } };
    if (electron.app) {
      return {
        isPackaged: electron.app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: electron.app.getAppPath()
      };
    }
  } catch {}
  return {
    isPackaged: false,
    resourcesPath: process.cwd(),
    appPath: process.cwd()
  };
}

function bundledRuntimeRoot(): string {
  const paths = appPaths();
  return paths.isPackaged
    ? path.join(paths.resourcesPath, '.pi-runtime')
    : path.join(paths.appPath, '.pi-runtime');
}
function overrideRoot(dataRootPath: string): string {
  return path.join(dataRootPath, 'pi-runtime');
}

function activeOverrideRoot(dataRootPath: string): string {
  return path.join(overrideRoot(dataRootPath), 'active');
}

function previousOverrideRoot(dataRootPath: string): string {
  return path.join(overrideRoot(dataRootPath), 'previous');
}

function stagingOverrideRoot(dataRootPath: string): string {
  return path.join(overrideRoot(dataRootPath), 'staging');
}

export function piCliFromRuntimeRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
}

export function piVisionExtensionFromRuntimeRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', 'pi-vision-tool', 'extensions', 'vision-tool.ts');
}

export async function readRuntimeVersion(runtimeRoot: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')) as { version?: string };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePiRuntimeRoot(dataRootPath?: string | null): Promise<string> {
  if (dataRootPath) {
    const active = activeOverrideRoot(dataRootPath);
    if (await exists(piCliFromRuntimeRoot(active))) return active;
  }
  return bundledRuntimeRoot();
}

export async function getPiRuntimeInfo(dataRootPath?: string | null): Promise<PiRuntimeInfo> {
  const root = await resolvePiRuntimeRoot(dataRootPath);
  const bundled = bundledRuntimeRoot();
  const source: 'bundled' | 'override' = path.resolve(root) === path.resolve(bundled) ? 'bundled' : 'override';
  const version = (await readRuntimeVersion(root)) ?? 'unknown';
  const previousVersion = dataRootPath ? await readRuntimeVersion(previousOverrideRoot(dataRootPath)) : null;
  const stagingVersion = dataRootPath ? await readRuntimeVersion(stagingOverrideRoot(dataRootPath)) : null;
  return { version, root, source, previousVersion, stagingVersion };
}

export async function probePiRuntime(runtimeRoot: string): Promise<CommandResult<{ version: string }>> {
  const cli = piCliFromRuntimeRoot(runtimeRoot);
  if (!(await exists(cli))) return failure('NOT_FOUND', `Pi CLI 不存在：${cli}`);
  const version = await readRuntimeVersion(runtimeRoot);
  if (!version) return failure('VALIDATION_ERROR', '无法读取 Pi runtime 版本。');
  const { spawn } = await import('node:child_process');
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, '--help'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => resolve({ code: 1, stderr: error.message }));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  if (result.code !== 0) {
    return failure('PI_RUNTIME_PROBE_FAILED', result.stderr || `Pi CLI help exited ${result.code}`);
  }
  return success({ version });
}

export async function stagePiRuntimeFromSource(
  dataRootPath: string,
  sourceRuntimeRoot: string
): Promise<CommandResult<{ stagedVersion: string; stagingRoot: string }>> {
  const sourceCli = piCliFromRuntimeRoot(sourceRuntimeRoot);
  if (!(await exists(sourceCli))) return failure('NOT_FOUND', '更新源不包含可运行的 Pi CLI。');
  const stagedVersion = await readRuntimeVersion(sourceRuntimeRoot);
  if (!stagedVersion) return failure('VALIDATION_ERROR', '更新源缺少 Pi 版本。');

  const stagingRoot = stagingOverrideRoot(dataRootPath);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(path.dirname(stagingRoot), { recursive: true });
  await cp(sourceRuntimeRoot, stagingRoot, { recursive: true });

  const probe = await probePiRuntime(stagingRoot);
  if (!probe.ok) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    return failure(probe.error.code, `预检失败，未替换当前 Pi：${probe.error.message}`);
  }
  return success({ stagedVersion, stagingRoot });
}

export async function activateStagedPiRuntime(dataRootPath: string): Promise<CommandResult<PiRuntimeInfo>> {
  const stagingRoot = stagingOverrideRoot(dataRootPath);
  if (!(await exists(piCliFromRuntimeRoot(stagingRoot)))) {
    return failure('NOT_FOUND', '没有可激活的 staged Pi runtime。');
  }
  const activeRoot = activeOverrideRoot(dataRootPath);
  const previousRoot = previousOverrideRoot(dataRootPath);
  await mkdir(overrideRoot(dataRootPath), { recursive: true });

  if (await exists(activeRoot)) {
    await rm(previousRoot, { recursive: true, force: true });
    await rename(activeRoot, previousRoot);
  }
  await rename(stagingRoot, activeRoot);
  await writeFile(path.join(overrideRoot(dataRootPath), 'active-version.txt'), (await readRuntimeVersion(activeRoot)) ?? 'unknown', 'utf8');
  return success(await getPiRuntimeInfo(dataRootPath));
}

export async function rollbackPiRuntime(dataRootPath: string): Promise<CommandResult<PiRuntimeInfo>> {
  const activeRoot = activeOverrideRoot(dataRootPath);
  const previousRoot = previousOverrideRoot(dataRootPath);
  if (!(await exists(piCliFromRuntimeRoot(previousRoot)))) {
    return failure('NOT_FOUND', '没有可回滚的 previous Pi runtime。');
  }
  const failedRoot = path.join(overrideRoot(dataRootPath), `failed-${Date.now()}`);
  if (await exists(activeRoot)) await rename(activeRoot, failedRoot);
  await rename(previousRoot, activeRoot);
  return success(await getPiRuntimeInfo(dataRootPath));
}

/** Convenience: stage source, probe, activate. On probe failure keep current active. */
export async function updatePiRuntime(
  dataRootPath: string,
  sourceRuntimeRoot: string
): Promise<CommandResult<PiRuntimeInfo>> {
  const staged = await stagePiRuntimeFromSource(dataRootPath, sourceRuntimeRoot);
  if (!staged.ok) return staged;
  return activateStagedPiRuntime(dataRootPath);
}
