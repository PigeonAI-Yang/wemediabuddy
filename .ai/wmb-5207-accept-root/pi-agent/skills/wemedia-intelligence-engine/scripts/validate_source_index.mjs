import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = process.argv[2] ?? join(root, 'references', 'source-index.json');
const logoRoot = join(root, '..', '..', 'images', 'source-logos');
const index = JSON.parse(readFileSync(path, 'utf8'));
const levels = new Set(['primary', 'professional', 'signal_only', 'first_party']);
const ids = new Set();

if (index.version !== 1 || !Array.isArray(index.sources) || index.sources.length === 0) {
  throw new Error('source index must contain version 1 and non-empty sources');
}

for (const source of index.sources) {
  for (const key of ['id', 'name', 'url', 'kind', 'trust_level', 'collector', 'logo']) {
    if (!source[key]) throw new Error(`${source.id ?? 'unknown'} missing ${key}`);
  }
  if (ids.has(source.id)) throw new Error(`duplicate source id: ${source.id}`);
  if (!levels.has(source.trust_level)) throw new Error(`invalid trust level: ${source.id}`);
  if (!Array.isArray(source.domain) || !source.domain.length || !Array.isArray(source.roles) || !source.roles.length) {
    throw new Error(`${source.id} must have domain and roles`);
  }
  if (!/^[a-z0-9-]+\.(?:svg|ico|png|jpe?g|webp)$/.test(source.logo)) {
    throw new Error(`${source.id} has invalid logo filename`);
  }
  const logoPath = join(logoRoot, source.logo);
  if (!existsSync(logoPath)) throw new Error(`${source.id} logo not found: ${source.logo}`);
  if (source.logo.endsWith('.svg') && !/viewBox="0 0 24 24"/.test(readFileSync(logoPath, 'utf8'))) {
    throw new Error(`${source.id} SVG logo must use the shared 24x24 viewBox`);
  }
  new URL(source.url);
  ids.add(source.id);
}

console.log(`source-index OK: ${index.sources.length} sources`);
