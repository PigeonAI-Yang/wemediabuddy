// WMB-5251 辅助面板弹窗迁移 E2E 验收（真实 Electron + 隔离 workspace，零外部副作用）。
//
// 共享契约（AppModal foundation，src/renderer/app-modal.tsx + styles-modal.css）：
// - 根 .app-modal-root（portal 到 body，role=presentation，testId → data-testid）
// - 遮罩 .app-modal-backdrop（dialog 的兄弟节点，点击关闭默认开启 closeOnBackdrop）
// - 对话框 .app-modal-dialog[role=dialog|alertdialog][aria-modal=true][data-size=confirm|standard|large|fullscreen]
// - 头 .app-modal-head（.app-modal-title h2 + .app-modal-close），体 .app-modal-body，尾 .app-modal-footer
// - Tab/Shift+Tab 焦点圈定 + Esc + body 滚动锁 + 关闭焦点归还均为 JS 行为（window keydown / body.style.overflow）
// - 紧凑窗口（max-width:799px 或 max-height:699px）非 fullscreen 对话框降级为 100vw/100vh
//
// 验收（与六个实现 worker 通过 hub 协调的稳定选择器，全部已对照落地源码）：
// 1) 今日来源详情 = 非模态内联阅读页，只呈现当前点击的一条来源；全局导航与 Pi 入口保持可用；
//    资料依次呈现来源身份、标题、摘要、存档媒体、已归档正文摘录、版权与来源，正文不承担 Pi 动作；
//    「在资料库中查看」进入资料库；feed 标题打开来源 1/2；媒体空态如实；Esc/返回恢复 Today。
// 2) 详情 = 单张等距圆角卡：四边外边距均等于 var(--page-space)，单一 12px 圆角/边框/表面，
//    返回与全部来源动作收进卡头（动作统一 36px，仅 1 个 violet 主操作），无横向溢出；
//    最小窗口与 Pi 展开时仍按单列阅读流收缩，滚动到底来源与版权可达。
// 3) X Lists 操作确认 = alertdialog + backdrop-inert（点遮罩不关）+ Esc 可关 + 删除需输入列表名。
// 4) 智能体任务详情 = standard modal；关闭绝不取消运行中任务（状态前后一致、非 cancelled）。
// 5) 创作记录 = large 页签弹窗（批注/版本 role=tab）；第三列 rail 不再出现，关闭后编辑器布局原样返回。
// 6) 关系画布最近变化 = large 弹窗；弹窗打开时 Esc 只关弹窗、不清除画布框选，焦点归还触发按钮。
//
// 运行方式（与既有 standalone e2e 一致）：
//   node tests/e2e/runner.mjs --file tests/e2e/wmb-5251-modal-migration.test.mjs
// 或单场景：  ... --file tests/e2e/wmb-5251-modal-migration.test.mjs --scenario WMB-5270-today-inline-detail-contract

import { createHash } from 'node:crypto';
import { helpers } from './harness.mjs';
import { openDb, shanghaiPlanDate, seedPlan, seedSource } from './lib/seed.mjs';
import { seedRichKnowledge } from './fixture-knowledge.mjs';
import { seedWorkflowBase, openWriteDb, seedStudioProject } from './seed-workflow.mjs';
import { rebuildWikiIndex } from '../../src/main/db/wiki-index-store.ts';
import { writeSourceBodyCache } from '../../src/main/source-body-cache.ts';
import { importAssetBytes } from '../../src/main/assets.ts';

const { assert, step, waitForAppReady, navigateTo, delay, captureEvidence } = helpers;

const planDate = shanghaiPlanDate();

// ---------------------------------------------------------------------------
// 共享小工具
// ---------------------------------------------------------------------------

/** 返回 document 里某个 data-testid 的弹窗状态（root 计数 + dialog 契约 + 关键件可见性）。 */
function modalSnapshot(page, testId) {
  return page.evaluate((tid) => {
    const root = [...document.querySelectorAll('.app-modal-root')].find((el) => el.getAttribute('data-testid') === tid);
    const dialog = root?.querySelector('.app-modal-dialog') ?? null;
    return {
      rootCount: document.querySelectorAll('.app-modal-root').length,
      visible: Boolean(root && dialog && dialog.getClientRects().length > 0),
      role: dialog?.getAttribute('role') ?? null,
      ariaModal: dialog?.getAttribute('aria-modal') ?? null,
      size: dialog?.getAttribute('data-size') ?? null,
      dialogId: dialog?.id ?? null,
      title: dialog?.querySelector('.app-modal-title')?.textContent?.trim() ?? null,
      hasBackdrop: Boolean(root?.querySelector('.app-modal-backdrop')),
      hasBody: Boolean(dialog?.querySelector('.app-modal-body')),
      hasClose: Boolean(dialog?.querySelector('.app-modal-close')),
      bodyOverflow: document.body.style.overflow
    };
  }, testId);
}

/** dialog 内当前聚焦元素描述（tagName + className）；不在 dialog 内时为 null。 */
function activeElementInsideDialog(page, testId) {
  return page.evaluate((tid) => {
    const dialog = [...document.querySelectorAll('.app-modal-dialog')]
      .find((el) => el.closest('.app-modal-root')?.getAttribute('data-testid') === tid);
    if (!dialog) return null;
    const active = document.activeElement;
    return active && dialog.contains(active)
      ? { tag: active.tagName.toLowerCase(), className: typeof active.className === 'string' ? active.className : '', text: (active.textContent ?? '').trim().slice(0, 24) }
      : null;
  }, testId);
}

/** dialog 内可聚焦元素清单（与 AppModal FOCUSABLE_SELECTOR 同语义，仅取可见项）。 */
function dialogFocusables(page, testId) {
  return page.evaluate((tid) => {
    const dialog = [...document.querySelectorAll('.app-modal-dialog')]
      .find((el) => el.closest('.app-modal-root')?.getAttribute('data-testid') === tid);
    if (!dialog) return [];
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    return [...dialog.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ tag: el.tagName.toLowerCase(), className: typeof el.className === 'string' ? el.className : '' }));
  }, testId);
}

/** 从页内把焦点移到 dialog 第 n 个可聚焦元素（n 从 0 起）。 */
function focusDialogItem(page, testId, index) {
  return page.evaluate(({ tid, n }) => {
    const dialog = [...document.querySelectorAll('.app-modal-dialog')]
      .find((el) => el.closest('.app-modal-root')?.getAttribute('data-testid') === tid);
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const items = [...dialog.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0);
    items[n]?.focus();
    return items.length;
  }, { tid: testId, n: index });
}

async function bodyText(page, selector) {
  return page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', selector);
}

/** 详情阅读列纵向滚动状态：overflowY 应为 auto，且能滚动到底看到来源脚注（不被 today-layout 裁剪）。 */
async function readingFlowState(page) {
  return page.evaluate(() => {
    const section = document.querySelector('.today-source-detail-page');
    const provenance = section?.querySelector('.source-provenance');
    if (!section || !provenance) return { scrollable: false, reached: false, overflowY: '' };
    section.scrollTop = section.scrollHeight;
    const pr = provenance.getBoundingClientRect();
    const sr = section.getBoundingClientRect();
    const reached = pr.bottom <= sr.bottom + 1 && pr.top >= sr.top - 1;
    section.scrollTop = 0;
    return { scrollable: section.scrollHeight > section.clientHeight, reached, overflowY: getComputedStyle(section).overflowY };
  });
}

