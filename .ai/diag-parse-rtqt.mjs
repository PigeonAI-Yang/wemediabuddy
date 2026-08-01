
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
// dynamic import of ts via node experimental? use local reimplementation of extract by importing file
const mod = await import('../src/main/platforms/x-list-browser.ts');
// functions not exported - call readXListTimeline instead for end-to-end
const config = { id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334' };
const result = await mod.readXListTimeline(config, '2082177169078251627', 40);
const counts = { total: result.posts.length, tweet:0, repost:0, quote:0 };
const samples = [];
for (const p of result.posts) {
  const kind = p.postKind || 'tweet';
  counts[kind] = (counts[kind]||0)+1;
  if ((kind==='quote'||kind==='repost') && samples.length<6) {
    samples.push({
      kind,
      author: p.authorHandle,
      text: (p.text||'').slice(0,60),
      repostedBy: p.repostedBy?.handle || null,
      quoted: p.quotedPost ? { author:p.quotedPost.authorHandle, text:(p.quotedPost.text||'').slice(0,50) } : null
    });
  }
}
console.log(JSON.stringify({ ok:true, counts, samples, hasMore: result.hasMore }, null, 2));
