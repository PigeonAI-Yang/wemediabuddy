// WMB-5244 Source 媒体 UI 合同 —— 共享契约纯函数 + 主进程投影 + renderer 媒体区块结构。
// 覆盖（聚焦，不跑项目级套件）：
// - 共享契约（src/shared/source-media.ts）：七态→六组映射、中文文案、
//   isPreservedMediaItem 真源判定（远程 URL 绝不为已保存）、buildSourceMediaCounts 3/5 口径、progress。
// - 主进程投影（src/main/source-media.ts）：store 记录 → UI 行/聚合（有效绑定才算 preserved；
//   已归档绑定不算；channel/图注/错误透传；revisionKey 与权威实现一致）。
// - renderer 区块（src/renderer/library-media.tsx，esbuild 打包 + react-dom/server 渲染）：
//   完整度「媒体 3/5 已保存」、六态可见、缩略图只指向 wmb-asset://（本地），
//   失败项错误+重试、已保存项查看原件、全局暂停 aria-pressed、空态引导、loading。
// 数据测试全部使用 production 函数/组件，不做源码字符串断言（结构断言走既有 esbuild harness 模式）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

const shared = await import('../src/shared/source-media.ts');
const mapper = await import('../src/main/source-media.ts');

// ---------------------------------------------------------------------------
// 共享契约：状态分组 / 文案 / preserved 真源 / 计数口径
// ---------------------------------------------------------------------------

test('WMB-5244 source media: status grouping maps 7 candidate states into 6 UI groups', () => {
  assert.equal(shared.sourceMediaStatusGroup('pending'), 'processing');
  assert.equal(shared.sourceMediaStatusGroup('downloading'), 'processing');
  assert.equal(shared.sourceMediaStatusGroup('preserved'), 'preserved');
  assert.equal(shared.sourceMediaStatusGroup('failed'), 'failed');
  assert.equal(shared.sourceMediaStatusGroup('needs_user'), 'needs_user');
  assert.equal(shared.sourceMediaStatusGroup('skipped_limit'), 'skipped');
  assert.equal(shared.sourceMediaStatusGroup('unsupported'), 'unsupported');
  assert.equal(shared.sourceMediaStatusGroup('bogus'), 'unsupported', '未知状态按不支持兜底，不伪造');
});

test('WMB-5244 source media: user-facing Chinese labels are stable (no engineering jargon)', () => {
  assert.equal(shared.sourceMediaStatusLabel('pending'), '待保存');
  assert.equal(shared.sourceMediaStatusLabel('downloading'), '保存中');
  assert.equal(shared.sourceMediaStatusLabel('preserved'), '已保存');
  assert.equal(shared.sourceMediaStatusLabel('failed'), '失败');
  assert.equal(shared.sourceMediaStatusLabel('needs_user'), '待处理');
  assert.equal(shared.sourceMediaStatusLabel('skipped_limit'), '超限');
  assert.equal(shared.sourceMediaStatusLabel('unsupported'), '不支持');
  assert.equal(shared.sourceMediaGroupLabel('processing'), '处理中');
  assert.equal(shared.sourceMediaGroupLabel('skipped'), '超限');
  assert.equal(shared.sourceMediaKindLabel('video'), '视频');
  assert.equal(shared.sourceMediaKindLabel('video_poster'), '视频封面');
  assert.equal(shared.sourceMediaKindLabel('image'), '图片');
  assert.equal(shared.sourceMediaChannelLabel('x_lists'), 'X');
  assert.equal(shared.sourceMediaChannelLabel('official_web'), '官网');
  assert.equal(shared.sourceMediaChannelLabel('research'), '研究');
});

test('WMB-5244 source media: isPreservedMediaItem requires preserved status AND local binding (remote URL never preserved)', () => {
  assert.equal(shared.isPreservedMediaItem({ status: 'preserved', assetId: 'asset1' }), true, 'preserved + 绑定 → 已保存');
  assert.equal(shared.isPreservedMediaItem({ status: 'preserved', assetId: null }), false, 'preserved 但无绑定 → 不是已保存');
  assert.equal(shared.isPreservedMediaItem({ status: 'preserved', assetId: '' }), false);
  assert.equal(shared.isPreservedMediaItem({ status: 'failed', assetId: null }), false);
  assert.equal(shared.isPreservedMediaItem({ status: 'downloading', assetId: null }), false);
  assert.equal(shared.isPreservedMediaItem({ status: 'needs_user', assetId: null }), false);
  assert.equal(shared.isPreservedMediaItem({ status: 'unsupported', assetId: null }), false);
  assert.equal(shared.isPreservedMediaItem({ status: 'skipped_limit', assetId: null }), false);
});