/**
 * WMB-5272 单一卡片契约：等距外边距（四边均 = var(--page-space)）、单卡边界/圆角/表面
 * （与外层产品页 token 一致）、返回与全部来源动作收进卡头（36px 统一控制、标签不换行、
 * 仅 1 个 primary 主操作）、无横向溢出、滚动到底卡片完整延伸且来源与版权可见。
 */
async function sourceCardContract(page) {
  return page.evaluate(() => {
    const section = document.querySelector('[data-testid="today-source-detail-page"]');
    const card = section?.querySelector('.today-source-detail');
    if (!section || !card) return { present: false };
    const pageSpace = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-space')) || 16;
    const sr = section.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const insets = {
      left: Math.round(cr.left - sr.left),
      right: Math.round(sr.left + section.clientWidth - cr.right),
      top: Math.round(cr.top - sr.top),
      bottom: Math.round(section.scrollHeight - (cr.bottom - sr.top + section.scrollTop))
    };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--surface);border:1px solid var(--border);border-radius:12px;';
    document.body.appendChild(probe);
    const expected = {
      background: getComputedStyle(probe).backgroundColor,
      borderColor: getComputedStyle(probe).borderTopColor,
      radius: getComputedStyle(probe).borderRadius
    };
    probe.remove();
    const cs = getComputedStyle(card);
    const head = card.querySelector('.detail-head');
    const back = card.querySelector('.today-source-detail-back');
    const actions = card.querySelector('.today-source-detail-actions');
    const actionButtons = actions ? [...actions.querySelectorAll('button')] : [];
    section.scrollTop = section.scrollHeight;
    const pr = card.querySelector('.source-provenance')?.getBoundingClientRect();
    const cardBottom = Math.round(card.getBoundingClientRect().bottom);
    const sectionBottom = Math.round(sr.bottom);
    section.scrollTop = 0;
    return {
      present: true,
      pageSpace,
      insets,
      singleCard: document.querySelectorAll('.today-source-detail').length === 1,
      onlyChild: section.children.length === 1 && section.children[0] === card,
      boundary: {
        radius: cs.borderRadius,
        borderWidth: cs.borderTopWidth,
        matches: cs.borderRadius === expected.radius && cs.borderTopWidth === '1px' && cs.borderTopColor === expected.borderColor && cs.backgroundColor === expected.background
      },
      header: {
        hasHead: Boolean(head),
        backInside: Boolean(back && head?.contains(back)),
        actionsInside: Boolean(actions && head?.contains(actions)),
        backLeft: Boolean(back && actions && back.getBoundingClientRect().left < actions.getBoundingClientRect().left),
        backHeight: back ? Math.round(back.getBoundingClientRect().height) : 0,
        actionHeights: actionButtons.map((b) => Math.round(b.getBoundingClientRect().height)),
        labelsWrapped: actionButtons.filter((b) => b.scrollWidth > b.clientWidth + 1).length,
        primaryCount: actionButtons.filter((b) => b.classList.contains('primary-button')).length,
        secondaryCount: actionButtons.filter((b) => b.classList.contains('secondary-button')).length,
        libraryButton: (() => {
          const button = actionButtons.find((item) => item.textContent?.includes('在资料库中查看'));
          if (!button) return null;
          const buttonStyle = getComputedStyle(button);
          return {
            className: button.className,
            borderWidth: buttonStyle.borderTopWidth,
            borderColor: buttonStyle.borderTopColor,
            background: buttonStyle.backgroundColor,
            radius: buttonStyle.borderRadius
          };
        })(),
        sourceText: (() => {
          const sourceText = card.querySelector('.detail-title');
          if (!sourceText) return null;
          const sourceTextStyle = getComputedStyle(sourceText);
          return {
            fontSize: sourceTextStyle.fontSize,
            fontWeight: sourceTextStyle.fontWeight,
            lineHeight: sourceTextStyle.lineHeight,
            letterSpacing: sourceTextStyle.letterSpacing
          };
        })()
      },
      overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      bottomReached: {
        provenanceVisible: Boolean(pr && pr.top < sr.bottom && pr.bottom > sr.top),
        cardBottom,
        sectionBottom
      }
    };
  });
}

// ---------------------------------------------------------------------------
// 今日夹具：主计划项 + 今日入库资料（TD-004 同款形状）
// ---------------------------------------------------------------------------

const IDLE_ITEMS = [
  { title: 'E2E 机会 1', priority: 1, timeliness: '爆点' },
  { title: 'E2E 长青选题 B', priority: 2, timeliness: '长青' }
];
const DUPLICATE_SOURCE_TEXT = 'E2E 资料 1 原帖正文：in may they said they were at a 47B run rate. if that was an estimate based on their next quarter this perfectly nails it they also said 100-120B by end of year so they need to more than double next quarter, crazy';
const DUPLICATE_SOURCE_TITLE = DUPLICATE_SOURCE_TEXT.slice(0, DUPLICATE_SOURCE_TEXT.indexOf('more than') + 3);
const DISTINCT_BODY_TEXT = 'E2E 独立归档正文 3：这段正文与资料标题、工作摘要均不同，必须继续显示在正文摘录区域。';
const TODAY_SOURCES = [
  { id: 'e2e-source-1', title: DUPLICATE_SOURCE_TITLE, summary: DUPLICATE_SOURCE_TEXT, author: 'E2E 作者', originalUrl: 'https://x.com/e2e/status/1' },
  { id: 'e2e-source-2', title: 'E2E 资料 2', summary: 'E2E 资料摘要 2', author: 'E2E 作者', originalUrl: 'https://example.com/e2e/source-2' },
  { id: 'e2e-source-3', title: 'E2E 资料 3', summary: 'E2E 独立工作摘要 3', author: 'E2E 作者', originalUrl: 'https://example.com/e2e/source-3' }
];

