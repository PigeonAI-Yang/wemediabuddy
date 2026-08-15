// WMB-5243 创作（Studio）页真实 Electron E2E（ST-001..ST-008）。
//
// Contract: default export = scenario array; each item { id, journeyIds, launch?, run }.
// launch.seedFixture runs pre-boot (harness seedWorkspace + migrateDatabase already
// created the schema and workspace_id); run(ctx) drives the real app.
// Dual evidence: user-visible DOM + persisted SQLite read-back via ctx.openDb().
// No business code is touched; no external platform is ever invoked.
//
// ST-008（WMB-5237 图片调整全链路）：真实素材经 assets 后端 importAssetBytes 落盘落库，
// 正文两张 wmb-asset 图片；UI 走正文图选中工具条（尺寸/对齐/拖拽/图注）、核心裁切
// （派生 asset + provenance）、平台封面/裁切投影与保存；SQLite 回读核心/平台绑定、
// 派生血缘、正文 token 纯净（`![alt](wmb-asset://assetId)` 无尺寸/对齐/裁切杂质）；
// 只读版本编辑按钮禁用；1568 视口无横向溢出。共享类型/parser/DDL 引用
// src/shared/media-bindings.ts、src/shared/media-token.ts、media-binding-migrations.ts（v62）。

import { deflateSync } from 'node:zlib';
import { seedWorkflowBase, openWriteDb, seedStudioProject } from './seed-workflow.mjs';
import { savePlatformVersion } from '../../src/main/content.ts';
import { importAssetBytes, linkProjectAsset, markdownImageForAsset } from '../../src/main/assets.ts';
import { seedSource } from './lib/seed.mjs';

const seedBase = async ({ dataRoot, workspaceId }) => {
  await seedWorkflowBase(dataRoot, workspaceId);
};

const seedWithProject = async ({ dataRoot, workspaceId }) => {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    const xSourceId = seedSource(db, { title: 'E2E X 资料', summary: 'X 来源摘要', author: '@wmb_e2e', originalUrl: 'https://x.com/wmb_e2e/status/100' });
    const wechatSourceId = seedSource(db, { title: 'E2E 微信资料', summary: '微信来源摘要', author: 'WMB 测试公众号', originalUrl: 'https://mp.weixin.qq.com/s/wmb-e2e-source' });
    seedStudioProject(db, { sourceIds: [xSourceId, wechatSourceId] });
  } finally {
    db.close();
  }
};

/** Open the project row by title via its real 「打开」 button. */
async function openProjectByName(page, title) {
  const ok = await page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll('.studio-project-row:not(.head)')];
    const row = rows.find((r) => r.textContent?.includes(wanted));
    const btn = row?.querySelector('button.studio-row-action');
    if (!btn) return false;
    btn.click();
    return true;
  }, title);
  if (!ok) throw new Error(`创作库未找到项目「${title}」`);
  await page.waitForSelector('.studio-editor-view', { timeout: 15_000 });
}

// ============================ ST-008 local helpers ============================
// 无第三方依赖的小型 PNG 生成器：真实 PNG 字节（8bit truecolor + CRC），
// 经 assets 后端 importAssetBytes 落盘/落库后由 Chromium 正常解码（含裁切 canvas 读取）。

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([length, body, crcBuf]);
}

function makeSeedPng(width, height, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * ST-008 种子：真实 project + 两张真实素材（file/row/link 全部经生产 assets 管线）+ 正文两图片。
 * 核心 v2 与 X 平台 v1 均显式携带媒体绑定草稿（最终契约字段），UI 编辑后的保存走新版本绑定。
 * @returns {{ projectId, coreV2Id, platXId, assetAId, assetBId, shaA, shaB }}
 */
async function seedImageEditingProject({ dataRoot, workspaceId }) {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    const content = await import('../../src/main/content.ts');
    const assetA = await importAssetBytes(db, dataRoot, {
      bytes: makeSeedPng(64, 64, 214, 42, 42),
      fileName: 'seed-a.png',
      mimeType: 'image/png',
      origin: 'e2e:st008:source',
      width: 64,
      height: 64
    });
    const assetB = await importAssetBytes(db, dataRoot, {
      bytes: makeSeedPng(64, 64, 42, 82, 214),
      fileName: 'seed-b.png',
      mimeType: 'image/png',
      origin: 'e2e:st008:source',
      width: 64,
      height: 64
    });
    const core1 = content.createContentProjectWithVersion(db, { title: 'E2E 图片编辑项目', body: '图片编辑项目正文' });
    linkProjectAsset(db, core1.id, assetA.id);
    linkProjectAsset(db, core1.id, assetB.id);
    const imageBody = `图片编辑项目正文\n\n${markdownImageForAsset(assetA, '图注A')}\n\n${markdownImageForAsset(assetB, '图注B')}`;
    const core2 = content.saveCoreVersion(db, {
      projectId: core1.id,
      body: imageBody,
      expectedRevision: 1,
      mediaBindings: [
        { assetId: assetA.id, occurrence: 0, widthPreset: 'full', align: 'center', caption: '图注A' },
        { assetId: assetB.id, occurrence: 0, widthPreset: 'full', align: 'center', caption: '图注B' }
      ]
    });
    if (!core2.ok) throw new Error(`seedImageEditingProject: 核心图片版保存失败 ${JSON.stringify(core2.error ?? core2)}`);
    const platX = content.savePlatformVersion(db, {
      projectId: core1.id,
      contentVersionId: core2.data.id,
      platform: 'x',
      format: 'text',
      title: 'X 图片稿',
      body: imageBody,
      mediaBindings: [
        { assetId: assetA.id, ordinal: 0, caption: '图注A' },
        { assetId: assetB.id, ordinal: 1, caption: '图注B' }
      ]
    });
    if (!platX.ok) throw new Error(`seedImageEditingProject: X 平台图片版保存失败 ${JSON.stringify(platX.error ?? platX)}`);
    return {
      projectId: core1.id,
      coreV2Id: core2.data.id,
      platXId: platX.data.id,
      assetAId: assetA.id,
      assetBId: assetB.id,
      shaA: assetA.sha256,
      shaB: assetB.sha256
    };
  } finally {
    db.close();
  }
}

/** 正文图选中工具条/选中框（核心与平台编辑态共用；只读历史只显示只读提示条）。 */
const INLINE_FIGURE = '.studio-rich-annotate-wrap .studio-rich-editor figure.studio-figure[data-wmb-asset]';
const INLINE_TOOLBAR = '.studio-inline-image-toolbar[role="toolbar"][aria-label="图片工具条"]';

/** 切到渲染编辑（富文本）模式；等正文两张图片 figure 渲染。 */
async function switchToRichEditor(page) {
  const switched = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.studio-mode-switch button')].find((b) => b.textContent?.includes('渲染编辑'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!switched) throw new Error('未找到「渲染编辑」模式切换按钮');
  await page.waitForSelector(INLINE_FIGURE, { timeout: 15_000 });
}

