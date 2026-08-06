import { execFileSync } from 'node:child_process';
import net from 'node:net';

function listProcesses() {
  const raw = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
  ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isWmbDev(cmd) {
  const text = String(cmd || '').toLowerCase();
  if (!text.includes('pigeonyang') || !text.includes('wemediabuddy')) return false;
  if (text.includes('codex.exe') || text.includes('cua_node')) return false;
  return (
    text.includes('node_modules\\electron\\dist\\electron.exe')
    || text.includes('node_modules/electron/dist/electron.exe')
    || text.includes('electron-forge')
    || text.includes('vite.renderer')
    || text.includes('resources\\xiaohongshu-mcp\\xiaohongshu-mcp-windows-amd64.exe')
    || text.includes('resources/xiaohongshu-mcp/xiaohongshu-mcp-windows-amd64.exe')
  );
}

const hits = listProcesses().filter((row) => isWmbDev(row.CommandLine));
console.log(JSON.stringify({ kills: hits.map((row) => row.ProcessId) }));
for (const row of hits) {
  try {
    execFileSync('taskkill', ['/PID', String(row.ProcessId), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

await new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', (error) => {
    console.log(JSON.stringify({ port: 27391, status: error.code }));
    resolve();
  });
  server.listen(27391, '127.0.0.1', () => {
    console.log(JSON.stringify({ port: 27391, status: 'free' }));
    server.close(() => resolve());
  });
});
