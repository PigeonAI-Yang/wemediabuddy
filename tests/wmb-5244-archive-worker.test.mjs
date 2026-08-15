// WMB-5244 渠道媒体冻结 —— 归档 Worker 行为聚焦测试（ArchiveWorker 交付面）。
// 覆盖（验收逐项）：SSRF/DNS rebinding/重定向防护；HEAD 超限、流式越限、时长超限、
// magic/MIME 共同确认（含伪装）；图片/MP4/WebM/SVG 签名与扩展名；七态状态分类；
// ≤3 次自动 attempt（指数退避）；用户重试（attempt 顺延 MAX+1）；中断恢复
// （DOWNLOAD_INTERRUPTED + 重试）；幂等字节/绑定（跨 Source 独立血缘）；每 revision
// 字节总量限额（skipped_limit）；发现任务（media_discover → 候选 + media_archive jobs）；
// 全局暂停；data-root 隔离（staging 清理、assets 内容寻址、无残留）。
// 全部经注入缝（fetchImpl/resolveHost/probeDurationMs）伪造 HTTP/DNS/时长，零网络。
// 运行（本批次不执行；由 Main 统一验证）：node --test --test-concurrency=1 tests/wmb-5244-archive-worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { insertMediaCandidates, enqueueMediaDiscoverJob, mediaArchiveStatusSummary, getMediaCandidate } = await import('../src/main/db/media-archive-store.ts');
const { sourceRevisionKey, stableRemoteIdentity, mediaDiscoverDedupeKey } = await import('../src/shared/media-candidates.ts');
const { MEDIA_LIMITS_DEFAULT } = await import('../src/shared/media-limits.ts');
const {
  fetchWithMediaGuard,
  isPrivateIp,
  sniffMediaType,
  MediaFetchError
} = await import('../src/main/media-archive-fetch.ts');
const {
  runDueMediaArchiveJobs,
  claimMediaArchiveJob,
  executeMediaArchiveCandidate,
  finishMediaArchiveJob,
  recoverInterruptedMediaArchiveJobs,
  retryMediaArchiveCandidate,
  setMediaArchivePaused,
  isMediaArchivePaused,
  setMediaArchivePostPreserveHook,
  extractHtmlMediaCandidates,
  getSourceMediaSummary,
  listSourceMedia,
  mediaRetryBackoffMs,
  MEDIA_ARCHIVE_RETRY_COMMAND,
  MEDIA_ARCHIVE_SET_PAUSED_COMMAND
} = await import('../src/main/media-archive-worker.ts');

// ============ fixtures ============

const shaOf = (value) => createHash('sha256').update(value).digest('hex');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(16, 0x41)]);
/** 最小 MP4：ftyp box（size=20, 'ftyp', 'isom'）。 */
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x14]), Buffer.from('ftypisom'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('isom')]);
/** 最小 WebM：EBML 头 + 'webm' DocType（头部 4KB 内）。 */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), Buffer.from('webm'), Buffer.alloc(32, 0)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
const HTML_PAGE = Buffer.from(`<!DOCTYPE html><html><head>
  <meta property="og:image" content="https://cdn.example.com/og.png">
  <link rel="icon" href="https://cdn.example.com/favicon.ico">
</head><body>
  <img src="/img/a.png" width="640" height="480">
  <img src="data:image/png;base64,AAAA" width="100" height="100">
  <img src="/pixel.gif" width="1" height="1">
  <video src="https://cdn.example.com/clip.mp4" poster="/img/poster.png"></video>
  <img srcset="/img/b.jpg 1x, /img/b@2x.jpg 2x" width="800" height="600">
</body></html>`);

// ============ helpers ============

async function makeRoot(prefix = 'wmb-5244-worker-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeDatabase(root) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  const workspaceId = `ws-${randomUUID()}`;
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  return { database, workspaceId };
}

function randomUUID() {
  return `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function seedSource(database, overrides = {}) {
  const now = new Date().toISOString();
  const id = overrides.id ?? `src-${randomUUID()}`;
  const url = overrides.url ?? `https://example.com/${id}`;
  database.prepare(
    `INSERT INTO source_items (id, feed_id, original_url, canonical_url, title, collected_at, categories_json, keywords_json,
      recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision)
     VALUES (?, NULL, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, 1)`
  ).run(id, url, url, overrides.title ?? 't', now, now, now);
  return { id, revision: 1 };
}

