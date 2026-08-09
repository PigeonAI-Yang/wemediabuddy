/**
 * Real-user walkthrough over live Electron via CDP.
 * Produces screenshots + JSON report. Does not claim pass without UI evidence.
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'walkthrough-out');
const CDP = process.env.WMB_CDP || 'http://127.0.0.1:9222';

const NAV = [
  { id: 'today', label: /今日/ },
  { id: 'agents', label: /智能体/ },
  { id: 'discover', label: /发现/ },
  { id: 'proposals', label: /选题/ },
  { id: 'studio', label: /创作/ },
  { id: 'publish', label: /发布/ },
  { id: 'results', label: /结果/ },
  { id: 'topic', label: /主题/ },
  { id: 'library', label: /资料库/ },
  { id: 'canvas', label: /关系画布|画布/ },
  { id: 'settings', label: /设置/ }
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function textSnapshot(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    const active = [...document.querySelectorAll('button.active, nav button[aria-current], .sidebar button.active')]
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    const headlines = [...document.querySelectorAll('h1,h2,.today-command-line,.empty-state h2')]
      .slice(0, 12)
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    const errors = [...document.querySelectorAll('[role="alert"], .callout.danger, .agents-callout.danger, .task-status[data-failed="true"]')]
      .map((el) => el.textContent?.trim())
      .filter((text) => text && !/^删除$/.test(text) && text.length > 1)
      .slice(0, 8);
    const buttons = [...document.querySelectorAll('button')]
      .map((el) => el.textContent?.trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 40);
    return {
      title: document.title,
      activeNav: active,
      headlines,
      errors,
      buttons,
      bodyPreview: body.replace(/\s+/g, ' ').trim().slice(0, 1200)
    };
  });
}

async function ensureWorkbench(page) {
  // 设置全屏模式会藏侧栏
  const back = page.getByRole('button', { name: /返回工作台/ }).first();
  if (await back.count() && await back.isVisible().catch(() => false)) {
    await back.click({ timeout: 5000 }).catch(() => {});
    await sleep(600);
  }
}

async function clickNav(page, label) {
  await ensureWorkbench(page);
  const clicked = await page.evaluate((source) => {
    const re = new RegExp(source);
    const buttons = [...document.querySelectorAll('.sidebar button, nav button, aside button, button[title]')];
    for (const btn of buttons) {
      const text = `${btn.getAttribute('title') || ''} ${btn.textContent || ''}`.trim();
      if (!re.test(text)) continue;
      btn.click();
      return text;
    }
    return null;
  }, label.source);
  if (clicked) {
    await sleep(900);
    return clicked;
  }
  const byRole = page.getByRole('button', { name: label }).first();
  if (await byRole.count()) {
    await byRole.click({ timeout: 5000, force: true });
    await sleep(900);
    return 'role';
  }
  throw new Error(`nav not found: ${label}`);
}

async function tryClick(page, names) {
  for (const name of names) {
    const loc = page.getByRole('button', { name }).first();
    if (await loc.count()) {
      const enabled = await loc.isEnabled().catch(() => false);
      const visible = await loc.isVisible().catch(() => false);
      if (enabled && visible) {
        await loc.click({ timeout: 4000 }).catch(() => {});
        await sleep(1000);
        return name;
      }
    }
  }
  return null;
}

const report = {
  startedAt: new Date().toISOString(),
  cdp: CDP,
  steps: [],
  blockers: [],
  summary: null
};

await mkdir(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
if (!context) throw new Error('no electron context');
let page = null;
for (const candidate of context.pages()) {
  const ok = await candidate.evaluate(() => /今日|智能体|设置/.test(document.body?.innerText || '')).catch(() => false);
  if (ok) { page = candidate; break; }
}
if (!page) page = context.pages().find((p) => /27391|wmb|index\.html|localhost/i.test(p.url())) || context.pages()[0];
if (!page) page = await context.newPage();
await page.bringToFront().catch(() => {});

// wait UI
for (let i = 0; i < 30; i++) {
  const ready = await page.evaluate(() => Boolean(document.body && document.body.innerText.length > 20)).catch(() => false);
  if (ready) break;
  await sleep(500);
}

report.steps.push({
  id: 'boot',
  ok: true,
  url: page.url(),
  snap: await textSnapshot(page),
  shot: await shot(page, '00-boot')
});

for (const nav of NAV) {
  const step = { id: nav.id, ok: false, action: null, snap: null, shot: null, error: null };
  try {
    step.action = await clickNav(page, nav.label);
    await sleep(600);
    step.snap = await textSnapshot(page);
    step.shot = await shot(page, `nav-${nav.id}`);
    // page-specific light interactions
    if (nav.id === 'today') {
      const clicked = await tryClick(page, [
        /继续生成方案/,
        /继续今日情报/,
        /生成今日方案/,
        /开始今日情报/,
        /刷新/
      ]);
      step.todayClick = clicked;
      await sleep(1500);
      step.snapAfter = await textSnapshot(page);
      step.shotAfter = await shot(page, 'nav-today-after-cta');
      if (step.snapAfter?.errors?.length) {
        report.blockers.push({ where: 'today', errors: step.snapAfter.errors });
      }
    }
    if (nav.id === 'agents') {
      step.snap = await textSnapshot(page);
      const body = step.snap.bodyPreview || '';
      if (/主管冲突|被任务占用/.test(body) && /策划/.test(body) && /主编席/.test(body)) {
        // only flag if desk shows daily_judge-ish occupation text without dock
        step.note = 'check seat labels carefully';
      }
      // detect desk occupied while planner running text
      if (/主编席/.test(body) && /被任务占用|主管 占用/.test(body) && /daily_judge|策划[\s\S]{0,40}执行中/.test(body)) {
        report.blockers.push({ where: 'agents', issue: 'possible desk/planner seat confusion', body: body.slice(0, 400) });
      }
    }
    if (nav.id === 'studio') {
      await tryClick(page, [/新建/, /创建项目/, /开始写作/]);
      await sleep(800);
      step.snapAfter = await textSnapshot(page);
      step.shotAfter = await shot(page, 'nav-studio-after');
    }
    if (nav.id === 'settings') {
      step.snap = await textSnapshot(page);
    }
    // generic error harvest
    if (step.snap?.errors?.length) {
      report.blockers.push({ where: nav.id, errors: step.snap.errors });
    }
    // blank / crash signals
    if (!step.snap?.bodyPreview || step.snap.bodyPreview.length < 30) {
      report.blockers.push({ where: nav.id, issue: 'near-empty page body' });
      step.ok = false;
      step.error = 'empty body';
    } else {
      step.ok = true;
    }
  } catch (error) {
    step.error = error instanceof Error ? error.message : String(error);
    report.blockers.push({ where: nav.id, error: step.error });
    step.shot = await shot(page, `nav-${nav.id}-error`).catch(() => null);
  }
  report.steps.push(step);
}

// return today for final state
try {
  await clickNav(page, /今日/);
  await sleep(800);
  report.steps.push({
    id: 'final-today',
    ok: true,
    snap: await textSnapshot(page),
    shot: await shot(page, '99-final-today')
  });
} catch (error) {
  report.blockers.push({ where: 'final-today', error: String(error) });
}

report.finishedAt = new Date().toISOString();
report.summary = {
  pagesTried: NAV.length,
  pagesOk: report.steps.filter((s) => s.id !== 'boot' && s.id !== 'final-today' && s.ok).length,
  blockers: report.blockers.length,
  blockerWhere: [...new Set(report.blockers.map((b) => b.where))]
};

const reportPath = path.join(OUT, 'report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report.summary, null, 2));
console.log('report', reportPath);
console.log('blockers', report.blockers);
// keep browser connected (do not close electron)
await browser.close().catch(() => {});
process.exit(report.blockers.length ? 2 : 0);
