// WMB-5244–5247 deterministic media byte fixtures (no internet, no third-party
// mutable resources). Every generator is a pure function of its inputs so the
// same workspace scenario can be replayed byte-for-byte.
//
// Magic-byte reference mirrors design §8: MIME is decided by content signature,
// not extension. MP4 must carry an `ftyp` box at offset 4; WebM must start with
// the EBML magic; images carry their own magic. The MP4 fixture includes a real
// `mvhd` box so a built-in duration parser can read a deterministic duration.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG (real bytes, zlib-compressed scanlines; Chromium/Electron decodable)
// ---------------------------------------------------------------------------

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
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  let crc = 0xffffffff;
  for (const byte of typeBytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  for (const byte of data) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

export function pngBytes(width, height, rgb) {
  const [r, g, b] = rgb;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// JPEG (minimal valid 1x1; known-good constant byte sequence)
// ---------------------------------------------------------------------------

const MINIMAL_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

export const jpegBytes = () => Buffer.from(MINIMAL_JPEG_B64, 'base64');

// ---------------------------------------------------------------------------
// WebP (RIFF....WEBP + VP8L lossless; known-good minimal 1x1)
// ---------------------------------------------------------------------------

const MINIMAL_WEBP_B64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

export const webpBytes = () => Buffer.from(MINIMAL_WEBP_B64, 'base64');

// ---------------------------------------------------------------------------
// GIF (GIF89a minimal 1x1, no extension blocks)
// ---------------------------------------------------------------------------

export function gifBytes(width = 1, height = 1) {
  const header = Buffer.from('GIF89a', 'ascii');
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80; // global color table flag + size (2 colors)
  lsd[5] = 0;
  lsd[6] = 0;
  const gct = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]); // black + white
  const imageDescriptor = Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const lzw = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]); // minimal LZW min-code-size block
  return Buffer.concat([header, lsd, gct, imageDescriptor, lzw, Buffer.from([0x3b])]);
}

// ---------------------------------------------------------------------------
// MP4 (ftyp at offset 4 + real mvhd duration; deterministic durationMs)
// ---------------------------------------------------------------------------

function box(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length + 8, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), payload]);
}

export function mp4Bytes({ durationMs = 12000, variant = 0 } = {}) {
  const ftyp = Buffer.concat([
    Buffer.from('isom', 'ascii'),
    Buffer.alloc(4), // minor version
    Buffer.from('isomiso2avc1mp41', 'ascii')
  ]);
  // mvhd: fullbox + timescale/duration (timescale 1000 → durationMs direct)
  const mvhd = Buffer.alloc(4 + 80);
  mvhd.writeUInt32BE(0, 0); // version+flags
  mvhd.writeUInt32BE(0, 4); // creation_time
  mvhd.writeUInt32BE(0, 8); // modification_time
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(durationMs, 16); // duration
  mvhd.writeUInt32BE(0x00010000, 20); // rate
  mvhd.writeUInt16BE(0x0100, 24); // volume
  // remaining 10 reserved + 36 matrix + 24 pre_defined + next_track_ID are zeros
  const mdat = Buffer.alloc(64 + (variant % 32) * 16);
  for (let i = 0; i < mdat.length; i += 1) mdat[i] = (variant * 31 + i) & 0xff;
  return Buffer.concat([
    box('ftyp', ftyp),
    box('mvhd', mvhd),
    box('mdat', mdat)
  ]);
}

// ---------------------------------------------------------------------------
// WebM (EBML magic + DocType webm; deterministic variant payload)
// ---------------------------------------------------------------------------

export function webmBytes({ variant = 0 } = {}) {
  const ebmlHeader = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // EBML magic
    Buffer.from([0x81]), // size = 1 byte element (0x81 → data length 1)
    Buffer.from([0x42, 0x86, 0x81, 0x01]), // EBMLVersion = 1
    Buffer.from([0x42, 0xf7, 0x81, 0x01]), // EBMLReadVersion = 1
    Buffer.from([0x42, 0xf2, 0x81, 0x04]), // EBMLMaxIDLength = 4
    Buffer.from([0x42, 0xf3, 0x81, 0x08]), // EBMLMaxSizeLength = 8
    Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]), // DocType = "webm"
    Buffer.from([0x42, 0x87, 0x81, 0x04]), // DocTypeVersion = 4
    Buffer.from([0x42, 0x85, 0x81, 0x02]) // DocTypeReadVersion = 2
  ]);
  const payload = Buffer.alloc(96 + (variant % 16) * 8);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (variant * 17 + i * 3) & 0xff;
  return Buffer.concat([ebmlHeader, Buffer.from([0x1f, 0x43, 0xb6, 0x75]), payload]);
}