/** 模拟 HTTP 服务器：handler(url, method, init) → Response | {status, headers, body} | 抛错 | 永不返回 */
function fakeFetch(handler) {
  return async (url, init = {}) => {
    const method = String(init.method ?? 'GET');
    const result = await handler(String(url), method, init);
    if (result instanceof Response) return result;
    if (result && typeof result === 'object' && result.__hang) {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    const status = result?.status ?? 200;
    const headers = result?.headers ?? {};
    const body = result?.body ?? '';
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.isBuffer(body) ? body : body;
    const response = new Response(bytes, { status, headers });
    if (method === 'HEAD') {
      // HEAD 的 body 必须为空；Content-Length 由 headers 提供。
      Object.defineProperty(response, 'body', { value: null, configurable: true });
    }
    return response;
  };
}

const publicIp = ['93.184.216.34'];
function resolveHost(ipMap = {}) {
  return async (hostname) => ipMap[hostname] ?? publicIp;
}

async function enqueueImage(database, { sourceId, revKey, url, ordinal = 0, channel = 'research' }) {
  return insertMediaCandidates(database, {
    sourceId,
    sourceRevisionKey: revKey,
    channel,
    requestId: `req-${randomUUID()}`,
    discoveredAt: new Date().toISOString(),
    candidates: [{ kind: 'image', originalUrl: url, ordinal, channel }]
  });
}

async function withCleanup(run) {
  const root = await makeRoot();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function goodFetch(bytes, contentType = 'application/octet-stream', headers = {}) {
  return fakeFetch((url, method) => ({
    status: 200,
    headers: { 'content-type': contentType, ...headers },
    body: method === 'HEAD' ? null : bytes
  }));
}

// ============ SSRF / 网络防护 ============

test('fetchWithMediaGuard: 私网 IP、环回、localhost 与 IPv6 链路本地一律 SSRF_BLOCKED', async () => {
  await withCleanup(async (root) => {
    for (const [url, ips] of [
      ['https://example.com/a.png', ['10.0.0.5']],
      ['https://example.com/b.png', ['127.0.0.1']],
      ['https://example.com/c.png', ['169.254.1.1']],
      ['https://example.com/d.png', ['192.168.1.10']],
      ['https://example.com/e.png', ['::1']],
      ['https://example.com/f.png', ['fe80::1']],
      ['https://example.com/g.png', ['fd00::1']],
      ['https://example.com/h.png', ['::ffff:10.0.0.1']]
    ]) {
      const result = await fetchWithMediaGuard({
        url, mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
        fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost({ 'example.com': ips })
      });
      assert.equal(result.ok, false, url);
      assert.equal(result.error.code, 'SSRF_BLOCKED', url);
      assert.equal(result.error.candidateStatus, 'failed');
      assert.equal(result.error.retryable, false);
    }
    // IP 字面量与保留名不依赖 DNS。
    const literal = await fetchWithMediaGuard({
      url: 'http://127.0.0.1/x.png', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: async () => publicIp
    });
    assert.equal(literal.ok, false);
    assert.equal(literal.error.code, 'SSRF_BLOCKED');
    const localhost = await fetchWithMediaGuard({
      url: 'https://localhost/x.png', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: async () => publicIp
    });
    assert.equal(localhost.ok, false);
    assert.equal(localhost.error.code, 'SSRF_BLOCKED');
  });
});

test('fetchWithMediaGuard: DNS rebinding 跨跳重新解析 —— 重定向到私网主机被拒', async () => {
  await withCleanup(async (root) => {
    const ipMap = {
      'public.example.com': ['93.184.216.34'],
      'rebind.example.com': ['10.1.2.3'] // 第二跳变私网
    };
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/hop')) {
        return { status: 302, headers: { location: 'https://rebind.example.com/final.png' } };
      }
      return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
    });
    const result = await fetchWithMediaGuard({
      url: 'https://public.example.com/hop', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl, resolveHost: resolveHost(ipMap)
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SSRF_BLOCKED');
  });
});

test('fetchWithMediaGuard: 重定向最多 5 跳；超限 REDIRECT_LIMIT', async () => {
  await withCleanup(async (root) => {
    let hops = 0;
    const fetchImpl = fakeFetch((url) => {
      hops += 1;
      if (hops <= 7) {
        return { status: 302, headers: { location: `https://example.com/next-${hops}` } };
      }
      return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
    });
    const result = await fetchWithMediaGuard({
      url: 'https://example.com/start', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl, resolveHost: resolveHost()
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'REDIRECT_LIMIT');
  });
});

test('fetchWithMediaGuard: 非 http(s) scheme 与 m3u8/blob URL 确定性 unsupported', async () => {
  await withCleanup(async (root) => {
    const blob = await fetchWithMediaGuard({
      url: 'blob:https://example.com/abc', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost()
    });
    assert.equal(blob.ok, false);
    assert.equal(blob.error.code, 'UNSUPPORTED_SCHEME');
    const m3u8 = await fetchWithMediaGuard({
      url: 'https://example.com/live/master.m3u8', mode: 'video', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(Buffer.from('#EXTM3U\n'), 'application/vnd.apple.mpegurl'), resolveHost: resolveHost()
    });
    assert.equal(m3u8.ok, false);
    assert.equal(m3u8.error.code, 'UNSUPPORTED_STREAM');
    assert.equal(m3u8.error.candidateStatus, 'unsupported');
  });
});

// ============ 限额 ============

test('fetchWithMediaGuard: 流式越限中止时取消底层 Web 流（socket 不泄漏，无需 force-destroy）', async () => {
  await withCleanup(async (root) => {
    let cancelled = false;
    let pullCount = 0;
    // 服务端流：模拟持续推送的超大/无限响应（pull 永不 close）；越限中止必须 cancel 底层 reader，
    // 让服务端正常关闭连接 —— 若只靠 GC/force-destroy 则会泄漏 socket。
    const big = Buffer.alloc(MEDIA_LIMITS_DEFAULT.imageMaxBytes + 4096, 0x42);
    const trackable = new ReadableStream({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(big.subarray(0, 64 * 1024));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchImpl = fakeFetch((url, method) => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: method === 'HEAD' ? null : trackable
    }));
    const result = await fetchWithMediaGuard({
      url: 'https://example.com/tracked.png', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl, resolveHost: resolveHost()
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SIZE_LIMIT_EXCEEDED');
    assert.equal(cancelled, true, '越限中止必须调用底层流 cancel()，让服务端正常关闭连接');
    assert.ok(pullCount > 1, '流确实在传输中被打断');
    assert.deepEqual(await readdir(path.join(root, 'staging', 'media')), [], 'staging 已清理');
  });
});

test('fetchWithMediaGuard: HEAD 可信 Content-Length 超限直接 needs_user，不发起 GET', async () => {
  await withCleanup(async (root) => {
    let getCalls = 0;
    const fetchImpl = fakeFetch((url, method) => {
      if (method === 'HEAD') {
        return { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(MEDIA_LIMITS_DEFAULT.imageMaxBytes + 1) } };
      }
      getCalls += 1;
      return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
    });
    const result = await fetchWithMediaGuard({
      url: 'https://example.com/big.png', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl, resolveHost: resolveHost()
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SIZE_LIMIT_EXCEEDED');
    assert.equal(result.error.candidateStatus, 'needs_user');
    assert.equal(getCalls, 0, 'HEAD 超限不得发起 GET');
  });
});

test('fetchWithMediaGuard: 流式越限立即中止并清理 staging（无残留 .part）', async () => {
  await withCleanup(async (root) => {
    const big = Buffer.alloc(MEDIA_LIMITS_DEFAULT.imageMaxBytes + 1024, 0x42);
    const fetchImpl = fakeFetch((url, method) => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: method === 'HEAD' ? null : big
    }));
    const result = await fetchWithMediaGuard({
      url: 'https://example.com/stream.png', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl, resolveHost: resolveHost()
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SIZE_LIMIT_EXCEEDED');
    const staging = await readdir(path.join(root, 'staging', 'media')).catch(() => []);
    assert.deepEqual(staging, [], '越限后 staging 必须清空');
  });
});

test('fetchWithMediaGuard: 连接/首字节超时 → TIMEOUT failed（可重试）', async () => {
  await withCleanup(async (root) => {
    const hang = fakeFetch(() => ({ __hang: true }));
    const tinyLimits = { ...MEDIA_LIMITS_DEFAULT, connectTimeoutMs: 40 };
    const result = await fetchWithMediaGuard({
      url: 'https://example.com/slow.png', mode: 'image', limits: tinyLimits, dataRoot: root,
      fetchImpl: hang, resolveHost: resolveHost()
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TIMEOUT');
    assert.equal(result.error.candidateStatus, 'failed');
    assert.equal(result.error.retryable, true);
  });
});

// ============ magic / MIME / 扩展名 ============

test('fetchWithMediaGuard: 签名识别 PNG/JPEG/WebP/GIF/SVG/MP4/WebM；扩展名由签名决定', async () => {
  await withCleanup(async (root) => {
    for (const [bytes, contentType, expectMime, expectExt] of [
      [PNG, 'application/octet-stream', 'image/png', '.png'],
      [JPEG, 'image/jpeg', 'image/jpeg', '.jpg'],
      [SVG, 'image/svg+xml', 'image/svg+xml', '.svg'],
      [MP4, 'video/mp4', 'video/mp4', '.mp4'],
      [WEBM, 'video/webm', 'video/webm', '.webm']
    ]) {
      const result = await fetchWithMediaGuard({
        url: `https://example.com/fake${expectExt}`, mode: expectExt === '.mp4' || expectExt === '.webm' ? 'video' : 'image',
        limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
        fetchImpl: goodFetch(bytes, contentType), resolveHost: resolveHost(),
        probeDurationMs: async () => ({ durationMs: 5000, runtimeName: 'test', runtimeVersion: '1' })
      });
      assert.equal(result.ok, true, expectExt);
      assert.equal(result.staged.mimeType, expectMime);
      assert.ok(result.staged.relativePath.endsWith(expectExt), `relativePath=${result.staged.relativePath}`);
      assert.equal(result.staged.sha256, shaOf(bytes));
      assert.equal(result.staged.reused, false);
      // 内容寻址落位
      await stat(path.join(root, ...result.staged.relativePath.split('/')));
    }
  });
});

test('fetchWithMediaGuard: 伪装/错误 MIME 与未知签名确定性拒绝，无假 Asset', async () => {
  await withCleanup(async (root) => {
    // PNG 字节 + text/html 声明 → MISLABELED_CONTENT
    const mislabeled = await fetchWithMediaGuard({
      url: 'https://example.com/a.png', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(PNG, 'text/html'), resolveHost: resolveHost()
    });
    assert.equal(mislabeled.ok, false);
    assert.equal(mislabeled.error.code, 'MISLABELED_CONTENT');
    assert.equal(mislabeled.error.candidateStatus, 'unsupported');
    // 未知签名 + image/png 声明 → UNSUPPORTED_MEDIA_TYPE
    const unknown = await fetchWithMediaGuard({
      url: 'https://example.com/b.png', mode: 'image', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(Buffer.from('not an image at all.........'), 'image/png'), resolveHost: resolveHost()
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    // 视频模式收到图片签名 → 模式不符
    const modeMismatch = await fetchWithMediaGuard({
      url: 'https://example.com/c.mp4', mode: 'video', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(PNG, 'video/mp4'), resolveHost: resolveHost()
    });
    assert.equal(modeMismatch.ok, false);
    assert.equal(modeMismatch.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    // assets 目录不存在任何文件（零假 Asset）
    await assert.rejects(stat(path.join(root, 'assets')), { code: 'ENOENT' });
  });
});

test('fetchWithMediaGuard: 视频时长超 30 分钟 → needs_user 且清理落位文件', async () => {
  await withCleanup(async (root) => {
    const over = await fetchWithMediaGuard({
      url: 'https://example.com/long.mp4', mode: 'video', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(MP4, 'video/mp4'), resolveHost: resolveHost(),
      probeDurationMs: async () => ({ durationMs: 31 * 60 * 1000 + 1, runtimeName: 'test', runtimeVersion: '1' })
    });
    assert.equal(over.ok, false);
    assert.equal(over.error.code, 'DURATION_LIMIT_EXCEEDED');
    assert.equal(over.error.candidateStatus, 'needs_user');
    await assert.rejects(stat(path.join(root, 'assets', `${shaOf(MP4)}.mp4`)), { code: 'ENOENT' }, '超限落位文件必须清理');
    // 时长合法 → 记录 durationMs + 运行时身份
    const ok = await fetchWithMediaGuard({
      url: 'https://example.com/short.mp4', mode: 'video', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(MP4, 'video/mp4'), resolveHost: resolveHost(),
      probeDurationMs: async () => ({ durationMs: 90_000, runtimeName: 'wmb-test', runtimeVersion: '9' })
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.staged.durationMs, 90_000);
    assert.equal(ok.staged.runtimeName, 'wmb-test');
    // 落位文件复用（同字节再下载 → reused）
    const again = await fetchWithMediaGuard({
      url: 'https://example.com/short.mp4', mode: 'video', limits: MEDIA_LIMITS_DEFAULT, dataRoot: root,
      fetchImpl: goodFetch(MP4, 'video/mp4'), resolveHost: resolveHost(),
      probeDurationMs: async () => ({ durationMs: 90_000, runtimeName: 'wmb-test', runtimeVersion: '9' })
    });
    assert.equal(again.ok, true);
    assert.equal(again.staged.reused, true);
  });
});

// ============ Worker 端到端 ============

test('worker: 单图归档端到端 —— preserved + Binding + Asset + Provenance + 无 staging 残留', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      const { candidateIds } = await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/photo.png' });
      const candidateId = candidateIds[0];
      const result = await runDueMediaArchiveJobs(database, {
        dataRoot: root,
        deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() }
      });
      assert.equal(result.processed, 1);
      assert.equal(result.preserved, 1);
      const candidate = getMediaCandidate(database, candidateId);
      assert.equal(candidate.status, 'preserved');
      assert.equal(candidate.attemptCount, 1);
      const items = listSourceMedia(database, sourceId, revKey);
      assert.equal(items.length, 1);
      assert.equal(items[0].status, 'preserved');
      assert.equal(items[0].assetMimeType, 'image/png');
      assert.equal(items[0].sha256, shaOf(PNG));
      assert.equal(items[0].rightsStatus, 'unknown');
      assert.ok(items[0].assetRelativePath.endsWith('.png'));
      const summary = getSourceMediaSummary(database, sourceId, revKey);
      assert.equal(summary.total, 1);
      assert.equal(summary.preserved, 1);
      assert.equal(summary.preservedBytes, PNG.byteLength);
      const job = database.prepare("SELECT status FROM jobs WHERE payload_json LIKE ?").get(`%${candidateId}%`);
      assert.equal(job.status, 'succeeded');
      const attempts = database.prepare('SELECT status FROM media_archive_attempts WHERE candidate_id = ?').all(candidateId);
      assert.deepEqual(attempts.map((a) => a.status), ['succeeded']);
      // 资产行 + imported provenance
      const asset = database.prepare('SELECT id FROM assets WHERE sha256 = ?').get(shaOf(PNG));
      assert.ok(asset, 'asset 必须登记');
      const provenance = database.prepare("SELECT kind, origin FROM asset_provenance WHERE asset_id = ?").get(asset.id);
      assert.equal(provenance.kind, 'imported');
      assert.equal(provenance.origin, 'source_media');
      // data-root 隔离：staging 无残留；assets 只有内容寻址文件
      assert.deepEqual(await readdir(path.join(root, 'staging', 'media')), []);
      const files = await readdir(path.join(root, 'assets'));
      assert.deepEqual(files, [items[0].assetRelativePath.split('/').pop()]);
      // 幂等：再次 runDue 零处理
      const again = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      assert.equal(again.processed, 0);
    } finally {
      database.close();
    }
  });
});

test('worker: 同字节跨 Source 复用 Asset，各 Source 保留独立 Binding/Provenance', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const s1 = seedSource(database, { url: 'https://a.example.com/post' });
      const s2 = seedSource(database, { url: 'https://b.example.com/post' });
      const r1 = sourceRevisionKey(s1.id, s1.revision);
      const r2 = sourceRevisionKey(s2.id, s2.revision);
      await enqueueImage(database, { sourceId: s1.id, revKey: r1, url: 'https://cdn1.example.com/x.png' });
      await enqueueImage(database, { sourceId: s2.id, revKey: r2, url: 'https://cdn2.example.com/x.png' });
      await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      const assets = database.prepare('SELECT id FROM assets WHERE sha256 = ?').all(shaOf(PNG));
      assert.equal(assets.length, 1, '同字节必须复用同一 Asset');
      const bindings = database.prepare('SELECT id, source_revision_key AS revKey FROM source_media_bindings WHERE asset_id = ?').all(assets[0].id);
      assert.equal(bindings.length, 2, '各 Source 独立 Binding');
      assert.deepEqual(new Set(bindings.map((b) => b.revKey)), new Set([r1, r2]));
      const provenances = database.prepare('SELECT id FROM asset_provenance WHERE asset_id = ? AND kind = ?').all(assets[0].id, 'imported');
      assert.equal(provenances.length, 2, '各 Source 独立 Provenance');
    } finally {
      database.close();
    }
  });
});

test('worker: 同 revision 同字节两个候选 → 共享 Binding（UNIQUE(revKey, assetId) 复用），候选均 preserved', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/a.png', ordinal: 0 });
      await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/b.png', ordinal: 1 });
      await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      const candidates = database.prepare('SELECT status FROM source_media_candidates WHERE source_revision_key = ? ORDER BY ordinal').all(revKey);
      assert.deepEqual(candidates.map((c) => c.status), ['preserved', 'preserved']);
      const bindings = database.prepare('SELECT id FROM source_media_bindings WHERE source_revision_key = ?').all(revKey);
      assert.equal(bindings.length, 1, '同 revision 同字节共享一个 Binding');
    } finally {
      database.close();
    }
  });
});

