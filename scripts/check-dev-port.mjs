/**
 * Prevent the recurring black-screen failure mode:
 * another Vite app occupies the renderer port and Electron loads the wrong page.
 */
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.WMB_RENDERER_PORT || 27391);

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function ownerHint(port) {
  try {
    const out = execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${port}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const pids = [...new Set([...out.matchAll(/\s(\d+)\s*$/gm)].map((m) => m[1]).filter((pid) => pid && pid !== '0'))];
    if (!pids.length) return out.trim() || 'unknown owner';
    const details = [];
    for (const pid of pids.slice(0, 4)) {
      try {
        const cmd = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
        details.push(`pid ${pid}: ${cmd || '(no command line)'}`);
      } catch {
        details.push(`pid ${pid}`);
      }
    }
    return details.join('\n');
  } catch {
    return 'unable to inspect owner';
  }
}

async function probeContent(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    const html = await response.text();
    return {
      ok: response.ok,
      isWmb: /<title>WeMediaBuddy<\/title>/i.test(html) && /id=["']root["']/.test(html),
      title: html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '(no title)',
      snippet: html.slice(0, 180).replace(/\s+/g, ' ')
    };
  } catch {
    return null;
  }
}

if (await canListen(PORT)) {
  console.log(`[wmb] renderer port ${PORT} is free`);
  process.exit(0);
}

const content = await probeContent(PORT);
console.error(`[wmb] renderer port ${PORT} is already in use.`);
if (content?.isWmb) {
  console.error('[wmb] It looks like WeMediaBuddy is already running on this port.');
  console.error('[wmb] Stop the existing wmb-dev/Electron instance before starting another one.');
} else if (content) {
  console.error(`[wmb] Foreign page detected at http://127.0.0.1:${PORT}/ -> title="${content.title}"`);
  console.error('[wmb] This is the black-screen failure mode: Electron would load the wrong project.');
  console.error(content.snippet);
} else {
  console.error('[wmb] Port is busy but no HTTP page responded. Free the port before starting.');
}
console.error(ownerHint(PORT));
console.error('[wmb] Refusing to start.');
process.exit(1);
