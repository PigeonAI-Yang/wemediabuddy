// WMB-5243/WMB-5253/WMB-5264 发布（Publish）页真实 Electron E2E（PB-001..005, PB-009, PB-010）。
//
// 契约：default export = scenario array；launch.seedFixture 在启动前建真数据。
// 边界：绝不点击「授权打开并填充编辑器」（会启动真实平台登录态浏览器）；
// 绝不触发微信回读（依赖真实账号文章）；最终发布（PB-006/007/008）为 manual 排除。
// 本页只验证矩阵/详情/弹窗交互与状态链、人工边界 UI：矩阵单元（代表性任务 + v3 工作态文案）、
// WMB-5265 v3 尺寸契约：1600/1366/1100 无页面溢出、列/行/单元尺寸达标、紧凑宽度矩阵内部滚动；
// 内容详情子页（面包屑/返回/Esc）、聚焦 AppModal 任务弹窗：prepared→待授权按钮存在、
// needs_user→接管入口、unknown→对账（真实 DB 写、无外部副作用）、failed→失败原因可见、
// 未启用平台→历史保留、awaiting_confirmation→退回创作修改（真实 DB 写、跳转原创作项目）。
// 正式外壳断言：左侧 nav[aria-label=工作流] 与右侧 Pi dock 在发布页常驻；展开 Pi 压缩
// 工作区/矩阵而非覆盖或移除矩阵（shell 网格收缩，页面不产生遮罩层）。

import { seedWorkflowBase, openWriteDb, seedStudioProject, seedPublishBinding, seedPreparedPublication, seedAwaitingConfirmationPublication, seedPublicationWithStatus, makePublicationLatest } from './seed-workflow.mjs';

const PLAT_X = 'x';
const ACC_KEY = '@e2e-workflow-x';