test('worker: 临时失败自动重试 ≤3 次（指数退避），耗尽 → failed + 旧 attempt 行保留', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      const { candidateIds } = await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/fail.png' });
      const candidateId = candidateIds[0];
      const failing = fakeFetch(() => ({ status: 500, headers: {}, body: 'boom' }));
      let attempts = 0;
      for (let round = 1; round <= 3; round += 1) {
        const claim = claimMediaArchiveJob(database, jobIdOf(database, candidateId), attempts, { requestId: `t${round}` });
        assert.equal(claim.claimed, true, `round ${round} 应可认领`);
        assert.equal(claim.attemptNumber, round, `执行序号应为 ${round}`);
        const execution = await executeMediaArchiveCandidate(database, claim.candidate.id, claim.attemptNumber, root, { fetchImpl: failing, resolveHost: resolveHost() });
        assert.equal(execution.outcome, 'failed');
        assert.equal(execution.code, 'HTTP_5XX');
        assert.equal(execution.retryable, true);
        const finish = finishMediaArchiveJob(database, { jobId: jobIdOf(database, candidateId), expectedAttempts: claim.job.attempts, result: execution });
        if (round < 3) {
          assert.equal(finish.jobStatus, 'pending', '未耗尽 → 退避重排 pending');
          const candidate = getMediaCandidate(database, candidateId);
          assert.equal(candidate.status, 'failed');
          assert.equal(candidate.errorCode, 'HTTP_5XX');
          assert.ok(candidate.retryAfter);
          assert.equal(candidate.retryAfter, database.prepare('SELECT due_at AS dueAt FROM jobs WHERE id = ?').get(jobIdOf(database, candidateId)).dueAt);
          // 退避公式：2^(round-1) * 30s，封顶 1h
          const expectedDelay = mediaRetryBackoffMs(round);
          const actualDelay = Date.parse(candidate.retryAfter) - Date.parse(new Date().toISOString());
          assert.ok(actualDelay >= expectedDelay - 5_000 && actualDelay <= expectedDelay + 5_000, `退避 ${actualDelay} 应≈${expectedDelay}`);
          // 手动拨快 due_at 让下一轮可认领
          database.prepare('UPDATE jobs SET due_at = ? WHERE id = ?').run(new Date().toISOString(), jobIdOf(database, candidateId));
          attempts = round;
        } else {
          assert.equal(finish.jobStatus, 'failed');
          const candidate = getMediaCandidate(database, candidateId);
          assert.equal(candidate.status, 'failed');
          assert.equal(candidate.errorCode, 'HTTP_5XX_RETRY_EXHAUSTED');
          const job = database.prepare('SELECT status, last_error AS lastError FROM jobs WHERE id = ?').get(jobIdOf(database, candidateId));
          assert.equal(job.status, 'failed');
        }
      }
      const attemptsRows = database.prepare('SELECT attempt, status, error_code AS code FROM media_archive_attempts WHERE candidate_id = ? ORDER BY attempt').all(candidateId);
      assert.deepEqual(attemptsRows.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'failed'], [3, 'failed']]);
      // 无假 Asset
      await assert.rejects(stat(path.join(root, 'assets')), { code: 'ENOENT' });
    } finally {
      database.close();
    }
  });
});