test('WMB-5244 source media: counts truthfully render incomplete 3/5 and progress text', () => {
  const items = [
    { status: 'preserved', assetId: 'a1' },
    { status: 'preserved', assetId: 'a2' },
    { status: 'preserved', assetId: 'a3' },
    { status: 'downloading', assetId: null },
    { status: 'failed', assetId: null }
  ];
  const counts = shared.buildSourceMediaCounts(items);
  assert.deepEqual(counts, {
    total: 5, preserved: 3, processing: 1, failed: 1, needsUser: 0, skippedLimit: 0, unsupported: 0
  });
  assert.equal(shared.sourceMediaProgress(counts), '3/5');
  const allStates = [
    { status: 'preserved', assetId: 'x' },
    { status: 'pending', assetId: null },
    { status: 'downloading', assetId: null },
    { status: 'failed', assetId: null },
    { status: 'needs_user', assetId: null },
    { status: 'skipped_limit', assetId: null },
    { status: 'unsupported', assetId: null }
  ];
  assert.deepEqual(shared.buildSourceMediaCounts(allStates), {
    total: 7, preserved: 1, processing: 2, failed: 1, needsUser: 1, skippedLimit: 1, unsupported: 1
  });
});

// ---------------------------------------------------------------------------
// 主进程投影：store 记录 → UI 行 / 聚合
// ---------------------------------------------------------------------------

function candidate(id, kind, ordinal, status, extra = {}) {
  return {
    id,
    sourceId: 'src1',
    sourceRevisionKey: 'source:src1:r5',
    kind,
    originalUrl: `https://example.com/${id}.jpg`,
    stableRemoteIdentity: '',
    channel: 'x_lists',
    postKind: null,
    parentCandidateId: null,
    postOrdinal: null,
    ordinalInPost: null,
    ordinal,
    captionHint: null,
    surroundingText: null,
    status,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    maxAttempts: 3,
    retryAfter: null,
    requestId: 'req-1',
    discoveredAt: '2026-08-14T00:00:00.000Z',
    archivedAt: null,
    ...extra
  };
}

function binding(candidateId, assetId, extra = {}) {
  return {
    id: `sbm:${candidateId}`,
    sourceId: 'src1',
    sourceRevisionKey: 'source:src1:r5',
    candidateId,
    assetId,
    kind: 'image',
    ordinal: 0,
    originalUrl: '',
    caption: null,
    sha256: 'aa',
    capturedAt: '2026-08-14T00:00:00.000Z',
    rightsStatus: 'unknown',
    riskFlagsJson: '[]',
    createdAt: '2026-08-14T00:00:00.000Z',
    createdBy: 'archive_worker',
    archivedAt: null,
    archivedReason: null,
    ...extra
  };
}

test('WMB-5244 source media: compose maps store records to UI items with truthful preserved/asset info', () => {
  const candidates = [
    candidate('c1', 'image', 0, 'preserved'),
    candidate('c2', 'video', 1, 'downloading'),
    candidate('c3', 'image', 2, 'failed', { errorCode: 'DOWNLOAD_TIMEOUT', errorMessage: '连接超时', attemptCount: 3 }),
    candidate('c4', 'image', 3, 'needs_user', { errorMessage: '文件超过大小限制' }),
    candidate('c5', 'image', 4, 'skipped_limit'),
    candidate('c6', 'video_poster', 5, 'unsupported')
  ];
  const bindings = [
    binding('c1', 'asset1', { kind: 'image' })
  ];
  const assetsById = new Map([
    ['asset1', { id: 'asset1', mimeType: 'image/jpeg', byteCount: 4096, width: 640, height: 480, durationMs: null }]
  ]);
  const overview = mapper.composeSourceMediaOverview({
    sourceId: 'src1',
    revision: 5,
    revisionKey: 'source:src1:r5',
    candidates,
    bindings,
    assetsById,
    globalPaused: false
  });
  assert.equal(overview.revisionKey, 'source:src1:r5');
  assert.equal(overview.counts.total, 6);
  assert.equal(overview.counts.preserved, 1);
  assert.equal(overview.counts.processing, 1);
  assert.equal(overview.counts.failed, 1);
  assert.equal(overview.counts.needsUser, 1);
  assert.equal(overview.counts.skippedLimit, 1);
  assert.equal(overview.counts.unsupported, 1);

  const [item1] = overview.items;
  assert.equal(item1.status, 'preserved');
  assert.equal(item1.assetId, 'asset1');
  assert.equal(item1.asset.byteCount, 4096);
  assert.equal(item1.asset.mimeType, 'image/jpeg');
  assert.equal(item1.asset.width, 640);
  assert.equal(item1.channel, 'x_lists');
  assert.equal(item1.originalUrl, 'https://example.com/c1.jpg');

  const failed = overview.items.find((item) => item.id === 'c3');
  assert.equal(failed.assetId, null, '失败候选绝无本地资产');
  assert.equal(failed.asset, null);
  assert.equal(failed.errorCode, 'DOWNLOAD_TIMEOUT');
  assert.equal(failed.errorMessage, '连接超时');
  assert.equal(failed.attemptCount, 3);

  const downloading = overview.items.find((item) => item.id === 'c2');
  assert.equal(downloading.assetId, null);
  assert.equal(downloading.kind, 'video');
});