/** 共用：项目 + X 平台版本 + 账号/binding + prepared 发布（含 operation prepared）。 */
async function seedPublishDataset({ dataRoot, workspaceId, platforms = ['x', 'xiaohongshu', 'wechat'] }) {
  await seedWorkflowBase(dataRoot, workspaceId, { platforms });
  const db = openWriteDb(dataRoot);
  try {
    const studio = seedStudioProject(db, {});
    const accX = seedPublishBinding(db, { platform: PLAT_X, accountKey: ACC_KEY, displayName: 'E2E X' });
    const prepared = seedPreparedPublication(db, {
      workspaceId,
      platformVersionId: studio.platXId,
      account: accX,
      payloadTitle: 'X 平台稿修订',
      payloadBody: '平台 V2 正文'
    });
    return { db, studio, accX, prepared, workspaceId };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** 等待发布页渲染（矩阵/空态/详情均以 .publish-page 为锚）。 */
async function waitPublishPage(page) {
  await page.waitForSelector('.publish-page', { timeout: 20_000 });
}

/** 展开/收起 Pi：真实开关（hover rail 后点击），等 shell 类切换完成。 */
async function togglePi(page, collapsed) {
  const beforeWidth = await page.evaluate(() => document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0);
  await page.locator('.pi-dock-toggle-rail').hover();
  await page.locator('.pi-dock-toggle').click();
  await page.waitForFunction(
    ({ wantCollapsed, widthBefore }) => {
      const shell = document.querySelector('.app-shell');
      const width = document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0;
      const stateReady = shell?.classList.contains(wantCollapsed ? 'pi-collapsed' : 'pi-open') === true;
      return stateReady && (wantCollapsed ? width > widthBefore + 10 : width < widthBefore - 10);
    },
    { wantCollapsed: collapsed, widthBefore: beforeWidth },
    { timeout: 10_000 }
  );
}

export default [
  {
    id: 'PB-001-publish-list-normal',
    journeyIds: ['PB-001-publish-list-normal'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX, prepared } = await seedPublishDataset({ dataRoot, workspaceId });
        try {
          // 状态全景：prepared(待授权) / published / needs_user / unknown / failed
          seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'published', externalUrl: 'https://x.com/e2e-workflow-x/1', externalId: 'e2e-x-1', publishedAt: new Date(Date.now() - 2 * 86400_000).toISOString() });
          seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'needs_user', lastError: { code: 'PUBLICATION_BROWSER_NEEDS_USER', message: '浏览器需要人工接管' } });
          seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'unknown' });
          seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'failed', lastError: { code: 'EDITOR_ERROR', message: '编辑器回读失败' } });
          // 代表性单元 = 待授权（prepared）项：列表按 updated_at DESC，prepared 刷为最新
          makePublicationLatest(db, prepared.publicationId);
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { app, page, helpers, assert, step, openDb, evidence, artifactsDir } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到发布页', () => helpers.navigateTo(page, 'publish'));
      await step('正式外壳：左导航与右 Pi 常在，展开 Pi 压缩工作区而非覆盖矩阵', async () => {
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix-scroller', { timeout: 15_000 });
        const initial = await page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="工作流"]');
          const dock = document.querySelector('.pi-dock');
          const workspace = document.querySelector('.workspace');
          const matrix = document.querySelector('.publish-matrix-scroller');
          return {
            hasNav: Boolean(nav && nav.querySelectorAll('button').length >= 2),
            hasDock: Boolean(dock),
            dockCollapsed: dock?.classList.contains('collapsed') ?? false,
            wsWidth: workspace?.getBoundingClientRect().width ?? 0,
            matrixWidth: matrix?.getBoundingClientRect().width ?? 0,
            matrixExists: Boolean(matrix)
          };
        });
        assert(initial.hasNav, '发布页缺少左侧 nav[aria-label="工作流"]');
        assert(initial.hasDock, '发布页缺少右侧 Pi dock');
        assert(initial.matrixExists && initial.matrixWidth > 0, '发布页矩阵不可见');
        // 翻转到相反 Pi 状态：展开必须压缩工作区与矩阵，不得覆盖/移除矩阵；恢复初始状态
        await togglePi(page, !initial.dockCollapsed);
        const flipped = await page.evaluate(() => ({
          wsWidth: document.querySelector('.workspace')?.getBoundingClientRect().width ?? 0,
          matrixWidth: document.querySelector('.publish-matrix-scroller')?.getBoundingClientRect().width ?? 0
        }));
        if (initial.dockCollapsed) {
          assert(flipped.wsWidth < initial.wsWidth, `展开 Pi 后工作区应收窄: ${initial.wsWidth} -> ${flipped.wsWidth}`);
        } else {
          assert(flipped.wsWidth > initial.wsWidth, `收起 Pi 后工作区应变宽: ${initial.wsWidth} -> ${flipped.wsWidth}`);
        }
        assert(flipped.matrixWidth > 0 && flipped.matrixWidth <= flipped.wsWidth, `Pi 状态变化后矩阵不应被覆盖或移除: ${flipped.matrixWidth} vs ${flipped.wsWidth}`);
        await togglePi(page, initial.dockCollapsed);
      });
      await step('真实 Electron 响应式：1600/1366/1100 满足 v3 尺寸契约，紧凑宽度由矩阵内部滚动承接', async () => {
        // v3 尺寸契约以 Pi 默认收起的工作区为准：测量前确保折叠，结束后还原初始状态
        const piWasCollapsed = await page.evaluate(() => document.querySelector('.pi-dock')?.classList.contains('collapsed') ?? true);
        if (!piWasCollapsed) await togglePi(page, true);
        // v3 断点：1600 → 内容列 288 / 平台列 178；1366 → 260 / 165；1100 → 240 / 160；项目行 >=108；可操作单元 >=88
        const layoutWidths = [1600, 1366, 1100];
        const columnMinima = { 1600: { content: 288, platform: 178 }, 1366: { content: 260, platform: 165 }, 1100: { content: 240, platform: 160 } };
        for (const width of layoutWidths) {
          await page.setViewportSize({ width, height: width === 1100 ? 800 : 960 });
          await page.waitForTimeout(250);
          const layout = await page.evaluate(() => {
            const frame = document.querySelector('.publish-matrix-scroller');
            const wrapStyle = getComputedStyle(document.querySelector('.publish-matrix-wrap'));
            const matrixRect = document.querySelector('.publish-matrix')?.getBoundingClientRect();
            const workspace = document.querySelector('.workspace')?.getBoundingClientRect();
            const projectCell = document.querySelector('.publish-matrix-project')?.getBoundingClientRect();
            const actionCell = document.querySelector('.publish-matrix-row .publish-cell')?.getBoundingClientRect();
            const corner = document.querySelector('.publish-matrix-corner')?.getBoundingClientRect();
            const row = document.querySelector('.publish-matrix-row');
            // 平台列宽取矩阵行内网格项（首项=内容列，其余=各平台列），与表头类名解耦
            const platformCells = row ? [...row.children].slice(1).map((el) => el.getBoundingClientRect().width) : [];
            return {
              outerOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              docOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
              workspaceWidth: workspace?.width ?? 0,
              matrixWidth: frame?.getBoundingClientRect().width ?? 0,
              matrixClientWidth: frame?.clientWidth ?? 0,
              matrixScrollWidth: frame?.scrollWidth ?? 0,
              matrixClientHeight: frame?.clientHeight ?? 0,
              matrixTableHeight: matrixRect?.height ?? 0,
              matrixOverflowX: frame ? getComputedStyle(frame).overflowX : '',
              contentColWidth: corner?.width ?? projectCell?.width ?? 0,
              platformColWidths: platformCells,
              rowHeight: projectCell?.height ?? 0,
              actionCellHeight: actionCell?.height ?? 0,
              hasNav: Boolean(document.querySelector('nav[aria-label="工作流"]')),
              hasDock: Boolean(document.querySelector('.pi-dock')),
              matrixPadding: [wrapStyle.paddingTop, wrapStyle.paddingRight, wrapStyle.paddingBottom, wrapStyle.paddingLeft]
            };
          });
          const expected = columnMinima[width];
          assert(layout.outerOverflow <= 1, `宽度 ${width} 不应产生外壳横向溢出: ${layout.outerOverflow}`);
          assert(layout.docOverflowY <= 2, `宽度 ${width} 不应产生外壳纵向溢出: ${layout.docOverflowY}`);
          assert(layout.hasNav && layout.hasDock, `宽度 ${width} 必须保留左导航与右 Pi`);
          assert(layout.matrixWidth > 0 && layout.matrixWidth <= layout.workspaceWidth, `宽度 ${width} 矩阵应留在工作区内: ${layout.matrixWidth} vs ${layout.workspaceWidth}`);
          assert(layout.matrixScrollWidth >= layout.matrixClientWidth, `宽度 ${width} 矩阵内容不应被截断: ${layout.matrixScrollWidth} vs ${layout.matrixClientWidth}`);
          assert(layout.matrixPadding.every((value) => value === '12px'), `宽度 ${width} 矩阵四边距应以顶部 12px 为统一基准: ${layout.matrixPadding.join('/')}`);
          assert(layout.matrixTableHeight + 0.5 >= layout.matrixClientHeight, `宽度 ${width} 矩阵底边应自适应填满可用高度: ${layout.matrixTableHeight} vs ${layout.matrixClientHeight}`);
          assert(layout.contentColWidth + 0.5 >= expected.content, `宽度 ${width} 内容列低于契约下限 ${expected.content}px: ${layout.contentColWidth}`);
          for (const colWidth of layout.platformColWidths) {
            assert(colWidth + 0.5 >= expected.platform, `宽度 ${width} 平台列低于契约下限 ${expected.platform}px: ${colWidth}`);
          }
          assert(layout.rowHeight + 0.5 >= 108, `宽度 ${width} 项目行低于契约下限 108px: ${layout.rowHeight}`);
          assert(layout.actionCellHeight + 0.5 >= 88, `宽度 ${width} 可操作单元低于契约下限 88px: ${layout.actionCellHeight}`);
          // 内容容量放不下时：横向扩展必须由矩阵滚动容器内部承接（可滚动、不外溢页面）
          if (width === 1100 && layout.matrixScrollWidth > layout.matrixClientWidth + 1) {
            assert(['auto', 'scroll'].includes(layout.matrixOverflowX), `紧凑宽度矩阵应内部滚动: overflowX=${layout.matrixOverflowX}`);
            assert(layout.outerOverflow <= 1, `紧凑宽度矩阵溢出不得外溢到页面: ${layout.outerOverflow}`);
          }
          await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: width === 1600 ? 'publish-matrix-desktop' : width === 1366 ? 'publish-matrix-mid' : 'publish-matrix-compact' });
        }
        await page.setViewportSize({ width: 1600, height: 960 });
        await page.waitForTimeout(250);
        if (!piWasCollapsed) await togglePi(page, false);
      });
      await step('矩阵渲染：项目行 + X 平台列 + 代表性单元（继续发布）与 v3 文案（无重复计数）', async () => {
        const matrix = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.publish-matrix-row')];
          const cells = rows[0] ? [...rows[0].querySelectorAll('.publish-cell')] : [];
          const activeTab = document.querySelector('.publish-tabs .proposal-tab.active');
          activeTab?.focus();
          const activeTabStyle = activeTab ? getComputedStyle(activeTab) : null;
          const scrollerStyle = getComputedStyle(document.querySelector('.publish-matrix-scroller'));
          const tableStyle = getComputedStyle(document.querySelector('.publish-matrix'));
          return {
            rowCount: rows.length,
            cellCount: cells.length,
            projectName: document.querySelector('.publish-project-name')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            projectMeta: document.querySelector('.publish-matrix-project small')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            extra: cells[0]?.querySelector('.publish-cell-extra')?.textContent?.trim() ?? '',
            repText: cells[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            h1Count: document.querySelectorAll('.publish-page h1').length,
            tabLabels: [...document.querySelectorAll('.publish-tabs .proposal-tab')].map((t) => t.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
            colHeadTexts: [...document.querySelectorAll('.publish-platform-head')].map((h) => h.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
            colCount: document.querySelectorAll('.publish-matrix-col-count').length,
            chipCount: document.querySelectorAll('.publish-chip-count').length,
            headerCopy: [...document.querySelectorAll('.publish-page p')].map((p) => p.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
            activeTabOutline: activeTabStyle?.outlineStyle ?? '',
            activeTabBottomBorder: activeTabStyle?.borderBottomColor ?? '',
            scrollerBorderWidth: scrollerStyle.borderTopWidth,
            scrollerRadius: scrollerStyle.borderTopLeftRadius,
            tableBorderWidth: tableStyle.borderTopWidth,
            tableRadius: tableStyle.borderTopLeftRadius,
            tableOverflow: tableStyle.overflow
          };
        });
        assert(matrix.rowCount === 1, `矩阵应有 1 行项目: ${matrix.rowCount}`);
        assert(matrix.projectName.includes('E2E 创作项目 A'), `项目行标题缺失: ${matrix.projectName}`);
        assert(matrix.projectMeta.includes('有任务待处理'), `项目行工作态文案缺失: ${matrix.projectMeta}`);
        assert(!/\d+\s*项任务/.test(matrix.projectMeta), `项目行不应再显示重复任务计数: ${matrix.projectMeta}`);
        assert(matrix.repText.includes('继续发布') && matrix.repText.includes('内容已准备好'), `代表性单元应使用真实可理解动作: ${matrix.repText}`);
        assert(matrix.extra.includes('›'), `代表性单元应保留 › 前进符号: ${matrix.extra}`);
        assert(!/^\+?\d+$/.test(matrix.extra) && !matrix.repText.includes('+'), `代表性单元不应显示附加任务计数: ${matrix.extra} / ${matrix.repText}`);
        assert(matrix.h1Count === 1, `发布台应只有一个 H1: ${matrix.h1Count}`);
        // v3 页签：全部 / 待我处理 / 已发布，无数字计数徽标
        for (const label of ['全部', '待我处理', '已发布']) {
          assert(matrix.tabLabels.some((t) => t.includes(label)), `页签缺少「${label}」: ${JSON.stringify(matrix.tabLabels)}`);
        }
        assert(matrix.tabLabels.every((t) => !/\d/.test(t)), `页签不应显示重复计数: ${JSON.stringify(matrix.tabLabels)}`);
        // v3 列表头：平台名，无列计数；过滤芯片计数已移除
        assert(['X', '小红书', '公众号'].every((name) => matrix.colHeadTexts.some((text) => text.includes(name))), `平台列表头缺失: ${JSON.stringify(matrix.colHeadTexts)}`);
        assert(matrix.colCount === 0, `平台列表头不应显示列计数: ${matrix.colCount}`);
        assert(matrix.chipCount === 0, `过滤芯片计数应移除: ${matrix.chipCount}`);
        // v3 工作队列说明：单一语句，不保留计数式工程文案
        assert(matrix.headerCopy.some((p) => p.includes('选择一篇内容')), `缺少 v3 工作队列说明: ${JSON.stringify(matrix.headerCopy)}`);
        assert(matrix.headerCopy.every((p) => !p.includes('项需要处理')), `不应保留计数式工程文案: ${JSON.stringify(matrix.headerCopy)}`);
        assert(matrix.activeTabOutline === 'none', `选中页签不应叠加矩形焦点线框: ${matrix.activeTabOutline}`);
        assert(matrix.activeTabBottomBorder !== 'rgba(0, 0, 0, 0)', `选中页签必须保留强调色下划线: ${matrix.activeTabBottomBorder}`);
        assert(matrix.scrollerBorderWidth === '0px' && matrix.scrollerRadius === '0px', `滚动器不应再充当圆角外框: border=${matrix.scrollerBorderWidth}, radius=${matrix.scrollerRadius}`);
        assert(matrix.tableBorderWidth === '1px' && matrix.tableRadius === '12px' && matrix.tableOverflow === 'clip', `矩阵本体应形成单一圆角边界: border=${matrix.tableBorderWidth}, radius=${matrix.tableRadius}, overflow=${matrix.tableOverflow}`);
      });
      await step('内容详情子页：面包屑 + 六态任务行 + 原文链接，Esc 返回矩阵', async () => {
        await page.evaluate(() => { document.querySelector('.publish-project-name')?.click(); });
        await page.waitForSelector('.publish-detail', { timeout: 10_000 });
        const detail = await page.evaluate(() => {
          const bar = document.querySelector('.publish-detail-bar')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          const tasks = [...document.querySelectorAll('.publish-detail-task-main')].map((t) => t.textContent?.replace(/\s+/g, ' ').trim() ?? '');
          return { bar, tasks, link: document.querySelector('.publish-detail-link')?.getAttribute('href') ?? '' };
        });
        assert(detail.bar.includes('发布') && detail.bar.includes('E2E 创作项目 A'), `面包屑缺失: ${detail.bar}`);
        const joined = detail.tasks.join('|');
        for (const expected of ['待授权', '已发布', '需要接管', '待对账', '失败']) {
          assert(joined.includes(expected), `详情缺少状态「${expected}」: ${joined.slice(0, 300)}`);
        }
        assert(joined.includes('人工发布'), '已发布项应标注人工发布');
        assert(detail.link.includes('https://x.com/e2e-workflow-x/1'), `已发布项应有原文链接: ${detail.link}`);
        // 返回矩阵：面包屑「发布」/ 返回按钮 / Esc 三条路径至少验证 Esc
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.publish-detail'), null, { timeout: 10_000 });
        await page.waitForSelector('.publish-matrix', { timeout: 10_000 });
      });
      await step('任务弹窗：平台/账号/版本/流转记录聚焦展示', async () => {
        await page.evaluate(() => { document.querySelector('.publish-matrix-row .publish-cell')?.click(); });
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const modal = await page.evaluate(() => {
          const dialog = document.querySelector('#publish-task-modal-dialog');
          return {
            text: dialog?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            facts: [...document.querySelectorAll('.publish-task-facts dd')].map((d) => d.textContent?.trim() ?? '')
          };
        });
        assert(modal.text.includes('待授权'), `弹窗状态词应为待授权: ${modal.text.slice(0, 200)}`);
        assert(modal.text.includes('X'), '弹窗缺少平台标签');
        assert(modal.facts.some((f) => f.includes(ACC_KEY)), `弹窗未显示账号: ${modal.facts.join(',')}`);
        assert(modal.facts.some((f) => /^v\d+$/.test(f)), `弹窗未显示内容版本: ${modal.facts.join(',')}`);
        assert(modal.text.includes('流转记录'), '弹窗缺少流转记录');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('#publish-task-modal-dialog'), null, { timeout: 10_000 });
      });
      await step('持久化读回：发布状态与矩阵一致', () => {
        const { db, close } = openDb();
        try {
          const rows = db.prepare('SELECT status, COUNT(*) AS c FROM publications GROUP BY status').all();
          const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
          for (const expected of ['awaiting_confirmation', 'published', 'needs_user', 'unknown', 'failed']) {
            assert(byStatus[expected] >= 1, `DB 缺少状态 ${expected}: ${JSON.stringify(byStatus)}`);
          }
        } finally { close(); }
      });
      return { listNormal: true };
    }
  },

  {
    id: 'PB-002-publish-empty',
    journeyIds: ['PB-002-publish-empty'],
    launch: { seedFixture: async ({ dataRoot, workspaceId }) => { await seedWorkflowBase(dataRoot, workspaceId); } },
    run: async (ctx) => {
      const { page, helpers, assert, step } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到发布页', () => helpers.navigateTo(page, 'publish'));
      await step('空态「还没有发布任务」+ 回到创作', async () => {
        await waitPublishPage(page);
        await page.waitForSelector('.compact-empty', { timeout: 15_000 });
        const emptyText = await page.textContent('.compact-empty');
        assert(emptyText.includes('还没有发布任务'), `空态文案不符: ${emptyText}`);
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.publish-page button')].find((b) => b.textContent?.includes('回到创作'));
          btn?.click();
        });
        await page.waitForFunction(() => document.querySelector('nav button[title="创作"]')?.classList.contains('active'), null, { timeout: 15_000 });
      });
      return { empty: true };
    }
  },

  {
    id: 'PB-003-publish-prepared-actions',
    journeyIds: ['PB-003-publish-prepared-actions'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        // 平台仅启用 X：X 项显示动作按钮；小红书项走「未启用平台」历史保留边界
        const { db, studio, accX, prepared } = await seedPublishDataset({ dataRoot, workspaceId, platforms: ['x'] });
        try {
          // 小红书已发布（平台未启用 → 仅历史记录，无动作按钮）
          const { saveAccount } = await import('../../src/main/accounts.ts');
          const accXhs = saveAccount(db, { platform: 'xiaohongshu', accountKey: '@e2e-workflow-xhs', displayName: 'E2E XHS', loginState: 'authenticated' });
          const { savePlatformVersion } = await import('../../src/main/content.ts');
          const platXhs = savePlatformVersion(db, { projectId: studio.projectId, contentVersionId: studio.coreV2Id, platform: 'xiaohongshu', format: 'text', title: '小红书稿', body: '小红书正文' });
          seedPublicationWithStatus(db, { platformVersionId: platXhs.data.id, accountId: accXhs.id, accountKey: '@e2e-workflow-xhs', to: 'published', externalUrl: 'https://www.xiaohongshu.com/explore/e2e-xhs', externalId: 'e2e-xhs', publishedAt: new Date(Date.now() - 3 * 86400_000).toISOString() });
          // 代表性单元 = 待授权 prepared 项
          makePublicationLatest(db, prepared.publicationId);
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到发布页', () => helpers.navigateTo(page, 'publish'));
      await step('prepared 任务弹窗渲染「继续编辑」与「授权打开并填充编辑器」', async () => {
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix', { timeout: 15_000 });
        await page.evaluate(() => { document.querySelector('.publish-matrix-row .publish-cell')?.click(); });
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const buttons = await page.$$eval('#publish-task-modal-dialog .publish-task-actions button', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        assert(buttons.includes('继续编辑'), `缺少继续编辑: ${JSON.stringify(buttons)}`);
        assert(buttons.includes('授权打开并填充编辑器'), `缺少授权打开并填充编辑器: ${JSON.stringify(buttons)}`);
      });
      await step('「继续编辑」跳转 studio 对应项目', async () => {
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('#publish-task-modal-dialog button')].find((b) => b.textContent?.includes('继续编辑'));
          btn?.click();
        });
        await page.waitForFunction(() => document.querySelector('nav button[title="创作"]')?.classList.contains('active'), null, { timeout: 15_000 });
        await page.waitForSelector('.studio-editor-view', { timeout: 20_000 });
        const title = await page.inputValue('#studio-title');
        assert(title === 'E2E 创作项目 A', `继续编辑应打开对应项目: ${JSON.stringify(title)}`);
      });
      await step('未启用平台：小红书单元仅历史记录、无动作按钮、无错误', async () => {
        await helpers.navigateTo(page, 'publish');
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix', { timeout: 15_000 });
        const xhsOpened = await page.evaluate(() => {
          const cell = [...document.querySelectorAll('.publish-matrix-row .publish-cell')].find((c) => c.getAttribute('aria-label')?.includes('小红书'));
          if (!cell) return false;
          cell.click();
          return true;
        });
        assert(xhsOpened, '未找到小红书平台单元');
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const notice = await page.evaluate(() => document.querySelector('#publish-task-modal-dialog .notice')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
        assert(notice.includes('当前工作空间未启用该发布平台，仅保留历史记录。'), `未启用平台提示缺失: ${notice}`);
        const hasAuthorize = await page.evaluate(() => [...document.querySelectorAll('#publish-task-modal-dialog button')]
          .some((b) => b.textContent?.includes('授权打开并填充编辑器')));
        assert(!hasAuthorize, '未启用平台不应渲染授权按钮');
      });
      return { preparedActions: true, disabledPlatform: true };
    }
  },

  {
    id: 'PB-004-publish-needs-user-takeover',
    journeyIds: ['PB-004-publish-needs-user-takeover'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX } = await seedPublishDataset({ dataRoot, workspaceId });
        try {
          const seeded = seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'needs_user', lastError: { code: 'PUBLICATION_BROWSER_NEEDS_USER', message: '浏览器需要人工接管' } });
          makePublicationLatest(db, seeded.publicationId);
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到发布页', () => helpers.navigateTo(page, 'publish'));
      await step('needs_user 任务弹窗渲染「打开浏览器接管」主按钮', async () => {
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix', { timeout: 15_000 });
        await page.evaluate(() => { document.querySelector('.publish-matrix-row .publish-cell')?.click(); });
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const buttons = await page.$$eval('#publish-task-modal-dialog .publish-task-actions button', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        assert(buttons.includes('打开浏览器接管'), `缺少接管按钮: ${JSON.stringify(buttons)}`);
        const pill = await page.textContent('#publish-task-modal-dialog .publish-task-modal-head .pill-status');
        assert(pill.includes('需要接管'), `状态词应为需要接管: ${pill}`);
      });
      await step('接管入口可达（takeover → 设置）', async () => {
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('#publish-task-modal-dialog button')].find((b) => b.textContent?.includes('打开浏览器接管'));
          btn?.click();
        });
        await page.waitForFunction(() => document.querySelector('nav button[title="设置"]')?.classList.contains('active'), null, { timeout: 15_000 });
        await page.waitForSelector('.settings-mode', { timeout: 15_000 });
      });
      return { takeoverReachable: true };
    }
  },

  {
    id: 'PB-005-publish-reconcile-unknown',
    journeyIds: ['PB-005-publish-reconcile-unknown'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX } = await seedPublishDataset({ dataRoot, workspaceId });
        try {
          const seeded = seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'unknown' });
          makePublicationLatest(db, seeded.publicationId);
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到发布页', () => helpers.navigateTo(page, 'publish'));
      await step('unknown 任务弹窗渲染「我已核对，确认未发布」', async () => {
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix', { timeout: 15_000 });
        await page.evaluate(() => { document.querySelector('.publish-matrix-row .publish-cell')?.click(); });
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const buttons = await page.$$eval('#publish-task-modal-dialog .publish-task-actions button', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        assert(buttons.includes('我已核对，确认未发布'), `缺少对账按钮: ${JSON.stringify(buttons)}`);
        const pill = await page.textContent('#publish-task-modal-dialog .publish-task-modal-head .pill-status');
        assert(pill.includes('待对账'), `状态词应为待对账: ${pill}`);
      });
      await step('对账执行且弹窗状态更新为失败', async () => {
        const before = await (() => {
          const { db, close } = openDb();
          try {
            return db.prepare('SELECT COUNT(*) AS c FROM publication_reconciliations').get().c;
          } finally { close(); }
        })();
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('#publish-task-modal-dialog button')].find((b) => b.textContent?.includes('我已核对，确认未发布'));
          btn?.click();
        });
        await page.waitForFunction(() => document.querySelector('#publish-task-modal-dialog .publish-task-modal-head .pill-status')?.textContent?.includes('失败'), null, { timeout: 15_000 });
        const pill = await page.textContent('#publish-task-modal-dialog .publish-task-modal-head .pill-status');
        assert(pill.includes('失败'), `对账后弹窗状态应更新为失败: ${pill}`);
        const after = await (() => {
          const { db, close } = openDb();
          try {
            return db.prepare('SELECT COUNT(*) AS c FROM publication_reconciliations').get().c;
          } finally { close(); }
        })();
        assert(Number(after) > Number(before), '对账记录未落库（无持久化副作用）');
        const unknownLeft = await (() => {
          const { db, close } = openDb();
          try {
            return db.prepare("SELECT COUNT(*) AS c FROM publications WHERE status = 'unknown'").get().c;
          } finally { close(); }
        })();
        assert(Number(unknownLeft) === 0, `对账后仍残留 unknown 状态: ${unknownLeft}`);
      });
      return { reconciled: true };
    }
  },

  {
    id: 'PB-009-publish-operation-error',
    journeyIds: ['PB-009-publish-operation-error'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX } = await seedPublishDataset({ dataRoot, workspaceId });
        try {
          seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'unknown' });
          // failed 最后种子并刷为最新 → 代表性单元 = 失败项
          const failed = seedPublicationWithStatus(db, { platformVersionId: studio.platXId, accountId: accX.id, accountKey: ACC_KEY, to: 'failed', lastError: { code: 'EDITOR_ERROR', message: '编辑器回读失败：超时' } });
          makePublicationLatest(db, failed.publicationId);
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到发布页', () => helpers.navigateTo(page, 'publish'));
      await step('failed 任务弹窗显示失败与错误原因、页面不崩溃', async () => {
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix', { timeout: 15_000 });
        await page.evaluate(() => { document.querySelector('.publish-matrix-row .publish-cell')?.click(); });
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const modalText = await page.textContent('#publish-task-modal-dialog');
        assert(modalText.includes('失败'), `failed 状态词缺失: ${modalText.slice(0, 200)}`);
        // 错误原因经失败横幅可见（事件 reason 来自真实行）
        assert(modalText.includes('编辑器回读失败'), `错误原因未显示: ${modalText.slice(0, 300)}`);
      });
      await step('unknown 项经详情子页进入对账恢复路径', async () => {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('#publish-task-modal-dialog'), null, { timeout: 10_000 });
        await page.evaluate(() => { document.querySelector('.publish-project-name')?.click(); });
        await page.waitForSelector('.publish-detail', { timeout: 10_000 });
        const picked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.publish-detail-task-main')].find((b) => b.textContent?.includes('待对账'));
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(picked, '未找到待对账任务');
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const buttons = await page.$$eval('#publish-task-modal-dialog .publish-task-actions button', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        assert(buttons.includes('我已核对，确认未发布'), `对账入口缺失: ${JSON.stringify(buttons)}`);
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('#publish-task-modal-dialog button')].find((b) => b.textContent?.includes('我已核对，确认未发布'));
          btn?.click();
        });
        await page.waitForFunction(() => document.querySelector('#publish-task-modal-dialog .publish-task-modal-head .pill-status')?.textContent?.includes('失败'), null, { timeout: 15_000 });
      });
      await step('状态刷新后矩阵数据更新（dataChanged publications scope）', async () => {
        const { db, close } = openDb();
        try {
          const failed = db.prepare('SELECT COUNT(*) AS c FROM publications WHERE status = ?').get('failed').c;
          const unknown = db.prepare('SELECT COUNT(*) AS c FROM publications WHERE status = ?').get('unknown').c;
          assert(Number(failed) >= 2, `failed 计数不符: ${failed}`);
          assert(Number(unknown) === 0, `unknown 应已全部对账: ${unknown}`);
        } finally { close(); }
      });
      return { operationErrorHonest: true };
    }
  },
  {
    id: 'PB-010-publish-return-to-edit',
    journeyIds: ['PB-010-publish-return-to-edit'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        const { db, studio, accX } = await seedPublishDataset({ dataRoot, workspaceId });
        try {
          // 真实编辑后状态：awaiting_confirmation + operation succeeded（带已准备负载）
          const awaiting = seedAwaitingConfirmationPublication(db, {
            workspaceId,
            platformVersionId: studio.platXId,
            account: accX,
            payloadTitle: 'X 平台稿修订',
            payloadBody: '平台 V2 正文'
          });
          makePublicationLatest(db, awaiting.publicationId);
        } finally {
          db.close();
        }
      }
    },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到发布页', () => helpers.navigateTo(page, 'publish'));
      await step('awaiting_confirmation 任务弹窗渲染「退回创作修改」，状态词为等待人工发布', async () => {
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix', { timeout: 15_000 });
        await page.evaluate(() => { document.querySelector('.publish-matrix-row .publish-cell')?.click(); });
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const buttons = await page.$$eval('#publish-task-modal-dialog .publish-task-actions button', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        assert(buttons.includes('退回创作修改'), `缺少退回创作修改: ${JSON.stringify(buttons)}`);
        // operation succeeded 已过期：状态词以发布状态为准（等待人工发布），不显示「编辑器已准备」
        const pill = await page.textContent('#publish-task-modal-dialog .publish-task-modal-head .pill-status');
        assert(pill.includes('等待人工发布'), `状态词应为等待人工发布: ${pill}`);
      });
      await step('退回后打开原创作项目', async () => {
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('#publish-task-modal-dialog button')].find((b) => b.textContent?.includes('退回创作修改'));
          btn?.click();
        });
        await page.waitForFunction(() => document.querySelector('nav button[title="创作"]')?.classList.contains('active'), null, { timeout: 15_000 });
        await page.waitForSelector('.studio-editor-view', { timeout: 20_000 });
        const title = await page.inputValue('#studio-title');
        assert(title === 'E2E 创作项目 A', `退回应打开原创作项目: ${JSON.stringify(title)}`);
      });
      await step('回到发布页：退回记录显示已退回创作且无退回按钮，未退回项不受影响', async () => {
        await helpers.navigateTo(page, 'publish');
        await waitPublishPage(page);
        await page.waitForSelector('.publish-matrix', { timeout: 15_000 });
        // 代表性单元 = 刚退回的 draft（updated_at 最新）
        await page.evaluate(() => { document.querySelector('.publish-matrix-row .publish-cell')?.click(); });
        await page.waitForSelector('#publish-task-modal-dialog', { timeout: 10_000 });
        const pill = await page.textContent('#publish-task-modal-dialog .publish-task-modal-head .pill-status');
        assert(pill.includes('已退回创作'), `退回后状态词应为已退回创作: ${pill}`);
        const buttons = await page.$$eval('#publish-task-modal-dialog .publish-task-actions button', (els) => els.map((e) => e.textContent?.trim() ?? ''));
        assert(!buttons.includes('退回创作修改'), `退回后不应再渲染退回按钮: ${JSON.stringify(buttons)}`);
        // 未退回的待授权项仍在「待我处理」页签
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('#publish-task-modal-dialog'), null, { timeout: 10_000 });
        await page.evaluate(() => {
          const tab = [...document.querySelectorAll('.publish-tabs .proposal-tab')].find((b) => b.textContent?.includes('待我处理'));
          tab?.click();
        });
        await page.waitForFunction(() => document.querySelector('.publish-matrix-row .publish-cell')?.textContent?.includes('继续发布'), null, { timeout: 10_000 });
      });
      await step('持久化：draft 状态 + Owner preflight rejection 审计事件 + 零发布副作用', () => {
        const { db, close } = openDb();
        try {
          const row = db.prepare(`SELECT p.status, e.from_status AS fromStatus, e.to_status AS toStatus, e.reason
            FROM publications p JOIN publication_events e ON e.publication_id = p.id
            WHERE p.status = 'draft' ORDER BY e.rowid DESC LIMIT 1`).get();
          assert(row && row.status === 'draft' && row.fromStatus === 'awaiting_confirmation' && row.toStatus === 'draft', `退回事件缺失: ${JSON.stringify(row)}`);
          assert(String(row.reason).includes('Owner preflight rejection'), `审计原因缺失: ${JSON.stringify(row)}`);
          assert(Number(db.prepare('SELECT COUNT(*) AS c FROM publication_attempts').get().c) === 0, '退回不得创建发布尝试（无自动发布）');
        } finally { close(); }
      });
      return { returned: true };
    }
  }
];
