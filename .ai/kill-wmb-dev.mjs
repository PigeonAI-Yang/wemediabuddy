import { execSync } from 'node:child_process';

const out = execSync('wmic process get ProcessId,CommandLine /FORMAT:CSV', {
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
const kill = new Set();
for (const line of out.split(/\r?\n/)) {
  if (!/WeMediaBuddy/i.test(line)) continue;
  if (!/electron|node|esbuild|forge|vite/i.test(line)) continue;
  const pid = Number(line.split(',').at(-1));
  if (pid && pid !== process.pid) kill.add(pid);
}
for (const pid of kill) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
}
console.log(JSON.stringify({ killed: [...kill] }));
