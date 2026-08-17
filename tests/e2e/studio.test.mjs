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
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { seedWorkflowBase, openWriteDb, seedStudioProject } from './seed-workflow.mjs';
import { savePlatformVersion } from '../../src/main/content.ts';
import { importAssetBytes, linkProjectAsset, markdownImageForAsset } from '../../src/main/assets.ts';
import { seedSource } from './lib/seed.mjs';
import { buildJobContextRefs, buildJobObjectBoundary } from '../../src/main/job-object-boundary.ts';
import { buildResearchEvidencePack } from '../../src/main/research-task-state.ts';
import { upsertResearchClaim } from '../../src/main/db/research-claims-store.ts';
import { enqueueResearchSuccessor } from '../../src/main/research-successor.ts';

const seedBase = async ({ dataRoot, workspaceId }) => {
  await seedWorkflowBase(dataRoot, workspaceId);
};

const seedWithProject = async ({ dataRoot, workspaceId }) => {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    const xSourceId = seedSource(db, { title: 'E2E X 资料', summary: 'X 来源摘要', author: '@wmb_e2e', originalUrl: 'https://x.com/wmb_e2e/status/100' });
    const wechatSourceId = seedSource(db, { title: 'E2E 微信资料', summary: '微信来源摘要', author: 'WMB 测试公众号', originalUrl: 'https://mp.weixin.qq.com/s/wmb-e2e-source' });
    seedStudioProject(db, { sourceIds: [xSourceId, wechatSourceId], coreV2: '核心 V2 正文（编辑保存）\n\n## Markdown 二级标题\n\n**已确认：**2026 年继续验证。\n\n- 一级条目\n  - 二级条目' });
  } finally {
    db.close();
  }
};

function startPiComposerMock() {
  let responseNumber = 0;
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        return respond(200, { data: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-vision' }] });
      }
      if (req.method === 'POST' && req.url?.endsWith('/responses')) {
        req.on('data', () => {});
        req.on('end', () => {
          responseNumber += 1;
          const responseId = `e2e-response-${responseNumber}`;
          const itemId = `e2e-message-${responseNumber}`;
          const outputItem = {
            id: itemId, type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'E2E mock response', annotations: [] }]
          };
          const events = [
            { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
            { type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
            { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: 'E2E mock response' },
            { type: 'response.output_item.done', output_index: 0, item: outputItem },
            {
              type: 'response.completed',
              response: {
                id: responseId, status: 'completed', output: [outputItem],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
              }
            }
          ];
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
          for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
          res.end();
        });
        return;
      }
      respond(404, {});
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('本地 Pi mock 未能取得端口。'));
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve()))
      });
    });
  });
}

const RESEARCH_GATE_DATE = '2026-08-16';