/** 点击状态栏「本文图片 N 张」入口打开图片菜单（已打开则跳过，幂等）。 */
async function openImageMenu(page) {
  const alreadyOpen = await page.evaluate(() => Boolean(document.querySelector('.studio-image-menu .studio-image-card')));
  if (alreadyOpen) return;
  const ok = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button.studio-status-link')].find((b) => b.textContent?.includes('本文图片'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!ok) throw new Error('未找到「本文图片」状态栏入口');
  await page.waitForSelector('.studio-image-menu .studio-image-card', { timeout: 10_000 });
}

/** 关闭「本文图片」菜单（未打开则跳过，幂等）。 */
async function closeImageMenu(page) {
  const open = await page.evaluate(() => Boolean(document.querySelector('.studio-image-menu')));
  if (!open) return;
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button.studio-status-link')].find((b) => b.textContent?.includes('本文图片'));
    btn?.click();
  });
  await page.waitForSelector('.studio-image-menu', { state: 'detached', timeout: 10_000 });
}

/** 按卡片文本定位图片菜单卡片（返回卡片文本；找不到返回 null）。 */
async function findImageCard(page, text) {
  await page.waitForSelector('.studio-image-menu .studio-image-card', { timeout: 10_000 });
  return page.evaluate((wanted) => {
    const card = [...document.querySelectorAll('.studio-image-menu .studio-image-card')].find((c) => c.textContent?.includes(wanted));
    if (!card) return null;
    card.scrollIntoView({ block: 'nearest' });
    return card.textContent;
  }, text);
}

