import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const workspace = process.cwd();
const modulesRoot = path.join(workspace, 'node_modules');
const output = path.join(workspace, '.pi-runtime', 'node_modules');
const marker = path.join(workspace, '.pi-runtime', '.package-lock.sha256');
const lockHash = createHash('sha256').update(await readFile(path.join(workspace, 'package-lock.json'))).digest('hex');
const pending = [path.join(modulesRoot, '@earendil-works', 'pi-coding-agent')];
const copied = new Set();

try {
  if ((await readFile(marker, 'utf8')) === lockHash) {
    console.log('Reused unchanged Pi runtime.');
    process.exit(0);
  }
} catch {}
try {
  const bundled = JSON.parse(await readFile(path.join(output, '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(path.join(modulesRoot, '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
  if (bundled.version === installed.version) {
    await writeFile(marker, lockHash, 'utf8');
    console.log('Adopted existing Pi runtime.');
    process.exit(0);
  }
} catch {}

await rm(path.dirname(output), { recursive: true, force: true });
await mkdir(output, { recursive: true });

while (pending.length) {
  const packageDir = pending.pop();
  const relative = path.relative(modulesRoot, packageDir);
  if (copied.has(relative)) continue;
  copied.add(relative);
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  await cp(packageDir, path.join(output, relative), { recursive: true });
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const dependency = await resolveDependency(packageDir, name);
    if (dependency) pending.push(dependency);
  }
}

await mkdir(path.dirname(marker), { recursive: true });
await writeFile(marker, lockHash, 'utf8');
console.log(`Prepared Pi runtime with ${copied.size} packages.`);

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