function insertResearchGateTask(db, { id, intent, status, phase, businessDate, contextRefs, resultRefs = {} }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, heartbeat_at, error_code, error_message,
    created_at, updated_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '{}', '{}', '[]', NULL, NULL, NULL, ?, ?, NULL)`).run(
    id, intent, businessDate, status, phase, JSON.stringify(contextRefs), JSON.stringify(resultRefs), now, now
  );
}

/** WMB-5296: one Studio project plus a truthful unresolved research successor requiring owner choice. */
const seedStudioResearchGate = async ({ dataRoot, workspaceId }) => {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    const project = seedStudioProject(db, {
      title: 'E2E 研究续写项目',
      coreV1: '研究续写项目正文',
      coreV2: '等待研究结论后继续写作',
      platforms: []
    });
    const parentTaskId = `e2e-parent-${randomUUID()}`;
    const parentJobId = `e2e-job-${randomUUID()}`;
    const parentRequest = {
      roleId: 'writer', brief: '基于研究结果完成核心正文', projectId: project.projectId,
      writerTask: 'core_draft', businessDate: RESEARCH_GATE_DATE
    };
    const parentRefs = buildJobContextRefs({
      jobId: parentJobId,
      request: parentRequest,
      boundary: buildJobObjectBoundary(parentRequest, RESEARCH_GATE_DATE)
    });
    insertResearchGateTask(db, {
      id: parentTaskId, intent: 'studio_draft', status: 'partial', phase: 'research_dispatched',
      businessDate: RESEARCH_GATE_DATE, contextRefs: parentRefs
    });

    const researchTaskId = `e2e-research-${randomUUID()}`;
    const claim = { key: 'agentic_loop_study_identity', text: '原始研究出处、论文标题与作者身份', type: 'fact' };
    const research = {
      gapId: `gap-${researchTaskId}`, parentJobId, parentTaskId, parentRoleId: 'writer',
      requiredClaims: [claim],
      budget: { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 },
      channels: ['web', 'x', 'xhs']
    };
    const researchRequest = {
      roleId: 'reporter', brief: '研究补料工单', businessDate: RESEARCH_GATE_DATE,
      projectId: project.projectId, research
    };
    const researchRefs = buildJobContextRefs({
      jobId: `e2e-research-job-${randomUUID()}`,
      request: researchRequest,
      boundary: buildJobObjectBoundary(researchRequest, RESEARCH_GATE_DATE)
    });
    const pack = buildResearchEvidencePack({
      jobId: researchTaskId, round: 1,
      claims: [{ id: `claim-${randomUUID()}`, key: claim.key, status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], needsTimeExcerpt: false }],
      sourceIds: [], validSourceCount: 0, candidateCount: 0, timeSpentMinutes: 2,
      terminalReason: 'candidates_exhausted', unresolvedRequiredClaims: [claim.key]
    });
    insertResearchGateTask(db, {
      id: researchTaskId, intent: 'research', status: 'partial', phase: 'partial',
      businessDate: RESEARCH_GATE_DATE, contextRefs: researchRefs, resultRefs: pack
    });
    const claimResult = upsertResearchClaim(db, {
      taskId: researchTaskId, claimKey: claim.key, claimText: claim.text, claimType: claim.type, status: 'unresolved'
    });
    if (!claimResult.ok) throw new Error(`seedStudioResearchGate: claim 写入失败 ${JSON.stringify(claimResult.error ?? claimResult)}`);
    const successor = enqueueResearchSuccessor(db, { researchTaskId });
    if (!successor.enqueued || successor.job?.status !== 'needs_user') {
      throw new Error(`seedStudioResearchGate: 续派门未建立 ${JSON.stringify(successor)}`);
    }
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
async function seedImageEditingProject({ dataRoot, workspaceId }, assetASize = { width: 64, height: 64 }) {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try {
    const content = await import('../../src/main/content.ts');
    const assetA = await importAssetBytes(db, dataRoot, {
      bytes: makeSeedPng(assetASize.width, assetASize.height, 214, 42, 42),
      fileName: 'seed-a.png',
      mimeType: 'image/png',
      origin: 'e2e:st008:source',
      width: assetASize.width,
      height: assetASize.height
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

/** 切到可视化编辑模式；等正文图片 figure 渲染。 */
async function switchToRichEditor(page) {
  const switched = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.studio-mode-switch button')].find((node) => node.textContent?.includes('可视化编辑'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!switched) throw new Error('未找到「可视化编辑」模式切换按钮');
  await page.waitForSelector(INLINE_FIGURE, { timeout: 15_000 });
}

/** 切到源码编辑模式；只等待原始 Markdown textarea。 */
async function switchToSourceEditor(page) {
  const switched = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.studio-mode-switch button')].find((node) => node.textContent?.includes('源码编辑'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!switched) throw new Error('未找到「源码编辑」模式切换按钮');
  await page.waitForSelector('#studio-body-source:not([disabled])', { state: 'visible', timeout: 15_000 });
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

/** 断言只读版本：顶栏不显示无关保存；历史操作统一成正常按钮；正文图不可编辑。 */
async function assertReadonlyImageState(page) {
  const historyChrome = await page.evaluate(() => {
    const topSave = [...document.querySelectorAll('.studio-editor-top button')].filter((button) => button.textContent?.trim() === '保存').length;
    const actions = [...document.querySelectorAll('.historical-version-actions button')].map((button) => ({
      label: button.textContent?.trim() ?? '',
      primary: button.classList.contains('primary-button'),
      secondary: button.classList.contains('secondary-button'),
      height: Math.round(button.getBoundingClientRect().height)
    }));
    return { topSave, actions, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  if (historyChrome.topSave !== 0) throw new Error(`历史只读态不应显示无关的保存按钮: ${JSON.stringify(historyChrome)}`);
  if (historyChrome.actions.length !== 3 || historyChrome.actions.filter((item) => item.primary).length !== 1 || historyChrome.actions.some((item) => !item.primary && !item.secondary)) {
    throw new Error(`历史版本三个操作应统一使用按钮样式且仅返回最新版为主操作: ${JSON.stringify(historyChrome)}`);
  }
  if (new Set(historyChrome.actions.map((item) => item.height)).size !== 1 || historyChrome.overflowX !== 0) {
    throw new Error(`历史版本操作应等高且无横向溢出: ${JSON.stringify(historyChrome)}`);
  }
  await page.locator('.historical-version-actions button', { hasText: '复制为新项目' }).click();
  await page.waitForSelector('.historical-copy-row #studio-copy-title', { timeout: 10_000 });
  const copyRow = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.historical-copy-row button')].map((button) => button.textContent?.trim() ?? ''),
    allStyled: [...document.querySelectorAll('.historical-copy-row button')].every((button) => button.classList.contains('secondary-button')),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));
  if (!copyRow.allStyled || copyRow.labels.join('|') !== '创建新项目|取消' || copyRow.overflowX !== 0) throw new Error(`复制项目展开行按钮/布局错误: ${JSON.stringify(copyRow)}`);
  await page.locator('.historical-copy-row button', { hasText: '取消' }).click();
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
        const compact = await page.evaluate(() => {
          const formatbar = document.querySelector('.studio-formatbar');
          const barRect = formatbar?.getBoundingClientRect();
          const groups = [...(formatbar?.querySelectorAll('.studio-formatbar-group') ?? [])].map((group) => group.getBoundingClientRect());
          return {
            metaRows: document.querySelectorAll('.studio-doc-meta').length,
            status: document.querySelector('.studio-writing-status')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            titleVisible: Boolean(document.querySelector('#studio-title')?.getBoundingClientRect().height),
            formatbarHeight: Math.round(barRect?.height ?? 0),
            formatbarOverflow: formatbar ? formatbar.scrollWidth - formatbar.clientWidth : -1,
            groupsInside: Boolean(barRect) && groups.every((rect) => rect.left >= barRect.left - 1 && rect.right <= barRect.right + 1),
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
          };
        });
        assert(compact.metaRows === 0 && !/约\s*\d+\s*分钟/.test(compact.status), `最小窗口不得恢复重复元数据或阅读时间，实际 ${JSON.stringify(compact)}`);
        assert(compact.titleVisible && compact.status.includes('字数') && /来源 \d+/.test(compact.status) && /素材 \d+/.test(compact.status), `最小窗口应保留标题与真实状态入口，实际 ${JSON.stringify(compact)}`);
        assert(compact.overflowX === 0, `1100×800 创作编辑器不应产生页面横向溢出，实际 ${compact.overflowX}`);
        assert(compact.formatbarHeight > 48 && compact.formatbarOverflow === 0 && compact.groupsInside, `1100px 下格式工具栏应分行完整显示且不可横向滚动: ${JSON.stringify(compact)}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-metadata-cleanup-1100' });
      });
      await step('Markdown 完整渲染且不泄露字面标记', async () => {
        await page.locator('.studio-mode-switch button', { hasText: '可视化编辑' }).click();
        await page.waitForSelector('#studio-body h2', { timeout: 10_000 });
        const rendered = await page.evaluate(() => ({
          heading: document.querySelector('#studio-body h2')?.textContent?.trim() ?? '',
          strong: document.querySelector('#studio-body strong')?.textContent?.trim() ?? '',
          listItems: [...document.querySelectorAll('#studio-body li')].map((item) => item.firstChild?.textContent?.trim() ?? ''),
          literalMarkers: (document.querySelector('#studio-body')?.textContent ?? '').includes('**'),
          editable: document.querySelector('#studio-body')?.getAttribute('contenteditable')
        }));
        assert(rendered.heading === 'Markdown 二级标题' && rendered.strong === '已确认：' && rendered.listItems.length === 2, `Markdown 标题/强调/嵌套列表未完整渲染: ${JSON.stringify(rendered)}`);
        assert(!rendered.literalMarkers && rendered.editable === 'true', `可视化编辑不应泄露 Markdown 标记且必须可编辑: ${JSON.stringify(rendered)}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-editor-markdown-toolbar-1100' });
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
      const richSuffix = ' RICH_EDIT_ABC';
      await step('渲染态修改标题与正文并保存', async () => {
        await page.fill('#studio-title', editedTitle);
        await page.locator('.studio-mode-switch button', { hasText: '可视化编辑' }).click();
        await page.waitForSelector('#studio-body[contenteditable="true"]', { timeout: 10_000 });
        await page.evaluate(() => {
          const editor = document.querySelector('#studio-body');
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          editor.focus();
        });
        await page.keyboard.type(richSuffix);
        await page.waitForFunction((suffix) => document.querySelector('#studio-body')?.textContent?.trimEnd().endsWith(suffix.trim()), richSuffix, { timeout: 10_000 });
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('有未保存修改'), null, { timeout: 10_000 });
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 15_000 });
        const bodyText = await page.textContent('#studio-body');
        assert(bodyText.trimEnd().endsWith(richSuffix.trim()), `渲染态输入顺序或光标被重置: ${JSON.stringify(bodyText?.slice(-40))}`);
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
        const body = await page.inputValue('#studio-body-source');
        assert(title === editedTitle, `重载后标题未持久化: ${JSON.stringify(title)}`);
        assert(body.endsWith(richSuffix), `重载后渲染态正文修改未持久化: ${JSON.stringify(body.slice(-60))}`);
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
      await step('长正文深处右键打开说明输入不改变阅读位置', async () => {
        await page.locator('.studio-mode-switch button', { hasText: '可视化编辑' }).click();
        await page.waitForSelector('#studio-body[contenteditable="true"]', { timeout: 10_000 });
        await page.evaluate(() => {
          const editor = document.querySelector('#studio-body');
          if (!(editor instanceof HTMLElement)) throw new Error('missing rich editor');
          editor.innerHTML += Array.from({ length: 36 }, (_, index) => `<p>批注滚动稳定性段落 ${index + 1}：保持当前阅读位置。</p>`).join('');
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
        });
        await page.waitForFunction(() => (document.querySelector('#studio-body')?.textContent ?? '').includes('批注滚动稳定性段落 36'));
        const selection = await page.evaluate(() => {
          const canvas = document.querySelector('.studio-canvas');
          const editor = document.querySelector('#studio-body');
          if (!(canvas instanceof HTMLElement) || !(editor instanceof HTMLElement)) return null;
          const target = [...editor.querySelectorAll('p')].find((node) => node.textContent?.includes('批注滚动稳定性段落 36'));
          const textNode = target?.firstChild;
          if (!(target instanceof HTMLElement) || !textNode) return null;
          target.scrollIntoView({ block: 'center' });
          const text = textNode.textContent ?? '';
          const start = text.indexOf('保持当前阅读位置');
          if (start < 0) return null;
          const range = document.createRange();
          range.setStart(textNode, start);
          range.setEnd(textNode, start + '保持当前阅读位置'.length);
          const selected = window.getSelection();
          selected?.removeAllRanges();
          selected?.addRange(range);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2, scrollTop: canvas.scrollTop };
        });
        assert(selection && selection.scrollTop > 100, `未能建立正文深处选区: ${JSON.stringify(selection)}`);
        await page.mouse.click(selection.x, selection.y, { button: 'right' });
        await page.waitForSelector('.studio-annotation-menu', { timeout: 10_000 });
        await page.locator('.studio-annotation-menu button', { hasText: '标记并说明' }).click();
        await page.waitForSelector('.studio-annotation-note-pop textarea', { timeout: 10_000 });
        await page.waitForTimeout(200);
        const scrollAfter = await page.$eval('.studio-canvas', (node) => node.scrollTop);
        assert(Math.abs(scrollAfter - selection.scrollTop) <= 2, `打开说明输入导致编辑画布跳动: before=${selection.scrollTop}, after=${scrollAfter}`);
        await helpers.captureEvidence({ app: ctx.app, page, evidence: ctx.evidence, artifactsDir: ctx.artifactsDir, name: 'studio-annotation-scroll-stable' });
        await page.fill('.studio-annotation-note-pop textarea', 'E2E 深处批注说明');
        await page.click('.studio-annotation-note-actions button.primary-button');
        await page.waitForSelector('.studio-annotation-note-pop', { state: 'detached', timeout: 10_000 });
        await page.waitForFunction(() => document.querySelectorAll('.studio-annotation-rect, .studio-annotation-mark').length > 0);
        const { db, close } = openDb();
        try {
          const row = db.prepare(`SELECT quoted_text, note FROM studio_annotations WHERE note = 'E2E 深处批注说明' ORDER BY created_at DESC LIMIT 1`).get();
          assert(row?.note === 'E2E 深处批注说明' && row.quoted_text.length > 0, `深处批注未持久化: ${JSON.stringify(row)}`);
        } finally { close(); }
        await page.locator('.studio-mode-switch button', { hasText: '源码' }).click();
      });
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
      const { page, helpers, assert, step, openDb, app, evidence, artifactsDir } = ctx;
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
      await step('导航到创作页并打开超宽图片项目（1568 视口）', async () => {
        await page.setViewportSize({ width: 1568, height: 960 });
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 图片编辑项目');
      });

      await step('源码编辑只显示可编辑 Markdown，不混入渲染预览', async () => {
        await switchToSourceEditor(page);
        const sourceState = await page.evaluate(() => {
          const textarea = document.querySelector('#studio-body-source');
          const paper = document.querySelector('.studio-paper');
          const canvas = document.querySelector('.studio-canvas');
          return {
            value: textarea?.value ?? '',
            disabled: textarea?.disabled ?? true,
            readonly: textarea?.readOnly ?? true,
            renderedPreviewCount: document.querySelectorAll('.studio-live-false-body').length,
            paperOverflow: paper ? paper.scrollWidth - paper.clientWidth : -1,
            canvasOverflow: canvas ? canvas.scrollWidth - canvas.clientWidth : -1,
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
          };
        });
        assert(sourceState.value.includes('wmb-asset://') && !sourceState.disabled && !sourceState.readonly,
          `源码编辑器未显示可编辑原始 Markdown: ${JSON.stringify(sourceState)}`);
        assert(sourceState.renderedPreviewCount === 0, `源码编辑器不应混入渲染预览: ${JSON.stringify(sourceState)}`);
        assert(sourceState.paperOverflow === 0 && sourceState.canvasOverflow === 0 && sourceState.pageOverflow === 0,
          `源码编辑模式出现横向溢出: ${JSON.stringify(sourceState)}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-source-editor-raw-markdown' });
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

      await step('WMB-5287：尺寸/对齐真实几何生效、失焦延迟不回滚、保存重载后从绑定恢复', async () => {
        // 基线：上一步已将图 A 置为 medium/right —— 先以真实几何（65% 行宽、贴右缘）验证，
        // 而非仅按钮态/数据属性。
        const measureFigure = () => page.evaluate((sel) => {
          const editor = document.querySelector('.studio-rich-editor');
          const fig = editor?.querySelector(sel);
          if (!editor || !fig) return null;
          const cs = getComputedStyle(editor);
          const er = editor.getBoundingClientRect();
          const contentLeft = er.left + (Number.parseFloat(cs.paddingLeft) || 0);
          const contentRight = er.right - (Number.parseFloat(cs.paddingRight) || 0);
          const rect = fig.getBoundingClientRect();
          return {
            width: rect.width,
            ratio: rect.width / Math.max(1, contentRight - contentLeft),
            leftGap: rect.left - contentLeft,
            rightGap: contentRight - rect.right,
            attrWidth: fig.getAttribute('data-wmb-width'),
            attrAlign: fig.getAttribute('data-wmb-align')
          };
        }, FIGURE_SEL);
        const approx = (a, b, eps) => Math.abs(a - b) <= eps;
        const baseline = await measureFigure();
        assert(baseline && approx(baseline.ratio, 0.65, 0.03) && baseline.rightGap <= 3
          && baseline.attrWidth === 'medium' && baseline.attrAlign === 'right',
          `基线（medium/right）未按真实几何渲染: ${JSON.stringify(baseline)}`);
        const bodyBefore = await page.evaluate(() => document.querySelector('.studio-rich-editor')?.textContent ?? '');

        // 点击 small + left：必须立即以真实几何生效（40% 行宽、贴左缘），而非仅按钮态/数据属性。
        await page.click(`${TOOLBAR_SEL} .studio-inline-width[data-preset="small"]`);
        await page.waitForFunction((sel) => {
          const fig = document.querySelector(sel);
          const editor = document.querySelector('.studio-rich-editor');
          if (!fig || !editor) return false;
          const cs = getComputedStyle(editor);
          const er = editor.getBoundingClientRect();
          const cw = er.right - (Number.parseFloat(cs.paddingRight) || 0) - (er.left + (Number.parseFloat(cs.paddingLeft) || 0));
          const ratio = fig.getBoundingClientRect().width / cw;
          return fig.getAttribute('data-wmb-width') === 'small' && ratio >= 0.37 && ratio <= 0.43;
        }, FIGURE_SEL, { timeout: 10_000 });
        await page.click(`${TOOLBAR_SEL} .studio-inline-align[data-align="left"]`);
        await page.waitForFunction((sel) => {
          const fig = document.querySelector(sel);
          const editor = document.querySelector('.studio-rich-editor');
          if (!fig || !editor) return false;
          const cs = getComputedStyle(editor);
          const er = editor.getBoundingClientRect();
          const contentLeft = er.left + (Number.parseFloat(cs.paddingLeft) || 0);
          return fig.getAttribute('data-wmb-align') === 'left' && fig.getBoundingClientRect().left - contentLeft <= 3;
        }, FIGURE_SEL, { timeout: 10_000 });
        const s1 = await measureFigure();
        assert(s1 && approx(s1.ratio, 0.4, 0.03) && s1.leftGap <= 3 && s1.attrWidth === 'small' && s1.attrAlign === 'left',
          `small/left 未按真实几何生效: ${JSON.stringify(s1)}`);

        // 失焦（点击标题）关闭选中框，等待 >1s：几何与投影不得回滚（WMB-5287 回归点）。
        await page.locator('#studio-title').click({ position: { x: 10, y: 10 } });
        try { await page.waitForSelector(TOOLBAR_SEL, { state: 'detached', timeout: 5_000 }); } catch { /* 工具条可能已先行关闭 */ }
        await page.waitForTimeout(1200);
        const s2 = await measureFigure();
        assert(s2 && Math.abs(s2.width - s1.width) <= 1 && Math.abs(s2.leftGap - s1.leftGap) <= 1
          && s2.attrWidth === 'small' && s2.attrAlign === 'left',
          `失焦/延迟后尺寸或对齐回滚（WMB-5287）: before=${JSON.stringify(s1)} after=${JSON.stringify(s2)}`);
        const bodyAfter = await page.evaluate(() => document.querySelector('.studio-rich-editor')?.textContent ?? '');
        assert(bodyAfter === bodyBefore, '宽度/对齐不应改动正文内容（正文 token 不动）');
        const tokenClean = await page.evaluate((sel) => {
          const f = document.querySelector(sel);
          const img = f?.querySelector(':scope > img');
          return { src: img?.getAttribute('src') ?? '', alt: img?.getAttribute('alt') ?? '', imgStyle: img?.getAttribute('style') ?? '', figStyle: f?.getAttribute('style') ?? '' };
        }, FIGURE_SEL);
        assert(tokenClean.src === `wmb-asset://${assetAId}` && tokenClean.alt === '图注A' && !tokenClean.imgStyle && !tokenClean.figStyle,
          `布局编辑不应改写正文图片引用/alt 或残留内联样式: ${JSON.stringify(tokenClean)}`);

        // 重新选中：工具条按钮态与草稿一致。
        await page.locator(FIGURE_SEL).nth(0).click();
        await page.waitForSelector(TOOLBAR_SEL, { timeout: 10_000 });
        const pressed = await page.evaluate((tb) => ({
          width: [...document.querySelectorAll(`${tb} .studio-inline-width`)].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-preset')),
          align: [...document.querySelectorAll(`${tb} .studio-inline-align`)].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-align'))
        }), TOOLBAR_SEL);
        assert(JSON.stringify(pressed.width) === '["small"]' && JSON.stringify(pressed.align) === '["left"]',
          `重新选中后工具条按钮态与草稿不一致: ${JSON.stringify(pressed)}`);

        // 保存（现有协议）：新核心版本落库；正文 token 纯净；点击的 small/left 进入绑定。
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 25_000 });
        const { db, close } = openDb();
        try {
          const version = db.prepare('SELECT id, body FROM content_versions WHERE project_id = ? ORDER BY version_number DESC LIMIT 1').get(projectIdValue);
          assert(Boolean(version), '缺少保存后的最新核心版本');
          const tokens = [...version.body.matchAll(/!\[([^\]]*)\]\((wmb-asset:\/\/[0-9a-fA-F-]{36})\)/g)];
          assert(tokens.length === 2, `保存后核心正文应仍为 2 个纯净图片 token: ${version.body.match(/!\[[^\]]*\]\([^)]*\)/g)?.join(' | ') ?? version.body}`);
          for (const [, , dest] of tokens) assert(/^wmb-asset:\/\/[0-9a-fA-F-]{36}$/.test(dest), `正文 token 混入布局杂质: ${dest}`);
          assert(tokens[0][1] === '图注A', `保存后图 A alt 不应被布局改动污染: ${tokens[0][1]}`);
          assert(!/data-wmb-|style=|width=|align=|crop/i.test(version.body), '保存后正文出现布局残留');
          const bindings = db.prepare('SELECT asset_id, occurrence, width_preset, align, caption FROM content_media_bindings WHERE content_version_id = ? ORDER BY ordinal').all(version.id);
          assert(bindings.length === 2, `绑定行数应为 2，实际 ${bindings.length}`);
          const first = bindings.find((b) => b.asset_id === assetAId && b.occurrence === 0);
          assert(first && first.width_preset === 'small' && first.align === 'left' && first.caption === '图注A',
            `点击的 small/left 未持久化到核心绑定: ${JSON.stringify(first)}`);
        } finally { close(); }

        // 重载同一项目：从持久化绑定恢复真实几何与工具条态。
        await page.reload();
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head), .studio-editor-view', { timeout: 20_000 });
        const rowShown = await page.evaluate(() => !!document.querySelector('.studio-project-row:not(.head)'));
        if (rowShown) await openProjectByName(page, 'E2E 图片编辑项目');
        await page.waitForSelector('.studio-editor-view', { timeout: 15_000 });
        await switchToRichEditor(page);
        await page.locator(FIGURE_SEL).nth(0).click();
        await page.waitForSelector(TOOLBAR_SEL, { timeout: 10_000 });
        const restored = await measureFigure();
        assert(restored && approx(restored.ratio, 0.4, 0.03) && restored.leftGap <= 3 && restored.attrWidth === 'small' && restored.attrAlign === 'left',
          `重载后绑定未恢复（应仍为 small/left）: ${JSON.stringify(restored)}`);
        const restoredPressed = await page.evaluate((tb) => ({
          width: [...document.querySelectorAll(`${tb} .studio-inline-width`)].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-preset')),
          align: [...document.querySelectorAll(`${tb} .studio-inline-align`)].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-align'))
        }), TOOLBAR_SEL);
        assert(JSON.stringify(restoredPressed.width) === '["small"]' && JSON.stringify(restoredPressed.align) === '["left"]',
          `重载后工具条未反映恢复的绑定: ${JSON.stringify(restoredPressed)}`);

        // 恢复 medium/right 草稿，衔接后续拖拽步骤（其断言 before === 'medium'）。
        await page.click(`${TOOLBAR_SEL} .studio-inline-width[data-preset="medium"]`);
        await page.waitForFunction((sel) => {
          const fig = document.querySelector(sel);
          const editor = document.querySelector('.studio-rich-editor');
          if (!fig || !editor) return false;
          const cs = getComputedStyle(editor);
          const er = editor.getBoundingClientRect();
          const cw = er.right - (Number.parseFloat(cs.paddingRight) || 0) - (er.left + (Number.parseFloat(cs.paddingLeft) || 0));
          const ratio = fig.getBoundingClientRect().width / cw;
          return fig.getAttribute('data-wmb-width') === 'medium' && ratio >= 0.62 && ratio <= 0.68;
        }, FIGURE_SEL, { timeout: 10_000 });
        await page.click(`${TOOLBAR_SEL} .studio-inline-align[data-align="right"]`);
        await page.waitForFunction((sel) => {
          const fig = document.querySelector(sel);
          const editor = document.querySelector('.studio-rich-editor');
          if (!fig || !editor) return false;
          const cs = getComputedStyle(editor);
          const er = editor.getBoundingClientRect();
          const contentRight = er.right - (Number.parseFloat(cs.paddingRight) || 0);
          return fig.getAttribute('data-wmb-align') === 'right' && contentRight - fig.getBoundingClientRect().right <= 3;
        }, FIGURE_SEL, { timeout: 10_000 });
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
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-historical-version-actions' });
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
  },
  {
    id: 'WMB-5305-studio-editor-modes-and-image-insertion',
    launch: { seedFixture: seedWithProject },
    run: async ({ page, app, evidence, artifactsDir, helpers, assert, openDb }) => {
      const step = (label, action) => helpers.step(evidence, label, action);
      const sourceImage = makeSeedPng(72, 48, 139, 124, 255);
      const visualImage = makeSeedPng(64, 64, 76, 195, 138);
      await helpers.waitForAppReady(page);
      await step('打开项目并确认两种编辑模式语义', async () => {
        await page.setViewportSize({ width: 1100, height: 800 });
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 创作项目 A');
        const labels = await page.$$eval('.studio-mode-switch button', (nodes) => nodes.map((node) => node.textContent?.trim()));
        assert(JSON.stringify(labels) === JSON.stringify(['源码编辑', '可视化编辑']), `编辑模式标签不明确: ${JSON.stringify(labels)}`);
        await switchToSourceEditor(page);
        const state = await page.evaluate(() => ({
          visible: Boolean(document.querySelector('#studio-body-source')),
          disabled: document.querySelector('#studio-body-source')?.disabled ?? true,
          readonly: document.querySelector('#studio-body-source')?.readOnly ?? true,
          previewCount: document.querySelectorAll('.studio-live-false-body').length
        }));
        assert(state.visible && !state.disabled && !state.readonly && state.previewCount === 0, `源码编辑模式合同错误: ${JSON.stringify(state)}`);
      });
      await step('源码编辑在当前光标插入图片 token', async () => {
        await page.evaluate(() => {
          const textarea = document.querySelector('#studio-body-source');
          const offset = textarea.value.indexOf('核心 V2 正文') + '核心 V2 正文'.length;
          textarea.focus();
          textarea.setSelectionRange(offset, offset);
        });
        await page.locator('input.studio-import-input').first().setInputFiles({ name: 'source-mode.png', mimeType: 'image/png', buffer: sourceImage });
        await page.waitForFunction(() => (document.querySelector('#studio-body-source')?.value.match(/wmb-asset:\/\//g) ?? []).length === 1, null, { timeout: 20_000 });
        const body = await page.inputValue('#studio-body-source');
        const expectedAt = body.indexOf('核心 V2 正文') + '核心 V2 正文'.length;
        const tokenAt = body.indexOf('![source-mode](wmb-asset://');
        assert(tokenAt > expectedAt && /^\s+$/.test(body.slice(expectedAt, tokenAt)), `源码图片未按当前光标插入独立图片段: ${JSON.stringify(body)}`);
      });
      await step('可视化编辑在当前光标插入并立即渲染第二张图片', async () => {
        await page.locator('.studio-mode-switch button', { hasText: '可视化编辑' }).click();
        await page.waitForSelector('#studio-body[contenteditable="true"] figure[data-wmb-asset]', { timeout: 15_000 });
        await page.evaluate(() => {
          const editor = document.querySelector('#studio-body');
          const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent?.includes('来源身份')) ?? editor.lastChild;
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          editor.focus();
        });
        await page.locator('input.studio-import-input').first().setInputFiles({ name: 'visual-mode.png', mimeType: 'image/png', buffer: visualImage });
        await page.waitForFunction(() => document.querySelectorAll('#studio-body figure[data-wmb-asset]').length === 2, null, { timeout: 20_000 });
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-editor-two-mode-image-insertion' });
      });
      await step('拖动图片到标题下方并提供键盘移动替代', async () => {
        const dragResult = await page.evaluate(() => {
          const editor = document.querySelector('#studio-body');
          const sourceFigure = document.querySelector('figure.studio-figure img[alt="source-mode"]')?.closest('figure.studio-figure');
          const heading = [...editor.querySelectorAll('h2')].find((node) => node.textContent?.includes('Markdown 二级标题'));
          if (!editor || !sourceFigure || !heading) return null;
          const transfer = new DataTransfer();
          const targetRect = heading.getBoundingClientRect();
          sourceFigure.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          heading.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: targetRect.left + 12, clientY: targetRect.bottom - 1 }));
          const indicator = heading.getAttribute('data-wmb-drop-position');
          heading.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: targetRect.left + 12, clientY: targetRect.bottom - 1 }));
          sourceFigure.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
          const children = [...editor.children];
          return {
            draggable: sourceFigure.getAttribute('draggable'),
            indicator,
            sourceIndex: children.indexOf(sourceFigure),
            headingIndex: children.indexOf(heading)
          };
        });
        assert(dragResult?.draggable === 'true' && dragResult.indicator === 'after' && dragResult.sourceIndex === dragResult.headingIndex + 1, `图片拖动落点错误: ${JSON.stringify(dragResult)}`);
        await page.waitForSelector('.studio-inline-image-toolbar [data-action="move-up"]:not([disabled])');
        await page.click('.studio-inline-image-toolbar [data-action="move-up"]');
        await page.waitForFunction(() => {
          const editor = document.querySelector('#studio-body');
          const figure = document.querySelector('figure.studio-figure img[alt="source-mode"]')?.closest('figure.studio-figure');
          const heading = [...editor.querySelectorAll('h2')].find((node) => node.textContent?.includes('Markdown 二级标题'));
          return editor && figure && heading && [...editor.children].indexOf(figure) + 1 === [...editor.children].indexOf(heading);
        });
        await page.waitForSelector('.studio-inline-image-toolbar [data-action="move-down"]:not([disabled])');
        await page.click('.studio-inline-image-toolbar [data-action="move-down"]');
        await page.waitForFunction(() => {
          const editor = document.querySelector('#studio-body');
          const figure = document.querySelector('figure.studio-figure img[alt="source-mode"]')?.closest('figure.studio-figure');
          const heading = [...editor.querySelectorAll('h2')].find((node) => node.textContent?.includes('Markdown 二级标题'));
          return editor && figure && heading && [...editor.children].indexOf(figure) === [...editor.children].indexOf(heading) + 1;
        });
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-inline-image-drag-position' });
      });
      await step('保存重载后源码与两张图片保持一致', async () => {
        await switchToSourceEditor(page);
        const beforeSave = await page.inputValue('#studio-body-source');
        assert((beforeSave.match(/wmb-asset:\/\//g) ?? []).length === 2, `源码未读回两张图片 token: ${JSON.stringify(beforeSave)}`);
        assert(beforeSave.indexOf('## Markdown 二级标题') < beforeSave.indexOf('![source-mode](wmb-asset://'), `拖动后图片未位于标题下方: ${JSON.stringify(beforeSave)}`);
        await page.click('.studio-editor-top button.primary-button');
        await page.waitForFunction(() => document.querySelector('.studio-doc-state')?.textContent?.includes('已保存'), null, { timeout: 20_000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head), .studio-editor-view', { timeout: 20_000 });
        if (await page.locator('.studio-project-row:not(.head)').count()) await openProjectByName(page, 'E2E 创作项目 A');
        await switchToSourceEditor(page);
        const reloaded = await page.inputValue('#studio-body-source');
        assert((reloaded.match(/wmb-asset:\/\//g) ?? []).length === 2, `保存重载后图片 token 丢失: ${JSON.stringify(reloaded)}`);
        assert(reloaded.indexOf('## Markdown 二级标题') < reloaded.indexOf('![source-mode](wmb-asset://'), `保存重载后图片位置回退: ${JSON.stringify(reloaded)}`);
        const { db, close } = openDb();
        try {
          const persisted = db.prepare("SELECT cv.body FROM content_versions cv JOIN content_projects cp ON cp.id = cv.project_id WHERE cp.title = ? ORDER BY cv.version_number DESC LIMIT 1").get('E2E 创作项目 A')?.body ?? '';
          assert((persisted.match(/wmb-asset:\/\//g) ?? []).length === 2, `SQLite 最新正文未持久化两张图片: ${JSON.stringify(persisted)}`);
        } finally { close(); }
        const overflow = await page.evaluate(() => ({
          canvas: document.querySelector('.studio-canvas')?.scrollWidth - document.querySelector('.studio-canvas')?.clientWidth,
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth
        }));
        assert((overflow.canvas ?? 0) <= 1 && overflow.document <= 1, `1100 视口出现横向溢出: ${JSON.stringify(overflow)}`);
      });
      return { sourceModeRawEditable: true, sourceImageInserted: true, visualImageInserted: true, imageDragMoved: true, keyboardMoveFallback: true, persisted: true };
    }
  },
  {
    id: 'WMB-5307-pi-image-batch-composer',
    journeyIds: [],
    launch: { seedFixture: seedWithProject },
    run: async ({ page, app, evidence, artifactsDir, helpers, assert, openDb }) => {
      const step = (label, action) => helpers.step(evidence, label, action);
      await helpers.waitForAppReady(page);
      await step('进入有核心正文的 Studio 项目', async () => {
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 创作项目 A');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
      });
      await step('切换到本地黑洞 Pi 配置，避免真实 provider 副作用', async () => {
        await page.evaluate(() => window.wmb.savePiConfig({
          id: 'e2e',
          name: 'E2E 本地黑洞配置',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'gpt-5.4',
          api: 'openai-responses',
          thinking: 'off',
          contextWindow: 400000,
          maxTokens: 1024,
          apiKey: 'e2e-blackhole-key'
        }));
      });
      await step('拖入六张图片并显示有序预览', async () => {
        const payloads = Array.from({ length: 6 }, (_, index) => ({
          name: `drag-${index + 1}.png`,
          mimeType: 'image/png',
          base64: makeSeedPng(24 + index, 16 + index, 40 + index, 80 + index, 120 + index).toString('base64')
        }));
        await page.evaluate((items) => {
          const composer = document.querySelector('.pi-composer');
          if (!composer) throw new Error('Pi composer 不存在。');
          const transfer = new DataTransfer();
          for (const item of items) {
            const binary = atob(item.base64);
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            transfer.items.add(new File([bytes], item.name, { type: item.mimeType }));
          }
          composer.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }, payloads);
        await page.waitForFunction(() => document.querySelectorAll('.pi-image-queue-item').length === 6, null, { timeout: 20_000 });
        await page.waitForFunction(() => [...document.querySelectorAll('.pi-image-queue-item small')].length === 6 && [...document.querySelectorAll('.pi-image-queue-item small')].every((node) => !node.textContent?.includes('读取中')), null, { timeout: 20_000 });
        const labels = await page.$$eval('.pi-image-queue-item b', (nodes) => nodes.map((node) => node.textContent?.trim()));
        assert(labels.length === 6 && labels.every((label, index) => label?.includes(`${index + 1}. drag-${index + 1}.png`)), `拖拽图片顺序或预览错误: ${JSON.stringify(labels)}`);
      });
      await step('立即发送并在 Main IPC 数据库边界确认六个附件', async () => {
        const { db, close } = openDb();
        const projectId = db.prepare('SELECT id FROM content_projects WHERE title = ? LIMIT 1').get('E2E 创作项目 A')?.id;
        close();
        assert(typeof projectId === 'string' && projectId.length > 0, '未能读取 E2E 创作项目 ID。');
        await page.getByRole('button', { name: '发送' }).click();
        let observation = null;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const batches = await page.evaluate((id) => window.wmb.listPiImageBatches({ projectId: id, limit: 1 }), projectId);
          const batch = batches[0] ?? null;
          if (batch) {
            observation = { batch, attachments: batch.attachments };
            if (batch.status === 'failed_analysis' && batch.attachments.length === 6) break;
          }
          await helpers.delay(100);
        }
        assert(observation?.batch?.status === 'failed_analysis', `批量图片路径未进入预期分析失败: ${JSON.stringify(observation)}`);
        assert(observation.attachments.length === 6, `Main IPC 边界附件数量错误: ${JSON.stringify(observation)}`);
        assert(observation.attachments.every((item, index) => item.ordinal === index && item.sourceFileName === `drag-${index + 1}.png`), `Main IPC 边界附件顺序错误: ${JSON.stringify(observation.attachments)}`);
        await page.waitForFunction(() => document.querySelectorAll('.pi-image-queue-item').length === 6, null, { timeout: 20_000 });
        const retainedLabels = await page.$$eval('.pi-image-queue-item b', (nodes) => nodes.map((node) => node.textContent?.trim()));
        assert(retainedLabels.every((label, index) => label?.includes(`${index + 1}. drag-${index + 1}.png`)), `分析失败后待发送图片被静默清空: ${JSON.stringify(retainedLabels)}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'pi-image-batch-composer-six-send' });
      });
      return { dragged: true, sent: true, mainBatchSelected: true, attachmentCount: 6, retainedOnFailure: true, order: ['drag-1.png', 'drag-2.png', 'drag-3.png', 'drag-4.png', 'drag-5.png', 'drag-6.png'] };
    }
  },
  {
    id: 'WMB-5309-pi-composer-keyboard-history',
    journeyIds: [],
    launch: { seedFixture: seedWithProject },
    run: async ({ page, app, evidence, artifactsDir, helpers, assert }) => {
      const step = (label, action) => helpers.step(evidence, label, action);
      const mock = await startPiComposerMock();
      try {
        await helpers.waitForAppReady(page);
        await step('进入 Studio 项目并固定视口', async () => {
          await helpers.navigateTo(page, 'studio');
          await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
          await openProjectByName(page, 'E2E 创作项目 A');
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        });
        await step('切换到本地成功响应 Pi mock', async () => {
          await page.evaluate((baseUrl) => window.wmb.savePiConfig({
            id: 'e2e', name: 'E2E Pi history mock', baseUrl, model: 'gpt-5.4', api: 'openai-responses', thinking: 'off',
            contextWindow: 400000, maxTokens: 1024, apiKey: 'e2e-history-key'
          }), mock.baseUrl);
        });
        await page.waitForSelector('.pi-composer textarea', { timeout: 20_000 });
        const input = page.locator('.pi-composer textarea');
        const sendText = async (text) => {
          await input.fill(text);
          await page.waitForSelector('.pi-send-button[title="发送"]:not([disabled])', { timeout: 20_000 });
          await input.press('Enter');
          await page.waitForFunction((wanted) => [...document.querySelectorAll('.pi-bubble.user')].some((node) => node.textContent?.trim() === wanted), text, { timeout: 20_000 });
          await page.waitForSelector('.pi-send-button[title="发送"]', { timeout: 20_000 });
        };
        await step('发送两条成功文本并输入未发送草稿', async () => {
          await sendText('history-first');
          await sendText('history-second');
          await input.fill('draft-to-restore');
          await input.evaluate((node) => { node.focus(); node.setSelectionRange(0, 0); });
        });
        const recalledSequence = [];
        for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown']) {
          await input.press(key);
          recalledSequence.push(await input.inputValue());
        }
        const restoredDraft = await input.inputValue();
        assert(JSON.stringify(recalledSequence) === JSON.stringify(['history-second', 'history-first', 'history-second', 'draft-to-restore']), `历史召回顺序错误: ${JSON.stringify(recalledSequence)}`);
        assert(restoredDraft === 'draft-to-restore', `越过最新记录未恢复草稿: ${JSON.stringify({ restoredDraft })}`);
        const multilineValue = 'multiline first\nmultiline second';
        await step('多行编辑中非零偏移 ArrowUp 保持原生移动', async () => {
          await input.fill(multilineValue);
          await input.evaluate((node) => { node.focus(); node.setSelectionRange(node.value.length, node.value.length); });
        });
        const multilineBefore = await input.evaluate((node) => ({ value: node.value, caret: node.selectionStart ?? -1 }));
        await input.press('ArrowUp');
        const multilineAfter = await input.evaluate((node) => ({ value: node.value, caret: node.selectionStart ?? -1 }));
        const multilinePreservation = {
          valueBefore: multilineBefore.value,
          valueAfter: multilineAfter.value,
          caretBefore: multilineBefore.caret,
          caretAfter: multilineAfter.caret,
          nativeMovement: multilineAfter.value === multilineBefore.value && multilineAfter.caret < multilineBefore.caret
        };
        assert(multilinePreservation.nativeMovement, `多行 ArrowUp 被历史劫持: ${JSON.stringify(multilinePreservation)}`);
        let palettePrecedence = null;
        await step('命令面板上下键优先改变活动命令', async () => {
          await input.fill('/');
          await page.waitForFunction(() => document.querySelectorAll('.pi-command-options [role="option"]').length >= 2, null, { timeout: 20_000 });
          const paletteInitial = await input.getAttribute('aria-activedescendant');
          assert(paletteInitial, '命令面板未提供初始活动项');
          await input.press('ArrowDown');
          await page.waitForFunction((initial) => document.querySelector('.pi-composer textarea')?.getAttribute('aria-activedescendant') !== initial, paletteInitial, { timeout: 5_000 });
          const paletteAfterDown = await input.getAttribute('aria-activedescendant');
          const inputAfterDown = await input.inputValue();
          await input.press('ArrowUp');
          await page.waitForFunction((initial) => document.querySelector('.pi-composer textarea')?.getAttribute('aria-activedescendant') === initial, paletteInitial, { timeout: 5_000 });
          const paletteAfterUp = await input.getAttribute('aria-activedescendant');
          const inputAfterUp = await input.inputValue();
          palettePrecedence = { initialActive: paletteInitial, afterDown: paletteAfterDown, afterUp: paletteAfterUp, inputAfterDown, inputAfterUp };
          assert(paletteAfterDown !== paletteInitial && paletteAfterUp === paletteInitial && inputAfterDown === '/' && inputAfterUp === '/', `命令面板上下键未保持优先级: ${JSON.stringify(palettePrecedence)}`);
          await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'pi-composer-keyboard-history' });
        });
        return { recalledSequence, restoredDraft, multilinePreservation, palettePrecedence };
      } finally {
        await mock.close();
      }
    }
  },
  {
    id: 'WMB-5296-studio-research-auto-continue',
    journeyIds: [],
    launch: { seedFixture: seedStudioResearchGate },
    run: async ({ page, app, evidence, artifactsDir, helpers, assert, step, openDb }) => {
      await helpers.waitForAppReady(page);
      await step('历史待决研究缺口在启动时自动收窄并续派', async () => {
        await page.waitForTimeout(500);
        const { db, close } = openDb();
        try {
          const row = db.prepare("SELECT status, payload_json AS payloadJson FROM jobs WHERE kind='research_successor' ORDER BY created_at DESC LIMIT 1").get();
          const payload = JSON.parse(row.payloadJson);
          assert(payload.decision === 'narrow', `自动决策必须采用最保守的 narrow: ${JSON.stringify({ status: row.status, decision: payload.decision })}`);
          assert(['pending', 'running', 'succeeded', 'needs_user'].includes(row.status), `续派状态无效: ${row.status}`);
        } finally { close(); }
      });
      await step('Studio 不再要求用户处理内部研究路由', async () => {
        await helpers.navigateTo(page, 'studio');
        await page.waitForSelector('.studio-project-row:not(.head)', { timeout: 20_000 });
        await openProjectByName(page, 'E2E 研究续写项目');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(250);
        const state = await page.evaluate(() => ({
          gateRows: document.querySelectorAll('.studio-research-gate-row[data-successor]').length,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
        }));
        assert(state.gateRows === 0, `自动续派后不应显示待决门: ${JSON.stringify(state)}`);
        assert(state.overflowX === 0 && evidence.pageerrors.length === 0, `1100px Studio 应无横向溢出/page error: ${JSON.stringify({ state, pageerrors: evidence.pageerrors })}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'studio-research-auto-continue-1100' });
      });
      return { askedUser: false, decision: 'narrow', continued: true };
    }
  }
];