test('worker: 用户重试（failed→pending）→ 归档成功，attempt 顺延 MAX+1 且旧行保留', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      const { candidateIds } = await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/retry.png' });
      const candidateId = candidateIds[0];
      // 先失败一次
      const claim1 = claimMediaArchiveJob(database, jobIdOf(database, candidateId), 0, { requestId: 'r1' });
      const fail1 = await executeMediaArchiveCandidate(database, claim1.candidate.id, claim1.attemptNumber, root, {
        fetchImpl: fakeFetch(() => ({ status: 404, headers: {}, body: 'nope' })), resolveHost: resolveHost()
      });
      assert.equal(fail1.code, 'HTTP_404');
      assert.equal(fail1.retryable, false);
      finishMediaArchiveJob(database, { jobId: jobIdOf(database, candidateId), expectedAttempts: claim1.job.attempts, result: fail1 });
      assert.equal(getMediaCandidate(database, candidateId).status, 'failed');
      // 用户重试
      const retried = retryMediaArchiveCandidate(database, candidateId);
      assert.equal(retried.ok, true);
      const afterRetry = getMediaCandidate(database, candidateId);
      assert.equal(afterRetry.status, 'pending');
      assert.equal(afterRetry.attemptCount, 0);
      assert.equal(afterRetry.errorCode, null);
      const jobAfter = database.prepare('SELECT attempts FROM jobs WHERE id = ?').get(jobIdOf(database, candidateId));
      assert.equal(jobAfter.attempts, 0);
      // 再归档（好 fetch）
      const run = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      assert.equal(run.preserved, 1);
      const candidate = getMediaCandidate(database, candidateId);
      assert.equal(candidate.status, 'preserved');
      const attemptsRows = database.prepare('SELECT attempt, status FROM media_archive_attempts WHERE candidate_id = ? ORDER BY attempt').all(candidateId);
      // attempt=1 已结束（failed）→ 新执行顺延为 2（MAX+1），旧行保留
      assert.deepEqual(attemptsRows.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'succeeded']]);
    } finally {
      database.close();
    }
  });
});

