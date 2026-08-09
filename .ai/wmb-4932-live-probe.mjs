// WMB-4932 live Electron acceptance probe: Today editor desk (A1/A2/B4).
// Uses the repo's established acceptance pattern (see wmb-1506/wmb-1905):
//   fixture data root + isolated userData -> spawn dev electron with
//   WMB_ACCEPTANCE_* env -> attach over CDP -> assert Today DOM -> screenshots.
// No real user data is touched: the fixture root/userData live in a temp dir.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { migrateDatabase } from '../src/main/db/migrations.ts';

const CDP = 9366;
const OUT = (name) => path.join(process.cwd(), '.ai', name);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wmb-4932-probe-'));
const root = path.join(tmp, 'root');
const userData = path.join(tmp, 'userData');
for (const dir of [root, userData, path.join(root, 'assets'), path.join(root, 'browser-profile'), path.join(root, 'logs'), path.join(root, 'exports')]) mkdirSync(dir, { recursive: true });

// ---- fixture seed ---------------------------------------------------------
const nowIso = new Date().toISOString();
const shanghaiDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const today = shanghaiDate();
const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 24 * 3600_000));
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600_000).toISOString();

const database = migrateDatabase(path.join(root, 'wmb.db'));
// app identity + workspace profile (official.ai template values from workspace-profiles.ts)
database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-4932-fixture', ?, ?, 1)`).run(nowIso, nowIso);
database.prepare(`INSERT INTO workspace_profiles (id, profile_id, revision, official_template_id, official_template_version,
  display_name, audience, content_goal, editorial_brief, intelligence_pack_id, intelligence_pack_version,
  creation_pack_id, creation_pack_version, platforms_json, created_at, updated_at)
  VALUES ('effective', 'profile.ai.official', 1, 'official.ai', 1, 'AI', '关注 AI 工具、行业、开发和商业机会的中文受众',
  '持续发现并做出有判断、有证据、可执行的 AI 内容', '优先官方发布、真实实测和受众正在遇到的问题；机会按 SSS 至 F 保留全部合格结果。',
  'wemedia-intelligence-engine', 1, 'wmb-core-creation', 1, '["x","xiaohongshu","wechat"]', ?, ?)`).run(nowIso, nowIso);

// topics
database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('t-1', '英国移民规则', nowIso, nowIso);
database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('t-2', 'AI 写作工具', nowIso, nowIso);

// plans: yesterday (is_current=0, seed for carry origin) + today (is_current=1, chair pool source)
database.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision)
  VALUES ('plan-y0', ?, '+08:00', '昨日方案（探针夹具）', 0, ?, ?, 1)`).run(yesterday, daysAgo(1), daysAgo(1));
database.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision)
  VALUES ('plan-t0', ?, '+08:00', '今日运营方案（探针夹具）', 1, ?, ?, 1)`).run(today, nowIso, nowIso);

const PI_COLS = `(id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view,
  platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate,
  source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)`;
