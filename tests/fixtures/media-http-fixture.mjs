// WMB-5244–5247 deterministic local HTTP fixture server.
//
// No internet, no mutable third-party resources: every route is configured
// before listen and serves stable bytes on 127.0.0.1 with an ephemeral port.
// The SSRF guard's `resolveHost` seam (media-archive-fetch.ts) is injected by
// tests to report a public-looking IP for positive paths and private IPs for
// rejection paths; the real default `fetchImpl` (global fetch) transfers the
// bytes against this server, so HEAD/GET semantics, redirects and streaming
// are exercised for real on the loopback interface.
//
// Behaviors are registered per path; each behavior is a pure function of
// (request, state) so scenarios are reproducible.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Fixture hostname that never resolves publicly (.invalid TLD). The SSRF guard
 * re-resolves every hop via the injected `resolveHost` seam; tests report this
 * hostname as resolving to a genuinely public IP. Real byte transfer flows
 * through `fixtureFetchImpl`, which rewrites the host to the loopback fixture
 * server before the actual HTTP request — so HEAD/GET/redirect/streaming
 * semantics run against a real local HTTP server while the guard's per-hop
 * hostname/IP checks are fully exercised.
 */
export const FIXTURE_HOST = 'media-fixture.invalid';
/** Genuinely public address (example.com); NOT a TEST-NET range (those are SSRF-blocked). */
export const PUBLIC_LOOKING_IP = '93.184.216.34';
/** Private/loopback families for rejection paths. */
export const PRIVATE_IPS = Object.freeze(['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.10', '169.254.169.254', '::1']);

/**
 * fetch 注入缝：guard 见 FIXTURE_HOST（public DNS 结果），真实字节走
 * 127.0.0.1 fixture server（每跳 URL 重写，redirect Location 保持相对路径不变）。
 */
export function fixtureFetchImpl(server) {
  const base = server.baseUrl; // http://127.0.0.1:<port>
  return (url, init) => {
    const rewritten = String(url).replace(`http://${FIXTURE_HOST}`, base);
    return globalThis.fetch(rewritten, init);
  };
}

/**
 * 候选/发现 URL 工厂：`http://<FIXTURE_HOST><path>`（不含端口）。
 * guard 的 hostname 检查（非 localhost/.local、非 IP 字面量）通过；
 * fixtureFetchImpl 把 host 段重写为 127.0.0.1:<port> 后真实落盘。
 */
export function fixtureUrl(server, path) {
  void server;
  return `http://${FIXTURE_HOST}${path}`;
}

/** fixture 可复用的 resolveHost：总是返回公网 IP（正向下载路径）。 */
export const publicResolveHost = async () => [PUBLIC_LOOKING_IP];