test('WMB-5244 source media: archived binding does not count as preserved (truthfulness)', () => {
  const candidates = [candidate('c1', 'image', 0, 'preserved')];
  const bindings = [binding('c1', 'asset1', { archivedAt: '2026-08-14T01:00:00.000Z', archivedReason: 'source_archived' })];
  const overview = mapper.composeSourceMediaOverview({
    sourceId: 'src1', revision: 5, revisionKey: 'source:src1:r5', candidates, bindings,
    assetsById: new Map([['asset1', { id: 'asset1', mimeType: 'image/png', byteCount: 1, width: null, height: null, durationMs: null }]]),
    globalPaused: true
  });
  const [item] = overview.items;
  assert.equal(item.assetId, null, '已归档绑定不呈现为已保存');
  assert.equal(overview.counts.preserved, 0);
  assert.equal(overview.globalPaused, true, '全局暂停透传');
});

test('WMB-5244 source media: caption prefers binding caption over discovery hint; mapSourceMediaItem is pure', () => {
  const c = candidate('c1', 'image', 0, 'preserved', { captionHint: '发现图注' });
  const b = binding('c1', 'asset1', { caption: '绑定图注' });
  const item = mapper.mapSourceMediaItem(c, b, null);
  assert.equal(item.captionHint, '绑定图注');
  assert.equal(item.assetId, 'asset1');
  assert.equal(item.asset, null, '无 asset 记录时不伪造资产信息');
  const itemNoBinding = mapper.mapSourceMediaItem(c, null, null);
  assert.equal(itemNoBinding.assetId, null);
  assert.equal(itemNoBinding.captionHint, '发现图注');
});

// ---------------------------------------------------------------------------
// renderer：媒体区块结构合同（esbuild 打包 production 组件 + react-dom/server 渲染）
// ---------------------------------------------------------------------------

let component;
let createElement;
let renderToStaticMarkup;
let harnessDir;

test.before(async () => {
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'tmp', 'wmb-5244-ui-harness-'));
  harnessDir = dir;
  const out = path.join(dir, 'library-media.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/library-media.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    logLevel: 'silent'
  });
  component = await import(pathToFileURL(out).href);
  ({ createElement } = await import('react'));
  ({ renderToStaticMarkup } = await import('react-dom/server'));
});

