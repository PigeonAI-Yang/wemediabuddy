import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const workspace = process.cwd();
const modulesRoot = path.join(workspace, 'node_modules');
const runtimeRoot = path.join(workspace, '.r');
const output = path.join(runtimeRoot, 'node_modules');
const marker = path.join(runtimeRoot, '.package-lock.sha256');
const lockHash = createHash('sha256').update(await readFile(path.join(workspace, 'package-lock.json'))).digest('hex');
const runtimeFingerprint = `${lockHash}:2`;
const codingAgentSource = path.join(modulesRoot, '@earendil-works', 'pi-coding-agent');
const pending = [
  codingAgentSource,
  path.join(modulesRoot, 'pi-vision-tool')
];
const copied = new Set();

try {
  const bundled = JSON.parse(await readFile(path.join(output, 'a', 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(path.join(modulesRoot, '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
  const bundledVision = JSON.parse(await readFile(path.join(output, 'pi-vision-tool', 'package.json'), 'utf8'));
  const installedVision = JSON.parse(await readFile(path.join(modulesRoot, 'pi-vision-tool', 'package.json'), 'utf8'));
  const bundledFingerprint = (await readFile(marker, 'utf8')).trim();
  if (bundled.version === installed.version && bundledVision.version === installedVision.version && bundledFingerprint === runtimeFingerprint) {
    console.log('Adopted existing Pi runtime.');
    process.exit(0);
  }
} catch {}
await rm(path.join(workspace, '.pi-runtime'), { recursive: true, force: true });

await rm(path.dirname(output), { recursive: true, force: true });
await mkdir(output, { recursive: true });

while (pending.length) {
  const packageDir = pending.pop();
  const relative = bundledRelative(packageDir);
  if (copied.has(relative)) continue;
  copied.add(relative);
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  await cp(packageDir, path.join(output, relative), { recursive: true });
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const dependency = await resolveDependency(packageDir, name);
    if (dependency) pending.push(dependency);
  }
}
const agentModules = path.join(output, 'a', 'node_modules');
const mistralScope = path.join(agentModules, '@mistralai');
await rename(path.join(mistralScope, 'mistralai'), path.join(agentModules, 'm'));
await rm(mistralScope, { recursive: true, force: true });
const mistralAdapterPath = path.join(agentModules, '@earendil-works', 'pi-ai', 'dist', 'api', 'mistral-conversations.js');
const mistralAdapter = await readFile(mistralAdapterPath, 'utf8');
await writeFile(mistralAdapterPath, mistralAdapter.replace('"@mistralai/mistralai"', '"../../../../m/esm/index.js"'), 'utf8');

await mkdir(path.dirname(marker), { recursive: true });
await writeFile(marker, runtimeFingerprint, 'utf8');
console.log(`Prepared Pi runtime with ${copied.size} packages.`);
function bundledRelative(packageDir) {
  const nested = path.relative(codingAgentSource, packageDir);
  if (!nested.startsWith('..') && !path.isAbsolute(nested)) return path.join('a', nested);
  return path.relative(modulesRoot, packageDir);
}


async function resolveDependency(from, name) {
  for (let current = from; current.startsWith(modulesRoot); current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    try {
      await readFile(path.join(candidate, 'package.json'));
      return candidate;
    } catch {}
  }
  const candidate = path.join(modulesRoot, name);
  try {
    await readFile(path.join(candidate, 'package.json'));
    return candidate;
  } catch {
    return undefined;
  }
}