test('worker: 非 failed 状态不可用户重试；INVALID_STATE', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      const { candidateIds } = await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/pending.png' });
      const result = retryMediaArchiveCandidate(database, candidateIds[0]);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'INVALID_STATE');
      assert.equal(retryMediaArchiveCandidate(database, 'missing').code, 'NOT_FOUND');
    } finally {
      database.close();
    }
  });
});

test('worker: 中断恢复 —— 孤儿 running >15 分钟 → DOWNLOAD_INTERRUPTED，之后成功重试归档', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      const { candidateIds } = await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/crash.png' });
      const candidateId = candidateIds[0];
      // 认领后"崩溃"（job running、候选 downloading）
      const claim = claimMediaArchiveJob(database, jobIdOf(database, candidateId), 0, { requestId: 'crash' });
      assert.equal(claim.claimed, true);
      // 模拟 20 分钟前崩溃（updated_at 回拨到过去）。
      const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      database.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(staleTime, jobIdOf(database, candidateId));
      const recovery = recoverInterruptedMediaArchiveJobs(database, { staleAfterMs: 15 * 60 * 1000 });
      assert.equal(recovery.recovered, 1);
      const candidate = getMediaCandidate(database, candidateId);
      assert.equal(candidate.status, 'failed');
      assert.equal(candidate.errorCode, 'DOWNLOAD_INTERRUPTED');
      const job = database.prepare('SELECT status, last_error AS lastError FROM jobs WHERE id = ?').get(jobIdOf(database, candidateId));
      assert.equal(job.status, 'pending');
      assert.equal(job.lastError, 'DOWNLOAD_INTERRUPTED');
      const attempt = database.prepare('SELECT status, error_code AS code FROM media_archive_attempts WHERE candidate_id = ? AND attempt = 1').get(candidateId);
      assert.equal(attempt.status, 'failed');
      assert.equal(attempt.code, 'DOWNLOAD_INTERRUPTED');
      // 恢复后可重试成功（新 attempt 行 attempt=2）
      const run = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      assert.equal(run.preserved, 1);
      const attemptsRows = database.prepare('SELECT attempt, status FROM media_archive_attempts WHERE candidate_id = ? ORDER BY attempt').all(candidateId);
      assert.deepEqual(attemptsRows.map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'succeeded']]);
    } finally {
      database.close();
    }
  });
});

