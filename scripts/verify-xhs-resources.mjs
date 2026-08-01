import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('resources/xiaohongshu-mcp');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, 'v2.1.1');
for (const asset of manifest.assets) {
  const file = path.join(root, asset.name);
  await access(file);
  const buf = await readFile(file);
  assert.equal(buf.byteLength, asset.size, asset.name + ' size');
  const sha = createHash('sha256').update(buf).digest('hex');
  assert.equal(sha, asset.sha256, asset.name + ' sha256');
}
try {
  await access(path.join(root, 'cookies.json'));
  throw new Error('cookies.json must not ship in resources');
} catch (error) {
  if (error && error.message === 'cookies.json must not ship in resources') throw error;
}
console.log(JSON.stringify({ ok: true, root, version: manifest.version, assets: manifest.assets.length }, null, 2));