function seedTodayFixture() {
  return async ({ dataRoot }) => {
    const db = openDb(dataRoot);
    try {
      seedPlan(db, { planDate, items: IDLE_ITEMS });
      for (const s of TODAY_SOURCES) seedSource(db, s);

      const revisionKey = 'source:e2e-source-1:r1';
      const image = await importAssetBytes(db, dataRoot, {
        bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', 'base64'),
        fileName: 'e2e-source-image.png',
        mimeType: 'image/png',
        origin: 'e2e:today-source-detail'
      });
      const video = await importAssetBytes(db, dataRoot, {
        bytes: Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==', 'base64'),
        fileName: 'e2e-source-video.mp4',
        mimeType: 'video/mp4',
        origin: 'e2e:today-source-detail',
        durationMs: 12_000
      });
      const now = new Date().toISOString();
      const insertCandidate = db.prepare(`INSERT INTO source_media_candidates
        (id, source_id, source_revision_key, kind, original_url, stable_remote_identity, channel, ordinal, status, attempt_count, max_attempts, discovered_at)
        VALUES (?, 'e2e-source-1', ?, ?, ?, ?, 'research', ?, 'preserved', 1, 3, ?)`);
      const insertBinding = db.prepare(`INSERT INTO source_media_bindings
        (id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, caption, sha256,
         captured_at, rights_status, risk_flags_json, created_at, created_by)
        VALUES (?, 'e2e-source-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', '[]', ?, 'e2e')`);
      for (const [ordinal, kind, asset, url, caption] of [
        [0, 'image', image, 'https://cdn.example.com/e2e-image.png', 'E2E 本地图片'],
        [1, 'video', video, 'https://cdn.example.com/e2e-video.mp4', 'E2E 本地视频']
      ]) {
        const candidateId = `smc:e2e-source-1:${ordinal}:${kind}`;
        insertCandidate.run(candidateId, revisionKey, kind, url, createHash('sha256').update(url).digest('hex'), ordinal, now);
        insertBinding.run(`sbm:${candidateId}`, revisionKey, candidateId, asset.id, kind, ordinal, url, caption, asset.sha256, now, now);
      }
      // WMB-5271：经生产 writeSourceBodyCache 契约落一条真实 ready 正文（latest 投影 + 不可变 revision）。
      // 后台正文归档调度对已有 ready revision 的来源不会重复补抓，摘录状态因此确定。
      const bodyText = DUPLICATE_SOURCE_TEXT
        .replace(' they also said', '\n\nthey also said')
        .replace(' so they need', '\n\nso they need');
      writeSourceBodyCache(db, {
        sourceId: 'e2e-source-1',
        url: 'https://example.com/e2e/source-1',
        status: 'ready',
        contentType: 'text/plain',
        extractedText: bodyText,
        extractedChars: bodyText.length,
        errorMessage: null,
        fetchedAt: now,
        updatedAt: now
      });
      writeSourceBodyCache(db, {
        sourceId: 'e2e-source-3',
        url: 'https://example.com/e2e/source-3',
        status: 'ready',
        contentType: 'text/plain',
        extractedText: DISTINCT_BODY_TEXT,
        extractedChars: DISTINCT_BODY_TEXT.length,
        errorMessage: null,
        fetchedAt: now,
        updatedAt: now
      });
    } finally {
      db.close();
    }
  };
}

/** 通过 feed 标题打开当前来源详情内联子页。 */
async function openTodaySourceDetail(page, title) {
  const feedTitle = page.locator('.feed-title', { hasText: title }).first();
  await feedTitle.waitFor({ state: 'visible', timeout: 20_000 });
  await feedTitle.click();
  await page.waitForSelector('[data-testid="today-source-detail-page"]', { state: 'visible', timeout: 10_000 });
}

// ===========================================================================
// WMB-5270：今日来源详情是内联子页，不再以全屏弹窗遮断导航与 Pi。
// ===========================================================================

