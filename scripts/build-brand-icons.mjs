/**
 * Build a reusable fixed-size brand/platform icon pack.
 * - masters: SVG/original under images/brand-icons/masters
 * - raster: 128x128 PNG under images/brand-icons/128
 * - manifest: images/brand-icons/manifest.json
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outRoot = path.join(root, 'images', 'brand-icons');
const mastersDir = path.join(outRoot, 'masters');
const rasterDir = path.join(outRoot, '128');
const SIZE = 128;

/** Canonical brand ids used by the app. */
const brands = [
  { id: 'x', title: 'X', simple: 'x', color: '#000000', group: 'platform' },
  { id: 'wechat', title: '微信', simple: 'wechat', color: '#07C160', group: 'platform' },
  { id: 'xiaohongshu', title: '小红书', simple: 'xiaohongshu', color: '#FF2442', group: 'platform' },
  { id: 'jike', title: '即刻', local: 'images/brand-icons/masters/jike.svg', color: '#FFE411', group: 'platform' },
  { id: 'github', title: 'GitHub', simple: 'github', color: '#181717', group: 'source' },
  { id: 'google', title: 'Google', simple: 'google', color: '#4285F4', group: 'source' },
  { id: 'anthropic', title: 'Anthropic', simple: 'anthropic', color: '#191919', group: 'source' },
  { id: 'meta', title: 'Meta', simple: 'meta', color: '#0668E1', group: 'source' },
  { id: 'nvidia', title: 'NVIDIA', simple: 'nvidia', color: '#76B900', group: 'source' },
  { id: 'reddit', title: 'Reddit', simple: 'reddit', color: '#FF4500', group: 'source' },
  { id: 'producthunt', title: 'Product Hunt', simple: 'producthunt', color: '#DA552F', group: 'source' },
  { id: 'huggingface', title: 'Hugging Face', simple: 'huggingface', color: '#FFD21E', group: 'source' },
  { id: 'arxiv', title: 'arXiv', simple: 'arxiv', color: '#B31B1B', group: 'source' },
  { id: 'ycombinator', title: 'Y Combinator', simple: 'ycombinator', color: '#F0652F', group: 'source' },
  { id: 'deepseek', title: 'DeepSeek', simple: 'deepseek', color: '#4D6BFE', group: 'source' },
  { id: 'mistralai', title: 'Mistral AI', simple: 'mistralai', color: '#F7D046', group: 'source' },
  { id: 'qwen', title: 'Qwen', simple: 'qwen', color: '#6A35FF', group: 'source' },
  { id: 'kimi', title: 'Kimi', simple: 'kimi', color: '#1A1A1A', group: 'source' },
  { id: 'deepmind', title: 'Google DeepMind', simple: 'deepmind', color: '#4285F4', group: 'source' },
  { id: 'gemini', title: 'Google Gemini', simple: 'googlegemini', color: '#8E75B2', group: 'source' },
  { id: 'openai', title: 'OpenAI', local: 'images/source-logos/openai.ico', color: '#10A37F', group: 'source' },
  { id: 'microsoft', title: 'Microsoft', local: 'images/source-logos/microsoft.ico', color: '#00A4EF', group: 'source' },
  { id: 'openreview', title: 'OpenReview', local: 'images/source-logos/openreview.ico', color: '#8C1D18', group: 'source' },
  { id: 'x-simonw', title: 'Simon Willison', local: 'images/source-logos/x-simonw.jpeg', color: '#000000', group: 'account' },
  { id: 'x-karpathy', title: 'Andrej Karpathy', local: 'images/source-logos/x-karpathy.jpg', color: '#000000', group: 'account' },
  { id: 'x-emollick', title: 'Ethan Mollick', local: 'images/source-logos/x-emollick.jpg', color: '#000000', group: 'account' },
  { id: 'x-swyx', title: 'swyx', local: 'images/source-logos/x-swyx.jpg', color: '#000000', group: 'account' },
  { id: 'x-chipro', title: 'Chip Huyen', local: 'images/source-logos/x-chipro.jpg', color: '#000000', group: 'account' }
];

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'WeMediaBuddy-brand-icons/1.0' }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

