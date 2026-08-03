import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findSourceLogo } from '../src/shared/source-logo.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(readFileSync(join(root, 'skills/wemedia-intelligence-engine/references/source-index.json'), 'utf8'));

test('every registered source has a packaged local logo', () => {
  assert.ok(index.sources.length > 0);
  for (const source of index.sources) {
    assert.match(source.logo, /^[a-z0-9-]+\.(?:svg|ico|png|jpe?g|webp)$/);
    assert.equal(existsSync(join(root, 'images/source-logos', source.logo)), true, source.id);
  }
});

test('source logo matching prefers registered paths and rejects ambiguous hosts', () => {
  assert.equal(findSourceLogo('https://openai.com/index/example/', index.sources)?.logo, 'openai.ico');
  assert.equal(findSourceLogo('https://github.com/deepseek-ai/DeepSeek-V3', index.sources)?.logo, 'deepseek.svg');
  assert.equal(findSourceLogo('https://github.com/example/project', index.sources), null);
  assert.equal(findSourceLogo('https://x.com/karpathy/status/123', index.sources)?.logo, 'x-karpathy.jpg');
  assert.equal(findSourceLogo('https://x.com/unknown/status/123', index.sources), null);
});