export default [
  {
    id: 'WMB-5270-today-inline-detail-contract',
    journeyIds: ['WMB-5270-today-inline-detail-contract'],
    launch: { seedFixture: seedTodayFixture() },
    run: async ({ app, page, evidence, artifactsDir }) => {
      await step(evidence, '启动进入主壳；查看资料 仍进入资料库并返回今日', async () => {
        await waitForAppReady(page);
        await page.locator('.today-command[data-mode="idle"]').waitFor({ state: 'visible', timeout: 30_000 });
        const trigger = page.locator('.today-command-actions button.secondary-button', { hasText: '查看资料' });
        await trigger.waitFor({ state: 'visible', timeout: 20_000 });
        await trigger.click();
        await page.waitForSelector('.page.library-page', { state: 'visible', timeout: 10_000 });
        assert((await page.locator('[data-testid="today-source-detail-page"]').count()) === 0, '查看资料 应进入资料库而非来源详情');
        await navigateTo(page, 'today');
        await page.locator('.today-command[data-mode="idle"]').waitFor({ state: 'visible', timeout: 30_000 });
      });

      await step(evidence, 'feed 标题打开来源 1 内联详情；全局导航和 Pi 保持可用', async () => {
        await openTodaySourceDetail(page, 'E2E 资料 1');
        const state = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="today-source-detail-page"]');
          const rect = root?.getBoundingClientRect();
          return {
            detailCount: document.querySelectorAll('[data-testid="today-source-detail-page"]').length,
            modalCount: document.querySelectorAll('.app-modal-root').length,
            navVisible: Boolean(document.querySelector('.sidebar')),
            piToggleVisible: Boolean(document.querySelector('.pi-dock')),
            bodyOverflow: document.body.style.overflow,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            width: rect?.width ?? 0
          };
        });
        assert(state.detailCount === 1, `应恰好有 1 个内联详情，实际 ${state.detailCount}`);
        assert(state.modalCount === 0, `来源详情不应创建 modal，实际 ${state.modalCount}`);
        assert(state.navVisible && state.piToggleVisible, '详情页必须保留全局导航与 Pi 入口');
        assert(state.bodyOverflow !== 'hidden', `内联详情不应锁定 body 滚动，实际 ${state.bodyOverflow}`);
        assert(state.overflowX === 0, `详情页不应横向溢出，实际 ${state.overflowX}px`);
        assert(state.width > 600, `详情内容宽度异常，实际 ${state.width}px`);
        const flow = await readingFlowState(page);
        assert(flow.reached && flow.overflowY === 'auto',
          `阅读流应可纵向到达来源脚注且不被裁剪，实际 ${JSON.stringify(flow)}`);
      });

      await step(evidence, '单一卡片契约：等距外边距、单卡边界/圆角/表面、动作收进卡头、无横向溢出、底部来源可达', async () => {
        const card = await sourceCardContract(page);
        assert(card.present && card.singleCard && card.onlyChild, '来源详情应为页面内唯一的整页卡片');
        for (const side of ['left', 'right', 'top', 'bottom']) {
          assert(Math.abs(card.insets[side] - card.pageSpace) <= 1, `外距 ${side} 应等于 var(--page-space)（${card.pageSpace}px），实际 ${card.insets[side]}px`);
        }
        assert(card.boundary.radius === '12px', `卡片圆角应为 12px，实际 ${card.boundary.radius}`);
        assert(card.boundary.matches, `卡片边框/圆角/表面应与外层产品页 token 一致，实际 ${JSON.stringify(card.boundary)}`);
        assert(card.header.hasHead && card.header.backInside && card.header.actionsInside, '返回与全部来源动作应位于卡片头内');
        assert(card.header.backLeft, '返回应在左、动作组在右');
        assert(card.header.backHeight === 36 && card.header.actionHeights.length === 2 && card.header.actionHeights.every((h) => h === 36),
          `返回与两个来源动作应统一 36px 高，实际 back=${card.header.backHeight} actions=${JSON.stringify(card.header.actionHeights)}`);
        assert(card.header.labelsWrapped === 0, '桌面端动作标签不得换行');
        assert(card.header.primaryCount === 0 && card.header.secondaryCount === 2,
          `详情自身已是 Pi focus，头部应只保留 2 个次要来源动作，实际 primary=${card.header.primaryCount} secondary=${card.header.secondaryCount}`);
        assert(card.header.libraryButton?.className.includes('secondary-button')
          && card.header.libraryButton.borderWidth === '1px'
          && card.header.libraryButton.borderColor !== 'rgba(0, 0, 0, 0)'
          && card.header.libraryButton.background !== 'rgba(0, 0, 0, 0)'
          && card.header.libraryButton.radius === '7px',
          `在资料库中查看 应具有标准次级按钮边框、表面与圆角，实际 ${JSON.stringify(card.header.libraryButton)}`);
        assert(card.header.sourceText?.fontSize === '16px'
          && Number.parseFloat(card.header.sourceText.lineHeight) >= 27,
          `来源推文正文应使用正文级 16px 字号与舒展行高，实际 ${JSON.stringify(card.header.sourceText)}`);
        assert(card.overflowX === 0, `不应横向溢出，实际 ${card.overflowX}px`);
        assert(card.bottomReached.provenanceVisible, '滚动到底时来源与版权块应可见');
        assert(Math.abs(card.bottomReached.sectionBottom - card.bottomReached.cardBottom - card.pageSpace) <= 1,
          `卡片底部应延伸至内容末端（不被裁剪），实际 ${JSON.stringify(card.bottomReached)}`);
      });

      await step(evidence, '截断标题、同文摘要与归档正文合并为一份完整原帖', async () => {
        await page.waitForFunction(() => Boolean(document.querySelector('.source-body-inline-state'))
          && !document.querySelector('.today-source-detail .detail-body'), null, { timeout: 10_000 });
        const detailState = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="today-source-detail-page"]');
          return {
            primaryText: root?.querySelector('.detail-title')?.textContent?.trim() ?? '',
            summaryCount: root?.querySelectorAll('.detail-summary').length ?? 0,
            bodyCount: root?.querySelectorAll('.detail-body').length ?? 0,
            archiveState: root?.querySelector('.source-body-inline-state')?.textContent?.trim() ?? '',
            legacyCount: document.querySelectorAll('.today-sources-list, .today-sources-split, .source-list, .source-row, [data-pane], [data-testid="today-sources-modal"]').length,
            text: root?.textContent ?? ''
          };
        });
        assert(detailState.primaryText.replace(/\s+/g, ' ') === DUPLICATE_SOURCE_TEXT, `应展示最完整原帖而非截断标题，实际 ${detailState.primaryText}`);
        assert(detailState.summaryCount === 0 && detailState.bodyCount === 0,
          `同文工作摘要与正文摘录不应重复成独立分区，实际 summary=${detailState.summaryCount} body=${detailState.bodyCount}`);
        assert(detailState.archiveState.includes('正文已归档'), `去重后仍应保留正文归档事实，实际 ${detailState.archiveState}`);
        assert(!detailState.text.includes('E2E 资料 2') && detailState.legacyCount === 0, '详情不得混入其他来源或旧弹窗/列表 DOM');
      });

      await step(evidence, '进入来源详情即成为 Pi 当前 focus，ready 正文自动补齐', async () => {
        await page.waitForFunction(() => {
          const chip = document.querySelector('.pi-context-chip')?.textContent ?? '';
          return chip.includes('E2E 资料 1') && chip.includes('含正文');
        }, null, { timeout: 10_000 });
        const focusState = await page.evaluate(() => {
          const chip = document.querySelector('.pi-context-chip')?.textContent ?? '';
          const detailActions = document.querySelector('.today-source-detail-actions')?.textContent ?? '';
          return { chip, detailActions };
        });
        assert(focusState.chip.includes('E2E 资料 1') && focusState.chip.includes('含正文'), `Pi 当前标签应指向正在阅读且含正文的来源，实际 ${focusState.chip}`);
        assert(!focusState.chip.includes('持续关注') && !/加入 Pi 上下文|移出 Pi 上下文/.test(focusState.detailActions),
          `详情 focus 不应再显示笼统持续关注或冗余上下文按钮，实际 ${JSON.stringify(focusState)}`);
      });

      await step(evidence, '当前 revision 媒体如实呈现：2/2 已保存、本地图片与视频预览', async () => {
        await page.waitForFunction(() => document.querySelector('.today-source-detail .detail-media')?.textContent?.includes('已保存 2/2') ?? false, null, { timeout: 10_000 });
        const imageMedia = await page.evaluate(() => {
          const root = document.querySelector('.today-source-detail .detail-media');
          const image = root?.querySelector('.media-preview-img');
          return { tiles: root?.querySelectorAll('.media-thumb').length ?? 0, imageSrc: image?.getAttribute('src') ?? '', text: root?.textContent ?? '' };
        });
        assert(imageMedia.tiles === 2, `应展示 2 个本地媒体项，实际 ${imageMedia.tiles}`);
        assert(imageMedia.imageSrc.startsWith('wmb-asset://'), `图片必须使用本地 Asset，实际 ${imageMedia.imageSrc}`);
        assert(imageMedia.text.includes('已本地保存'), '媒体项应明确标记已本地保存');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'inline-source-image' });

        await page.locator('.media-thumb[aria-label^="视频"]').click();
        await page.waitForSelector('.media-preview-video[src^="wmb-asset://"]', { state: 'visible', timeout: 10_000 });
        const videoMedia = await page.evaluate(() => {
          const video = document.querySelector('.media-preview-video');
          return { src: video?.getAttribute('src') ?? '', controls: video?.hasAttribute('controls') ?? false };
        });
        assert(videoMedia.src.startsWith('wmb-asset://'), `视频必须使用本地 Asset，实际 ${videoMedia.src}`);
        assert(videoMedia.controls, '本地视频预览应提供播放控件');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'inline-source-video' });
      });

      await step(evidence, '去重后的阅读层级明确：完整原帖、媒体、来源单向排列', async () => {
        const detailState = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="today-source-detail-page"]');
          const media = root?.querySelector('.detail-media');
          const provenance = root?.querySelector('.source-provenance');
          return {
            mediaTop: media?.getBoundingClientRect().top ?? 0,
            provenanceTop: provenance?.getBoundingClientRect().top ?? 0,
            primaryText: root?.querySelector('.detail-title')?.textContent?.trim() ?? '',
            summaryCount: root?.querySelectorAll('.detail-summary').length ?? 0,
            bodyCount: root?.querySelectorAll('.detail-body').length ?? 0,
            text: root?.textContent ?? ''
          };
        });
        assert(detailState.mediaTop < detailState.provenanceTop,
          `去重详情应按完整原帖→媒体→来源排列，实际 ${JSON.stringify(detailState)}`);
        assert(detailState.primaryText.replace(/\s+/g, ' ') === DUPLICATE_SOURCE_TEXT, '完整原帖必须成为唯一主内容');
        assert(detailState.summaryCount === 0 && detailState.bodyCount === 0, '同文摘要与摘录必须退出阅读流');
        assert(!/抓取正文|重新抓取|带正文给 Pi/.test(detailState.text), '详情不应残留手动抓取/Pi 动作文案');
      });

      await step(evidence, 'Esc 返回今日并恢复到来源触发点', async () => {
        await page.keyboard.press('Escape');
        await page.waitForSelector('[data-testid="today-source-detail-page"]', { state: 'detached', timeout: 10_000 });
        await page.locator('.today-command[data-mode="idle"]').waitFor({ state: 'visible', timeout: 10_000 });
        const focused = await page.evaluate(() => ({ sourceId: document.activeElement?.getAttribute('data-source-open'), insideModal: Boolean(document.activeElement?.closest('.app-modal-root')) }));
        assert(focused.sourceId === 'e2e-source-1', `焦点应恢复到来源 1 触发点，实际 ${focused.sourceId}`);
        const chipAfterReturn = await page.locator('.pi-context-chip').textContent();
        assert(!chipAfterReturn?.includes('E2E 资料 1'), `返回 Today 后应清除来源详情 focus，实际 ${chipAfterReturn}`);
        assert(!focused.insideModal, '焦点不应位于 modal');
      });

      await step(evidence, '来源 2 保持独立摘要、媒体空态与自动正文状态', async () => {
        await openTodaySourceDetail(page, 'E2E 资料 2');
        const detailText = await bodyText(page, '[data-testid="today-source-detail-page"]');
        assert(detailText.includes('E2E 资料摘要 2') && !detailText.includes(DUPLICATE_SOURCE_TEXT), '来源 2 详情应独立');
        assert(detailText.includes('这条资料没有随附媒体'), `来源 2 应显示媒体空态，实际 ${detailText}`);
        const bodyState = await page.evaluate(() => {
          const body = document.querySelector('.today-source-detail .detail-body');
          return { text: body?.textContent ?? '', actions: body?.querySelectorAll('button').length ?? 0 };
        });
        assert(bodyState.text.includes('正文摘录'), `来源 2 应呈现自动正文状态区，实际 ${bodyState.text}`);
        assert(bodyState.actions === 0 && !/给 Pi|抓取正文|重新抓取/.test(bodyState.text), '自动正文状态同样不得有动作/Pi 耦合');
        await page.locator('.today-source-detail-back').click();
        await page.waitForSelector('[data-testid="today-source-detail-page"]', { state: 'detached', timeout: 10_000 });
      });

      await step(evidence, '真实不同的摘要与归档正文继续分别展示', async () => {
        await openTodaySourceDetail(page, 'E2E 资料 3');
        await page.waitForFunction(() => document.querySelector('.today-source-detail .excerpt-box')?.textContent?.includes('E2E 独立归档正文 3') ?? false, null, { timeout: 10_000 });
        const distinct = await page.evaluate(() => {
          const root = document.querySelector('.today-source-detail');
          return {
            summary: root?.querySelector('.detail-summary')?.textContent ?? '',
            body: root?.querySelector('.detail-body')?.textContent ?? '',
            summaryCount: root?.querySelectorAll('.detail-summary').length ?? 0,
            bodyCount: root?.querySelectorAll('.detail-body').length ?? 0
          };
        });
        assert(distinct.summaryCount === 1 && distinct.summary.includes('E2E 独立工作摘要 3'), `独立摘要应保留，实际 ${JSON.stringify(distinct)}`);
        assert(distinct.bodyCount === 1 && distinct.body.includes(DISTINCT_BODY_TEXT), `独立归档正文应保留，实际 ${JSON.stringify(distinct)}`);
        await page.locator('.today-source-detail-back').click();
        await page.waitForSelector('[data-testid="today-source-detail-page"]', { state: 'detached', timeout: 10_000 });
      });

      await step(evidence, '健康：无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { presentation: 'inline-subpage', modal: false, duplicateContentCollapsed: true, distinctContentPreserved: true, navigationPreserved: true, piPreserved: true, mediaPreserved: true, mediaEmpty: true, escReturns: true, focusRestored: true };
    }
  },

  // ===========================================================================
  // WMB-5270 响应式：最小窗口与 Pi 展开时仍是可滚动内联页，无横向溢出。
  // ===========================================================================

  {
    id: 'WMB-5270-inline-detail-responsive',
    journeyIds: ['WMB-5270-inline-detail-responsive'],
    launch: { seedFixture: seedTodayFixture() },
    run: async ({ app, page, evidence }) => {
      await step(evidence, '启动进入主壳并展开 Pi', async () => {
        await waitForAppReady(page);
        await page.locator('.today-command[data-mode="idle"]').waitFor({ state: 'visible', timeout: 30_000 });
        const alreadyOpen = await page.evaluate(() => document.querySelector('.app-shell')?.classList.contains('pi-open') === true);
        if (!alreadyOpen) {
          await page.locator('.pi-dock-toggle-rail').hover();
          await page.locator('.pi-dock-toggle').click();
        }
        await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('pi-open') === true, null, { timeout: 10_000 });
        const width = await page.evaluate(() => document.querySelector('.pi-dock')?.getBoundingClientRect().width ?? 0);
        assert(width > 300, `Pi dock 应展开（>300px），实际 ${width}`);
      });

      await step(evidence, '打开内联来源详情', async () => {
        await openTodaySourceDetail(page, 'E2E 资料 1');
        assert((await page.locator('.app-modal-root').count()) === 0, '内联详情不应创建弹窗');
      });

      await step(evidence, '1183×871 + Pi 展开：详情随内容区收缩且无横向溢出', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1183, 871));
        await delay(300);
        const geometry = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="today-source-detail-page"]');
          const content = document.querySelector('.today-source-detail');
          const rr = root?.getBoundingClientRect();
          const cr = content?.getBoundingClientRect();
          return {
            rootLeft: rr?.left ?? 0,
            rootRight: rr?.right ?? 0,
            rootWidth: rr?.width ?? 0,
            rootClientWidth: root?.clientWidth ?? 0,
            contentWidth: cr?.width ?? 0,
            innerWidth: window.innerWidth,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            modalCount: document.querySelectorAll('.app-modal-root').length
          };
        });
        assert(geometry.rootWidth > 300 && geometry.contentWidth > 300 && geometry.contentWidth < geometry.rootClientWidth,
          `详情卡片应占滚动容器可用内容宽度（等距外边距由卡契约断言），实际 root=${geometry.rootWidth} client=${geometry.rootClientWidth} content=${geometry.contentWidth}`);
        assert(geometry.rootLeft >= 0 && geometry.rootRight <= geometry.innerWidth, `详情应位于视口内，实际 ${geometry.rootLeft}..${geometry.rootRight}/${geometry.innerWidth}`);
        assert(geometry.overflowX === 0, `不应横向溢出，实际 ${geometry.overflowX}px`);
        assert(geometry.modalCount === 0, '收缩时仍不得出现 modal');
        const card = await sourceCardContract(page);
        assert(card.present && card.singleCard && card.onlyChild, 'Pi 展开收缩后仍应为单张整页卡片');
        for (const side of ['left', 'right', 'top', 'bottom']) {
          assert(Math.abs(card.insets[side] - card.pageSpace) <= 1, `Pi 展开时外距 ${side} 应等于 var(--page-space)（${card.pageSpace}px），实际 ${card.insets[side]}px`);
        }
        assert(card.header.labelsWrapped === 0 && card.header.actionHeights.every((h) => h === 36),
          `Pi 展开时动作标签不得换行且统一 36px，实际 ${JSON.stringify(card.header)}`);
        const flow = await readingFlowState(page);
        assert(flow.scrollable && flow.reached && flow.overflowY === 'auto',
          `Pi 展开收缩后阅读流仍应纵向滚动到底，实际 ${JSON.stringify(flow)}`);
      });

      await step(evidence, '1100×800 最小窗口：标题、返回和核心动作可见可用', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await delay(300);
        const state = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="today-source-detail-page"]');
          const rect = root?.getBoundingClientRect();
          const actionText = root?.querySelector('.today-source-detail-actions')?.textContent ?? '';
          return {
            width: rect?.width ?? 0,
            right: rect?.right ?? 0,
            innerWidth: window.innerWidth,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            text: root?.textContent ?? '',
            actionText
          };
        });
        assert(state.width > 280 && state.right <= state.innerWidth, `最小窗口详情应在视口内，实际 width=${state.width} right=${state.right}/${state.innerWidth}`);
        assert(state.overflowX === 0, `最小窗口不得横向溢出，实际 ${state.overflowX}px`);
        const card = await sourceCardContract(page);
        assert(card.present && card.singleCard, '最小窗口仍应为单张整页卡片');
        for (const side of ['left', 'right', 'top', 'bottom']) {
          assert(Math.abs(card.insets[side] - card.pageSpace) <= 1, `最小窗口外距 ${side} 应等于 var(--page-space)（${card.pageSpace}px），实际 ${card.insets[side]}px`);
        }
        assert(card.header.actionHeights.length === 2 && card.header.labelsWrapped === 0 && card.header.actionHeights.every((h) => h === 36),
          `最小窗口两个来源动作不得换行且统一 36px，实际 ${JSON.stringify(card.header)}`);
        assert(card.bottomReached.provenanceVisible, '最小窗口滚动到底时来源与版权块应可见');
        const flow = await readingFlowState(page);
        assert(flow.scrollable && flow.reached && flow.overflowY === 'auto',
          `最小窗口阅读流仍应纵向滚动到底，实际 ${JSON.stringify(flow)}`);
        assert(state.text.includes('E2E 资料 1') && state.text.includes('返回今日'), '最小窗口应保留标题与返回入口');
        assert(state.actionText.includes('在资料库中查看') && state.actionText.includes('打开原文') && !/加入 Pi 上下文|移出 Pi 上下文/.test(state.actionText), '最小窗口只保留资料库与原文动作，详情本身即 Pi 当前 focus');
        await page.locator('.today-source-detail-back').click();
        await page.waitForSelector('[data-testid="today-source-detail-page"]', { state: 'detached', timeout: 10_000 });
      });

      await step(evidence, '健康：无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { minimumWindow: true, inlineResponsive: true, piPreserved: true, noHorizontalOverflow: true };
    }
  },

  // ===========================================================================
  // 3) X Lists 操作确认：alertdialog + backdrop-inert + Esc 可关 + 删除名单词门
  // ===========================================================================

  {
    id: 'WMB-5251-x-confirm-modal',
    journeyIds: ['WMB-5251-x-confirm-modal'],
    launch: {
      seedFixture: async ({ dataRoot }) => {
        // 直写一条 awaiting_confirmation 的删除操作（生产恢复路径只处理 running/execution_granted，
        // 不会改动该状态）；弹窗全局挂载并按 1s 轮询自动打开。
        const db = openDb(dataRoot);
        const now = new Date().toISOString();
        const snapshot = {
          accountKey: '@e2e-owner',
          list: {
            listId: '18531234567890',
            canonicalUrl: 'https://x.com/i/lists/18531234567890',
            ownerHandle: '@e2e-owner',
            name: 'E2E 待删除列表',
            description: '',
            isPrivate: false,
            memberCount: 0,
            kind: 'owned',
            evidenceFingerprint: 'e2e-snapshot'
          }
        };
        try {
          db.prepare(`INSERT INTO x_list_operations
            (id, request_id, input_hash, kind, account_key, list_id, canonical_url, owner_handle, snapshot_json, payload_json,
             state, phase, stop_requested, confirmation_fingerprint, evidence_json, created_at, updated_at, revision)
            VALUES (?, ?, ?, 'delete', ?, ?, ?, ?, ?, '{}', 'awaiting_confirmation', 'awaiting_confirmation', 0, NULL, '{}', ?, ?, 1)`)
            .run(
              'e2e-x-op-delete', 'e2e-x-req-delete', 'e2e-input-hash',
              '@e2e-owner', '18531234567890', 'https://x.com/i/lists/18531234567890', '@e2e-owner',
              JSON.stringify(snapshot), now, now
            );
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动后确认弹窗自动打开（alertdialog + confirm 尺寸）', async () => {
        await waitForAppReady(page);
        await page.waitForSelector('.app-modal-root[data-testid="x-list-operation-modal"]', { state: 'visible', timeout: 20_000 });
        const snap = await modalSnapshot(page, 'x-list-operation-modal');
        assert(snap.rootCount === 1, `X 确认弹窗应唯一，实际 ${snap.rootCount}`);
        assert(snap.role === 'alertdialog' && snap.ariaModal === 'true', `应为 alertdialog + aria-modal，实际 ${snap.role}/${snap.ariaModal}`);
        assert(snap.size === 'confirm', `确认弹窗应为 data-size=confirm，实际 ${snap.size}`);
        assert(snap.dialogId === 'x-list-operation-modal-dialog', `dialog id 应派生自 testId，实际 ${snap.dialogId}`);
        assert(snap.title === '删除 List', `确认标题应为 删除 List，实际 ${snap.title}`);
        const body = await bodyText(page, '.app-modal-root[data-testid="x-list-operation-modal"] .app-modal-body');
        assert(body.includes('@e2e-owner') && body.includes('E2E 待删除列表'), '弹窗应展示账号与目标 List');
        // 初始焦点在取消按钮（initialFocusRef）。
        const initial = await activeElementInsideDialog(page, 'x-list-operation-modal');
        assert(initial?.className.includes('x-list-operation-cancel'), `初始焦点应为取消按钮，实际 ${initial?.className}`);
      });

      await step(evidence, 'backdrop-inert：点击遮罩不关闭（确认不可绕过）', async () => {
        await page.locator('.app-modal-root[data-testid="x-list-operation-modal"] .app-modal-backdrop').click({ position: { x: 4, y: 4 } });
        await delay(300);
        assert((await modalSnapshot(page, 'x-list-operation-modal')).visible, '点遮罩不得关闭 X 确认弹窗');
      });

      await step(evidence, '删除名单词门：输入错误名单无确认按钮，输入精确名单才出现', async () => {
        const input = page.locator('.app-modal-root[data-testid="x-list-operation-modal"] .app-modal-body input');
        await input.waitFor({ state: 'visible', timeout: 10_000 });
        assert((await page.locator('.app-modal-root[data-testid="x-list-operation-modal"] .x-list-operation-confirm').count()) === 0, '未输入名单前不应有确认按钮');
        await input.fill('错误名单');
        await delay(150);
        assert((await page.locator('.app-modal-root[data-testid="x-list-operation-modal"] .x-list-operation-confirm').count()) === 0, '名单不匹配时确认按钮应保持隐藏');
        await input.fill('E2E 待删除列表');
        await delay(150);
        const confirm = page.locator('.app-modal-root[data-testid="x-list-operation-modal"] .x-list-operation-confirm');
        assert((await confirm.count()) === 1, '名单精确匹配后应出现确认按钮');
      });

      await step(evidence, 'Esc 可关闭（非 busy）+ 焦点归还触发按钮', async () => {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelectorAll('.app-modal-root').length === 0, null, { timeout: 10_000 });
        const focusAfter = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? { tag: el.tagName.toLowerCase(), className: typeof el.className === 'string' ? el.className : '' } : null;
        });
        assert(focusAfter?.className.includes('x-list-operation-trigger'), `Esc 关闭后焦点应归还 X List 触发按钮，实际 ${JSON.stringify(focusAfter)}`);
      });

      await step(evidence, '健康：无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { modal: 'x-list-operation', size: 'confirm', backdropInert: true, esc: true, nameGate: true };
    }
  },

  // ===========================================================================
  // 4) 智能体任务详情：standard modal；关闭绝不取消运行中任务
  // ===========================================================================

  {
    id: 'WMB-5251-agents-detail-modal',
    journeyIds: ['WMB-5251-agents-detail-modal'],
    launch: { seedFixture: seedTodayFixture() },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动进入主壳并打开智能体页', async () => {
        await waitForAppReady(page);
        await navigateTo(page, 'agents');
        await page.locator('.agents-role-card').first().waitFor({ state: 'visible', timeout: 20_000 });
      });

      await step(evidence, '详情弹窗：standard 尺寸 + 关闭只关弹窗并归还焦点', async () => {
        const card = page.locator('.agents-role-card').first();
        await card.click();
        await page.waitForSelector('.app-modal-root[data-testid="agents-detail-modal"]', { state: 'visible', timeout: 10_000 });
        const snap = await modalSnapshot(page, 'agents-detail-modal');
        assert(snap.visible && snap.rootCount === 1, `智能体详情弹窗应可见且唯一，实际 root=${snap.rootCount}`);
        assert(snap.size === 'standard', `智能体详情应为 data-size=standard，实际 ${snap.size}`);
        assert(snap.role === 'dialog' && snap.ariaModal === 'true', `应为 dialog + aria-modal，实际 ${snap.role}/${snap.ariaModal}`);
        assert(snap.title?.includes('运行明细'), `标题应含 运行明细，实际 ${snap.title}`);
        assert((await page.locator('.app-modal-root[data-testid="agents-detail-modal"] .agents-detail-body').count()) === 1, '弹窗内应有运行明细主体');
        await page.locator('.app-modal-root[data-testid="agents-detail-modal"] .app-modal-close').click();
        await page.waitForFunction(() => document.querySelectorAll('.app-modal-root').length === 0, null, { timeout: 10_000 });
        const focusAfter = await page.evaluate(() => document.activeElement?.className ?? '');
        assert(focusAfter.includes('agents-role-card'), `关闭后焦点应归还角色卡，实际 ${focusAfter}`);
      });

      await step(evidence, '关闭取消解耦：真实 IPC 启动 daily 任务 → 打开详情 → 关闭 → 任务状态不变且非 cancelled', async () => {
        const started = await page.evaluate(
          (bd) => window.wmb.startAgentTask({ intent: 'daily_intelligence', businessDate: bd }),
          planDate
        );
        assert(Boolean(started?.ok || started?.reused), `启动运行任务失败: ${JSON.stringify(started?.error ?? started)}`);
        // 等待班组出现运行中角色卡（运行中实例 工作中/研究中）。
        const runningCard = page.locator('.agents-role-card .agents-status-word.status-running').first();
        await runningCard.waitFor({ state: 'visible', timeout: 45_000 });
        // getAgentTask 是异步 IPC；page.evaluate 自动 await 返回的 Promise。
        const statusBefore = await page.evaluate((bd) => window.wmb.getAgentTask({ intent: 'daily_intelligence', businessDate: bd })
          .then((task) => task?.status ?? null)
          .catch(() => null), planDate);
        assert(statusBefore === 'running', `任务应在运行中，实际 ${statusBefore}`);
        await runningCard.locator('xpath=ancestor::button[contains(@class,"agents-role-card")]').click();
        await page.waitForSelector('.app-modal-root[data-testid="agents-detail-modal"]', { state: 'visible', timeout: 10_000 });
        await page.locator('.app-modal-root[data-testid="agents-detail-modal"] .app-modal-close').click();
        await page.waitForFunction(() => document.querySelectorAll('.app-modal-root').length === 0, null, { timeout: 10_000 });
        const statusAfter = await page.evaluate((bd) => window.wmb.getAgentTask({ intent: 'daily_intelligence', businessDate: bd })
          .then((task) => task?.status ?? null)
          .catch(() => null), planDate);
        assert(statusAfter !== 'cancelled', `关闭详情弹窗不得取消运行中任务，实际 ${statusAfter}`);
        assert(statusAfter === statusBefore, `关闭详情弹窗后任务状态应保持不变：${statusBefore} → ${statusAfter}`);
        // 班组仍在场且任务卡未消失。
        assert((await page.locator('.agents-roster').count()) === 1, '关闭详情后班组页应保持渲染');
      });

      await step(evidence, '健康：无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { modal: 'agents-detail', size: 'standard', closeKeepsTask: true };
    }
  },

  // ===========================================================================
  // 5) 创作记录：large 页签弹窗（批注/版本 role=tab）；第三列 rail 不出现，关闭后布局返回
  // ===========================================================================

  {
    id: 'WMB-5251-studio-history-modal',
    journeyIds: ['WMB-5251-studio-history-modal'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        await seedWorkflowBase(dataRoot, workspaceId);
        const db = openWriteDb(dataRoot);
        try {
          seedStudioProject(db, { platforms: ['wechat'] });
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动并打开创作项目（编辑器两列布局，无第三列 rail）', async () => {
        await waitForAppReady(page);
        await navigateTo(page, 'studio');
        await page.locator('.studio-project-row:not(.head)').first().waitFor({ state: 'visible', timeout: 20_000 });
        const opened = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.studio-project-row:not(.head)')];
          const row = rows.find((r) => r.textContent?.includes('E2E 创作项目 A'));
          const btn = row?.querySelector('button.studio-row-action');
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(opened, '创作库未找到项目 E2E 创作项目 A');
        await page.waitForSelector('.studio-editor-view', { timeout: 15_000 });
        await page.locator('.studio-editor-grid').waitFor({ state: 'visible', timeout: 10_000 });
        await page.locator('.studio-canvas').waitFor({ state: 'visible', timeout: 10_000 });
        assert((await page.locator('.studio-context-v2').count()) === 0, '编辑器不应再渲染第三列 .studio-context-v2');
      });

      await step(evidence, '版本 触发 large 页签弹窗（批注/版本 role=tab），第三列仍缺席', async () => {
        await page.locator('.studio-editor-top button.secondary-button', { hasText: '版本' }).click();
        await page.waitForSelector('.app-modal-root[data-testid="studio-history-modal"]', { state: 'visible', timeout: 10_000 });
        const snap = await modalSnapshot(page, 'studio-history-modal');
        assert(snap.visible && snap.rootCount === 1, `创作记录弹窗应可见且唯一，实际 root=${snap.rootCount}`);
        assert(snap.size === 'large', `创作记录应为 data-size=large，实际 ${snap.size}`);
        assert(snap.dialogId === 'studio-history-modal-dialog', `dialog id 应派生自 testId，实际 ${snap.dialogId}`);
        assert(snap.title === '创作记录', `标题应为 创作记录，实际 ${snap.title}`);
        assert((await page.locator('.studio-context-v2').count()) === 0, '弹窗打开时第三列 rail 不得复活');
        const tabs = page.locator('.app-modal-root[data-testid="studio-history-modal"] .studio-history-tabs button[role="tab"]');
        assert((await tabs.count()) === 2, `应有 批注/版本 两个 tab，实际 ${await tabs.count()}`);
        const tabTexts = await tabs.evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ''));
        assert(tabTexts.some((t) => t.includes('批注')) && tabTexts.some((t) => t.includes('版本')), `页签文案异常: ${JSON.stringify(tabTexts)}`);
        const selected = await tabs.evaluateAll((els) => els.filter((el) => el.getAttribute('aria-selected') === 'true').length);
        assert(selected === 1, `应有且仅有 1 个 aria-selected tab，实际 ${selected}`);
        await page.locator('.app-modal-root[data-testid="studio-history-modal"] .studio-history-version').first().waitFor({ state: 'visible', timeout: 10_000 });
      });

      await step(evidence, '切换批注页签 aria-selected 转移；选择版本关闭弹窗', async () => {
        await page.locator('.app-modal-root[data-testid="studio-history-modal"] .studio-history-tabs button[role="tab"]', { hasText: '批注' }).click();
        await page.waitForFunction(() => {
          const tabs = [...document.querySelectorAll('.app-modal-root[data-testid="studio-history-modal"] .studio-history-tabs button[role="tab"]')];
          const annotate = tabs.find((t) => t.textContent?.includes('批注'));
          return annotate?.getAttribute('aria-selected') === 'true';
        }, null, { timeout: 10_000 });
        // 选择任一版本 → 弹窗按契约关闭。
        await page.locator('.app-modal-root[data-testid="studio-history-modal"] .studio-history-tabs button[role="tab"]', { hasText: '版本' }).click();
        await page.waitForFunction(() => {
          const tabs = [...document.querySelectorAll('.app-modal-root[data-testid="studio-history-modal"] .studio-history-tabs button[role="tab"]')];
          const versions = tabs.find((t) => t.textContent?.includes('版本'));
          return versions?.getAttribute('aria-selected') === 'true';
        }, null, { timeout: 10_000 });
        await page.locator('.app-modal-root[data-testid="studio-history-modal"] .studio-history-version').first().click();
        await page.waitForFunction(() => document.querySelectorAll('.app-modal-root').length === 0, null, { timeout: 10_000 });
      });

      await step(evidence, '第三列归还：关闭弹窗后编辑器两列布局原样返回、可继续编辑', async () => {
        await page.locator('.studio-editor-grid').waitFor({ state: 'visible', timeout: 10_000 });
        await page.locator('.studio-canvas').waitFor({ state: 'visible', timeout: 10_000 });
        await page.locator('.studio-editor-top').waitFor({ state: 'visible', timeout: 10_000 });
        assert((await page.locator('.studio-context-v2').count()) === 0, '关闭后第三列 rail 不得出现');
        const grid = await page.locator('.studio-editor-grid').boundingBox();
        assert(grid && grid.width > 400 && grid.height > 200, `编辑器网格应保持可编辑尺寸，实际 ${JSON.stringify(grid)}`);
        assert((await page.locator('.studio-document').count()) === 1, '编辑器文档区应在场');
        assert((await page.locator('.studio-title-input').count()) === 1, '标题输入应可用');
        assert((await page.locator('.app-modal-root').count()) === 0, '不应残留任何弹窗');
      });

      await step(evidence, '健康：无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { modal: 'studio-history', size: 'large', tabs: true, thirdColumnGone: true };
    }
  },

  // ===========================================================================
  // 6) 关系画布最近变化：large 弹窗；Esc 只关弹窗不清除框选；焦点归还触发按钮
  // ===========================================================================

  {
    id: 'WMB-5251-canvas-log-modal',
    journeyIds: ['WMB-5251-canvas-log-modal'],
    launch: {
      seedFixture: async ({ dataRoot, workspaceId }) => {
        await seedRichKnowledge(dataRoot, workspaceId);
        const db = openWriteDb(dataRoot);
        try {
          rebuildWikiIndex(db, false);
        } finally {
          db.close();
        }
      }
    },
    run: async ({ page, evidence }) => {
      await step(evidence, '启动并进入关系画布，Ctrl+A 建立框选（选中计数可见）', async () => {
        await waitForAppReady(page);
        await navigateTo(page, 'canvas');
        await page.waitForFunction(() => document.querySelectorAll('.kn-node').length >= 8, null, { timeout: 30_000 });
        await page.locator('[data-kc-canvas]').focus();
        await page.keyboard.press('Control+A');
        await page.waitForFunction(() => (document.querySelector('[data-kc-selection-count]')?.textContent ?? '').includes('已框选'), null, { timeout: 10_000 });
        const count = await page.evaluate(() => document.querySelectorAll('.kn-node.selected').length);
        assert(count >= 8, `Ctrl+A 应选中全部节点，实际 ${count}`);
      });

      await step(evidence, '最近变化 large 弹窗打开；Esc 关闭弹窗且保留框选、焦点归还触发按钮', async () => {
        await page.locator('[data-kc-log-toggle]').click();
        await page.waitForSelector('.app-modal-root[data-testid="kc-log-panel"]', { state: 'visible', timeout: 10_000 });
        const snap = await modalSnapshot(page, 'kc-log-panel');
        assert(snap.visible && snap.rootCount === 1, `最近变化弹窗应可见且唯一，实际 root=${snap.rootCount}`);
        assert(snap.size === 'large', `最近变化应为 data-size=large，实际 ${snap.size}`);
        assert(snap.dialogId === 'kc-log-panel-dialog', `dialog id 应派生自 testId，实际 ${snap.dialogId}`);
        assert(snap.title === '最近变化', `标题应为 最近变化，实际 ${snap.title}`);
        const selectedBefore = await page.evaluate(() => document.querySelectorAll('.kn-node.selected').length);
        const countTextBefore = await bodyText(page, '[data-kc-selection-count]');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelectorAll('.app-modal-root').length === 0, null, { timeout: 10_000 });
        // 画布框选必须保留（Esc 只关弹窗，不得触达板面 Esc 清空选择）。
        const selectedAfter = await page.evaluate(() => document.querySelectorAll('.kn-node.selected').length);
        assert(selectedAfter === selectedBefore, `Esc 关闭弹窗后框选应保留：${selectedBefore} → ${selectedAfter}`);
        const countTextAfter = await bodyText(page, '[data-kc-selection-count]');
        assert(countTextAfter === countTextBefore, `选中计数不应变化：${countTextBefore} → ${countTextAfter}`);
        const focusAfter = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? { tag: el.tagName.toLowerCase(), hasToggle: Boolean(el.closest?.('[data-kc-log-toggle]')) } : null;
        });
        assert(focusAfter?.hasToggle === true, `Esc 关闭后焦点应归还 最近变化 按钮，实际 ${JSON.stringify(focusAfter)}`);
        assert((await page.locator('.app-modal-root').count()) === 0, '不应残留任何弹窗');
      });

      await step(evidence, '健康：无页面异常 / 无崩溃', async () => {
        assert(!evidence.crashed, '渲染进程崩溃');
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { modal: 'kc-log-panel', size: 'large', escapeKeepsSelection: true };
    }
  }
];
