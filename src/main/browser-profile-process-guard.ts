import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

export async function assertBrowserProfileStopped(profilePath: string): Promise<void> {
  const resolved = normalize(profilePath);
  const commandLines = process.platform === 'win32'
    ? await windowsBrowserCommandLines()
    : await posixBrowserCommandLines();
  if (commandLines.some((line) => normalize(line).includes(resolved))) {
    throw Object.assign(new Error('Legacy 浏览器档案仍被 Edge 或 Chrome 占用，请完全关闭后重试。'), {
      code: 'WORKSPACE_BUSY',
      details: { state: 'needs_user' }
    });
  }
}

async function windowsBrowserCommandLines(): Promise<string[]> {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(msedge|chrome)(\\.exe)?$' } | ForEach-Object { $_.CommandLine }";
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function posixBrowserCommandLines(): Promise<string[]> {
  const { stdout } = await run('ps', ['-ax', '-o', 'command=']);
  return stdout.split(/\r?\n/).filter((line) => /(?:chrome|chromium|edge)/i.test(line));
}

function normalize(value: string): string {
  return path.resolve(value.replace(/^['"]|['"]$/g, '')).replaceAll('\\', '/').toLowerCase();
}