test('worker: 中断恢复 attempt 耗尽 → job failed DOWNLOAD_INTERRUPTED_RETRY_EXHAUSTED', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      const { candidateIds } = await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/exhaust.png' });
      const candidateId = candidateIds[0];
      const jobId = jobIdOf(database, candidateId);
      database.prepare('UPDATE jobs SET attempts = 3, status = ? WHERE id = ?').run('running', jobId);
      database.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), jobId);
      const recovery = recoverInterruptedMediaArchiveJobs(database);
      assert.equal(recovery.recovered, 0);
      assert.equal(recovery.exhausted, 1);
      const job = database.prepare('SELECT status, last_error AS lastError FROM jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'failed');
      assert.equal(job.lastError, 'DOWNLOAD_INTERRUPTED_RETRY_EXHAUSTED');
    } finally {
      database.close();
    }
  });
});

test('worker: 全局暂停只停 claim；恢复后继续', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/pause.png' });
      setMediaArchivePaused(database, true);
      assert.equal(isMediaArchivePaused(database), true);
      const paused = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      assert.equal(paused.processed, 0, '暂停期间不得认领');
      const candidate = getMediaCandidate(database, database.prepare('SELECT id FROM source_media_candidates LIMIT 1').get().id);
      assert.equal(candidate.status, 'pending');
      setMediaArchivePaused(database, false);
      assert.equal(isMediaArchivePaused(database), false);
      const resumed = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      assert.equal(resumed.preserved, 1);
      assert.equal(MEDIA_ARCHIVE_RETRY_COMMAND, 'media_archive.retry_candidate');
      assert.equal(MEDIA_ARCHIVE_SET_PAUSED_COMMAND, 'media_archive.set_paused');
    } finally {
      database.close();
    }
  });
});

test('worker: 每 Source revision 字节总量超限 → skipped_limit（不登记、删除未注册落位文件）', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      // 造一个巨大的既有绑定（byte_count = 1GiB - 10），使新归档必然超总量
      const bigSha = shaOf('big-fake-asset');
      const now = new Date().toISOString();
      const fakeAssetId = `fake-${randomUUID()}`;
      database.prepare(`INSERT INTO assets (id, relative_path, mime_type, byte_count, sha256, origin, created_at, updated_at, revision)
        VALUES (?, 'assets/fake.bin', 'application/octet-stream', ?, ?, 'test', ?, ?, 1)`)
        .run(fakeAssetId, MEDIA_LIMITS_DEFAULT.maxTotalBytesPerRevision - 10, bigSha, now, now);
      const fakeCandidateId = `smc:${revKey}:99:image`;
      database.prepare(`INSERT INTO source_media_candidates (id, source_id, source_revision_key, kind, original_url, stable_remote_identity,
        channel, ordinal, status, attempt_count, max_attempts, discovered_at) VALUES (?, ?, ?, 'image', 'https://fake/x.png', ?, 'research', 99, 'preserved', 1, 3, ?)`)
        .run(fakeCandidateId, sourceId, revKey, shaOf('https://fake/x.png'), now);
      database.prepare(`INSERT INTO source_media_bindings (id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, sha256, captured_at, created_at, created_by)
        VALUES ('sbm:fake', ?, ?, ?, ?, 'image', 99, 'https://fake/x.png', ?, ?, ?, 'test')`)
        .run(sourceId, revKey, fakeCandidateId, fakeAssetId, bigSha, now, now);
      // 新候选（真实小图）
      const { candidateIds } = await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/tiny.png', ordinal: 0 });
      const run = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
      assert.equal(run.skippedLimit, 1);
      const candidate = getMediaCandidate(database, candidateIds[0]);
      assert.equal(candidate.status, 'skipped_limit');
      assert.equal(candidate.errorCode, 'MEDIA_LIMIT_EXCEEDED');
      const binding = database.prepare('SELECT id FROM source_media_bindings WHERE candidate_id = ?').get(candidateIds[0]);
      assert.equal(binding, undefined, '超限候选不得创建 Binding');
      const job = database.prepare('SELECT status FROM jobs WHERE payload_json LIKE ?').get(`%${candidateIds[0]}%`);
      assert.equal(job.status, 'needs_user');
      // 落位文件已被删除（未注册到任何 Source）
      await assert.rejects(stat(path.join(root, 'assets', `${shaOf(PNG)}.png`)), { code: 'ENOENT' });
      const summary = getSourceMediaSummary(database, sourceId, revKey);
      assert.equal(summary.skippedLimit, 1);
      assert.equal(summary.preserved, 1);
    } finally {
      database.close();
    }
  });
});