// ---------------------------------------------------------------------------
// SVG (text; only a restricted Source asset, never a publish payload)
// ---------------------------------------------------------------------------

export function svgBytes() {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="100%" height="100%" fill="#3366cc"/>' +
      '<text x="8" y="36" font-size="16" fill="#ffffff">SVG</text></svg>',
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// Subtitle fixtures (native caption paths; deterministic timestamps)
// ---------------------------------------------------------------------------

export const subtitleSrt = () => `1
00:00:01,000 --> 00:00:03,500
DeepSeek-V4-Pro 基准测试成绩领先

2
00:00:04,200 --> 00:00:06,800
多模态能力在 MMMU 上超过上一代

3
00:00:08,000 --> 00:00:11,200
推理成本下降 40%
`;

export const subtitleVtt = () => `WEBVTT

00:01.000 --> 00:03.500
DeepSeek-V4-Pro 基准测试成绩领先

00:04.200 --> 00:06.800
多模态能力在 MMMU 上超过上一代

00:08.000 --> 00:11.200
推理成本下降 40%
`;

// ---------------------------------------------------------------------------
// HTML discovery fixtures (official-web channel; design §7.3)
// ---------------------------------------------------------------------------

export function webPageFixture({ baseUrl, hasTrackingPixel = true } = {}) {
  const trackingPixel = hasTrackingPixel
    ? `<img src="${baseUrl}/tracking-pixel.gif" width="1" height="1" alt=""/>`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
  <title>DeepSeek-V4-Pro 基准测试性能的后续影响</title>
  <meta property="og:title" content="DeepSeek-V4-Pro 基准测试性能的后续影响"/>
  <meta property="og:image" content="${baseUrl}/og-chart.png"/>
  <meta property="og:video" content="${baseUrl}/og-demo.mp4"/>
</head>
<body>
  <h1>DeepSeek-V4-Pro 基准测试性能的后续影响</h1>
  <p>成绩段落：DeepSeek-V4-Pro 在 MMLU-Pro 与 GPQA 上保持领先。</p>
  <figure>
    <img srcset="${baseUrl}/bench-small.png 320w, ${baseUrl}/bench-large.png 1280w"
         src="${baseUrl}/bench-small.png" alt="Benchmark 总表"/>
    <figcaption>Benchmark 总表</figcaption>
  </figure>
  <p>边界说明：测试限制条件见下表截图。</p>
  <img src="/relative-test-limits.png" alt="测试限制截图"/>
  <video controls poster="${baseUrl}/video-poster.jpg">
    <source src="${baseUrl}/direct-demo.webm" type="video/webm"/>
    <source src="${baseUrl}/direct-demo.mp4" type="video/mp4"/>
  </video>
  ${trackingPixel}
  <img src="${baseUrl}/favicon.ico" alt=""/>
  <img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"/>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// X-style fixture payload (x_lists channel; design §7.2)
// ---------------------------------------------------------------------------

export function xTimelineFixture({ baseUrl }) {
  return {
    posts: [
      {
        id: 'post-1',
        text: 'DeepSeek-V4-Pro 基准测试成绩领先，实测视频见下方。',
        images: [`${baseUrl}/x-bench-1.png`, `${baseUrl}/x-bench-2.png`],
        videoUrl: `${baseUrl}/x-demo.mp4`,
        videoPoster: `${baseUrl}/x-demo-poster.jpg`,
        quotedPost: null
      },
      {
        id: 'post-2',
        text: '复现边界说明：测试限制条件截图。',
        images: [`${baseUrl}/x-limits.png`],
        quotedPost: {
          id: 'quoted-1',
          text: '引用帖媒体',
          images: [`${baseUrl}/x-quoted-chart.png`],
          videoUrl: null,
          videoPoster: null,
          quotedPost: null
        }
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Magic-byte reference (design §8: MIME decided by signature, not extension)
// ---------------------------------------------------------------------------

export function sniffMediaType(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '<?xml') return 'image/svg+xml';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === '<svg') return 'image/svg+xml';
  return null;
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export const MEDIA_FIXTURE_KINDS = Object.freeze(['image', 'video', 'video_poster']);
