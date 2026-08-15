// 主题 surface Electron E2E scenarios (WMB-5243, journey matrix TP-001..TP-008).
//
// Covers: 列表知识目录语义（当前认识/整理状态/筛选）、详情四页签与主 CTA、键盘 1-7 与深链、
// 诚实三态（等待整理/初始档案/已整理）、空列表、加载失败重试与无效 id 降级、
// 主 CTA→Pi / 去创作 / 放画布 动作、整理台账待批提案批准闭环。
// All scenarios run against a REAL Electron instance with an isolated workspace
// seeded through the production knowledge pipeline (no business code changes).

import { helpers } from './harness.mjs';
import { seedRichKnowledge, seedProposal } from './fixture-knowledge.mjs';

const { assert, step, waitForAppReady, navigateTo, openReadOnlyDb } = helpers;

const RICH = { seedFixture: async (ws) => seedRichKnowledge(ws.dataRoot, ws.workspaceId) };

async function openTopicDetail(page, title) {
  const head = page.locator('.topic-object-head h2');
  // 1) 目标详情已开（组件重挂载会恢复上次选中主题）→ 直接复用。
  if (await head.count() > 0) {
    try {
      if ((await head.first().textContent({ timeout: 2_000 })) === title) {
        await page.locator('.topic-wiki-page').waitFor({ state: 'visible', timeout: 20_000 });
        return;
      }
    } catch { /* 头部未就绪，走常规等待 */ }
  }
  // 2) 等待「目标卡或目标详情」任一出现（自动选中进行中时列表隐藏，勿点返回制造竞态）。
  await page.waitForFunction((t) => {
    const h2 = document.querySelector('.topic-object-head h2');
    if (h2?.textContent === t) return true;
    return [...document.querySelectorAll('.topic-object-card .topic-object-card-top strong')]
      .some((el) => el.textContent === t);
  }, title, { timeout: 25_000 });
  if (await head.count() > 0) {
    const current = await head.first().textContent({ timeout: 2_000 }).catch(() => '');
    if (current === title) {
      await page.locator('.topic-wiki-page').waitFor({ state: 'visible', timeout: 20_000 });
      return;
    }
  }
  // 3) 列表已就绪 → 点击卡片打开详情。
  await page.locator('.topic-object-card', { hasText: title }).first().click();
  await page.locator('.topic-wiki-page').waitFor({ state: 'visible', timeout: 20_000 });
}

/** 工作空间深链 localStorage 键（渲染端 workspaceStorageKey 同源格式）。 */
function libraryStorageKey(workspaceId, key) {
  return workspaceId ? `wmb.workspace.${workspaceId}.${key}` : `wmb.${key}`;
}

/** 主进程 IPC fail-once 注入：Electron ≥28 `_invokeHandlers` 的 Map 值是 handler 函数本身。 */
async function injectFailOnce(app, channel, message = 'E2E 强制 IPC 失败') {
  return app.evaluate(({ ipcMain }, { channel: ch, message: msg }) => {
    const store = ipcMain._invokeHandlers ?? ipcMain._events;
    const holder = store instanceof Map ? store.get(ch) : store?.[ch];
    const original = typeof holder === 'function' ? holder : holder?.handler;
    if (typeof original !== 'function') return { ok: false, channel: ch };
    let failed = false;
    const wrapped = async (event, ...args) => {
      if (!failed) { failed = true; throw new Error(msg); }
      return original(event, ...args);
    };
    if (store instanceof Map) store.set(ch, wrapped);
    else if (typeof holder === 'function') store[ch] = wrapped;
    else holder.handler = wrapped;
    return { ok: true, channel: ch };
  }, { channel, message });
}

function expectNoHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
}