/** 在图片菜单卡片上执行一次操作（btn 选择器优先，兜底按文本找按钮）。 */
async function clickImageCardButton(page, cardText, selector, fallbackText) {
  return page.evaluate(({ wanted, sel, text }) => {
    const card = [...document.querySelectorAll('.studio-image-menu .studio-image-card')].find((c) => c.textContent?.includes(wanted));
    if (!card) return false;
    const btn = card.querySelector(sel) ?? [...card.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, { wanted: cardText, sel: selector, text: fallbackText });
}

/** 等裁剪弹窗图片就绪（confirm/preset 可用）后切比例并确认；返回后弹窗应已关闭。 */
async function confirmCropModal(page, preset = '1:1') {
  await page.waitForSelector('.studio-image-crop-modal[role="dialog"][aria-label="裁剪图片"]', { timeout: 15_000 });
  await page.waitForFunction(() => {
    const confirm = document.querySelector('.studio-crop-confirm');
    return confirm && !confirm.disabled;
  }, null, { timeout: 20_000 });
  await page.click(`.studio-crop-preset[data-preset="${preset}"]`);
  await page.waitForTimeout(300);
  await page.click('.studio-crop-confirm');
  try {
    await page.waitForSelector('.studio-image-crop-modal', { state: 'detached', timeout: 30_000 });
  } catch (error) {
    const errText = await page.evaluate(() => document.querySelector('.studio-crop-error')?.textContent ?? '').catch(() => '');
    throw new Error(`裁剪确认后弹窗未关闭${errText ? `：${errText}` : ''}`);
  }
}

/** 断言只读版本：正文图无编辑工具条/手柄（编辑按钮不可用），保存按钮禁用；只读提示条尽量在场。 */
async function assertReadonlyImageState(page) {
  const saveDisabled = await page.$eval('.studio-editor-top button.primary-button', (b) => Boolean(b.disabled));
  if (!saveDisabled) throw new Error('只读版本「保存」按钮应禁用');
  await page.locator(INLINE_FIGURE).nth(0).click();
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => ({
    toolbar: Boolean(document.querySelector('.studio-inline-image-toolbar')),
    handles: Boolean(document.querySelector('.studio-inline-handle')),
    readonly: Boolean(document.querySelector('.studio-inline-readonly'))
  }));
  if (state.toolbar || state.handles) throw new Error(`只读版本不应有编辑工具条/拖拽手柄: ${JSON.stringify(state)}`);
  
  await openImageMenu(page);
  const editLabels = await page.$$eval('.studio-image-card .studio-image-actions button', (els) =>
    els.filter((b) => !b.disabled).map((b) => b.textContent?.trim() ?? ''));
  const forbidden = ['替换', '编辑图注', '保存图注', '移出', '裁切', '设为封面', '取消封面'];
  if (editLabels.some((label) => forbidden.includes(label))) {
    throw new Error(`只读版本图片菜单不应有可用的编辑按钮: ${JSON.stringify(editLabels)}`);
  }
  await closeImageMenu(page);
}

export default [
  {
    id: 'ST-001-studio-project-normal',
    journeyIds: ['ST-001-studio-project-normal'],
    launch: { seedFixture: seedWithProject },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb, app, evidence, artifactsDir } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到创作页', () => helpers.navigateTo(page, 'studio'));
      await step('项目列表渲染', async () => {
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        const titles = await page.$$eval('.studio-project-row:not(.head) .studio-project-name', (els) => els.map((e) => e.textContent?.trim()));
        assert(titles.includes('E2E 创作项目 A'), `项目列表缺少 E2E 创作项目 A: ${JSON.stringify(titles)}`);
      });
      await step('打开项目进入核心正文编辑器', () => openProjectByName(page, 'E2E 创作项目 A'));
      await step('标题/正文/格式栏/主 CTA 断言', async () => {
        const title = await page.inputValue('#studio-title');
        const body = await page.inputValue('#studio-body-source');
        assert(title === 'E2E 创作项目 A', `编辑器标题不符: ${JSON.stringify(title)}`);
        assert(body.includes('核心 V2 正文'), `编辑器正文未加载: ${JSON.stringify(body.slice(0, 40))}`);
        const saveLabels = await page.$$eval('.studio-editor-top button.primary-button', (els) => els.map((e) => e.textContent?.trim()));
        assert(saveLabels.filter((t) => t === '保存').length === 1, `主 CTA「保存」应唯一: ${JSON.stringify(saveLabels)}`);
        const docState = await page.textContent('.studio-doc-state');
        assert(docState.includes('已保存'), `文档状态应为已保存: ${docState}`);
      });
      await step('标题下无重复元数据，底栏仅保留真实字数与可操作关联信息', async () => {
        const chrome = await page.evaluate(() => ({
          metaRows: document.querySelectorAll('.studio-doc-meta').length,
          status: document.querySelector('.studio-writing-status')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          metrics: document.querySelector('.studio-status-metrics')?.textContent?.trim() ?? '',
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
        }));
        assert(chrome.metaRows === 0, `标题下重复元数据行应删除，实际 ${chrome.metaRows}`);
        assert(/^字数 \d+$/.test(chrome.metrics) && !/约\s*\d+\s*分钟/.test(chrome.status), `底栏只应显示真实字数，不应保留阅读时间估算，实际 ${JSON.stringify(chrome)}`);
        assert(/来源 \d+/.test(chrome.status) && /素材 \d+/.test(chrome.status), `底栏真实来源/素材入口应保留，实际 ${chrome.status}`);
        assert(chrome.overflowX === 0, `创作编辑器不应产生页面横向溢出，实际 ${chrome.overflowX}`);
      });
      await step('文章纲要与平台内容使用同一面板底色', async () => {
        const colors = await page.evaluate(() => ({
          outline: getComputedStyle(document.querySelector('.studio-outline-section--outline')).backgroundColor,
          content: getComputedStyle(document.querySelector('.studio-outline-section--content')).backgroundColor
        }));
        assert(colors.outline === colors.content, `文章纲要不应保留孤立底色: ${colors.outline} vs ${colors.content}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-outline-unified-background' });
      });
      await step('1100×800 最小窗口仍无重复元数据与虚假阅读时间', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(300);
        const compact = await page.evaluate(() => ({
          metaRows: document.querySelectorAll('.studio-doc-meta').length,
          status: document.querySelector('.studio-writing-status')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          titleVisible: Boolean(document.querySelector('#studio-title')?.getBoundingClientRect().height),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
        }));
        assert(compact.metaRows === 0 && !/约\s*\d+\s*分钟/.test(compact.status), `最小窗口不得恢复重复元数据或阅读时间，实际 ${JSON.stringify(compact)}`);
        assert(compact.titleVisible && compact.status.includes('字数') && /来源 \d+/.test(compact.status) && /素材 \d+/.test(compact.status), `最小窗口应保留标题与真实状态入口，实际 ${JSON.stringify(compact)}`);
        assert(compact.overflowX === 0, `1100×800 创作编辑器不应产生页面横向溢出，实际 ${compact.overflowX}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-metadata-cleanup-1100' });
      });
      await step('关联来源详情统一显示紧凑平台身份', async () => {
        await page.locator('button.studio-status-link', { hasText: '来源 2' }).click();
        await page.waitForSelector('.studio-detail-list .studio-source-meta', { timeout: 15_000 });
        const sourceIdentity = await page.evaluate(() => {
          const articles = [...document.querySelectorAll('.studio-detail-list article')];
          return {
            articleCount: articles.length,
            marksPerArticle: articles.map((article) => article.querySelectorAll('.source-platform-mark').length),
            xMarks: document.querySelectorAll('.studio-detail-list .source-platform-mark.pf-x').length,
            wechatMarks: document.querySelectorAll('.studio-detail-list .source-platform-mark.pf-wechat').length,
            sizes: [...document.querySelectorAll('.studio-detail-list .studio-source-meta')].map((row) => {
              const mark = row.querySelector('.source-platform-mark');
              const rowStyle = getComputedStyle(row);
              const rect = mark?.getBoundingClientRect();
              return { fontSize: Number.parseFloat(rowStyle.fontSize), width: rect?.width ?? 0, height: rect?.height ?? 0 };
            }),
            statusBarMarks: document.querySelectorAll('.studio-writing-status .source-platform-mark').length,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
          };
        });
        assert(sourceIdentity.articleCount === 2, `应显示两条关联来源，实际 ${JSON.stringify(sourceIdentity)}`);
        assert(sourceIdentity.marksPerArticle.every((count) => count === 1), `每条来源元数据只能有一个平台标，实际 ${JSON.stringify(sourceIdentity.marksPerArticle)}`);
        assert(sourceIdentity.xMarks === 1 && sourceIdentity.wechatMarks === 1, `应识别 X 与微信来源，实际 ${JSON.stringify(sourceIdentity)}`);
        assert(sourceIdentity.sizes.every(({ fontSize, width, height }) => Math.abs(width - fontSize) <= 1 && Math.abs(height - fontSize) <= 1), `平台标应与元数据文字等高，实际 ${JSON.stringify(sourceIdentity.sizes)}`);
        assert(sourceIdentity.statusBarMarks === 0, '高密度 Studio 状态栏不应重复堆叠来源平台标');
        assert(sourceIdentity.overflowX === 0, `来源详情不应产生横向溢出，实际 ${sourceIdentity.overflowX}`);
        assert(evidence.pageerrors.length === 0, `来源详情不应产生 page error：${JSON.stringify(evidence.pageerrors)}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-source-platform-icons-1100' });
      });
      await step('持久化读回：DB 项目存在', () => {
        const { db, close } = openDb();
        try {
          const row = db.prepare('SELECT title FROM content_projects WHERE title = ?').get('E2E 创作项目 A');
          assert(Boolean(row), 'DB 中缺少创作项目 E2E 创作项目 A');
        } finally { close(); }
      });
      return { opened: true };
    }
  },

  {
    id: 'ST-002-studio-save-persist',
    journeyIds: ['ST-002-studio-save-persist'],
    launch: { seedFixture: seedWithProject },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到创作页并打开项目', async () => {
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 创作项目 A');
      });
      const editedTitle = 'E2E 创作项目 A（已编辑保存）';
      await step('修改标题并保存', async () => {
        await page.fill('#studio-title', editedTitle);
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('有未保存修改'), null, { timeout: 10_000 });
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 15_000 });
        const docState = await page.textContent('.studio-doc-state');
        assert(docState.includes('已保存'), `保存后文档状态应为已保存: ${docState}`);
      });
      await step('重载后内容持久保留（UI 双读回）', async () => {
        await page.reload();
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        // 主进程/渲染器会把 studioSelectedId 写入 localStorage，重载后创作页
        // 自动恢复上次选中项目（编辑器直开）；否则回到项目库列表再点开。
        await page.waitForSelector('.studio-project-row:not(.head), .studio-editor-view', { timeout: 20_000 });
        const rowShown = await page.evaluate(() => !!document.querySelector('.studio-project-row:not(.head)'));
        if (rowShown) await openProjectByName(page, editedTitle);
        await page.waitForSelector('.studio-editor-view', { timeout: 15_000 });
        const title = await page.inputValue('#studio-title');
        assert(title === editedTitle, `重载后标题未持久化: ${JSON.stringify(title)}`);
      });
      await step('持久化读回：DB 标题与版本', () => {
        const { db, close } = openDb();
        try {
          const row = db.prepare('SELECT id, title, revision FROM content_projects WHERE id = (SELECT id FROM content_projects WHERE title = ? LIMIT 1)').get(editedTitle);
          assert(row && row.title === editedTitle, `DB 标题未持久化: ${JSON.stringify(row)}`);
          const versions = db.prepare('SELECT COUNT(*) AS c FROM content_versions WHERE project_id = ?').get(row.id);
          assert(Number(versions.c) >= 2, `DB 版本数异常: ${versions.c}`);
        } finally { close(); }
      });
      return { saved: true };
    }
  },

  {
    id: 'ST-003-studio-platform-tabs',
    journeyIds: ['ST-003-studio-platform-tabs'],
    launch: { seedFixture: async ({ dataRoot, workspaceId }) => {
      await seedWorkflowBase(dataRoot, workspaceId);
      const db = openWriteDb(dataRoot);
      try {
        // 公众号有版本；X 显式两个平台版本（'X 平台稿' 旧 / 'X 平台稿修订' 最新）
        // 供「页签只读 + 版本切换」断言（platform_versions 一行一版本，同 id 更新是修订）；
        // 小红书不创建 → 页签显示「未创建」→ 空编辑器创建首版路径
        const studio = seedStudioProject(db, { platforms: ['wechat'] });
        savePlatformVersion(db, { projectId: studio.projectId, contentVersionId: studio.coreV2Id, platform: 'x', format: 'text', title: 'X 平台稿', body: '平台 V1 正文' });
        savePlatformVersion(db, { projectId: studio.projectId, contentVersionId: studio.coreV2Id, platform: 'x', format: 'text', title: 'X 平台稿修订', body: '平台 V2 正文' });
      } finally {
        db.close();
      }
    } },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到创作页并打开项目', async () => {
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 创作项目 A');
      });
      await step('X 页签只读 X 平台版本', async () => {
        const ok = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.studio-outline-section--content button')]
            .find((b) => b.textContent?.includes('X') && b.textContent?.includes('个版本'));
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(ok, 'X 平台页签未找到');
        await page.waitForFunction(() => document.querySelector('.studio-outline-section--content button.active .pf-tag.x') && document.querySelector('#studio-title')?.value === 'X 平台稿修订', null, { timeout: 10_000 });
        const title = await page.inputValue('#studio-title');
        const body = await page.inputValue('#studio-body-source');
        assert(title === 'X 平台稿修订', `X 页签标题应为 X 平台稿修订: ${JSON.stringify(title)}`);
        assert(body.includes('平台 V2 正文'), `X 页签正文应为平台 V2 正文: ${JSON.stringify(body.slice(0, 30))}`);
      });
      await step('平台版本切换有效', async () => {
        await page.click('.studio-editor-top button.secondary-button'); // 打开版本面板
        await page.waitForSelector('.studio-history-version', { timeout: 10_000 });
        const versionLabels = await page.$$eval('.studio-history-version strong', (els) => els.map((e) => e.textContent?.trim()));
        assert(versionLabels.some((t) => t.includes('X 平台稿')), `X 平台版本列表异常: ${JSON.stringify(versionLabels)}`);
        const switched = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.studio-history-version')].find((b) => b.textContent?.includes('X 平台稿') && !b.textContent?.includes('修订'));
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(switched, '未找到可切换的 X 平台版本');
        await page.waitForTimeout(600);
        const title = await page.inputValue('#studio-title');
        assert(title === 'X 平台稿', `切换后标题应为 X 平台稿: ${JSON.stringify(title)}`);
      });
      await step('小红书页签空编辑器 + 保存创建首版', async () => {
        const ok = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.studio-outline-section--content button')]
            .find((b) => b.textContent?.includes('小红书') && b.textContent?.includes('未创建'));
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(ok, '小红书（未创建）页签未找到');
        await page.waitForTimeout(500);
        const placeholder = await page.getAttribute('#studio-body-source', 'placeholder');
        assert(placeholder.includes('小红书'), `小红书空编辑器占位符不符: ${placeholder}`);
        const emptyBody = await page.inputValue('#studio-body-source');
        assert(emptyBody === '', `小红书页签应显示空编辑器，实际: ${JSON.stringify(emptyBody.slice(0, 30))}`);
        await page.fill('#studio-body-source', '小红书首版正文');
        await page.click('.studio-editor-top button.primary-button');
        // 保存成功消息短暂闪现即被 loadFirst 清空，改等稳定信号：
        // 概要栏出现「小红书 N 个版本」（平台版本行落库后 detail 重载才会出现）
        await page.waitForFunction(() => {
          const btn = [...document.querySelectorAll('.studio-outline-section--content button')].find((b) => b.textContent?.includes('小红书'));
          return Boolean(btn && btn.textContent?.includes('个版本') && !btn.textContent?.includes('未创建'));
        }, null, { timeout: 15_000 });
      });
      await step('持久化读回：小红书平台版本落库', () => {
        const { db, close } = openDb();
        try {
          const row = db.prepare("SELECT id FROM platform_versions WHERE platform = 'xiaohongshu' AND body = '小红书首版正文'").get();
          assert(Boolean(row), 'DB 中缺少小红书平台版本（首版创建未落库）');
        } finally { close(); }
      });
      return { platformTabs: true };
    }
  },

  {
    id: 'ST-004-studio-annotations',
    journeyIds: ['ST-004-studio-annotations'],
    launch: { seedFixture: seedWithProject },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到创作页并打开项目', async () => {
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 创作项目 A');
      });
      let annotationId = null;
      await step('拖选文字并标记为有问题', async () => {
        await page.waitForSelector('#studio-body-source', { timeout: 10_000 });
        const selected = await page.evaluate(() => {
          const ta = document.querySelector('#studio-body-source');
          const text = ta.value;
          const idx = text.indexOf('核心 V2');
          if (idx < 0) return null;
          ta.focus();
          ta.setSelectionRange(idx, idx + 5); // 选中「核心 V2」（5 个字符）
          ta.dispatchEvent(new Event('select', { bubbles: true }));
          ta.dispatchEvent(new Event('selectionchange', { bubbles: true }));
          return { idx, snippet: text.slice(idx, idx + 4) };
        });
        assert(selected, '正文中未找到可标记文字');
        const clicked = await page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="标记所选文字为有问题"]');
          if (!btn || btn.disabled) return 'missing-or-disabled';
          btn.click();
          return 'clicked';
        });
        assert(clicked === 'clicked', `标记按钮不可用: ${clicked}`);
        await page.waitForSelector('.studio-annotation-rect, .studio-annotation-mark', { timeout: 15_000 });
      });
      await step('批注列表出现该批注', async () => {
        // 打开右侧版本/批注面板，切到「批注」页签（两个 role=tab，用 evaluate 精确点第一个）
        await page.click('.studio-editor-top button.secondary-button');
        await page.waitForSelector('.studio-history-tabs', { timeout: 10_000 });
        await page.evaluate(() => {
          const tabs = [...document.querySelectorAll('.studio-history-tabs button[role="tab"]')];
          const annotate = tabs.find((t) => t.textContent?.includes('批注')) ?? tabs[0];
          annotate?.click();
        });
        await page.waitForSelector('.studio-annotation-card', { timeout: 10_000 });
        const quotes = await page.$$eval('.studio-annotation-card-quote', (els) => els.map((e) => e.textContent ?? ''));
        assert(quotes.some((q) => q.includes('核心 V2')), `批注列表缺少标记文字: ${JSON.stringify(quotes)}`);
      });
      await step('持久化读回：批注落库', async () => {
        const { db, close } = openDb();
        try {
          const row = db.prepare(`SELECT id, quoted_text, status FROM studio_annotations WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`).get();
          assert(row && row.quoted_text.includes('核心 V2'), `DB 批注未落库: ${JSON.stringify(row)}`);
          annotationId = row.id;
        } finally { close(); }
      });
      await step('编辑批注说明并保存', async () => {
        await page.evaluate(() => {
          const card = document.querySelector('.studio-annotation-card');
          const btn = card?.querySelector('button'); // 定位/选择卡片
          btn?.click();
        });
        // 定位批注会先关闭创作记录弹窗，再滚动到正文标记
        await page.waitForSelector('.studio-annotation-card', { state: 'detached', timeout: 10_000 });
        await page.waitForTimeout(400);
        // 重新打开弹窗（仍停在批注页签），打开说明编辑（卡片上的说明按钮）
        await page.click('.studio-editor-top button.secondary-button');
        await page.waitForSelector('.studio-annotation-card', { timeout: 10_000 });
        const edited = await page.evaluate(() => {
          const card = document.querySelector('.studio-annotation-card');
          const buttons = [...card?.querySelectorAll('button') ?? []];
          const noteBtn = buttons.find((b) => b.textContent?.includes('说明') || b.getAttribute('aria-label')?.includes('说明'));
          if (!noteBtn) return false;
          noteBtn.click();
          return true;
        });
        if (edited) {
          await page.waitForSelector('.studio-annotation-note-pop', { timeout: 10_000 });
          await page.fill('.studio-annotation-note-pop textarea', 'E2E 批注说明');
          await page.click('.studio-annotation-note-actions button.primary-button');
          await page.waitForTimeout(800);
          const { db, close } = openDb();
          try {
            const row = db.prepare('SELECT note FROM studio_annotations WHERE id = ?').get(annotationId);
            assert(row?.note === 'E2E 批注说明', `批注说明未持久化: ${JSON.stringify(row)}`);
          } finally { close(); }
        }
      });
      return { annotation: annotationId };
    }
  },

  {
    id: 'ST-005-studio-empty',
    journeyIds: ['ST-005-studio-empty'],
    launch: { seedFixture: seedBase },
    run: async (ctx) => {
      const { page, helpers, assert, step } = ctx;
      await helpers.waitForAppReady(page);
      await step('导航到创作页', () => helpers.navigateTo(page, 'studio'));
      await step('空态渲染且页面不崩溃', async () => {
        await page.waitForSelector('.studio-library', { timeout: 20_000 });
        await page.waitForSelector('.compact-empty', { timeout: 15_000 });
        const emptyText = await page.textContent('.compact-empty');
        assert(emptyText.includes('没有符合条件的项目'), `空态文案不符: ${emptyText}`);
        const createBtn = await page.$$eval('.studio-library-header button, .page-command button', (els) => els.map((e) => e.textContent?.trim()));
        assert(createBtn.some((t) => t.includes('新建创作项目')), `缺少创建入口: ${JSON.stringify(createBtn)}`);
        const editorGone = await page.evaluate(() => !document.querySelector('.studio-editor-view'));
        assert(editorGone, '空项目时编辑器不应渲染');
      });
      return { empty: true };
    }
  },

  {
    id: 'ST-006-studio-body-error',
    journeyIds: ['ST-006-studio-body-error'],
    launch: { seedFixture: async ({ dataRoot, workspaceId }) => {
      await seedWorkflowBase(dataRoot, workspaceId);
      const db = openWriteDb(dataRoot);
      try {
        // 空正文项目：编辑器必须诚实显示空态，不伪造正文
        const { createContentProjectWithVersion } = await import('../../src/main/content.ts');
        const empty = createContentProjectWithVersion(db, { title: 'E2E 空正文项目', body: '' });
        // 正常项目：供失败恢复路径使用
        seedStudioProject(db, {});
        return { emptyProjectId: empty.id };
      } finally {
        db.close();
      }
    }},
    run: async (ctx) => {
      const { page, helpers, assert, step } = ctx;
      await helpers.waitForAppReady(page);
      const wsKey = `wmb.workspace.${ctx.workspace.workspaceId}.studioSelectedId`;
      await step('空正文项目：诚实空态、不伪造内容', async () => {
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 空正文项目');
        const body = await page.inputValue('#studio-body-source');
        assert(body === '', `空正文项目不应有伪造内容: ${JSON.stringify(body.slice(0, 30))}`);
        const editorBodyText = await page.evaluate(() => document.querySelector('.studio-paper')?.textContent ?? '');
        assert(!editorBodyText.includes('核心 V2'), '空正文项目显示了其他项目正文（数据串线）');
      });
      await step('加载失败：项目不存在 → 诚实失败态 + 重试入口', async () => {
        await page.evaluate((key) => localStorage.setItem(key, 'ghost-project-does-not-exist'), wsKey);
        await page.reload();
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.editor-empty', { timeout: 20_000 });
        const text = await page.textContent('.editor-empty');
        assert(text.includes('项目详情读取失败'), `失败态文案不符: ${text}`);
        const retryBtn = await page.evaluate(() => [...document.querySelectorAll('.editor-empty button')].some((b) => b.textContent?.includes('重新读取')));
        assert(retryBtn, '失败态缺少「重新读取」重试入口');
      });
      await step('恢复路径：指回真实项目后重新读取成功', async () => {
        const { db, close } = ctx.openDb();
        let projectId = null;
        try {
          projectId = db.prepare('SELECT id FROM content_projects WHERE title = ?').get('E2E 创作项目 A')?.id ?? null;
        } finally { close(); }
        assert(Boolean(projectId), 'DB 中缺少正常项目');
        await page.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: wsKey, id: projectId });
        await page.reload();
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-editor-view', { timeout: 20_000 });
        const title = await page.inputValue('#studio-title');
        assert(title === 'E2E 创作项目 A', `恢复后编辑器标题不符: ${JSON.stringify(title)}`);
      });
      return { emptyHonest: true, errorHonest: true, recovered: true };
    }
  },

  {
    id: 'ST-007-studio-save-permission-error',
    journeyIds: ['ST-007-studio-save-permission-error'],
    launch: { seedFixture: seedWithProject },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      await helpers.waitForAppReady(page);
      await step('打开项目并编辑正文', async () => {
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 创作项目 A');
        await page.fill('#studio-body-source', '核心 V2 正文（冲突保存测试）');
        await page.waitForTimeout(300);
      });
      await step('外部版本冲突 → 保存失败明确可见、dirty 保持', async () => {
        // 在 UI 加载之后用后端真实 API 推进版本，制造 REVISION_CONFLICT（与其他位置更新同语义）
        const { db, close } = openDb();
        let projectId = null;
        try {
          projectId = db.prepare('SELECT id FROM content_projects WHERE title = ?').get('E2E 创作项目 A').id;
        } finally { close(); }
        const wdb = openWriteDb(ctx.workspace.dataRoot);
        try {
          const content = await import('../../src/main/content.ts');
          const current = wdb.prepare('SELECT revision FROM content_projects WHERE id = ?').get(projectId);
          const bumped = content.saveCoreVersion(wdb, { projectId, body: '外部并发写入', expectedRevision: current.revision });
          assert(bumped.ok, `外部写入失败: ${JSON.stringify(bumped.error ?? bumped)}`);
        } finally {
          wdb.close();
        }
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-status-message')?.textContent?.includes('内容已在其他位置更新'), null, { timeout: 15_000 });
        const msg = await page.textContent('.studio-status-message');
        assert(msg.includes('内容已在其他位置更新'), `保存失败消息不符: ${msg}`);
        const docState = await page.textContent('.studio-doc-state');
        assert(docState.includes('有未保存修改'), `保存失败后 dirty 应保持: ${docState}`);
      });
      await step('恢复路径：重新读取最新版后可保存成功', async () => {
        await page.reload();
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        // 重载后创作页可能自动恢复上次选中项目（编辑器直开），否则回到项目库列表。
        await page.waitForSelector('.studio-project-row:not(.head), .studio-editor-view', { timeout: 20_000 });
        const rowShown = await page.evaluate(() => !!document.querySelector('.studio-project-row:not(.head)'));
        if (rowShown) await openProjectByName(page, 'E2E 创作项目 A');
        await page.waitForSelector('.studio-editor-view', { timeout: 15_000 });
        await page.fill('#studio-body-source', '冲突后恢复保存成功');
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 15_000 });
        const { db, close } = openDb();
        try {
          const row = db.prepare(`SELECT id FROM content_versions WHERE project_id = (SELECT id FROM content_projects WHERE title = 'E2E 创作项目 A') AND body = '冲突后恢复保存成功'`).get();
          assert(Boolean(row), '恢复保存未落库');
        } finally { close(); }
      });
      return { conflictHonest: true, recovered: true };
    }
  },

  {
    id: 'ST-008-studio-image-editing',
    journeyIds: ['ST-008-studio-image-editing'],
    launch: { seedFixture: seedImageEditingProject },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb } = ctx;
      // seedFixture 的返回值不直接回传，场景内从真实 DB 读取种子元数据（真实读回）。
      const seed = await (async () => {
        const { db, close } = openDb();
        try {
          const project = db.prepare('SELECT id FROM content_projects WHERE title = ?').get('E2E 图片编辑项目');
          if (!project) throw new Error('ST-008 种子缺少项目');
          const latestBody = db.prepare("SELECT body FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1").get(project.id)?.body ?? '';
                    const seededIds = [...latestBody.matchAll(/wmb-asset:\/\/([0-9a-f-]+)/g)].map((match) => match[1]);
                    const a = seededIds[0] ? db.prepare('SELECT id, sha256 FROM assets WHERE id = ?').get(seededIds[0]) : null;
          const b = seededIds[1] ? db.prepare('SELECT id, sha256 FROM assets WHERE id = ?').get(seededIds[1]) : null;
          if (!a || !b) throw new Error('ST-008 种子缺少源素材');
          return { projectId: project.id, assetAId: a.id, assetBId: b.id, shaA: a.sha256, shaB: b.sha256 };
        } finally { close(); }
      })();
      const { projectId: projectIdValue, assetAId, assetBId, shaA, shaB } = seed;
      const FIGURE_SEL = '.studio-rich-annotate-wrap .studio-rich-editor figure.studio-figure[data-wmb-asset]';
      const TOOLBAR_SEL = '.studio-inline-image-toolbar[role="toolbar"][aria-label="图片工具条"]';

      await helpers.waitForAppReady(page);
      await step('导航到创作页并打开图片项目（1568 视口）', async () => {
        await page.setViewportSize({ width: 1568, height: 960 });
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 图片编辑项目');
        await switchToRichEditor(page);
      });

      await step('正文两张图片渲染 + 点击选中出现浮动工具条', async () => {
        const count = await page.$$eval(FIGURE_SEL, (els) => els.length);
        assert(count === 2, `正文应渲染 2 张图片 figure，实际 ${count}`);
        await page.locator(FIGURE_SEL).nth(0).click();
        await page.waitForSelector(TOOLBAR_SEL, { timeout: 10_000 });
        const widthPresets = await page.$$eval(`${TOOLBAR_SEL} .studio-inline-width`, (els) => els.map((e) => e.getAttribute('data-preset')));
        assert(JSON.stringify(widthPresets) === JSON.stringify(['small', 'medium', 'large', 'full']), `宽度预设异常: ${JSON.stringify(widthPresets)}`);
        const aligns = await page.$$eval(`${TOOLBAR_SEL} .studio-inline-align`, (els) => els.map((e) => e.getAttribute('data-align')));
        assert(JSON.stringify(aligns) === JSON.stringify(['left', 'center', 'right']), `对齐预设异常: ${JSON.stringify(aligns)}`);
        const actions = await page.$$eval(`${TOOLBAR_SEL} .studio-inline-action`, (els) => els.map((e) => e.getAttribute('data-action')));
        for (const needed of ['replace', 'caption', 'crop', 'remove']) {
          assert(actions.includes(needed), `工具条缺少动作 ${needed}: ${JSON.stringify(actions)}`);
        }
        const selected = await page.evaluate((sel) => {
          const fig = document.querySelector(sel);
          return { selected: fig?.getAttribute('data-wmb-selected'), frame: Boolean(document.querySelector('.studio-inline-image-frame')) };
        }, FIGURE_SEL);
        assert(selected.selected === 'true' && selected.frame, `选中态投影异常: ${JSON.stringify(selected)}`);
      });

      await step('切尺寸 medium + 对齐 right（只改绑定草稿，不动正文 token）', async () => {
        const beforeBody = await page.evaluate(() => document.querySelector('.studio-rich-editor')?.textContent ?? '');
        await page.click(`${TOOLBAR_SEL} .studio-inline-width[data-preset="medium"]`);
        await page.waitForFunction((sel) => document.querySelector(`${sel} .studio-inline-width[data-preset="medium"]`)?.getAttribute('aria-pressed') === 'true', TOOLBAR_SEL, { timeout: 10_000 });
        await page.click(`${TOOLBAR_SEL} .studio-inline-align[data-align="right"]`);
        await page.waitForFunction((sel) => document.querySelector(`${sel} .studio-inline-align[data-align="right"]`)?.getAttribute('aria-pressed') === 'true', TOOLBAR_SEL, { timeout: 10_000 });
        const projected = await page.evaluate((sel) => {
          const fig = document.querySelector(sel);
          return { width: fig?.getAttribute('data-wmb-width'), align: fig?.getAttribute('data-wmb-align') };
        }, FIGURE_SEL);
        assert(projected.width === 'medium' && projected.align === 'right', `尺寸/对齐投影异常: ${JSON.stringify(projected)}`);
        const afterBody = await page.evaluate(() => document.querySelector('.studio-rich-editor')?.textContent ?? '');
        assert(afterBody === beforeBody, '尺寸/对齐不应修改正文内容（正文 token 不动）');
      });

      await step('拖拽一次：手柄拖到右侧吸附通栏，绑定草稿更新', async () => {
        const before = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-wmb-width'), FIGURE_SEL);
        assert(before === 'medium', `拖拽前应为 medium，实际 ${before}`);
        const handle = await page.locator('.studio-inline-image-frame .studio-inline-handle[data-side="right"]').boundingBox();
        assert(Boolean(handle), '未找到右侧拖拽手柄');
        const fromX = handle.x + handle.width / 2;
        const fromY = handle.y + handle.height / 2;
        await page.mouse.move(fromX, fromY);
        await page.mouse.down();
        await page.mouse.move(fromX + 640, fromY, { steps: 10 });
        await page.mouse.up();
        await page.waitForFunction((sel) => {
          const fig = document.querySelector(sel);
          return fig?.getAttribute('data-wmb-width') !== 'medium';
        }, FIGURE_SEL, { timeout: 10_000 });
        const after = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-wmb-width'), FIGURE_SEL);
        assert(['small', 'medium', 'large', 'full'].includes(after), `拖拽后宽度预设非法: ${after}`);
        const pressed = await page.evaluate(({ sel, preset }) => document.querySelector(`${sel} .studio-inline-width[data-preset="${preset}"]`)?.getAttribute('aria-pressed'), { sel: TOOLBAR_SEL, preset: after });
        assert(pressed === 'true', `拖拽后工具条应反映新预设 ${after}（aria-pressed=${pressed}）`);
      });

      await step('编辑图注（走正文 token alt 变更）', async () => {
        await page.click(`${TOOLBAR_SEL} .studio-inline-action[data-action="caption"]`);
        await page.waitForSelector(`${TOOLBAR_SEL} .studio-inline-caption-input`, { timeout: 10_000 });
        await page.fill('.studio-inline-caption-input', 'E2E 图注A 已编辑');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
          const fig = document.querySelector('.studio-rich-annotate-wrap .studio-rich-editor figure.studio-figure[data-wmb-asset]');
          return fig?.querySelector('figcaption')?.getAttribute('data-wmb-caption') === 'E2E 图注A 已编辑';
        }, null, { timeout: 10_000 });
      });

      await step('保存核心正文（新版本 + 新核心绑定落库）', async () => {
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 25_000 });
      });

      await step('核心裁切第二张图：派生 asset + 正文 token 换为派生 id', async () => {
        await page.locator(FIGURE_SEL).nth(1).click();
        await page.waitForSelector(TOOLBAR_SEL, { timeout: 10_000 });
        await page.click(`${TOOLBAR_SEL} .studio-inline-action[data-action="crop"]`);
        await confirmCropModal(page, '1:1');
        await page.waitForFunction((bId) => {
          const figs = [...document.querySelectorAll('.studio-rich-annotate-wrap .studio-rich-editor figure.studio-figure[data-wmb-asset]')];
          return figs.length === 2 && figs[1].getAttribute('data-wmb-asset') !== bId;
        }, assetBId, { timeout: 20_000 });
        const assetIds = await page.$$eval(FIGURE_SEL, (els) => els.map((e) => e.getAttribute('data-wmb-asset')));
        assert(assetIds[0] === assetAId && assetIds[1] !== assetBId, `核心裁切后图片引用异常: ${JSON.stringify(assetIds)}`);
      });

      await step('保存核心裁切（v4），SQLite 回读核心绑定 + 派生血缘 + token 纯净', async () => {
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 25_000 });
        const { db, close } = openDb();
        try {
          const version = db.prepare('SELECT id, body, version_number AS revision FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(projectIdValue);
          assert(Boolean(version), '缺少最新核心版本');
          const tokens = [...version.body.matchAll(/!\[([^\]]*)\]\((wmb-asset:\/\/[0-9a-fA-F-]{36})\)/g)];
          assert(tokens.length === 2, `核心正文应恰好 2 个纯净图片 token: ${JSON.stringify(version.body.match(/!\[[^\]]*\]\([^)]*\)/g))}`);
          for (const [, , dest] of tokens) {
            assert(/^wmb-asset:\/\/[0-9a-fA-F-]{36}$/.test(dest), `正文 token 不纯净（出现尺寸/对齐/裁切杂质）: ${dest}`);
          }
          assert(tokens[0][1] === 'E2E 图注A 已编辑', `图注编辑未写入 token alt: ${tokens[0][1]}`);
          assert(!/data-wmb-|style=|width=|align=|crop/i.test(version.body), '核心正文出现布局/裁切残留');
          const derivedCore = tokens[1][2].replace('wmb-asset://', '');
          const bindings = db.prepare('SELECT asset_id, occurrence, width_preset, align, caption FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal').all(version.id);
          assert(bindings.length === 2, `核心绑定应 2 行，实际 ${bindings.length}`);
          assert(bindings[0].asset_id === assetAId && bindings[0].occurrence === 0, `核心绑定 0 应为源图 A: ${JSON.stringify(bindings[0])}`);
          assert(bindings[0].width_preset === 'full' && bindings[0].align === 'right', `拖拽后布局未持久化: ${JSON.stringify(bindings[0])}`);
          assert(bindings[0].caption === 'E2E 图注A 已编辑', `绑定图注未落库: ${JSON.stringify(bindings[0])}`);
          assert(bindings[1].asset_id === derivedCore && bindings[1].occurrence === 0, `核心绑定 1 应为派生资产（occurrence 0）: ${JSON.stringify(bindings[1])}`);
          const prov = db.prepare(`SELECT kind, source_asset_id, derived_asset_id, transform_json FROM asset_provenance
            WHERE kind = 'derived_crop' AND source_asset_id = ? AND derived_asset_id = ?`).get(assetBId, derivedCore);
          assert(Boolean(prov), '缺少核心裁切 derived_crop provenance');
          const transform = JSON.parse(prov.transform_json);
          const region = transform.cropRegion;
          assert(region && region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0 && region.x + region.width <= 1 && region.y + region.height <= 1,
            `provenance cropRegion 无效: ${JSON.stringify(transform)}`);
          const derived = db.prepare('SELECT mime_type, byte_count, sha256 FROM assets WHERE id = ?').get(derivedCore);
          assert(derived && derived.mime_type === 'image/png' && derived.byte_count > 0, `派生资产未落库: ${JSON.stringify(derived)}`);
          assert(derived.sha256 !== shaA && derived.sha256 !== shaB, '派生资产 sha256 不应与源图相同');
          const sourceB = db.prepare('SELECT sha256, byte_count FROM assets WHERE id = ?').get(assetBId);
          assert(sourceB.sha256 === shaB, '源素材被覆盖（原图必须保持不动）');
        } finally { close(); }
      });

      await step('平台页签（X）打开图片菜单：设置封面并裁切', async () => {
        const xOk = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.studio-outline-section--content button')].find((b) => b.querySelector('.pf-tag.x'));
          if (!btn) return false;
          btn.click();
          return true;
        });
        assert(xOk, '未找到 X 平台页签');
        await page.waitForFunction(() => Boolean(document.querySelector('.studio-outline-section--content button.active .pf-tag.x')), null, { timeout: 10_000 });
        await page.waitForSelector(FIGURE_SEL, { timeout: 15_000 });
        await openImageMenu(page);
        const cardB = await findImageCard(page, '图注B');
        assert(Boolean(cardB), '图片菜单缺少第二张平台图（图注B）');
        const covered = await clickImageCardButton(page, '图注B', 'button.studio-image-cover-toggle', '设为封面');
        assert(covered, '平台卡片缺少可用的封面切换按钮');
        await page.waitForFunction(() => {
          const card = [...document.querySelectorAll('.studio-image-menu .studio-image-card')].find((c) => c.textContent?.includes('图注B'));
          return Boolean(card?.querySelector('.studio-image-cover-badge')) && (card?.textContent?.includes('图 1') ?? false);
        }, null, { timeout: 10_000 });
        const cropped = await clickImageCardButton(page, '图注B', 'button.studio-image-crop-button', '裁剪');
        assert(cropped, '平台卡片缺少可用的裁剪按钮');
        await confirmCropModal(page, '1:1');
        await openImageMenu(page);
        const chipOk = await page.evaluate(() => {
          const card = [...document.querySelectorAll('.studio-image-menu .studio-image-card')].find((c) => c.textContent?.includes('图注B'));
          return Boolean(card?.querySelector('.studio-image-crop-chip')) && Boolean(card?.querySelector('.studio-image-cover-badge'));
        });
        assert(chipOk, '平台卡片未显示「已裁切」状态或封面徽标');
        await closeImageMenu(page);
      });

      await step('保存平台版本（封面/裁切原子物化派生资产并重建 asset_ids_json）', async () => {
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 25_000 });
      });

      await step('SQLite 回读平台绑定：封面/裁切/派生投影', async () => {
        const { db, close } = openDb();
        try {
          const pv = db.prepare(`SELECT id, asset_ids_json, revision FROM platform_versions
            WHERE project_id = ? AND platform = 'x' ORDER BY revision DESC LIMIT 1`).get(projectIdValue);
          assert(pv && Number(pv.revision) >= 2, `X 平台版本应已保存新版本: ${JSON.stringify(pv)}`);
          const assetIds = JSON.parse(pv.asset_ids_json);
          const prov = db.prepare(`SELECT derived_asset_id FROM asset_provenance
            WHERE kind = 'derived_crop' AND source_asset_id = ? ORDER BY created_at DESC LIMIT 1`).get(assetBId);
          assert(Boolean(prov), '平台裁切缺少 derived_crop provenance');
          const derivedPlatform = prov.derived_asset_id;
          assert(assetIds[0] === derivedPlatform && assetIds[1] === assetAId,
            `asset_ids_json 应按 ordinal 用 derivedAssetId||assetId 重建: ${JSON.stringify(assetIds)}`);
          const bindings = db.prepare('SELECT asset_id, ordinal, is_cover, crop_region_json, derived_asset_id FROM platform_media_bindings WHERE platform_version_id = ? ORDER BY ordinal').all(pv.id);
          assert(bindings.length === 2, `平台绑定应 2 行，实际 ${bindings.length}`);
          assert(bindings[0].asset_id === assetBId && bindings[0].ordinal === 0 && bindings[0].is_cover === 1,
            `封面应为首图且 is_cover=1: ${JSON.stringify(bindings[0])}`);
          assert(bindings[0].derived_asset_id === derivedPlatform, `平台绑定派生 id 不符: ${JSON.stringify(bindings[0])}`);
          const region = JSON.parse(bindings[0].crop_region_json);
          assert(region && region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0 && region.x + region.width <= 1 && region.y + region.height <= 1,
            `平台绑定 cropRegion 无效: ${JSON.stringify(region)}`);
          assert(bindings[1].asset_id === assetAId && bindings[1].ordinal === 1 && bindings[1].is_cover === 0 && bindings[1].derived_asset_id === null,
            `平台绑定 1 应为非封面源图 A: ${JSON.stringify(bindings[1])}`);
          const derived = db.prepare('SELECT mime_type, byte_count FROM assets WHERE id = ?').get(derivedPlatform);
          assert(derived && derived.mime_type === 'image/png' && derived.byte_count > 0, '平台派生素材未落库');
          const sourceB = db.prepare('SELECT sha256 FROM assets WHERE id = ?').get(assetBId);
          assert(sourceB.sha256 === shaB, '平台裁切后源素材被覆盖');
        } finally { close(); }
      });

      await step('只读历史版本：图片编辑按钮禁用/不可用', async () => {
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.studio-outline-section--content button')].find((b) => b.querySelector('.pf-tag.core'));
          btn?.click();
        });
        await page.waitForFunction(() => Boolean(document.querySelector('.studio-outline-section--content button.active .pf-tag.core')), null, { timeout: 10_000 });
        await page.click('.studio-editor-top button.secondary-button');
        await page.waitForSelector('.studio-history-version', { timeout: 10_000 });
        const clicked = await page.evaluate(() => {
          const card = [...document.querySelectorAll('.studio-history-version')].find((c) => c.textContent?.includes('第 2 版'));
          if (!card) return false;
          card.click();
          return true;
        });
        assert(clicked, '版本面板缺少「第 2 版」核心版本');
        await page.waitForSelector('.historical-version-notice', { timeout: 10_000 });
        await page.waitForSelector(FIGURE_SEL, { timeout: 15_000 });
        await assertReadonlyImageState(page);
      });

      await step('返回最新版，1568 视口无横向溢出且未访问外部平台', async () => {
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.historical-version-notice button')].find((b) => b.textContent?.includes('返回最新版'));
          btn?.click();
        });
        await page.waitForSelector('.historical-version-notice', { state: 'detached', timeout: 10_000 });
        await page.setViewportSize({ width: 1568, height: 960 });
        await page.waitForTimeout(500);
        const layout = await page.evaluate(() => ({
          innerWidth: window.innerWidth,
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth
        }));
        assert(layout.innerWidth >= 1560, `视口宽度未应用 1568: ${JSON.stringify(layout)}`);
        assert(layout.docOverflow <= 1 && layout.bodyOverflow <= 1, `1568 视口出现横向溢出: ${JSON.stringify(layout)}`);
        const url = page.url();
        assert(!/twitter\.com|xiaohongshu\.com|weixin\.qq\.com|mp\.weixin/i.test(url), `场景不应访问真实外部平台: ${url}`);
        await page.waitForSelector('.studio-editor-view', { timeout: 10_000 });
      });

      return {
        coreVersionSaved: true,
        platformVersionSaved: true,
        derivedCropProvenance: true,
        tokenPure: true,
        readonlyDisabled: true,
        viewport1568NoOverflow: true
      };
    }
  }
];