const insPlanItem = database.prepare(`INSERT INTO plan_items ${PI_COLS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
insPlanItem.run('pi-y0', 'plan-y0', 't-1', '英国移民规则又更新：HC 259 配偶签证收入门槛', 1, '政策后续未出，需持续跟进官方细则', '热点',
  '准备赴英/在英华人', '解读新规对配偶签证申请的实际影响', '第一人称',
  '["x","xiaohongshu"]', '["text"]', '用问答体拆解门槛变化', '先给结论，再列证据', '按影响人群分段', '1 小时',
  '["s1"]', '[]', '[]', 0, daysAgo(1), daysAgo(1));
insPlanItem.run('pi-1', 'plan-t0', 't-2', 'AI 写作工具实测：周报级工作流对比', 0, '多个写作工具本周集中更新，实测结论有稀缺性', '长青',
  'AI 工具使用者', '用同一篇周报跑通各家工具，给出可复现对比', '第一人称',
  '["x","xiaohongshu","wechat"]', '["text"]', '对比表格 + 实测动图', '先给结论：本周最值得换的工具', '分工具分节，结尾给推荐组合', '3 小时',
  '["s2","s3"]', '[]', '[]', 0, nowIso, nowIso);
insPlanItem.run('pi-2', 'plan-t0', null, '智能体工作台：Claude Code 与 Codex 双端一致实践', 1, '双端工作台迁移是高频问题', '长青',
  '开发者', '把审计规则文件、统一命名、bridge 生成的全流程写成清单', '第三人称',
  '["x"]', '["text"]', '清单体 + 目录截图', '先给三张截图，再给步骤', '按迁移顺序分六步', '2 小时',
  '["s4"]', '[]', '[]', 1, nowIso, nowIso);
insPlanItem.run('pi-3', 'plan-t0', null, 'AI 热点日报自动化生产复盘', 2, '日报流程沉淀成方法论', '长青',
  '内容运营', '把扫描到发布的闭环拆成可复用模板', '第三人称',
  '["xiaohongshu"]', '["text"]', '流程图 + 时间线', '先给流程图', '按阶段复盘', '2 小时',
  '["s4"]', '[]', '[]', 2, nowIso, nowIso);

// source items (today's intake -> feed; s1 also referenced by yesterday's plan item)
const insSource = database.prepare(`INSERT INTO source_items (id, canonical_url, content_fingerprint, title, author, published_at, collected_at,
  summary, categories_json, keywords_json, recommended_platforms_json, recommended_formats_json, timeliness, priority,
  created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
insSource.run('s1', 'https://example.com/hc259-faq', 'fp-s1', '内政部发布 HC 259 后续问答', 'gov.uk', daysAgo(6), daysAgo(6),
  '配偶签证收入证明细则落地', '["政策"]', '["移民","配偶签证"]', '["x"]', '["text"]', '热点', 0, daysAgo(6), daysAgo(6));
const todayNoon = `${today}T10:00:00.000+08:00`;
insSource.run('s2', 'https://example.com/ai-writer-weekly', 'fp-s2', 'AI 写作工具周报：本周集中更新一览', '实测组', daysAgo(1), todayNoon,
  '五款写作工具本周上新', '["AI 工具"]', '["写作","评测"]', '["x","xiaohongshu"]', '["text"]', '长青', 1, todayNoon, todayNoon);
insSource.run('s3', 'https://example.com/ai-writer-bench', 'fp-s3', '同一篇周报跑通六家写作工具', '实测组', daysAgo(1), todayNoon,
  '可复现的写作工具对比基准', '["AI 工具"]', '["写作","评测"]', '["x","xiaohongshu"]', '["text"]', '长青', 1, todayNoon, todayNoon);
insSource.run('s4', 'https://example.com/agent-workbench', 'fp-s4', 'Agent 工作台迁移清单：双端一致', '社区实践', daysAgo(1), todayNoon,
  '规则文件审计与 bridge 生成流程', '["AI 工具"]', '["Agent","工作台"]', '["x"]', '["text"]', '长青', 2, todayNoon, todayNoon);
insSource.run('s5', 'https://example.com/agent-observe', 'fp-s5', 'Agent 工作台迁移实践观察帖', '社区实践', daysAgo(2), todayNoon,
  '双端工作台迁移的社区案例与踩坑记录', '["AI 工具"]', '["Agent","工作台"]', '["x"]', '["text"]', '长青', 2, todayNoon, todayNoon);

// work_carry_items: 2 active (fermenting rail, aftershock >= 1) + 1 watching (观察中 count)
const carryCols = `(id, object_type, object_id, fingerprint, title, state, priority, topic_id, source_ids_json,
  origin_plan_date, first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision)`;
const insCarry = database.prepare(`INSERT INTO work_carry_items ${carryCols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
insCarry.run('carry-1', 'plan_item', 'pi-y0', 'fp-carry-1', '英国移民规则又更新：HC 259 配偶签证门槛', 'active', 1, 't-1', '["s1"]',
  yesterday, daysAgo(6), daysAgo(1), daysAgo(-7), 1, '未完结影响：政策后续未出',
  JSON.stringify([{ sourceId: 's1', title: '内政部发布 HC 259 后续问答，配偶签证收入证明细则落地', collectedAt: daysAgo(6) }]), daysAgo(6), daysAgo(1));
insCarry.run('carry-2', 'source', 's5', 'fp-carry-2', 'Agent 工作台双端迁移实践观察', 'active', 2, null, '["s5"]',
  yesterday, daysAgo(3), daysAgo(1), daysAgo(-7), 0.8, '高优先级机会，持续关注',
  JSON.stringify([{ sourceId: 's5', title: '社区新增双端一致性检查清单', collectedAt: daysAgo(2) }]), daysAgo(3), daysAgo(1));
insCarry.run('carry-3', 'source', 's5', 'fp-carry-3', 'AI 写作工具榜单更迭观察', 'watching', 3, null, '[]',
  yesterday, daysAgo(4), daysAgo(2), daysAgo(-5), 0.5, null, '[]', daysAgo(4), daysAgo(2));
const dayStart = `${today}T00:00:00.000+08:00`;
const dayEnd = `${today}T23:59:59.999+08:00`;
const todaySources = database.prepare('SELECT COUNT(*) AS total FROM source_items WHERE collected_at >= ? AND collected_at <= ?').get(dayStart, dayEnd);
console.log(`[fixture] planDate=${today} todaySources=${todaySources.total} (${dayStart}..${dayEnd})`);
database.close();

// data-root + workspace registry (mirrors real userData shape)
writeFileSync(path.join(userData, 'data-root.json'), JSON.stringify({ path: root }));
writeFileSync(path.join(userData, 'workspace-registry.json'), JSON.stringify({
  version: 1,
  activeWorkspaceId: 'ws-4932-fixture',
  workspaces: [{ id: 'ws-4932-fixture', displayName: 'AI', rootPath: root }],
  switchJournal: null
}));

// ---- launch acceptance instance -------------------------------------------
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(CDP), WMB_ACCEPTANCE_USER_DATA: userData, WMB_ACCEPTANCE_HEADLESS: '1' };
const electronBin = new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(electronBin, ['.'], { env, cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', () => {});
const cleanup = () => {
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});
let cdpUp = false;
for (let i = 0; i < 240; i++) {
  try { await getJson('/json/version'); cdpUp = true; break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!cdpUp) throw new Error('CDP 未在 240s 内就绪');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
const context = browser.contexts()[0];
let page = context?.pages()[0] ?? null;
for (let i = 0; i < 60 && !page; i++) {
  await new Promise((r) => setTimeout(r, 500));
  page = context?.pages()[0] ?? null;
}
if (!page) throw new Error('Electron 窗口页面未在 30s 内出现');
const pageLoaded = async () => {
  await page.waitForSelector('.today-layout', { state: 'attached', timeout: 60000 }).catch(() => null);
  if (!(await page.$('.today-layout'))) {
    const todayBtn = await page.$('.sidebar button[title="今日"]');
    if (todayBtn) { await todayBtn.click(); await page.waitForSelector('.today-layout', { state: 'attached', timeout: 30000 }).catch(() => {}); }
  }
};
await pageLoaded();
// give getToday / fermenting data a moment to render
await page.waitForSelector('.today-opps', { state: 'attached', timeout: 30000 });
await page.waitForTimeout(1200);

const readState = () => page.evaluate(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  return {
    chairCards: document.querySelectorAll('.today-opps [data-opportunity-card]').length,
    chairEmpty: Boolean(document.querySelector('.today-opps .empty-state')),
    railLabel: document.querySelector('.fermenting-rail')?.getAttribute('aria-label') ?? null,
    railTitle: text('.fermenting-head h2'),
    railRows: document.querySelectorAll('.fermenting-row').length,
    railFirstMeta: text('.fermenting-row .fermenting-row-meta'),
    watchingText: text('.fermenting-watching-count'),
    commandMode: document.querySelector('.today-command')?.getAttribute('data-mode') ?? null,
    headline: text('.today-command-line') ?? text('.today-command-run-title strong'),
    primaryCta: text('.today-command .primary-button'),
    blockers: document.querySelectorAll('.action-card-button').length,
    emptyTitle: text('.today-opps .empty-state h2')
  };
});

const idle = await readState();
const screenshotIdle = OUT('wmb-4932-live-today.png');
await page.screenshot({ path: screenshotIdle });

// ---- A1: start a new intelligence run, chair must survive running/partial ----
let dialogAccepted = false;
const onDialog = async (dialog) => { dialogAccepted = true; await dialog.accept().catch(() => {}); };
page.on('dialog', onDialog);
const runSamples = [];
let runningSeen = false;
const a1 = { ok: false, runningSeen: false, dialogAccepted: false, settle: null, samples: 0 };

if (idle.primaryCta) {
  const primaryBtn = await page.$('.today-command .primary-button');
  // dialog auto-accept; sample tightly to catch the brief running phase, then
  // fire the screenshot the moment the DOM reports running (no serialization before sampling).
  const screenshotRunning = OUT('wmb-4932-live-today-running.png');
  let shotPromise = null;
  await primaryBtn.click();
  for (let i = 0; i < 60; i++) {
    const s = await readState();
    runSamples.push({ mode: s.commandMode, chairs: s.chairCards, empty: s.chairEmpty, headline: s.headline });
    if (s.commandMode === 'running') {
      runningSeen = true;
      if (!shotPromise) shotPromise = page.screenshot({ path: screenshotRunning }).catch(() => {});
    }
    await page.waitForTimeout(10);
    if (s.commandMode !== 'running' && runSamples.length > 8) break;
  }
  if (!shotPromise) shotPromise = page.screenshot({ path: screenshotRunning }).catch(() => {});
  await shotPromise;
  // settle: wait until the task state lands (needs_user/failed/partial/done)
  let settled = null;
  for (let i = 0; i < 60; i++) {
    const s = await readState();
    if (s.commandMode === 'idle') { settled = s; break; }
    await page.waitForTimeout(500);
  }
  settled ??= await readState();
  a1.dialogAccepted = dialogAccepted;
  a1.runningSeen = runningSeen;
  a1.samples = runSamples.length;
  a1.settle = settled;
  a1.ok = runSamples.every((s) => s.chairs >= 1 && !s.empty) && settled.chairCards >= 1 && !settled.chairEmpty;
  const screenshotSettled = OUT('wmb-4932-live-today-after.png');
  await page.screenshot({ path: screenshotSettled });
} else {
  a1.settle = idle;
  a1.ok = false;
}

page.off('dialog', onDialog);
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));

// ---- verdicts --------------------------------------------------------------
const checks = {
  B4_rail_title: { pass: idle.railLabel === '持续关注' && /^持续关注 · [1-9]/.test(idle.railTitle ?? ''), actual: `${idle.railLabel} / ${idle.railTitle}` },
  B4_rail_cards: { pass: idle.railRows >= 2 && /为何关注：/.test(idle.railFirstMeta ?? '') && /最新进展：/.test(idle.railFirstMeta ?? ''), actual: `${idle.railRows} rows; meta=${idle.railFirstMeta}` },
  B4_watching: { pass: idle.watchingText === '观察中 · 1', actual: idle.watchingText },
  A2_chair_visible: { pass: idle.chairCards >= 1 && !idle.chairEmpty, actual: `${idle.chairCards} cards; empty=${idle.chairEmpty}` },
  A2_idle_cmd: { pass: idle.commandMode === 'idle' && idle.headline === '今日运营方案已就绪' && idle.primaryCta === '重新侦察', actual: `${idle.commandMode} / ${idle.headline} / ${idle.primaryCta}` },
  A1_run_preserves_chair: { pass: a1.ok && a1.runningSeen, actual: `runningSeen=${a1.runningSeen}; samples=${a1.samples}; settle=${a1.settle?.commandMode} chairs=${a1.settle?.chairs} empty=${a1.settle?.chairEmpty} headline=${a1.settle?.headline} blockers=${a1.settle?.blockers} dialog=${a1.dialogAccepted}` }
};

const result = {
  ok: Object.values(checks).every((c) => c.pass),
  fixture: { root, userData, cdpPort: CDP, planDate: today },
  checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, `${v.pass ? 'PASS' : 'FAIL'}${v.actual ? ` — ${v.actual}` : ''}`])),
  a1,
  screenshots: { idle: screenshotIdle, running: OUT('wmb-4932-live-today-running.png'), after: OUT('wmb-4932-live-today-after.png') },
  runSamples
};
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