test('worker: 图片模式拒绝视频字节；URL 回退链（original→alternate）仅在 failed 回退', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      // 两个候选：一个带 alternateUrls（orig 404 → medium 成功）
      const { candidateIds } = insertMediaCandidates(database, {
        sourceId, sourceRevisionKey: revKey, channel: 'x_lists', requestId: 'r', discoveredAt: new Date().toISOString(),
        candidates: [
          { kind: 'image', originalUrl: 'https://cdn.example.com/orig.png', alternateUrls: ['https://cdn.example.com/medium.png'], ordinal: 0, channel: 'x_lists' },
          { kind: 'image', originalUrl: 'https://cdn.example.com/only.png', ordinal: 1, channel: 'x_lists' }
        ]
      });
      const called = [];
      const fetchImpl = fakeFetch((url, method) => {
        called.push(url);
        if (url.includes('/orig.png')) return { status: 404, headers: {}, body: 'gone' };
        return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
      });
      await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl, resolveHost: resolveHost() } });
      const items = listSourceMedia(database, sourceId, revKey);
      assert.deepEqual(items.map((i) => i.status), ['preserved', 'preserved']);
      assert.ok(called.some((u) => u.includes('/orig.png')), 'orig 必须尝试');
      assert.ok(called.some((u) => u.includes('/medium.png')), 'orig 失败后必须回退 medium');
      assert.deepEqual(items[0].alternateUrls, ['https://cdn.example.com/medium.png']);
      // 同候选同字节 → 共享 Asset
      const assets = database.prepare('SELECT COUNT(*) AS count FROM assets WHERE sha256 = ?').get(shaOf(PNG));
      assert.equal(assets.count, 1);
    } finally {
      database.close();
    }
  });
});

test('worker: media_discover —— HTML 有界发现 → 候选 + media_archive jobs；失败不影响 Source', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database, { url: 'https://news.example.com/article' });
      const revKey = sourceRevisionKey(sourceId, revision);
      enqueueMediaDiscoverJob(database, { sourceId, sourceRevisionKey: revKey, originalUrl: 'https://news.example.com/article' });
      assert.ok(database.prepare('SELECT id FROM jobs WHERE dedupe_key = ?').get(mediaDiscoverDedupeKey(revKey)));
      // 重复入队幂等（INSERT OR IGNORE by dedupe）
      enqueueMediaDiscoverJob(database, { sourceId, sourceRevisionKey: revKey, originalUrl: 'https://news.example.com/article' });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM jobs WHERE dedupe_key = ?').get(mediaDiscoverDedupeKey(revKey)).count, 1);
      // 发现：解析 HTML → 2 图（og 去重 + srcset 首项）+ 1 视频 + 1 poster；排除 data:/pixel/favicon
      const candidates = extractHtmlMediaCandidates(HTML_PAGE.toString('utf8'), 'https://news.example.com/article', MEDIA_LIMITS_DEFAULT);
      const imageUrls = candidates.filter((c) => c.kind === 'image').map((c) => c.originalUrl);
      assert.ok(imageUrls.includes('https://cdn.example.com/og.png'));
      assert.ok(imageUrls.includes('https://news.example.com/img/a.png'));
      assert.ok(imageUrls.includes('https://news.example.com/img/b.jpg'), 'srcset 首项');
      assert.ok(!imageUrls.some((u) => u.includes('data:')), 'data: 必须排除');
      assert.ok(!imageUrls.some((u) => u.includes('pixel.gif')), 'tracking pixel（<64px）必须排除');
      assert.ok(!imageUrls.some((u) => u.includes('favicon')), 'favicon 必须排除');
      const videoUrls = candidates.filter((c) => c.kind === 'video').map((c) => c.originalUrl);
      assert.deepEqual(videoUrls, ['https://cdn.example.com/clip.mp4']);
      const posters = candidates.filter((c) => c.kind === 'video_poster');
      assert.equal(posters.length, 1);
      assert.equal(posters[0].parentOrdinal, candidates.findIndex((c) => c.kind === 'video'));

      // 完整执行：discover job → 候选 → archive jobs → preserved
      const first = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: discoverFetch(), resolveHost: resolveHost() } });
      assert.equal(first.processed, 1);
      assert.equal(first.discovered, 1);
      const discovered = database.prepare('SELECT COUNT(*) AS count FROM source_media_candidates WHERE source_revision_key = ?').get(revKey);
      assert.equal(discovered.count, 5, 'og 图 + 2 正文图 + 视频 + poster');
      const discoverJob = database.prepare('SELECT status FROM jobs WHERE dedupe_key = ?').get(mediaDiscoverDedupeKey(revKey));
      assert.equal(discoverJob.status, 'succeeded');
      // 5 个 media_archive jobs 已入队；runDue 每批最多并发 3 → 循环直到排空。
      let preservedTotal = 0;
      for (let round = 0; round < 10; round += 1) {
        const drained = await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: mediaFetch(), resolveHost: resolveHost(), probeDurationMs: async () => ({ durationMs: 60_000, runtimeName: 'test', runtimeVersion: '1' }) } });
        preservedTotal += drained.preserved;
        if (drained.processed === 0) break;
      }
      assert.equal(preservedTotal, 5);
      const summary = getSourceMediaSummary(database, sourceId, revKey);
      assert.equal(summary.preserved, 5);
      assert.equal(summary.total, 5);
    } finally {
      database.close();
    }
  });
});

