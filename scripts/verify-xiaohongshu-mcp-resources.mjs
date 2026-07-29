import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'resources/xiaohongshu-mcp');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.version !== 'v2.1.1' || manifest.license !== 'Apache-2.0') throw new Error('Unexpected Xiaohongshu MCP manifest.');

const names = await readdir(root);
if (names.some((name) => /cookies\.json$/i.test(name))) throw new Error('Credential file found in Xiaohongshu MCP resources.');

for (const asset of manifest.assets) {
  const file = path.join(root, asset.name);
  const [info, bytes] = await Promise.all([stat(file), readFile(file)]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (info.size !== asset.size || hash !== asset.sha256) throw new Error(`Xiaohongshu MCP asset mismatch: ${asset.name}`);
}

console.log(JSON.stringify({ root, version: manifest.version, assets: manifest.assets.map(({ name, sha256 }) => ({ name, sha256 })) }));
