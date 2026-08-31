import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('usage: write-packaged-build-manifest --output <packaged-app-dir>');
const outputPath = path.resolve(process.argv[outputIndex + 1]);
const resourcesPath = path.join(outputPath, 'resources');
const executablePath = path.join(outputPath, process.platform === 'win32' ? 'WeMediaBuddy.exe' : 'WeMediaBuddy');
const appAsarPath = path.join(resourcesPath, 'app.asar');

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

let sourceCommit = process.env.WMB_SOURCE_COMMIT?.trim() || 'working-tree';
if (sourceCommit === 'working-tree') {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
    sourceCommit = dirty ? `${head}+dirty` : head;
  } catch {}
}

const [packageHash, appAsarHash] = await Promise.all([sha256(executablePath), sha256(appAsarPath)]);
const manifest = {
  version: 1,
  sourceCommit,
  packageHash,
  appAsarHash,
  executable: path.basename(executablePath),
  appAsar: 'app.asar',
  builtAt: new Date().toISOString(),
};
await writeFile(path.join(resourcesPath, 'wmb-build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[build-manifest] ${packageHash.slice(0, 12)} app.asar=${appAsarHash.slice(0, 12)} source=${sourceCommit}`);