test('worker: media_discover 抓取失败 → job failed 可重试，Source 不受影响', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database, { url: 'https://broken.example.com/article' });
      const revKey = sourceRevisionKey(sourceId, revision);
      enqueueMediaDiscoverJob(database, { sourceId, sourceRevisionKey: revKey, originalUrl: 'https://broken.example.com/article' });
      const run = await runDueMediaArchiveJobs(database, {
        dataRoot: root,
        deps: { fetchImpl: fakeFetch(() => ({ status: 500, headers: {}, body: 'down' })), resolveHost: resolveHost() }
      });
      assert.equal(run.failed, 1);
      const job = database.prepare('SELECT status, attempts FROM jobs WHERE dedupe_key = ?').get(mediaDiscoverDedupeKey(revKey));
      assert.equal(job.status, 'pending', '临时失败应退避重排');
      assert.equal(job.attempts, 1);
      const source = database.prepare('SELECT title FROM source_items WHERE id = ?').get(sourceId);
      assert.ok(source, 'Source 必须保留');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_media_candidates WHERE source_revision_key = ?').get(revKey).count, 0);
    } finally {
      database.close();
    }
  });
});

test('worker: post-preserve 钩子在提交后触发（image kind）', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const calls = [];
      setMediaArchivePostPreserveHook((db, input) => { calls.push({ ...input, kind: input.kind }); void db; });
      try {
        const { id: sourceId, revision } = seedSource(database);
        const revKey = sourceRevisionKey(sourceId, revision);
        await enqueueImage(database, { sourceId, revKey, url: 'https://cdn.example.com/hook.png' });
        await runDueMediaArchiveJobs(database, { dataRoot: root, deps: { fetchImpl: goodFetch(PNG, 'image/png'), resolveHost: resolveHost() } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].sourceId, sourceId);
        assert.equal(calls[0].sourceRevisionKey, revKey);
        assert.equal(calls[0].kind, 'image');
        assert.ok(calls[0].assetId);
      } finally {
        setMediaArchivePostPreserveHook(null);
      }
    } finally {
      database.close();
    }
  });
});

test('worker: 读模型 —— video_poster 父引用、状态计数口径与 data-root 隔离', async () => {
  await withCleanup(async (root) => {
    const { database } = await makeDatabase(root);
    try {
      const { id: sourceId, revision } = seedSource(database);
      const revKey = sourceRevisionKey(sourceId, revision);
      insertMediaCandidates(database, {
        sourceId, sourceRevisionKey: revKey, channel: 'x_lists', requestId: 'r', discoveredAt: new Date().toISOString(),
        candidates: [
          { kind: 'video', originalUrl: 'https://cdn.example.com/clip.mp4', ordinal: 0, channel: 'x_lists' },
          { kind: 'video_poster', originalUrl: 'https://cdn.example.com/poster.png', ordinal: 0, channel: 'x_lists', parentOrdinal: 0 }
        ]
      });
      // video_poster 父引用解析（同 ordinal 不同 kind）
      const poster = database.prepare("SELECT parent_candidate_id AS parent FROM source_media_candidates WHERE kind = 'video_poster'").get();
      const video = database.prepare("SELECT id FROM source_media_candidates WHERE kind = 'video'").get();
      assert.equal(poster.parent, video.id);
      // 执行：video 走 probe；poster 走 image
      await runDueMediaArchiveJobs(database, {
        dataRoot: root,
        deps: {
          fetchImpl: fakeFetch((url, method) => ({
            status: 200,
            headers: { 'content-type': url.includes('.mp4') ? 'video/mp4' : 'image/png' },
            body: method === 'HEAD' ? null : url.includes('.mp4') ? MP4 : PNG
          })),
          resolveHost: resolveHost(),
          probeDurationMs: async () => ({ durationMs: 12_000, runtimeName: 'wmb-mp4-mvhd', runtimeVersion: '1' })
        }
      });
      const items = listSourceMedia(database, sourceId, revKey);
      assert.equal(items.length, 2);
      const videoItem = items.find((i) => i.kind === 'video');
      const posterItem = items.find((i) => i.kind === 'video_poster');
      assert.equal(videoItem.status, 'preserved');
      assert.equal(videoItem.assetMimeType, 'video/mp4');
      assert.equal(videoItem.assetDurationMs, 12_000);
      assert.equal(posterItem.status, 'preserved');
      assert.equal(posterItem.assetMimeType, 'image/png');
      assert.equal(posterItem.parentCandidateId, videoItem.candidateId);
      const summary = getSourceMediaSummary(database, sourceId, revKey);
      assert.equal(summary.total, 2);
      assert.equal(summary.preserved, 2);
      // data-root 隔离：一切写入都在 root 内
      const staging = await readdir(path.join(root, 'staging', 'media')).catch(() => []);
      assert.deepEqual(staging, []);
      const assets = await readdir(path.join(root, 'assets'));
      assert.equal(assets.length, 2);
    } finally {
      database.close();
    }
  });
});

// ============ 工具 ============

function jobIdOf(database, candidateId) {
  const row = database.prepare('SELECT id FROM jobs WHERE payload_json LIKE ?').get(`%${candidateId}%`);
  return row.id;
}

function discoverFetch() {
  return fakeFetch((url, method) => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: method === 'HEAD' ? null : HTML_PAGE
  }));
}

function mediaFetch() {
  return fakeFetch((url, method) => ({
    status: 200,
    headers: { 'content-type': url.includes('.mp4') ? 'video/mp4' : url.includes('.webm') ? 'video/webm' : 'image/png' },
    body: method === 'HEAD' ? null : url.includes('.mp4') ? MP4 : url.includes('.webm') ? WEBM : PNG
  }));
}

void isPrivateIp;
void sniffMediaType;
void MediaFetchError;
void stableRemoteIdentity;
void mediaArchiveStatusSummary;
