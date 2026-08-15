// 资料库 surface Electron E2E scenarios (WMB-5243, journey matrix LB-001..LB-007).
//
// Covers: 保存资料按新鲜度分组渲染/分页、五区页签切换与移出指引、知识健康过滤、
// libraryFocusSourceId 深链聚焦与消费、空库空态、列表加载失败降级与恢复、来源→主题导航。
// Real Electron + isolated workspace seeded via the production pipeline.

import { helpers } from './harness.mjs';
import { seedRichKnowledge, seedHealthIssue, openWorkspaceDb } from './fixture-knowledge.mjs';
import { scheduleSourceBodyArchive } from '../../src/main/source-body-archive.ts';

const { assert, step, waitForAppReady, navigateTo, openReadOnlyDb, captureEvidence } = helpers;

const RICH = { seedFixture: async (ws) => seedRichKnowledge(ws.dataRoot, ws.workspaceId) };

export default [
  {
    id: 'LB-001-library-saved-normal',
    journeyIds: ['LB-001-library-saved-normal'],
    launch: RICH,
    run: async ({ app, page, evidence, artifactsDir }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '保存资料按新鲜度分组渲染', async () => {
        await navigateTo(page, 'library');
        await page.locator('.library-list').waitFor({ state: 'visible', timeout: 20_000 });
        const rows = page.locator('.lib-row');
        assert(await rows.count() >= 3, `资料行应为 3，实际 ${await rows.count()}`);
        const titles = await page.locator('.lib-title').allTextContents();
        for (const t of ['AgentForge 发布 v2：多模型路由', 'AgentForge v2 更新：平台限制与争议', '行业圆桌速记：AI 工具选型']) {
          assert(titles.includes(t), `缺少资料「${t}」，实际 ${JSON.stringify(titles)}`);
        }
        const firstRow = rows.first();
        assert((await firstRow.locator('.lib-sum').textContent()).length > 0, '资料行应有知识摘要');
        assert(await firstRow.locator('.lib-time').count() === 1, '资料行应有时间');
        const groupHeads = await page.locator('.lib-group-head span').first().allTextContents();
        assert(groupHeads.length >= 1, '应有新鲜度分组头');
        const pagerText = await page.locator('.knowledge-pager span').textContent();
        assert(pagerText.includes('3'), `分页应显示总数 3，实际 ${pagerText}`);
      });
      await step(evidence, '点击资料行打开详情', async () => {
        await page.locator('.lib-row', { hasText: 'AgentForge 发布 v2：多模型路由' }).first().click();
        await page.locator('.library-source-detail-page').waitFor({ state: 'visible', timeout: 20_000 });
        const title = await page.locator('.library-source-detail h1').textContent();
        assert(title.includes('AgentForge 发布 v2'), `详情标题错误：${title}`);
        assert(await page.locator('.library-source-detail section h2', { hasText: '证据贡献' }).count() >= 1, '详情应有证据贡献区');
        const sourceIdentity = await page.evaluate(() => {
          const meta = document.querySelector('.library-source-detail-meta');
          const mark = meta?.querySelector('.source-platform-mark');
          const metaStyle = meta ? getComputedStyle(meta) : null;
          const rect = mark?.getBoundingClientRect();
          return {
            count: meta?.querySelectorAll('.source-platform-mark').length ?? 0,
            fallback: Boolean(mark?.classList.contains('feed-source-platform-fallback')),
            fontSize: metaStyle ? Number.parseFloat(metaStyle.fontSize) : 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
          };
        });
        assert(sourceIdentity.count === 1 && sourceIdentity.fallback, `未知独立站详情应显示唯一通用来源标，实际 ${JSON.stringify(sourceIdentity)}`);
        assert(Math.abs(sourceIdentity.width - sourceIdentity.fontSize) <= 1 && Math.abs(sourceIdentity.height - sourceIdentity.fontSize) <= 1, `资料详情来源标应与元数据文字等高，实际 ${JSON.stringify(sourceIdentity)}`);
        assert(sourceIdentity.overflowX === 0, `资料详情不应产生横向溢出，实际 ${sourceIdentity.overflowX}`);
        assert(evidence.pageerrors.length === 0, `资料详情不应产生 page error：${JSON.stringify(evidence.pageerrors)}`);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'library-source-platform-icon-detail' });
      });
      return { surface: 'library', journey: 'LB-001', rows: 3, detail: true };
    }
  },
  {
    id: 'LB-002-library-sections-states',
    journeyIds: ['LB-002-library-sections-states'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '五区页签切换与空态/指引', async () => {
        await navigateTo(page, 'library');
        await page.locator('.library-list').waitFor({ state: 'visible', timeout: 20_000 });
        const tabs = await page.locator('.proposal-tab').allTextContents();
        for (const t of ['资料', '观察中', '待处理', '知识健康', '移出']) {
          assert(tabs.includes(t), `缺少页签 ${t}，实际 ${JSON.stringify(tabs)}`);
        }
        // 观察中：无 watching 资料 → 空态 + 指引
        await page.locator('.proposal-tab', { hasText: '观察中' }).click();
        await page.waitForFunction(() => Boolean(document.querySelector('.watching-section')));
        const watchingEmpty = await page.locator('.watching-section .library-empty h2').textContent();
        assert(watchingEmpty.includes('没有观察中的资料'), `观察中空态错误：${watchingEmpty}`);
        // 待处理：空池提示
        await page.locator('.proposal-tab', { hasText: '待处理' }).click();
        await page.waitForFunction(() => Boolean(document.querySelector('.pending-pools')));
        assert(await page.locator('.pending-pool').count() >= 1, '待处理池应渲染');
        // 知识健康：无问题 → 空态
        await page.locator('.proposal-tab', { hasText: '知识健康' }).click();
        await page.waitForFunction(() => Boolean(document.querySelector('.health-section')));
        const healthEmpty = await page.locator('.health-section .library-empty h2').textContent();
        assert(healthEmpty.includes('没有健康问题'), `健康空态错误：${healthEmpty}`);
        // 移出：指引 + 0 条
        await page.locator('.proposal-tab', { hasText: '移出' }).click();
        await page.waitForFunction(() => Boolean(document.querySelector('.removed-section')));
        const removedText = await page.locator('.removed-section').textContent();
        assert(removedText.includes('已移出 · 0 条'), '移出区应显示 0 条');
        assert(removedText.includes('被判定与本赛道无关'), '移出区应显示恢复指引');
        // 回到资料区
        await page.locator('.proposal-tab', { hasText: '资料' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.lib-row').length >= 3);
      });
      return { surface: 'library', journey: 'LB-002', tabs: 5 };
    }
  },
  {
    id: 'LB-003-library-health-filters',
    journeyIds: ['LB-003-library-health-filters'],
    launch: {
      seedFixture: async (ws) => {
        const rich = seedRichKnowledge(ws.dataRoot, ws.workspaceId);
        seedHealthIssue(ws.dataRoot, ws.workspaceId, rich.noteIds['agentforge-v2-multi-router']);
      }
    },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '知识健康区渲染问题并按严重度过滤', async () => {
        await navigateTo(page, 'library');
        await page.locator('.proposal-tab', { hasText: '知识健康' }).click();
        await page.locator('.library-issue-item').waitFor({ state: 'visible', timeout: 20_000 });
        const row = page.locator('.library-issue-item').first();
        const rowText = await row.textContent();
        assert(rowText.includes('中'), `问题严重度应为 中：${rowText}`);
        assert(rowText.includes('陈旧断言'), `问题类型应为 陈旧断言：${rowText}`);
        assert(rowText.includes('未处理'), `问题状态应为 未处理：${rowText}`);
        const healthTotal = await page.locator('.health-total').textContent();
        assert(healthTotal.includes('1 条'), `健康问题计数应为 1，实际 ${healthTotal}`);
        // 严重度过滤：中 → 显示；严重 → 空态
        await page.locator('button[aria-label="严重度 中"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.library-issue-item').length === 1);
        await page.locator('button[aria-label="严重度 严重"]').click();
        await page.waitForFunction(() => document.querySelector('.health-section .library-empty')?.textContent?.includes('没有健康问题') === true);
        await page.locator('button[aria-label="严重度 全部"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.library-issue-item').length === 1);
        // 类型过滤：陈旧断言 → 1；缺 Wiki 页 → 空
        await page.locator('button[aria-label="问题类型 陈旧断言"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.library-issue-item').length === 1);
        await page.locator('button[aria-label="问题类型 缺 Wiki 页"]').click();
        await page.waitForFunction(() => document.querySelector('.health-section .library-empty')?.textContent?.includes('没有健康问题') === true);
      });
      return { surface: 'library', journey: 'LB-003', issue: 'stale_claim/中/未处理' };
    }
  },
  {
    id: 'LB-004-library-focus-deeplink',
    journeyIds: ['LB-004-library-focus-deeplink'],
    launch: RICH,
    run: async ({ page, workspace, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, 'libraryFocusSourceId 深链聚焦并消费', async () => {
        const db = openReadOnlyDb(workspace.dataRoot);
        const row = db.db.prepare("SELECT id FROM source_items WHERE title = 'AgentForge 发布 v2：多模型路由'").get();
        db.close();
        await page.evaluate(({ wsId, sourceId }) => {
          const key = wsId ? `wmb.workspace.${wsId}.libraryFocusSourceId` : 'wmb.libraryFocusSourceId';
          localStorage.setItem(key, sourceId);
        }, { wsId: workspace.workspaceId, sourceId: String(row.id) });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await navigateTo(page, 'library');
        await page.locator('.library-source-detail-page').waitFor({ state: 'visible', timeout: 20_000 });
        const title = await page.locator('.library-source-detail h1').textContent();
        assert(title.includes('AgentForge 发布 v2'), `深链应打开对应来源详情：${title}`);
        // 消费后 localStorage 键被清除
        const consumed = await page.evaluate((wsId) => {
          const key = wsId ? `wmb.workspace.${wsId}.libraryFocusSourceId` : 'wmb.libraryFocusSourceId';
          return localStorage.getItem(key) === null;
        }, workspace.workspaceId);
        assert(consumed, 'focusSource 消费后 localStorage 键应被清除');
      });
      return { surface: 'library', journey: 'LB-004', focusConsumed: true };
    }
  },
  {
    id: 'LB-005-library-empty',
    journeyIds: ['LB-005-library-empty'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '空库空态且不崩溃', async () => {
        await navigateTo(page, 'library');
        await page.waitForFunction(() => document.querySelector('.library-page .library-empty h2')?.textContent?.includes('没有匹配资料') === true, null, { timeout: 20_000 });
        assert(await page.locator('.lib-row').count() === 0, '空库不应有资料行');
        await navigateTo(page, 'topic');
        assert(await page.locator('.app-shell').isVisible(), '空库后导航仍正常');
      });
      return { surface: 'library', journey: 'LB-005', empty: true };
    }
  },
  {
    id: 'LB-006-library-error',
    journeyIds: ['LB-006-library-error'],
    launch: RICH,
    run: async ({ page, app, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '列表加载失败降级不崩溃，恢复后刷新可见', async () => {
        const injected = await app.evaluate(({ ipcMain }, channel) => {
          const store = ipcMain._invokeHandlers ?? ipcMain._events;
          const holder = store instanceof Map ? store.get(channel) : store?.[channel];
          // Electron ≥28：`_invokeHandlers` 的 Map 值就是 handler 函数本身（非 {handler} 包装）。
          const original = typeof holder === 'function' ? holder : holder?.handler;
          if (typeof original !== 'function') return { ok: false, channel };
          let failed = false;
          const wrapped = async (event, ...args) => {
            if (!failed) { failed = true; throw new Error('E2E 强制列表加载失败'); }
            return original(event, ...args);
          };
          if (store instanceof Map) store.set(channel, wrapped);
          else if (typeof holder === 'function') store[channel] = wrapped;
          else holder.handler = wrapped;
          return { ok: true, channel };
        }, 'knowledge:list-sources');
        assert(injected?.ok, `IPC 注入失败: ${JSON.stringify(injected)}`);
        await navigateTo(page, 'library');
        await page.waitForTimeout(1500);
        assert(await page.locator('.app-shell').isVisible(), '加载失败不应导致崩溃');
        assert(await page.locator('.library-page').count() === 1, '资料库页仍应渲染');
        // 恢复后重进（remount 重新请求）→ 列表出现
        await navigateTo(page, 'topic');
        await navigateTo(page, 'library');
        await page.locator('.lib-row').first().waitFor({ state: 'visible', timeout: 20_000 });
        assert(await page.locator('.lib-row').count() >= 3, '恢复后列表应重新渲染');
      });
      return { surface: 'library', journey: 'LB-006', failOnce: 'knowledge:list-sources', recovered: true };
    }
  },
  {
    id: 'LB-007-library-open-topic-canvas',
    journeyIds: ['LB-007-library-open-topic-canvas'],
    launch: RICH,
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '来源详情打开关联主题', async () => {
        await navigateTo(page, 'library');
        await page.locator('.lib-row', { hasText: 'AgentForge 发布 v2：多模型路由' }).first().click();
        await page.locator('.library-source-detail-page').waitFor({ state: 'visible', timeout: 20_000 });
        const topicButtons = page.locator('.library-source-detail-links button.secondary-button');
        await topicButtons.first().waitFor({ state: 'visible', timeout: 20_000 });
        const topicTitle = await topicButtons.first().textContent();
        assert(topicTitle.includes('AI Agent 工具链'), `关联主题应为 AI Agent 工具链：${topicTitle}`);
        await topicButtons.first().click();
        await page.locator('.topic-object-head h2', { hasText: 'AI Agent 工具链' }).waitFor({ state: 'visible', timeout: 20_000 });
        // 主题详情包含该来源（已有资料预览；预览按时间倒序，第一行可能是更新来源，
        // 必须扫描全部预览行而不是只看 querySelector 首行）
        await page.waitForFunction(() => Array.from(document.querySelectorAll('.topic-wiki-source-title')).some((el) => el.textContent?.includes('AgentForge 发布 v2') === true), null, { timeout: 20_000 });
      });
      return { surface: 'library', journey: 'LB-007', topicNavigation: true };
    }
  },
  {
    id: 'LB-008-library-capture-failures',
    journeyIds: ['LB-008-library-capture-failures'],
    launch: {
      seedFixture: async (ws) => {
        const rich = seedRichKnowledge(ws.dataRoot, ws.workspaceId);
        const db = openWorkspaceDb(ws.dataRoot);
        try {
          const network = scheduleSourceBodyArchive(db, {
            sourceId: rich.source1.id,
            sourceRevision: 1,
            url: 'https://news.example/agentforge-v2',
            channel: 'official_web'
          });
          const security = scheduleSourceBodyArchive(db, {
            sourceId: rich.source2.id,
            sourceRevision: 1,
            url: 'https://news.example/agentforge-v2-dispute',
            channel: 'official_web'
          });
          const failedAt = new Date().toISOString();
          db.prepare(`UPDATE source_body_capture_jobs SET status = 'needs_review', attempt_count = 3,
            last_error_code = 'NETWORK_TIMEOUT', last_error_message = '网页读取超过时限。',
            reason_category = 'network', retryable = 1, finished_at = ?, updated_at = ? WHERE id = ?`)
            .run(failedAt, failedAt, network.jobId);
          db.prepare(`UPDATE source_body_capture_jobs SET status = 'needs_review', attempt_count = 1,
            last_error_code = 'URL_SECURITY_BLOCKED', last_error_message = '地址未通过公网安全检查。',
            reason_category = 'security', retryable = 0, finished_at = ?, updated_at = ? WHERE id = ?`)
            .run(failedAt, failedAt, security.jobId);
        } finally {
          db.close();
        }
      }
    },
    run: async ({ app, page, evidence, artifactsDir }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '采集异常展示分类、可重试边界与批量动作', async () => {
        await navigateTo(page, 'library');
        await page.locator('.proposal-tab', { hasText: '采集异常' }).click();
        await page.locator('.capture-failure-item').first().waitFor({ state: 'visible', timeout: 20_000 });
        assert(await page.locator('.capture-failure-item').count() === 2, '应显示两条正文归档终态失败');
        const text = await page.locator('.capture-failures-section').textContent();
        assert(text.includes('网络错误') && text.includes('安全拦截'), `应展示失败分类：${text}`);
        assert(text.includes('可重试') && text.includes('不可自动重试'), `应展示重试边界：${text}`);
        assert(text.includes('重试全部可重试项 (1)'), `批量重试应只计入可重试项：${text}`);
        assert(text.includes('另有 1 项不可自动重试'), `应明确排除不可自动重试项：${text}`);
        const disabled = await page.locator('.capture-failure-item.is-not-retryable input[type="checkbox"]').isDisabled();
        assert(disabled, '安全拦截项不应允许自动批量选择');
        const failureIdentity = await page.evaluate(() => ({
          marksPerRow: [...document.querySelectorAll('.capture-failure-item')].map((row) => row.querySelectorAll('.capture-failure-head .source-platform-mark').length),
          fallbackCount: document.querySelectorAll('.capture-failure-head .source-platform-mark.feed-source-platform-fallback').length,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
        }));
        assert(failureIdentity.marksPerRow.every((count) => count === 1) && failureIdentity.fallbackCount === 2, `每条采集异常应显示唯一来源标，实际 ${JSON.stringify(failureIdentity)}`);
        assert(failureIdentity.overflowX === 0, `采集异常来源标不应产生横向溢出，实际 ${failureIdentity.overflowX}`);
        assert(evidence.pageerrors.length === 0, `采集异常不应产生 page error：${JSON.stringify(evidence.pageerrors)}`);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'library-capture-failure-platform-icons' });
      });
      return { surface: 'library', journey: 'LB-008', failures: 2, retryable: 1, excluded: 1 };
    }
  },
];