test.after(async () => {
  if (harnessDir) {
    await rm(harnessDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    harnessDir = null;
  }
});

const noop = () => {};

function overviewFixture() {
  return {
    sourceId: 'src1',
    revision: 5,
    revisionKey: 'source:src1:r5',
    counts: { total: 5, preserved: 3, processing: 1, failed: 1, needsUser: 0, skippedLimit: 0, unsupported: 0 },
    items: [
      {
        id: 'c1', kind: 'image', ordinal: 0, channel: 'x_lists', originalUrl: 'https://example.com/a.png',
        captionHint: null, status: 'preserved', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3,
        assetId: 'asset1', asset: { id: 'asset1', mimeType: 'image/png', byteCount: 2048, width: 100, height: 80, durationMs: null }
      },
      {
        id: 'c2', kind: 'image', ordinal: 1, channel: 'x_lists', originalUrl: 'https://example.com/b.png',
        captionHint: null, status: 'preserved', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3,
        assetId: 'asset2', asset: { id: 'asset2', mimeType: 'image/png', byteCount: 4096, width: 200, height: 150, durationMs: null }
      },
      {
        id: 'c3', kind: 'video', ordinal: 2, channel: 'official_web', originalUrl: 'https://example.com/v.mp4',
        captionHint: null, status: 'preserved', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3,
        assetId: 'asset3', asset: { id: 'asset3', mimeType: 'video/mp4', byteCount: 1048576, width: 640, height: 360, durationMs: 125000 }
      },
      {
        id: 'c4', kind: 'image', ordinal: 3, channel: 'x_lists', originalUrl: 'https://example.com/d.png',
        captionHint: null, status: 'downloading', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3,
        assetId: null, asset: null
      },
      {
        id: 'c5', kind: 'image', ordinal: 4, channel: 'x_lists', originalUrl: 'https://example.com/e.png',
        captionHint: null, status: 'failed', errorCode: 'DOWNLOAD_TIMEOUT', errorMessage: '下载超时，请重试', attemptCount: 3, maxAttempts: 3,
        assetId: null, asset: null
      }
    ],
    globalPaused: false
  };
}

const render = (props) => renderToStaticMarkup(createElement(component.SourceMediaSection, props));

test('WMB-5244 source media: renders incomplete 3/5 summary, kind totals and all visible states', () => {
  const html = render({ overview: overviewFixture(), loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(html, /媒体 3\/5 已保存/, '完整度必须如实显示 3/5');
  assert.match(html, /图片 4 · 视频 1/, '按类型计数（4 图 1 视频）');
  assert.match(html, /已保存 3/, '状态分布计数');
  assert.match(html, /处理中 1/);
  assert.match(html, /失败 1/);
  assert.match(html, /保存中/, '下载中状态文案');
  assert.match(html, /失败/, '失败状态文案');
  assert.match(html, /下载超时，请重试/, '失败错误信息可见');
});

test('WMB-5244 source media: preserved images and videos render inline from local assets', () => {
  const html = render({ overview: overviewFixture(), loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(html, /<div class="library-media-viewer count-3"/);
  assert.match(html, /<img[^>]*class="library-media-image"[^>]*src="wmb-asset:\/\/asset1"/);
  assert.match(html, /<img[^>]*class="library-media-image"[^>]*src="wmb-asset:\/\/asset2"/);
  assert.match(html, /<video[^>]*class="library-media-video"[^>]*src="wmb-asset:\/\/asset3"/);
  assert.match(html, /<video[^>]*controls=""/);
  assert.match(html, /<video[^>]*playsInline=""|<video[^>]*playsinline=""/);
  assert.doesNotMatch(html, /<(?:img|video)[^>]*src="https?:\/\//, '预览不得回退远程 URL');
  assert.equal((html.match(/打开原件/g) ?? []).length, 3, '每个可预览原件保留打开动作');
  assert.match(html, /<details class="library-media-management">/, '保存状态默认退到折叠区');
});

test('WMB-5244 source media: failed item gets 重试 action; non-preserved items never offer 查看原件', () => {
  const html = render({ overview: overviewFixture(), loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.equal((html.match(/aria-label="重试/g) ?? []).length, 1, '仅失败候选提供重试');
  assert.match(html, /aria-label="重试图片 5"/, '重试按钮带可访问名称');
  // 失败项（c5）必须渲染原始 URL 作为来源文字（title 属性），但不得渲染为已保存形态
  assert.match(html, /title="https:\/\/example\.com\/e\.png"/, '来源 URL 保留为溯源');
  // 未保存项数量 = 总数 - 已保存 = 2（c4 下载中 + c5 失败），均无查看原件
  const originText = html.match(/library-media-origin"[^>]*>/g) ?? [];
  assert.equal(originText.length, 5, '每项都有来源');
});

test('WMB-5244 source media: all six state groups render user-facing labels', () => {
  const counts = { total: 7, preserved: 1, processing: 2, failed: 1, needsUser: 1, skippedLimit: 1, unsupported: 1 };
  const items = [
    { id: 'a', kind: 'image', ordinal: 0, channel: 'x_lists', originalUrl: 'https://e.com/a', captionHint: null, status: 'preserved', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3, assetId: 'assetA', asset: { id: 'assetA', mimeType: 'image/png', byteCount: 1, width: 1, height: 1, durationMs: null } },
    { id: 'b', kind: 'image', ordinal: 1, channel: 'x_lists', originalUrl: 'https://e.com/b', captionHint: null, status: 'pending', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3, assetId: null, asset: null },
    { id: 'c', kind: 'image', ordinal: 2, channel: 'x_lists', originalUrl: 'https://e.com/c', captionHint: null, status: 'downloading', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3, assetId: null, asset: null },
    { id: 'd', kind: 'image', ordinal: 3, channel: 'x_lists', originalUrl: 'https://e.com/d', captionHint: null, status: 'failed', errorCode: null, errorMessage: '错误', attemptCount: 1, maxAttempts: 3, assetId: null, asset: null },
    { id: 'e', kind: 'image', ordinal: 4, channel: 'x_lists', originalUrl: 'https://e.com/e', captionHint: null, status: 'needs_user', errorCode: null, errorMessage: '需要登录', attemptCount: 0, maxAttempts: 3, assetId: null, asset: null },
    { id: 'f', kind: 'image', ordinal: 5, channel: 'x_lists', originalUrl: 'https://e.com/f', captionHint: null, status: 'skipped_limit', errorCode: null, errorMessage: null, attemptCount: 0, maxAttempts: 3, assetId: null, asset: null },
    { id: 'g', kind: 'video', ordinal: 6, channel: 'x_lists', originalUrl: 'https://e.com/g', captionHint: null, status: 'unsupported', errorCode: 'UNSUPPORTED_STREAM', errorMessage: '暂不支持该流格式', attemptCount: 0, maxAttempts: 3, assetId: null, asset: null }
  ];
  const overview = { sourceId: 'src1', revision: 1, revisionKey: 'source:src1:r1', counts, items, globalPaused: false };
  const html = render({ overview, loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  for (const label of ['已保存', '待保存', '保存中', '失败', '待处理', '超限', '不支持']) {
    assert.match(html, new RegExp(label), `状态文案必须渲染：${label}`);
  }
  assert.match(html, /需要登录/, '待处理错误信息');
  assert.match(html, /暂不支持该流格式/, '不支持错误信息');
  assert.equal((html.match(/aria-label="重试/g) ?? []).length, 1, 'needs_user/unsupported/skipped 不提供重试（worker 仅接受 failed）');
});

test('WMB-5244 source media: global pause toggle is accessible inside media management', () => {
  const pausedHtml = render({ overview: { ...overviewFixture(), globalPaused: true }, loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(pausedHtml, /aria-pressed="true"/);
  assert.match(pausedHtml, /恢复自动保存/);
  assert.match(pausedHtml, /媒体自动保存已暂停/);
  const runningHtml = render({ overview: overviewFixture(), loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(runningHtml, /aria-pressed="false"/);
  assert.match(runningHtml, /暂停自动保存/);
  assert.doesNotMatch(runningHtml, /媒体自动保存已暂停/);
});

test('WMB-5244 source media: empty overview stays concise and keeps pause control', () => {
  const empty = { sourceId: 'src1', revision: 5, revisionKey: 'source:src1:r5', counts: { total: 0, preserved: 0, processing: 0, failed: 0, needsUser: 0, skippedLimit: 0, unsupported: 0 }, items: [], globalPaused: false };
  const emptyHtml = render({ overview: empty, loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(emptyHtml, /此资料暂无可保存的图片或视频/);
  assert.doesNotMatch(emptyHtml, /library-media-list/, '空态不渲染媒体列表');
  assert.match(emptyHtml, /暂停媒体自动保存/, '暂停控制始终可用');

  const loadingHtml = render({ overview: null, loading: true, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(loadingHtml, /正在读取媒体/);
  const errorHtml = render({ overview: null, loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(errorHtml, /暂时无法读取媒体状态/);
});

test('WMB-5244 source media: list is a semantic list (role=list/listitem) for accessibility', () => {
  const html = render({ overview: overviewFixture(), loading: false, busy: null, onRetry: noop, onTogglePause: noop, onOpenOriginal: noop });
  assert.match(html, /role="list"/);
  assert.equal((html.match(/class="library-media-item"/g) ?? []).length, 5, '每项一个媒体行');
  assert.match(html, /role="list" aria-label="媒体列表/);
});

test('WMB-5244 source media: busy state disables the retry button for the in-flight candidate', () => {
  const html = render({
    overview: overviewFixture(),
    loading: false,
    busy: { action: 'retry', candidateId: 'c5' },
    onRetry: noop,
    onTogglePause: noop,
    onOpenOriginal: noop
  });
  assert.match(html, /disabled=""/, '重试进行中按钮禁用');
});
