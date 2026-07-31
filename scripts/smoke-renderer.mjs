/**
 * Smoke-check that the renderer dev server is WeMediaBuddy, not another project.
 * Use after restart / before claiming UI work is verified.
 */
const port = Number(process.env.WMB_RENDERER_PORT || 27391);
const url = `http://127.0.0.1:${port}/`;

const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
if (!response.ok) {
  console.error(`[wmb-smoke] ${url} -> HTTP ${response.status}`);
  process.exit(1);
}
const html = await response.text();
const checks = [
  ['title', /<title>WeMediaBuddy<\/title>/i.test(html)],
  ['root', /id=["']root["']/.test(html)],
  ['entry', /src=["']\/main\.tsx["']/.test(html) || /src=["'][^"']*main\.tsx/.test(html)],
  ['not-polymarket', !/PigeonYang-PolyMarket/i.test(html)],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(`[wmb-smoke] wrong renderer content at ${url}`);
  console.error(`[wmb-smoke] failed checks: ${failed.join(', ')}`);
  console.error(html.slice(0, 300).replace(/\s+/g, ' '));
  process.exit(2);
}
console.log(`[wmb-smoke] ok ${url}`);