export function createMediaFixtureServer() {
  const routes = new Map();
  const served = [];
  let server = null;
  let baseUrl = null;

  function register(path, handler) {
    routes.set(path, handler);
    return api;
  }

  function writeHead(res, { status = 200, headers = {}, headOnly = false } = {}) {
    res.writeHead(status, headers);
  }

  function respond(res, { status = 200, headers = {}, bytes = Buffer.alloc(0), headOnly = false }) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    if (headOnly) {
      res.end();
      return;
    }
    res.end(bytes);
  }

  const api = {
    baseUrl: null,

    async start() {
      if (server) return api;
      server = createServer((req, res) => {
        const pathOnly = (req.url ?? '/').split('?')[0];
        const handler = routes.get(pathOnly) ?? routes.get('*');
        const record = { id: randomUUID(), method: req.method, path: pathOnly, query: req.url ?? '', at: Date.now() };
        served.push(record);
        if (!handler) {
          record.status = 404;
          respond(res, { status: 404, bytes: Buffer.from('not found') });
          return;
        }
        const headOnly = req.method === 'HEAD';
        try {
          const out = handler({ method: req.method, headOnly, path: pathOnly, served });
          if (!out) {
            record.status = 404;
            respond(res, { status: 404 });
            return;
          }
          record.status = out.status ?? 200;
          record.bytes = Buffer.isBuffer(out.bytes) ? out.bytes.length : (out.bytes?.length ?? 0);
          if (out.redirectTo) {
            record.redirectTo = out.redirectTo;
            res.writeHead(out.status ?? 302, { location: out.redirectTo, ...(out.headers ?? {}) });
            res.end();
            return;
          }
          if (out.streaming) {
            // HEAD 只回头部（fetchWithMediaGuard 先 HEAD 预检；流式 body 只对 GET 发）。
            res.writeHead(out.status ?? 200, { ...(out.headers ?? {}) });
            if (headOnly) {
              res.end();
              return;
            }
            const chunks = out.chunks ?? [Buffer.alloc(0)];
            let i = 0;
            let written = 0;
            const timer = setInterval(() => {
              if (res.destroyed || res.writableEnded) {
                clearInterval(timer);
                return;
              }
              const chunk = i < chunks.length ? chunks[i] : out.filler ?? Buffer.alloc(16384, 0x61);
              i += 1;
              written += chunk.length;
              record.streamedBytes = written;
              if (!res.write(chunk)) {
                // backpressure: wait for drain before continuing
              }
              if (out.maxTotalBytes && written >= out.maxTotalBytes) {
                clearInterval(timer);
                res.end();
              }
            }, out.chunkIntervalMs ?? 5);
            res.on('close', () => clearInterval(timer));
            return;
          }
          if (out.delayMs) {
            setTimeout(() => respond(res, out), out.delayMs);
            return;
          }
          respond(res, { ...out, headOnly });
        } catch (err) {
          record.status = 500;
          record.error = String(err);
          respond(res, { status: 500 });
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      api.baseUrl = baseUrl;
      return api;
    },

    async close() {
      if (!server) return;
      // 流式越限/中止路径（fetchWithMediaGuard SIZE_LIMIT_EXCEEDED 不 cancel reader）会遗留
      // 仍在写 filler 的服务端连接；不强制销毁则 close() 永久等待该连接，测试套件挂死。
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      server = null;
      baseUrl = null;
    },

    url(path) {
      if (!baseUrl) throw new Error('fixture server not started');
      return `${baseUrl}${path}`;
    },

    served,

    // ---- behavior registrations ----

    /** Serve fixed bytes with a content-type. */
    static(path, bytes, { mimeType = 'application/octet-stream', status = 200, extraHeaders = {} } = {}) {
      return register(path, () => ({
        status,
        headers: { 'content-type': mimeType, 'content-length': String(bytes.length), ...extraHeaders },
        bytes
      }));
    },

    /** Redirect (302) to `toPath`; chains are built by pointing at other routes. */
    redirect(path, { toPath }) {
      return register(path, () => ({ status: 302, redirectTo: toPath }));
    },

    /** HEAD reports a huge Content-Length; GET serves small real bytes. */
    headOverLimit(path, { mimeType = 'video/mp4', declaredBytes = 600 * 1024 * 1024, bytes = Buffer.alloc(64) } = {}) {
      return register(path, ({ headOnly }) => {
        if (headOnly) {
          return {
            headers: { 'content-type': mimeType, 'content-length': String(declaredBytes) },
            bytes: Buffer.alloc(0)
          };
        }
        return { headers: { 'content-type': mimeType, 'content-length': String(declaredBytes) }, bytes };
      });
    },

    /** No Content-Length; streams bytes then keeps writing filler (limit-crossing test). */
    streamOverLimit(path, { mimeType = 'video/mp4', bytes, fillerBytes = 262144 } = {}) {
      return register(path, () => ({
        streaming: true,
        headers: { 'content-type': mimeType },
        chunks: [bytes],
        filler: Buffer.alloc(fillerBytes, 0x61),
        chunkIntervalMs: 2
      }));
    },

    /** Serves bytes under a declared MIME that the signature refutes. */
    wrongMime(path, { bytes, declaredMime = 'video/mp4' } = {}) {
      return register(path, () => ({
        headers: { 'content-type': declaredMime },
        bytes
      }));
    },

    /** Same URL, different bytes per request (content-change detection). */
    mutable(path, producer, { mimeType = 'image/png' } = {}) {
      let requestCount = 0;
      return register(path, () => {
        requestCount += 1;
        const bytes = producer(requestCount);
        // 无 Content-Length（chunked）：HEAD 与 GET 的字节可能不同，避免长度声明与实体不一致。
        return { headers: { 'content-type': mimeType }, bytes };
      });
    },

    /** Fixed status without body (403/404/500/401). */
    statusOnly(path, { status = 403 }) {
      return register(path, () => ({ status, bytes: Buffer.from(String(status)) }));
    },

    /** First byte delayed (connection/first-byte timeout path). */
    slowFirstByte(path, { bytes, mimeType = 'video/mp4', delayMs = 60_000 } = {}) {
      return register(path, () => ({
        delayMs,
        headers: { 'content-type': mimeType, 'content-length': String(bytes.length) },
        bytes
      }));
    },

    /** m3u8 manifest text (unsupported stream classification). */
    manifest(path, text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nseg-0.ts\n') {
      return register(path, () => ({
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        bytes: Buffer.from(text, 'utf8')
      }));
    },

    /** Arbitrary raw handler (advanced scenarios). */
    route(path, handler) {
      return register(path, handler);
    }
  };

  return api;
}

// ---------------------------------------------------------------------------
// Convenience: pre-wired scenario servers
// ---------------------------------------------------------------------------

/**
 * Server with the standard fixture routes used by the unified acceptance
 * scenario. Deterministic bytes; every path documented in served[].
 */
export async function startStandardFixtureServer() {
  const server = createMediaFixtureServer();

  // images
  server.static('/img/bench.png', pngFixture('benchmark-chart', 640, 400, [214, 42, 42]), { mimeType: 'image/png' });
  server.static('/img/limits.png', pngFixture('test-limits', 480, 320, [42, 82, 214]), { mimeType: 'image/png' });
  server.static('/img/og-chart.png', pngFixture('og-chart', 512, 512, [42, 142, 92]), { mimeType: 'image/png' });
  server.static('/img/x-quoted-chart.png', pngFixture('x-quoted-chart', 256, 256, [200, 120, 30]), { mimeType: 'image/png' });
  server.static('/img/tiny.jpg', jpegFixture(), { mimeType: 'image/jpeg' });
  server.static('/img/tiny.webp', webpFixture(), { mimeType: 'image/webp' });
  server.static('/img/tiny.gif', gifFixture(), { mimeType: 'image/gif' });
  server.static('/tracking-pixel.gif', gifFixture(), { mimeType: 'image/gif' });
  server.static('/favicon.ico', Buffer.from('not-an-icon'), { mimeType: 'image/x-icon' });

  // videos
  server.static('/video/demo.mp4', mp4Fixture({ durationMs: 12000, variant: 1 }), { mimeType: 'video/mp4' });
  server.static('/video/demo.webm', webmFixture({ variant: 2 }), { mimeType: 'video/webm' });
  server.static('/video/poster.jpg', jpegFixture(), { mimeType: 'image/jpeg' });
  server.static('/video/x-demo.mp4', mp4Fixture({ durationMs: 12000, variant: 3 }), { mimeType: 'video/mp4' });
  server.static('/video/x-demo-poster.jpg', jpegFixture(), { mimeType: 'image/jpeg' });

  // failure/edge behaviors
  server.headOverLimit('/edge/head-over-limit.mp4', { mimeType: 'video/mp4', declaredBytes: 600 * 1024 * 1024, bytes: mp4Fixture({ durationMs: 1000, variant: 4 }) });
  // 流式越限走 image 模式（20MiB 限额，测试快）；视频 500MiB 同理但避免长耗时
  server.streamOverLimit('/edge/stream-over-limit.png', { mimeType: 'image/png', bytes: pngFixture('stream-start', 64, 64, [9, 9, 9]) });
  server.wrongMime('/edge/wrong-mime.mp4', { bytes: pngFixture('not-a-video', 16, 16, [1, 2, 3]), declaredMime: 'video/mp4' });
  server.statusOnly('/edge/forbidden.mp4', { status: 403 });
  server.manifest('/edge/stream.m3u8');
  server.redirect('/edge/redirect-1.mp4', { toPath: '/edge/redirect-2.mp4' });
  server.redirect('/edge/redirect-2.mp4', { toPath: '/video/demo.mp4' });
  server.mutable('/edge/mutable.png', (n) => pngFixture(`content-${n}`, 32 + n, 32 + n, [n * 10 % 255, 20, 30]), { mimeType: 'image/png' });
  server.mutable('/edge/mutable-video.mp4', (n) => mp4Fixture({ durationMs: 12000, variant: 10 + n }), { mimeType: 'video/mp4' });
  server.slowFirstByte('/edge/slow-first-byte.mp4', { bytes: mp4Fixture({ durationMs: 1000, variant: 6 }), delayMs: 60_000 });

  await server.start();
  return server;
}

// re-export byte helpers so scenario files have a single import
import {
  pngBytes,
  jpegBytes,
  webpBytes,
  gifBytes,
  mp4Bytes,
  webmBytes,
  svgBytes,
  subtitleSrt,
  subtitleVtt,
  webPageFixture,
  xTimelineFixture,
  sniffMediaType,
  sha256Hex
} from './media-fixture-bytes.mjs';

export {
  pngBytes,
  jpegBytes,
  webpBytes,
  gifBytes,
  mp4Bytes,
  webmBytes,
  svgBytes,
  subtitleSrt,
  subtitleVtt,
  webPageFixture,
  xTimelineFixture,
  sniffMediaType,
  sha256Hex
};

const pngFixture = (label, w, h, rgb) => pngBytes(w, h, rgb);
const jpegFixture = () => jpegBytes();
const webpFixture = () => webpBytes();
const gifFixture = () => gifBytes();
const mp4Fixture = (opts) => mp4Bytes(opts);
const webmFixture = (opts) => webmBytes(opts);
