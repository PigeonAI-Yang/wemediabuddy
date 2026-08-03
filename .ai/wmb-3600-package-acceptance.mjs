import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { readPiConversation, writePiConversation } from '../src/main/pi-conversation.ts';
import { createOfficialWorkspace } from '../src/main/workspaces.ts';

const execFileAsync = promisify(execFile);
const executable = path.join(process.cwd(), 'out', 'WeMediaBuddy-win32-x64', 'WeMediaBuddy.exe');
const temp = await mkdtemp(path.join(os.tmpdir(), 'wmb-3600-'));
const userData = path.join(temp, 'user-data');
const port = 29600;
let child;
try {
  await mkdir(userData, { recursive: true });
  const workspace = await createOfficialWorkspace({ registryPath: path.join(userData, 'workspace-registry.json'), rootPath: path.join(temp, 'root'), templateId: 'official.ai' });
  await writeFile(path.join(userData, 'data-root.json'), JSON.stringify({ path: workspace.rootPath }), 'utf8');
  const conversation = await readPiConversation(workspace.rootPath);
  const sessionId = 'wmb-3600-session';
  const entries = [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-08-03T16:00:00.000Z', cwd: path.join(workspace.rootPath, 'pi-agent', 'workspace') },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-03T16:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '[USER_MESSAGE]\n验收重试反馈' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-03T16:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '原回复' }] } }
  ];
  await writeFile(conversation.sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
  await writePiConversation(workspace.rootPath, { id: conversation.id, sessionFile: conversation.sessionFile, sessionId, messages: [
    { role: 'user', text: '验收重试反馈', entryId: 'u1' },
    { role: 'assistant', text: '原回复', entryId: 'a1', segments: [{ kind: 'text', text: '原回复' }] }
  ] });

  child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' }, stdio: 'ignore', windowsHide: true });
  await waitForCdp(port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let i = 0; i < 120 && !page; i += 1) { page = browser.contexts()[0]?.pages()[0]; if (!page) await new Promise((resolve) => setTimeout(resolve, 250)); }
  assert.ok(page, 'packaged renderer page did not start');
  await page.waitForSelector('#root', { timeout: 30_000 });
  await page.evaluate(() => window.wmb.savePiConfig({ name: 'WMB-3600', baseUrl: 'https://example.invalid/v1', model: 'acceptance-only', api: 'openai-responses', apiKey: 'not-used' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label="按 Pi 原生分叉重发"]', { timeout: 30_000 });
  await page.evaluate(() => window.wmb.listPiCommands());
  const piPid = await findNodeDescendant(child.pid);
  await powershell(`Add-Type 'using System;using System.Runtime.InteropServices;public static class N{[DllImport("ntdll.dll")]public static extern int NtSuspendProcess(IntPtr h);}'; [N]::NtSuspendProcess((Get-Process -Id ${piPid}).Handle)`);

  const pending = await page.evaluate(async () => {
    const button = document.querySelector('button[aria-label="按 Pi 原生分叉重发"]');
    const started = performance.now(); button.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return { elapsedMs: performance.now() - started, busy: button.getAttribute('aria-busy'), disabled: button.disabled, title: button.title, status: document.querySelector('.pi-dock-title')?.textContent ?? '' };
  });
  assert.equal(pending.busy, 'true'); assert.equal(pending.disabled, true); assert.equal(pending.title, '正在重新发送'); assert.match(pending.status, /正在重新发送/);
  await execFileAsync('taskkill.exe', ['/PID', String(piPid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('button[aria-label="按 Pi 原生分叉重发"]')?.hasAttribute('aria-busy'), null, { timeout: 10_000 });
  const settled = await page.evaluate(() => ({ busy: document.querySelector('button[aria-label="按 Pi 原生分叉重发"]')?.getAttribute('aria-busy') ?? null, status: document.querySelector('.pi-dock-title')?.textContent ?? '', toast: document.querySelector('.pi-toast')?.textContent ?? '' }));
  assert.equal(settled.busy, null); assert.doesNotMatch(settled.status, /正在重新发送/);
  console.log(JSON.stringify({ pending, settled }));
  await browser.close();
} finally {
  if (child?.pid) await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

async function waitForCdp(cdpPort) { for (let i = 0; i < 120; i += 1) { try { await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: cdpPort, path: '/json/version' }, (response) => { response.resume(); response.on('end', resolve); }).on('error', reject)); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); } } throw new Error('CDP did not start'); }
async function powershell(command) { return execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true }); }
async function findNodeDescendant(rootPid) {
  const command = `$all=Get-CimInstance Win32_Process;$ids=@(${rootPid});do{$added=$false;foreach($p in $all){if($ids -contains [int]$p.ParentProcessId -and $ids -notcontains [int]$p.ProcessId){$ids += [int]$p.ProcessId;$added=$true}}}while($added);($all|Where-Object{$ids -contains [int]$_.ProcessId -and $_.Name -eq 'node.exe'}|Select-Object -First 1 -ExpandProperty ProcessId)`;
  const { stdout } = await powershell(command); const pid = Number(stdout.trim()); assert.ok(pid, 'Pi node process not found'); return pid;
}