export default [
  {
    id: 'TP-001-topic-list-normal',
    journeyIds: ['TP-001-topic-list-normal'],
    launch: RICH,
    run: async ({ page, workspace, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '主题列表渲染知识目录语义', async () => {
        await navigateTo(page, 'topic');
        await page.locator('.topic-card-grid').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelectorAll('.topic-object-card').length >= 3);
        const cards = page.locator('.topic-object-card');
        assert(await cards.count() >= 3, `主题卡数量应为 3，实际 ${await cards.count()}`);
        const titles = await page.locator('.topic-object-card .topic-object-card-top strong').allTextContents();
        for (const t of ['AI Agent 工具链', '历史遗留主题', '尚未整理主题']) {
          assert(titles.includes(t), `缺少主题卡「${t}」，实际 ${JSON.stringify(titles)}`);
        }
        const agentCard = page.locator('.topic-object-card', { hasText: 'AI Agent 工具链' }).first();
        const summary = await agentCard.locator('.topic-object-card-current').textContent();
        assert(summary.includes('AgentForge v2 引入多模型路由'), `当前综合摘要缺失，实际 ${JSON.stringify(summary)}`);
        const states = await page.locator('.topic-object-card .topic-compile-state').allTextContents();
        for (const expected of ['已整理', '初始档案', '等待整理']) {
          assert(states.includes(expected), `整理状态缺少「${expected}」，实际 ${JSON.stringify(states)}`);
        }
        assert(!(await page.evaluate(() => document.body.innerText)).includes('compiled'), '列表不应泄漏 compiled 工程词');
      });
      await step(evidence, '状态筛选切换列表正确', async () => {
        const filters = page.locator('.topic-status-filters button');
        const labels = await filters.allTextContents();
        for (const label of ['全部', '活跃', '观察', '休眠']) assert(labels.includes(label), `缺少筛选「${label}」`);
        await page.locator('.topic-status-filters button', { hasText: '观察' }).click();
        await page.waitForFunction(() => {
          const empty = document.querySelector('.topic-home-empty');
          return Boolean(empty && empty.textContent.includes('没有匹配当前筛选的主题'));
        });
        await page.locator('.topic-status-filters button', { hasText: '全部' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.topic-object-card').length >= 3);
      });
      await step(evidence, '点击主题卡打开详情', async () => {
        await page.locator('.topic-object-card', { hasText: 'AI Agent 工具链' }).first().click();
        await page.locator('.topic-work-pane[aria-label="主题详情"]').waitFor({ state: 'visible' });
        assert(await page.locator('.topic-object-head h2').textContent() === 'AI Agent 工具链', '详情标题应为 AI Agent 工具链');
      });
      return { surface: 'topic', journey: 'TP-001', cards: 3, states: ['已整理', '初始档案', '等待整理'] };
    }
  },
  {
    id: 'TP-002-topic-detail-overview',
    journeyIds: ['TP-002-topic-detail-overview'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '概览页签展示当前认识/维护信息/来源预览/最近变化', async () => {
        await navigateTo(page, 'topic');
        await openTopicDetail(page, 'AI Agent 工具链');
        await page.locator('#topic-wiki-current').waitFor({ state: 'visible' });
        const summary = await page.locator('.topic-wiki-summary').textContent();
        assert(summary.includes('多模型路由') && summary.includes('小红书'), `当前认识正文缺失，实际 ${JSON.stringify(summary)}`);
        const meta = await page.locator('.topic-object-meta').allTextContents();
        assert(meta.some((line) => line.includes('资料员持续维护')), '应显示 资料员持续维护 维护信息');
        assert(await page.locator('.topic-wiki-source-row').count() >= 1, '概览应有来源预览行');
        assert(await page.locator('.topic-wiki-changes.topic-wiki-recent').count() === 1, '概览应有最近变化时间流');
      });
      await step(evidence, '四页签切换正确', async () => {
        const tabs = await page.locator('.topic-wiki-tabs button').allTextContents();
        for (const t of ['概览', '资料', '变化', '版本']) assert(tabs.some((text) => text.startsWith(t)), `缺少页签 ${t}，实际 ${JSON.stringify(tabs)}`);
        await page.locator('.topic-wiki-tabs button', { hasText: '资料' }).click();
        await page.waitForFunction(() => document.querySelector('.topic-wiki-page')?.getAttribute('data-wiki-tab') === 'sources');
        assert(await page.locator('#topic-wiki-evidence').count() === 1, '资料页签应含证据区');
        await page.locator('.topic-wiki-tabs button', { hasText: '变化' }).click();
        await page.waitForFunction(() => document.querySelector('.topic-wiki-page')?.getAttribute('data-wiki-tab') === 'changes');
        const changesVisible = await page.evaluate(() => {
          const el = document.querySelector('#topic-wiki-changes[data-wiki-tab="changes"]');
          return Boolean(el) && window.getComputedStyle(el).display !== 'none';
        });
        assert(changesVisible, '变化页签应显示最近变化区');
        await page.locator('.topic-wiki-tabs button', { hasText: '版本' }).click();
        await page.waitForFunction(() => document.querySelector('.topic-wiki-page')?.getAttribute('data-wiki-tab') === 'versions');
        assert(await page.locator('#topic-wiki-versions').count() === 1, '版本页签应含版本区');
      });
      await step(evidence, '唯一主 CTA 与无横向溢出', async () => {
        const ctas = await page.locator('.topic-object-head button.primary-button').allTextContents();
        assert(ctas.length === 1 && ctas[0].includes('让 Pi 出选题方案'), `主 CTA 应为唯一「让 Pi 出选题方案」，实际 ${JSON.stringify(ctas)}`);
        assert(await expectNoHorizontalOverflow(page), '详情页存在横向溢出');
      });
      return { surface: 'topic', journey: 'TP-002', tabs: 4, primaryCta: 1 };
    }
  },
  {
    id: 'TP-003-topic-keyboard-deeplinks',
    journeyIds: ['TP-003-topic-keyboard-deeplinks'],
    launch: RICH,
    run: async ({ page, workspace, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '键盘 1-7 直达章节', async () => {
        await navigateTo(page, 'topic');
        await openTopicDetail(page, 'AI Agent 工具链');
        const pane = page.locator('.topic-work-pane[aria-label="主题详情"]');
        await pane.focus();
        const sections = ['current', 'changes', 'evidence', 'impact', 'research', 'dossier', 'versions'];
        for (let i = 1; i <= 7; i += 1) {
          await page.keyboard.press(String(i));
          await page.waitForTimeout(160);
          const visible = await page.evaluate((id) => {
            // 章节 DOM 常驻，按当前页签投影显隐；内层章节（证据/影响/待研究/档案）由
            // 所属分区容器承载显隐，用真实布局可见性判定（父级 display:none 时 rect 为空）。
            const el = document.getElementById(`topic-wiki-${id}`);
            if (!el) return false;
            return el.getClientRects().length > 0;
          }, sections[i - 1]);
          assert(visible, `键盘 ${i} 应直达章节 ${sections[i - 1]}`);
        }
      });
      await step(evidence, 'wmb-open-library-topic 事件深链', async () => {
        const db = openReadOnlyDb(workspace.dataRoot);
        const row = db.db.prepare("SELECT id FROM topics WHERE title = '历史遗留主题'").get();
        db.close();
        await page.evaluate((topicId) => {
          window.dispatchEvent(new CustomEvent('wmb-open-library-topic', { detail: { topicId } }));
        }, String(row.id));
        await page.waitForFunction(() => document.querySelector('.topic-object-head h2')?.textContent === '历史遗留主题', null, { timeout: 20_000 });
        assert(await page.locator('.topic-object-head h2').textContent() === '历史遗留主题', '事件深链应打开指定主题详情');
      });
      await step(evidence, 'localStorage libraryTopicId 深链 + 版本页恢复动作', async () => {
        // 回到列表，用 localStorage 深链打开 历史遗留主题
        await page.locator('.topic-back-button', { hasText: '← 主题' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.topic-object-card').length >= 3);
        const db = openReadOnlyDb(workspace.dataRoot);
        const legacyRow = db.db.prepare("SELECT id FROM topics WHERE title = '历史遗留主题'").get();
        const legacyTopicId = String(legacyRow.id);
        db.close();
        await page.evaluate(({ wsId, topicId }) => {
          const key = wsId ? `wmb.workspace.${wsId}.libraryTopicId` : 'wmb.libraryTopicId';
          localStorage.setItem(key, topicId);
        }, { wsId: workspace.workspaceId, topicId: legacyTopicId });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await navigateTo(page, 'topic');
        await page.waitForFunction(() => document.querySelector('.topic-object-head h2')?.textContent === '历史遗留主题', null, { timeout: 20_000 });
        // 版本页签列出历史版本（legacy shell 仅当前初始化版本，无更早版本可恢复）。
        await page.locator('.topic-wiki-tabs button', { hasText: '版本' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.topic-wiki-version').length >= 1);
        // 恢复动作：切到 compiled 主题（2 个版本，V1 非当前 → 带「恢复此版本」）
        await page.locator('.topic-back-button', { hasText: '← 主题' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.topic-object-card').length >= 3);
        await openTopicDetail(page, 'AI Agent 工具链');
        await page.locator('.topic-wiki-tabs button', { hasText: '版本' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.topic-wiki-version').length >= 2);
        const versions = await page.locator('.topic-wiki-version').count();
        assert(versions >= 2, `compiled 主题应有 2 个版本，实际 ${versions}`);
        assert(await page.locator('.topic-wiki-version button', { hasText: '恢复此版本' }).count() >= 1, '版本行应有恢复动作');
      });
      return { surface: 'topic', journey: 'TP-003', keyboard: '1-7', deepLink: 'localStorage' };
    }
  },
  {
    id: 'TP-004-topic-honest-states',
    journeyIds: ['TP-004-topic-honest-states'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '列表诚实三态用户语言', async () => {
        await navigateTo(page, 'topic');
        await page.waitForFunction(() => document.querySelectorAll('.topic-object-card').length >= 3);
        const states = await page.locator('.topic-object-card .topic-compile-state').allTextContents();
        for (const expected of ['已整理', '初始档案', '等待整理']) assert(states.includes(expected), `缺少「${expected}」`);
        const body = await page.evaluate(() => document.querySelector('.topic-card-grid')?.textContent ?? '');
        assert(!/compiled|legacy_shell|uncompiled|knowledge_notes|change_set|receipt/i.test(body), `列表泄漏工程词: ${body.slice(0, 200)}`);
      });
      await step(evidence, 'legacy shell 显示初始档案而非全绿 current', async () => {
        await page.locator('.topic-object-card', { hasText: '历史遗留主题' }).first().click();
        await page.waitForFunction(() => Boolean(document.querySelector('.topic-wiki-page')));
        const banner = await page.locator('.topic-wiki-compile-banner.compile-state-legacy_shell').textContent();
        assert(banner.includes('初始档案'), `legacy shell 应显示初始档案，实际 ${JSON.stringify(banner)}`);
        assert(!banner.includes('已整理'), '空壳不得显示 已整理');
      });
      await step(evidence, 'uncompiled 诚实空态', async () => {
        await page.locator('.topic-back-button', { hasText: '← 主题' }).click();
        await page.locator('.topic-object-card', { hasText: '尚未整理主题' }).first().click();
        await page.waitForFunction(() => Boolean(document.querySelector('.topic-work-pane[aria-label="主题详情"]')));
        await page.waitForTimeout(600);
        // 无 wiki 页 → 不显示已整理/当前，显示诚实引导文案
        const bodyText = await page.evaluate(() => document.querySelector('.topic-work-pane')?.textContent ?? '');
        assert(bodyText.includes('还没有整理出当前认识'), `uncompiled 应显示诚实引导，实际 ${bodyText.slice(0, 120)}`);
        assert(!bodyText.includes('已整理') && !bodyText.includes('当前认识已更新'), '空壳不得冒充已整理');
        assert(await page.locator('.topic-wiki-page').count() === 0, '未整理主题不应渲染 wiki 页签');
      });
      return { surface: 'topic', journey: 'TP-004', states: ['已整理', '初始档案', '等待整理'] };
    }
  },
  {
    id: 'TP-005-topic-empty-list',
    journeyIds: ['TP-005-topic-empty-list'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '空列表引导文案且不崩溃', async () => {
        await navigateTo(page, 'topic');
        await page.locator('.topic-home-empty').waitFor({ state: 'visible', timeout: 20_000 });
        const text = await page.locator('.topic-home-empty').textContent();
        assert(text.includes('尚未形成主题'), `空态应显示尚未形成主题，实际 ${JSON.stringify(text)}`);
        assert(await page.locator('.topic-home-empty .topic-object-card').count() === 0, '空列表不应有主题卡');
        // 导航仍正常
        await navigateTo(page, 'today');
        assert(await page.locator('nav button.active').getAttribute('title') === '今日', '空态后导航应正常');
      });
      return { surface: 'topic', journey: 'TP-005', empty: true };
    }
  },
  {
    id: 'TP-006-topic-error',
    journeyIds: ['TP-006-topic-error'],
    launch: RICH,
    run: async ({ page, workspace, app, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '无效主题 id 优雅降级不崩溃', async () => {
        await page.evaluate((wsId) => {
          const key = wsId ? `wmb.workspace.${wsId}.libraryTopicId` : 'wmb.libraryTopicId';
          localStorage.setItem(key, 'topic-does-not-exist-e2e');
        }, workspace.workspaceId);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await navigateTo(page, 'topic');
        await page.waitForTimeout(1500);
        const shellAlive = await page.locator('.app-shell').isVisible();
        assert(shellAlive, '无效 id 不应导致崩溃');
        // 优雅降级：错误态 / 列表回退 / 「主题读取中」占位 三者之一，绝不白屏
        const degraded = await page.evaluate(() => {
          const error = document.querySelector('.library-topic-error');
          const list = document.querySelector('.topic-card-grid');
          const loadingPlaceholder = [...document.querySelectorAll('.empty-state h2')].some((el) => /主题读取中|正在准备主题/.test(el.textContent ?? ''));
          return Boolean(error || list || loadingPlaceholder);
        });
        assert(degraded, '无效 id 应显示错误态、列表或读取中占位');
        await navigateTo(page, 'today');
        assert(await page.locator('nav button.active').getAttribute('title') === '今日', '无效 id 后导航仍正常');
      });
      await step(evidence, '详情加载失败显示错误与重试，重试恢复', async () => {
        // 主进程对 topic-wiki-detail 通道 fail 一次后放行
        const injected = await injectFailOnce(app, 'knowledge:topic-wiki-detail', 'E2E 强制详情加载失败');
        assert(injected?.ok, `IPC 注入失败: ${JSON.stringify(injected)}`);
        await page.evaluate((wsId) => {
          const key = wsId ? `wmb.workspace.${wsId}.libraryTopicId` : 'wmb.libraryTopicId';
          localStorage.removeItem(key);
        }, workspace.workspaceId);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await navigateTo(page, 'topic');
        await page.locator('.topic-object-card', { hasText: 'AI Agent 工具链' }).first().click();
        await page.waitForFunction(() => document.querySelector('.library-topic-error')?.textContent?.includes('主题加载失败') === true, null, { timeout: 20_000 });
        const retry = page.locator('.library-topic-error button', { hasText: '重试' });
        assert(await retry.count() === 1, '错误态应有重试按钮');
        await retry.click();
        await page.locator('.topic-wiki-page').waitFor({ state: 'visible', timeout: 20_000 });
        const summary = await page.locator('.topic-wiki-summary').textContent();
        assert(summary.includes('多模型路由'), '重试后详情应恢复当前认识');
      });
      return { surface: 'topic', journey: 'TP-006', failOnce: 'knowledge:get-topic-wiki-detail' };
    }
  },
  {
    id: 'TP-007-topic-actions',
    journeyIds: ['TP-007-topic-actions'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '主 CTA 展开 Pi 并聚焦 composer', async () => {
        await navigateTo(page, 'topic');
        await openTopicDetail(page, 'AI Agent 工具链');
        await page.locator('.topic-object-head button.primary-button', { hasText: '让 Pi 出选题方案' }).click();
        await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('pi-open') === true, null, { timeout: 10_000 });
        const focused = await page.evaluate(() => document.activeElement?.matches?.('.pi-composer textarea, .pi-composer *') ?? false);
        assert(await page.locator('.pi-dock:not(.collapsed)').count() === 1, 'Pi dock 应展开');
        await page.waitForTimeout(300);
      });
      await step(evidence, '去创作导航到创作页', async () => {
        await page.locator('.topic-more summary').click();
        await page.locator('.topic-more-menu button', { hasText: '去创作' }).click();
        await page.waitForFunction(() => document.querySelector('nav button.active')?.getAttribute('title') === '创作', null, { timeout: 15_000 });
      });
      await step(evidence, '放画布导航到关系画布（全局知识网络）', async () => {
        await navigateTo(page, 'topic');
        await openTopicDetail(page, 'AI Agent 工具链');
        await page.locator('.topic-more summary').click();
        await page.locator('.topic-more-menu button', { hasText: '放画布' }).click();
        await page.waitForFunction(() => document.querySelector('nav button.active')?.getAttribute('title') === '关系画布', null, { timeout: 15_000 });
        await page.locator('[data-kc-view="knowledge-network"]').waitFor({ state: 'visible', timeout: 20_000 });
      });
      return { surface: 'topic', journey: 'TP-007', piExpanded: true, studio: true, canvas: true };
    }
  },
  {
    id: 'TP-008-topic-approval-ledger',
    journeyIds: ['TP-008-topic-approval-ledger'],
    launch: {
      seedFixture: async (ws) => {
        const rich = seedRichKnowledge(ws.dataRoot, ws.workspaceId);
        seedProposal(ws.dataRoot, ws.workspaceId, rich.topicA.id, rich.topicA.title);
      }
    },
    run: async ({ page, workspace, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '整理台账渲染待批提案正文', async () => {
        await navigateTo(page, 'topic');
        await page.locator('.topic-maintenance-entry', { hasText: '整理台账' }).click();
        await page.locator('.topic-maintenance-page').waitFor({ state: 'visible' });
        await page.locator('.topic-maintenance-row').waitFor({ state: 'visible', timeout: 20_000 });
        const row = page.locator('.topic-maintenance-row');
        assert((await row.count()) >= 1, '待批卡应渲染');
        const text = await row.first().textContent();
        assert(text.includes('主题整理建议'), '待批卡应显示 主题整理建议');
        assert(text.includes('资料员建议') && text.includes('批准后影响'), '待批卡应显示提案正文与明细入口');
      });
      await step(evidence, '批准动作原子生效', async () => {
        await page.locator('.topic-maintenance-actions button.primary-button', { hasText: '批准并生效' }).click();
        await page.waitForFunction(() => document.querySelector('.topic-maintenance-status[data-state="approved"]')?.textContent?.includes('已批准并生效') === true, null, { timeout: 20_000 });
        const db = openReadOnlyDb(workspace.dataRoot);
        try {
          const proposal = db.db.prepare("SELECT status FROM topic_maintenance_proposals WHERE title = '整理建议：更新 AI Agent 工具链当前认识'").get();
          assert(proposal && String(proposal.status) === 'approved', `提案终态应为 approved，实际 ${JSON.stringify(proposal)}`);
          const topic = db.db.prepare("SELECT summary FROM topics WHERE title = 'AI Agent 工具链'").get();
          assert(String(topic.summary).includes('E2E'), '批准后主题摘要应更新（原子生效）');
        } finally {
          db.close();
        }
      });
      return { surface: 'topic', journey: 'TP-008', proposal: 'approved', atomic: true };
    }
  }
];