async function ensureDirs() {
  await mkdir(mastersDir, { recursive: true });
  await mkdir(rasterDir, { recursive: true });
}

async function materializeMasters() {
  const records = [];
  for (const brand of brands) {
    let masterPath;
    let source;
    if (brand.simple) {
      const svg = await fetchBuffer(`https://cdn.simpleicons.org/${brand.simple}/000000`);
      masterPath = path.join(mastersDir, `${brand.id}.svg`);
      await writeFile(masterPath, svg);
      source = `simpleicons:${brand.simple}`;
    } else if (brand.local) {
      const from = path.join(root, brand.local);
      const ext = path.extname(from).toLowerCase() || '.bin';
      masterPath = path.join(mastersDir, `${brand.id}${ext}`);
      await copyFile(from, masterPath);
      source = `local:${brand.local}`;
    } else {
      throw new Error(`brand ${brand.id} has no source`);
    }
    const buf = await readFile(masterPath);
    records.push({
      ...brand,
      master: path.relative(outRoot, masterPath).replaceAll('\\', '/'),
      masterSha1: sha1(buf),
      source
    });
    process.stdout.write(`master ${brand.id}\n`);
  }
  return records;
}

function runElectronRaster(records) {
  return new Promise((resolve, reject) => {
    const electronBin = require('electron');
    const worker = path.join(root, 'scripts', 'rasterize-brand-icons-electron.mjs');
    const payloadPath = path.join(outRoot, '_jobs.json');
    const jobs = records.map((item) => ({
      id: item.id,
      masterAbs: path.join(outRoot, item.master),
      outAbs: path.join(rasterDir, `${item.id}.png`),
      size: SIZE,
      color: item.color
    }));
    writeFile(payloadPath, JSON.stringify(jobs)).then(() => {
      const child = spawn(electronBin, [worker, payloadPath], {
        cwd: root,
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
      child.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
      child.on('exit', (code) => {
        if (code === 0) resolve({ out, err });
        else reject(new Error(`electron raster failed (${code}): ${err || out}`));
      });
    }, reject);
  });
}

async function writeManifest(records) {
  const items = [];
  for (const item of records) {
    const pngRel = path.join('128', `${item.id}.png`).replaceAll('\\', '/');
    const pngAbs = path.join(outRoot, pngRel);
    const png = await readFile(pngAbs);
    items.push({
      id: item.id,
      title: item.title,
      group: item.group,
      color: item.color,
      source: item.source,
      master: item.master,
      masterSha1: item.masterSha1,
      png: pngRel,
      pngSha1: sha1(png),
      size: SIZE
    });
  }
  const manifest = {
    version: 1,
    size: SIZE,
    generatedAt: new Date().toISOString(),
    count: items.length,
    items
  };
  await writeFile(path.join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  await ensureDirs();
  const records = await materializeMasters();
  await runElectronRaster(records);
  const manifest = await writeManifest(records);
  const aliases = {
    'platform-x': 'x',
    'platform-wechat': 'wechat',
    'platform-xiaohongshu': 'xiaohongshu',
    'source-google-deepmind': 'deepmind',
    'source-openai': 'openai',
    'source-microsoft': 'microsoft'
  };
  await writeFile(path.join(outRoot, 'aliases.json'), `${JSON.stringify(aliases, null, 2)}\n`);
  // Keep publish-platform SVGs in platform-logos in sync with masters for PlatformMark.
  const platformDir = path.join(root, 'images', 'platform-logos');
  await mkdir(platformDir, { recursive: true });
  for (const id of ['x', 'wechat', 'xiaohongshu']) {
    await copyFile(path.join(mastersDir, `${id}.svg`), path.join(platformDir, `${id}.svg`));
  }
  console.log(`brand-icons ready: ${manifest.count} @ ${SIZE}px -> ${path.relative(root, outRoot)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
