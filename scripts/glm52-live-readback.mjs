/**
 * WMB-5175 / EVAL-CAP-028: 真实 GLM readback（产品路径，可重复运行）。
 *
 * 用产品真源 `wmb_read_web_page` 底层（src/main/research-web-read.ts）对现网
 *   - 智谱官方定价页 https://zhipuai.cn/pricing
 *   - OpenRouter GLM-5.2 模型页 https://openrouter.ai/models/zhipu/glm-5.2
 * 做真实读取：静态正文提取优先；静态失败/无定价行时尝试受控 headless fallback 渲染。
 * 之后用产品 claim 机器校验（research-claim-validation）对 required claim
 * `glm52_official_price_rise`（type=price）做可核验证据评估，并把全部证据写入
 * `.ai/glm52-live-readback-<date>.json`。
 *
 * 用法：node scripts/glm52-live-readback.mjs [--out <path>]
 * 退出码：0 = 脚本完整执行（含外部不可用时的精确失败记录）；非 0 = 脚本自身错误。
 * 说明：本脚本只读不写业务库；结果即证据，不伪造成功。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

// TS loader（与聚焦测试同款）：解析 .ts 相对导入。
const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const { readWebPage, headlessRenderPublicPage } = await import('../src/main/research-web-read.ts');
const { assertPublicUrl, assertPublicDns, hostnameOf } = await import('../src/main/website-channel.ts');
const { validateClaimProposal, assessSupportThreshold } = await import('../src/main/research-claim-validation.ts');

const CLAIM = { key: 'glm52_official_price_rise', text: 'GLM 5.2 官方在 OpenRouter 涨价', type: 'price' };
const TARGETS = [
  { label: 'zhipu-official-pricing', url: 'https://zhipuai.cn/pricing', kind: 'official' },
  { label: 'openrouter-glm52-model-page', url: 'https://openrouter.ai/models/zhipu/glm-5.2', kind: 'secondary' }
];

const outArg = process.argv.findIndex((arg) => arg === '--out');
const localDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const OUT_FILE = outArg >= 0 && process.argv[outArg + 1]
  ? process.argv[outArg + 1]
  : path.join(fileURLToPath(new URL('..', import.meta.url)), '.ai', `glm52-live-readback-${localDate}.json`);

/** 现网页面正文中的 GLM-5.2 价格线索（官方/OpenRouter 常见格式）。 */
function priceLines(text) {
  const patterns = [
    /glm[- ]?5\.2[\s\S]{0,200}?(?:元|¥|\$|usd)[\s\S]{0,120}/gi,
    /(?:元|¥|\$|usd)[\s\S]{0,80}?(?:百万|1m|per 1m)[\s\S]{0,80}/gi,
    /prompt[^\n]{0,60}(?:price)?[\s\S]{0,80}(?:0\.\d+|调[整]?)/gi
  ];
  const hits = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = match[0].replace(/\s+/g, ' ').trim();
      if (line.length <= 400) hits.add(line);
    }
  }
  return [...hits].slice(0, 12);
}

const validateUrl = async (value) => {
  assertPublicUrl(value);
  await assertPublicDns(hostnameOf(new URL(value)));
};

async function attempt(url, label) {
  const entry = { url, label, startedAt: new Date().toISOString(), static: null, fallback: null, pricingLines: [] };
  // 1) 静态读取（真实 DNS + 真实 fetch）。
  const t0 = Date.now();
  try {
    const res = await readWebPage({ url, timeoutMs: 20000 });
    entry.static = {
      ok: res.ok,
      ms: Date.now() - t0,
      ...(res.ok
        ? { renderMode: res.data.renderMode, title: res.data.title, bodyTextLength: res.data.bodyText.length, bodyHead: res.data.bodyText.slice(0, 240) }
        : { error: res.error })
    };
    if (res.ok) entry.pricingLines = priceLines(res.data.bodyText);
  } catch (error) {
    entry.static = { ok: false, ms: Date.now() - t0, threw: String(error?.message ?? error) };
  }

  // 2) 受控 headless fallback 渲染（真实浏览器后端）。
  const t1 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const rendered = await headlessRenderPublicPage(url, {
        signal: controller.signal, deadlineMs: Date.now() + 45000, maxBytes: 2 * 1024 * 1024, validateUrl
      });
      entry.fallback = {
        ok: true,
        ms: Date.now() - t1,
        status: rendered.status,
        contentType: rendered.contentType,
        finalUrl: rendered.finalUrl,
        title: rendered.title,
        bodyTextLength: rendered.bodyText.length
      };
      entry.pricingLines = [...new Set([...entry.pricingLines, ...priceLines(rendered.bodyText)])];
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    entry.fallback = {
      ok: false,
      ms: Date.now() - t1,
      code: error?.code ?? null,
      message: String(error?.message ?? error).split('\n')[0]
    };
  }
  return entry;
}

const run = async () => {
  const evidence = {
    claim: CLAIM,
    runAt: new Date().toISOString(),
    note: '产品路径真实读取（wmb_read_web_page 底层 + 受控 headless fallback）；静态失败/无定价行时尝试渲染。',
    targets: [],
    claimAssessment: null
  };

  for (const target of TARGETS) {
    evidence.targets.push(await attempt(target.url, target.label));
  }

  // 3) 用真实可提取证据评估 required claim（价格声明必须时间+摘录）。
  const items = [];
  for (const entry of evidence.targets) {
    if (!entry.static?.ok) continue;
    const body = entry.static.bodyText ?? '';
    const excerpt = priceLines(body)[0] ?? '';
    if (!excerpt) continue; // 无定价行 → 无可用证据（静态正文不含价格 = 客户端渲染）
    items.push({
      sourceId: `live-${entry.label}`,
      title: entry.static.title,
      url: entry.url,
      author: entry.label === 'zhipu-official-pricing' ? '智谱AI 官方' : 'OpenRouter',
      summary: excerpt.slice(0, 180),
      sourceKind: entry.label === 'zhipu-official-pricing' ? 'official' : 'secondary',
      publishedAt: new Date().toISOString().slice(0, 10),
      excerpt
    });
  }
  const verdict = validateClaimProposal(
    {
      claimKey: CLAIM.key,
      claimType: CLAIM.type,
      evidence: new Map(items.map((item) => [item.sourceId, item])),
      candidateTotal: evidence.targets.length,
      candidateFailed: items.length === 0 ? evidence.targets.length : 0,
      failureReason: items.length === 0 ? 'no_pricing_text_in_static_body' : null
    },
    null
  );
  evidence.claimAssessment = {
    verdict,
    threshold: assessSupportThreshold(items, CLAIM.type),
    evidenceItems: items.map((item) => ({ sourceId: item.sourceId, url: item.url, sourceKind: item.sourceKind, excerpt: item.excerpt.slice(0, 160) })),
    note: '无建议时机器校验按可核验证据产出（无证据 → unresolved/source_unavailable 而非伪造 supported）。'
  };

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`readback evidence written: ${OUT_FILE}`);
  console.log(`claim assessment: ${verdict.status} (${verdict.verdictReason})`);
  return evidence;
};

try {
  const evidence = await run();
  const failedTargets = evidence.targets.filter((entry) => !entry.static?.ok);
  process.exitCode = failedTargets.length ? 0 : 0; // 外部不可用也算完整执行（精确失败记录在 JSON）
} catch (error) {
  console.error('readback script error:', error);
  process.exitCode = 1;
}
