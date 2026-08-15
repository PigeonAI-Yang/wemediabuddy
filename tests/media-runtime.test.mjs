// WMB-5245 媒体运行时 lock/准备/门禁聚焦测试：
// 用微型假 manifest、假 zip、假可执行文件（.cmd 批处理假体，shell 仅用于测试桩）验证——
// 1) prepare 按 lock 生成 .r/media-runtime（file/zip/nsis 三种 kind）；
// 2) lock 缺失/哈希不符/平台不符以稳定退出码失败且不留半成品；
// 3) 幂等：有效运行时被直接采用；
// 4) 运行时定位/断言模块：缺失→MEDIA_RUNTIME_MISSING、哈希错→HASH_MISMATCH、
//    lock 标记错→LOCK_MISMATCH、绝不回退 PATH；
// 5) 打包门禁：真实执行 ffprobe -version / whisper-cli --help / tesseract --version；
// 6) 图片-only 应用在运行时缺失时可启动（断言确定性抛码、无悬挂）。
// 运行：node --test tests/media-runtime.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { register } from 'node:module';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREPARE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'prepare-media-runtime.mjs');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-packaged-media-runtime.mjs');

// ---- 测试本地 ESM 解析钩子（同仓库其它聚焦测试）：electron → 惰性桩；相对无扩展名补 .ts ----
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,export const app={isPackaged:false};export default {app};', shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  "      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };",
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);

const PREPARE = await import('../scripts/prepare-media-runtime.mjs');
const {
  MEDIA_RUNTIME_CODES,
  MEDIA_RUNTIME_EXIT,
  canonicalLockBytes,
  extractZipEntry,
  isRuntimeValid,
  lockSha256Of,
  prepareMediaRuntime,
  readZipIndex,
  validateLock,
  verifyPreparedRuntime,
  MediaRuntimePrepareError
} = PREPARE;
const RUNTIME = await import('../src/main/media-runtime.ts');

// ---------- fixtures ----------

const PLATFORM = `${process.platform}-${process.arch}`;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Minimal zip writer (stored + deflate entries) for fake artifacts. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipBuffer(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method ?? 0;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, stored);
    central.push({ name: entry.name, crc, size: data.length, compSize: stored.length, method, offset, nameLen: nameBuf.length });
    offset += 30 + nameBuf.length + stored.length;
  }
  const cdStart = offset;
  const cdChunks = [];
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(c.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.compSize, 20);
    ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameLen, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(c.offset, 42);
    cdChunks.push(ch, Buffer.from(c.name, 'utf8'));
  }
  const cdSize = cdChunks.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...cdChunks, eocd]);
}

/**
 * Builds a tiny fake runtime fixture:
 *  - fake .cmd batch "executables" for ffprobe/whisper-cli/tesseract (probed
 *    with shell:true in tests; production gates probe real .exe with shell:false)
 *  - a fake zip artifact with one stored + one deflated entry
 *  - a kind:file artifact and (optionally) an NSIS component driven by an
 *    injected installer that writes a file
 * Returns { dir, artifacts, lock, lockPath }.
 */
async function buildFixture({ includeNsis = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-mr-'));
  const artifacts = path.join(dir, 'artifacts');
  await mkdir(artifacts, { recursive: true });

  const cmdFake = async (name, body) => {
    const data = Buffer.from(body, 'utf8');
    const target = path.join(artifacts, name);
    await writeFile(target, data);
    return { path: target, sha256: sha256(data), size: data.length };
  };
  const ffprobe = await cmdFake('ffprobe.cmd', '@echo off\r\necho ffprobe version 99.99.99\r\n');
  const ffmpeg = await cmdFake('ffmpeg.cmd', '@echo off\r\necho ffmpeg version 99.99.99\r\n');
  const whisperCli = await cmdFake('whisper-cli.cmd', '@echo off\r\necho whisper-cli v9.9.9\r\n');
  const tesseract = await cmdFake('tesseract.cmd', '@echo off\r\necho tesseract 5.5.5\r\n');

  const modelData = Buffer.from('fake ggml-small.bin model bytes\n');
  const model = path.join(artifacts, 'ggml-small.bin');
  await writeFile(model, modelData);
  const engData = Buffer.from('fake eng.traineddata\n');
  const eng = path.join(artifacts, 'eng.traineddata');
  await writeFile(eng, engData);

  const zipName = 'fake-tool-b.zip';
  const storedData = Buffer.from('@echo off\r\necho ffmpeg version 99.99.99\r\n');
  const deflatedData = Buffer.from('@echo off\r\nif "%1"=="-bogus" exit /b 3\r\necho ffprobe version 99.99.99\r\n');
  const zipPath = path.join(artifacts, zipName);
  await writeFile(zipPath, zipBuffer([
    { name: 'toolb/stored.txt', data: storedData, method: 0 },
    { name: 'toolb/deflated.txt', data: deflatedData, method: 8 }
  ]));
  const zipData = await readFile(zipPath);

  const nsisData = Buffer.from('fake nsis installer payload\n');
  const nsisPath = path.join(artifacts, 'fake-tool-c-setup.exe');
  await writeFile(nsisPath, nsisData);
  const nsisFileBytes = await readFile(nsisPath);
  const installedData = Buffer.from('@echo off\r\necho tesseract 5.5.5\r\n');

  const components = [
    {
      id: 'ffmpeg',
      name: 'Fake ffmpeg pair',
      kind: 'zip',
      version: '9.9.9',
      url: 'file:///' + zipPath.replace(/\\/g, '/'),
      sha256: sha256(zipData),
      size: zipData.length,
      license: 'MIT',
      licenseUrl: 'https://example.test/ffmpeg',
      files: [
        { from: 'toolb/stored.txt', to: 'ffmpeg/bin/ffmpeg.cmd', sha256: sha256(storedData), size: storedData.length },
        { from: 'toolb/deflated.txt', to: 'ffmpeg/bin/ffprobe.cmd', sha256: sha256(deflatedData), size: deflatedData.length }
      ]
    },
    {
      id: 'whisper-cli',
      name: 'Fake whisper-cli',
      kind: 'file',
      version: 'v9.9.9',
      url: 'file:///' + whisperCli.path.replace(/\\/g, '/'),
      sha256: whisperCli.sha256,
      size: whisperCli.size,
      license: 'MIT',
      licenseUrl: 'https://example.test/whisper',
      files: [{ from: 'whisper-cli.cmd', to: 'whisper/bin/whisper-cli.cmd', sha256: whisperCli.sha256, size: whisperCli.size }]
    },
    {
      id: 'whisper-small-model',
      name: 'Fake small model',
      kind: 'file',
      version: 'small@fake',
      url: 'file:///' + model.replace(/\\/g, '/'),
      sha256: sha256(modelData),
      size: modelData.length,
      license: 'MIT',
      licenseUrl: 'https://example.test/model',
      files: [{ from: 'ggml-small.bin', to: 'whisper/models/ggml-small.bin', sha256: sha256(modelData), size: modelData.length }]
    }
  ];
  if (includeNsis) {
    components.push({
      id: 'tesseract',
      name: 'Fake tesseract installer',
      kind: 'nsis',
      version: '5.5.5',
      url: 'file:///' + nsisPath.replace(/\\/g, '/'),
      sha256: sha256(nsisFileBytes),
      size: nsisFileBytes.length,
      installArgs: ['/S'],
      license: 'Apache-2.0',
      licenseUrl: 'https://example.test/tesseract',
      files: [{ from: 'tesseract.cmd', to: 'tesseract/bin/tesseract.cmd', sha256: sha256(installedData), size: installedData.length }]
    });
  }
  components.push({
    id: 'tessdata-eng',
    name: 'Fake english traineddata',
    kind: 'file',
    version: 'tessdata@fake',
    url: 'file:///' + eng.replace(/\\/g, '/'),
    sha256: sha256(engData),
    size: engData.length,
    license: 'Apache-2.0',
    licenseUrl: 'https://example.test/tessdata',
    files: [{ from: 'eng.traineddata', to: 'tesseract/tessdata/eng.traineddata', sha256: sha256(engData), size: engData.length }]
  });

  const lock = { schemaVersion: 1, platform: PLATFORM, cpu: true, components };
  const lockPath = path.join(dir, 'media-runtime.lock.json');
  await writeFile(lockPath, canonicalLockBytes(lock));
  return {
    dir,
    artifacts: { zip: zipPath, nsis: nsisPath, installedData, modelData, engData },
    lock,
    lockPath
  };
}

function fakeInstaller(installedData) {
  return async (installerPath, installArgs, installDir) => {
    assert.ok(existsSync(installerPath), 'installer artifact must exist');
    assert.deepEqual(installArgs, ['/S']);
    await mkdir(installDir, { recursive: true });
    await writeFile(path.join(installDir, 'tesseract.cmd'), installedData);
  };
}

async function runCli(args) {
  const result = spawnSync(process.execPath, [PREPARE_SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function runGate(args) {
  const result = spawnSync(process.execPath, [GATE_SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function withRuntimeRoot(fn) {
  return async (t) => {
    const previous = process.env.WMB_MEDIA_RUNTIME_ROOT;
    try {
      await fn(t);
    } finally {
      if (previous === undefined) delete process.env.WMB_MEDIA_RUNTIME_ROOT;
      else process.env.WMB_MEDIA_RUNTIME_ROOT = previous;
    }
  };
}

// ---------- prepare 层 ----------

test('validateLock 拒绝非法 lock（缺 sha、坏 kind、坏 url、绝对 to、重复 to）', () => {
  const base = {
    schemaVersion: 1,
    platform: PLATFORM,
    components: [{ id: 'a', kind: 'file', version: '1', url: 'https://x.test/a', sha256: 'a'.repeat(64), size: 1, license: 'MIT', files: [{ from: 'a', to: 'bin/a.exe', sha256: 'a'.repeat(64), size: 1 }] }]
  };
  assert.deepEqual(validateLock(base), []);
  assert.ok(validateLock({ ...base, schemaVersion: 2 }).length > 0, 'schemaVersion');
  assert.ok(validateLock({ ...base, components: [] }).length > 0, '空 components');
  assert.ok(validateLock({ ...base, components: [{ ...base.components[0], kind: 'tar' }] }).length > 0, '坏 kind');
  assert.ok(validateLock({ ...base, components: [{ ...base.components[0], url: 'ftp://x/a' }] }).length > 0, '坏 url');
  assert.ok(validateLock({ ...base, components: [{ ...base.components[0], sha256: 'zzz' }] }).length > 0, '坏 sha');
  assert.ok(validateLock({ ...base, components: [{ ...base.components[0], files: [{ ...base.components[0].files[0], to: '/abs/path' }] }] }).length > 0, '绝对 to');
  assert.ok(validateLock({ ...base, components: [{ ...base.components[0], files: [base.components[0].files[0], base.components[0].files[0]] }] }).length > 0, '重复 to');
});

test('prepareMediaRuntime：file/zip/nsis 三种 kind 就位且字节精确、lock 标记与 manifest 齐全', async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    const manifest = await prepareMediaRuntime(fixture.lock, {
      root,
      runInstaller: fakeInstaller(fixture.artifacts.installedData)
    });
    const expected = fixture.lock.components.map((c) => ({ id: c.id, version: c.version }));
    assert.deepEqual(manifest.components, expected);
    assert.equal(manifest.lockSha256, lockSha256Of(fixture.lock));
    assert.equal(manifest.platform, PLATFORM);
    assert.equal(manifest.fileCount, 6);

    assert.equal(await readFile(path.join(root, 'lock.json'), 'utf8'), canonicalLockBytes(fixture.lock));
    assert.equal((await readFile(path.join(root, 'lock.sha256'), 'utf8')).trim(), lockSha256Of(fixture.lock));

    const stored = await readFile(path.join(root, 'ffmpeg/bin/ffmpeg.cmd'), 'utf8');
    assert.equal(stored, '@echo off\r\necho ffmpeg version 99.99.99\r\n');
    const deflated = await readFile(path.join(root, 'ffmpeg/bin/ffprobe.cmd'), 'utf8');
    assert.equal(deflated, '@echo off\r\nif "%1"=="-bogus" exit /b 3\r\necho ffprobe version 99.99.99\r\n');
    assert.equal(await readFile(path.join(root, 'whisper/bin/whisper-cli.cmd'), 'utf8'), '@echo off\r\necho whisper-cli v9.9.9\r\n');
    assert.equal(await readFile(path.join(root, 'whisper/models/ggml-small.bin'), 'utf8'), 'fake ggml-small.bin model bytes\n');
    assert.equal(await readFile(path.join(root, 'tesseract/bin/tesseract.cmd'), 'utf8'), '@echo off\r\necho tesseract 5.5.5\r\n');
    assert.equal(await readFile(path.join(root, 'tesseract/tessdata/eng.traineddata'), 'utf8'), 'fake eng.traineddata\n');

    const verify = await verifyPreparedRuntime(root, fixture.lock);
    assert.equal(verify.ok, true);
    assert.deepEqual(verify.missing, []);
    assert.deepEqual(verify.hashMismatch, []);
    assert.equal(await isRuntimeValid(root, fixture.lock, lockSha256Of(fixture.lock)), true);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('哈希不符：prepare 抛 MEDIA_RUNTIME_HASH_MISMATCH 且根目录整体移除（无半成品）', async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    const tampered = structuredClone(fixture.lock);
    tampered.components[0].files[0].sha256 = 'f'.repeat(64);
    await assert.rejects(
      prepareMediaRuntime(tampered, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) }),
      (error) => error instanceof MediaRuntimePrepareError && error.code === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH
    );
    assert.equal(existsSync(root), false, '失败后不得留下部分安装');
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('zip 缺条目 → MEDIA_RUNTIME_INCOMPLETE；nsis 安装缺产物 → MEDIA_RUNTIME_INSTALL_FAILED', async () => {
  const fixture = await buildFixture();
  try {
    const root1 = path.join(fixture.dir, 'r1');
    const missingEntry = structuredClone(fixture.lock);
    missingEntry.components[0].files[0].from = 'toolb/does-not-exist.txt';
    await assert.rejects(
      prepareMediaRuntime(missingEntry, { root: root1, runInstaller: fakeInstaller(fixture.artifacts.installedData) }),
      (error) => error instanceof MediaRuntimePrepareError && error.code === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INCOMPLETE
    );

    const root2 = path.join(fixture.dir, 'r2');
    const noInstall = async () => { await mkdir(path.join(fixture.dir, 'empty-install'), { recursive: true }); };
    await assert.rejects(
      prepareMediaRuntime(fixture.lock, { root: root2, runInstaller: noInstall }),
      (error) => error instanceof MediaRuntimePrepareError && error.code === MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_INSTALL_FAILED
    );
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('verifyPreparedRuntime 能发现缺失与哈希不符', async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    await prepareMediaRuntime(fixture.lock, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) });
    await rm(path.join(root, 'whisper/models/ggml-small.bin'));
    await writeFile(path.join(root, 'tesseract/tessdata/eng.traineddata'), Buffer.from('tampered bytes\n'));
    const verify = await verifyPreparedRuntime(root, fixture.lock);
    assert.equal(verify.ok, false);
    assert.ok(verify.missing.some((p) => p.includes('whisper-small-model')));
    assert.ok(verify.hashMismatch.some((p) => p.includes('tessdata-eng')));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('CLI：lock 缺失 → 退出码 2 且输出 MEDIA_RUNTIME_LOCK_MISSING', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-mr-cli-'));
  try {
    const result = await runCli(['--lock', path.join(dir, 'nope.json'), '--root', path.join(dir, 'runtime')]);
    assert.equal(result.status, MEDIA_RUNTIME_EXIT.LOCK_MISSING);
    assert.match(result.output, /MEDIA_RUNTIME_LOCK_MISSING/);
    assert.equal(existsSync(path.join(dir, 'runtime')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI：lock 无效 → 退出码 3', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-mr-cli-'));
  try {
    const badLock = path.join(dir, 'bad.lock.json');
    await writeFile(badLock, '{ not json');
    const result = await runCli(['--lock', badLock, '--root', path.join(dir, 'runtime')]);
    assert.equal(result.status, MEDIA_RUNTIME_EXIT.LOCK_INVALID);
    assert.match(result.output, /MEDIA_RUNTIME_LOCK_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI：平台不符 → 退出码 8', async () => {
  const fixture = await buildFixture({ includeNsis: false });
  try {
    const foreign = structuredClone(fixture.lock);
    foreign.platform = 'linux-x64';
    const lockPath = path.join(fixture.dir, 'foreign.lock.json');
    await writeFile(lockPath, canonicalLockBytes(foreign));
    const result = await runCli(['--lock', lockPath, '--root', path.join(fixture.dir, 'runtime')]);
    assert.equal(result.status, MEDIA_RUNTIME_EXIT.PLATFORM_MISMATCH);
    assert.match(result.output, /MEDIA_RUNTIME_PLATFORM_MISMATCH/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('CLI：哈希不符 → 退出码 4，根目录被清理', async () => {
  const fixture = await buildFixture({ includeNsis: false });
  try {
    const tampered = structuredClone(fixture.lock);
    tampered.components[2].files[0].sha256 = 'e'.repeat(64);
    const lockPath = path.join(fixture.dir, 'tampered.lock.json');
    await writeFile(lockPath, canonicalLockBytes(tampered));
    const root = path.join(fixture.dir, 'runtime');
    const result = await runCli(['--lock', lockPath, '--root', root]);
    assert.equal(result.status, MEDIA_RUNTIME_EXIT.HASH_MISMATCH);
    assert.match(result.output, /MEDIA_RUNTIME_HASH_MISMATCH/);
    assert.equal(existsSync(root), false);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('CLI：成功准备后二次运行幂等采用既有运行时（退出码 0，无需重下）', async () => {
  // CLI 无法注入假安装器，故用 file+zip 组件（无 nsis）；nsis 路径由上面的注入测试覆盖。
  const fixture = await buildFixture({ includeNsis: false });
  try {
    const root = path.join(fixture.dir, 'runtime');
    const first = await runCli(['--lock', fixture.lockPath, '--root', root]);
    assert.equal(first.status, MEDIA_RUNTIME_EXIT.OK, first.output);
    assert.match(first.output, /准备完成/);
    const second = await runCli(['--lock', fixture.lockPath, '--root', root]);
    assert.equal(second.status, MEDIA_RUNTIME_EXIT.OK, second.output);
    assert.match(second.output, /采用既有运行时/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

// ---------- 运行时定位/断言层 ----------

test('运行时缺失：probe available=false code=MEDIA_RUNTIME_MISSING，assert 抛稳定码，应用仍可启动（无悬挂/无 PATH 回退）', withRuntimeRoot(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-mr-empty-'));
  try {
    process.env.WMB_MEDIA_RUNTIME_ROOT = path.join(dir, 'no-runtime');
    const probe = await RUNTIME.probeMediaRuntime();
    assert.equal(probe.available, false);
    assert.equal(probe.code, RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING);
    assert.equal(probe.lockSha256, null);
    await assert.rejects(
      RUNTIME.assertMediaRuntime(),
      (error) => RUNTIME.isMediaRuntimeError(error) && error.code === RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING
    );
    assert.equal(await RUNTIME.mediaRuntimeBinPaths(), null);
    assert.equal(await RUNTIME.mediaRuntimeComponentVersion('ffmpeg'), null);
    assert.equal(await RUNTIME.mediaRuntimeManifestHash(), null);
    // runMediaRuntimeCommand 同样以 MEDIA_RUNTIME_MISSING 拒绝（绝不找 PATH）
    await assert.rejects(
      RUNTIME.runMediaRuntimeCommand('ffprobe', ['-version']),
      (error) => RUNTIME.isMediaRuntimeError(error) && error.code === RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}));

test('运行时就绪：probe available、binPaths 指向 root 内绝对路径、版本探测输出、命令执行', withRuntimeRoot(async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    await prepareMediaRuntime(fixture.lock, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) });
    process.env.WMB_MEDIA_RUNTIME_ROOT = root;

    const probe = await RUNTIME.probeMediaRuntime({ versions: true, probeShell: true });
    assert.equal(probe.available, true);
    assert.equal(probe.code, null);
    assert.equal(probe.lockSha256, lockSha256Of(fixture.lock));
    assert.ok(probe.probeOutput, '应执行版本探测');
    assert.match(probe.probeOutput.ffprobe, /ffprobe version 99\.99\.99/);
    assert.match(probe.probeOutput['whisper-cli'], /whisper-cli v9\.9\.9/);
    assert.match(probe.probeOutput.tesseract, /tesseract 5\.5\.5/);
    assert.equal(probe.versions.ffmpeg, '9.9.9');
    assert.equal(probe.versions['whisper-small-model'], 'small@fake');

    const asserted = await RUNTIME.assertMediaRuntime({ versions: true, probeShell: true });
    assert.equal(asserted.lockSha256, lockSha256Of(fixture.lock));
    assert.equal(asserted.binPaths.ffprobe, path.join(root, 'ffmpeg/bin/ffprobe.cmd'));
    assert.equal(asserted.binPaths.whisperModel, path.join(root, 'whisper/models/ggml-small.bin'));
    assert.equal(asserted.binPaths.tessdata, path.join(root, 'tesseract/tessdata'));

    // 命令执行（.cmd 假体需 shell；生产真实 .exe 用 shell:false）
    const run = await RUNTIME.runMediaRuntimeCommand('ffprobe', ['-version'], { shell: true });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /ffprobe version 99\.99\.99/);
    await assert.rejects(
      RUNTIME.runMediaRuntimeCommand('ffprobe', ['-bogus'], { shell: true, timeoutMs: 5000 }),
      (error) => error instanceof Error && /退出码/.test(error.message)
    );

    const tessEnv = await RUNTIME.tesseractEnv();
    assert.equal(tessEnv.TESSDATA_PREFIX, path.join(root, 'tesseract/tessdata'));
    assert.equal(await RUNTIME.mediaRuntimeComponentVersion('whisper-cli'), 'v9.9.9');
    assert.equal(await RUNTIME.mediaRuntimeManifestHash(), lockSha256Of(fixture.lock));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
}));

test('哈希不符：probe code=MEDIA_RUNTIME_HASH_MISMATCH', withRuntimeRoot(async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    await prepareMediaRuntime(fixture.lock, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) });
    await writeFile(path.join(root, 'whisper/models/ggml-small.bin'), Buffer.from('corrupted\n'));
    process.env.WMB_MEDIA_RUNTIME_ROOT = root;
    const probe = await RUNTIME.probeMediaRuntime();
    assert.equal(probe.available, false);
    assert.equal(probe.code, RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH);
    assert.ok(probe.hashMismatch.some((p) => p.includes('whisper/models')));
    await assert.rejects(RUNTIME.assertMediaRuntime(), (e) => RUNTIME.mediaRuntimeErrorCode(e) === RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_HASH_MISMATCH);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
}));

test('lock 标记不符：probe code=MEDIA_RUNTIME_LOCK_MISMATCH（lock 变更但未重新 prepare）', withRuntimeRoot(async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    await prepareMediaRuntime(fixture.lock, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) });
    await writeFile(path.join(root, 'lock.sha256'), 'f'.repeat(64));
    process.env.WMB_MEDIA_RUNTIME_ROOT = root;
    const probe = await RUNTIME.probeMediaRuntime();
    assert.equal(probe.available, false);
    assert.equal(probe.code, RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_LOCK_MISMATCH);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
}));

test('无 PATH 回退：PATH 里放同名假 ffprobe 也不被解析，binPaths 始终指向 root', withRuntimeRoot(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wmb-mr-path-'));
  try {
    const decoyDir = path.join(dir, 'decoy-bin');
    await mkdir(decoyDir, { recursive: true });
    await copyFile(process.execPath, path.join(decoyDir, 'ffprobe.exe'));
    process.env.PATH = `${decoyDir}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.WMB_MEDIA_RUNTIME_ROOT = path.join(dir, 'no-runtime');
    const probe = await RUNTIME.probeMediaRuntime();
    assert.equal(probe.available, false);
    assert.equal(probe.code, RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING);
    assert.equal(await RUNTIME.mediaRuntimeBinPaths(), null);
    await assert.rejects(RUNTIME.runMediaRuntimeCommand('ffprobe', ['-version']), (e) => RUNTIME.mediaRuntimeErrorCode(e) === RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}));

test('契约一致：TS 模块与 prepare 脚本共享的稳定码字符串完全一致', () => {
  for (const key of ['MEDIA_RUNTIME_MISSING', 'MEDIA_RUNTIME_HASH_MISMATCH', 'MEDIA_RUNTIME_LOCK_MISMATCH', 'MEDIA_RUNTIME_LOCK_MISSING']) {
    assert.equal(RUNTIME.MEDIA_RUNTIME_CODES[key], MEDIA_RUNTIME_CODES[key], `code ${key} 必须一致`);
    assert.ok(RUNTIME.MEDIA_RUNTIME_CODES[key].startsWith('MEDIA_RUNTIME_'));
  }
  for (const [key, value] of Object.entries(RUNTIME.MEDIA_RUNTIME_CODES)) {
    assert.equal(MEDIA_RUNTIME_CODES[key], value, `TS 码 ${key} 在 prepare 侧必须存在且一致`);
  }
  assert.equal(RUNTIME.MEDIA_RUNTIME_MISSING, RUNTIME.MEDIA_RUNTIME_CODES.MEDIA_RUNTIME_MISSING);
});

// ---------- 打包门禁层 ----------

/** 构造一个模拟打包产物目录：<out>/resources/.r/media-runtime，lock/标记与 gateLock 完全一致。 */
async function buildPackagedOutput(fixture, root, gateLock, { dropRuntime = false, badProbe = false } = {}) {
  const out = path.join(fixture.dir, 'packaged');
  const gateLockPath = path.join(fixture.dir, 'gate.lock.json');
  if (dropRuntime) {
    await writeFile(gateLockPath, canonicalLockBytes(gateLock));
    return { out, gateLockPath };
  }
  const runtimeRoot = path.join(out, 'resources', '.r', 'media-runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const entries = ['ffmpeg/bin/ffmpeg.cmd', 'ffmpeg/bin/ffprobe.cmd', 'whisper/bin/whisper-cli.cmd',
    'whisper/models/ggml-small.bin', 'tesseract/bin/tesseract.cmd', 'tesseract/tessdata/eng.traineddata'];
  for (const rel of entries) {
    await mkdir(path.dirname(path.join(runtimeRoot, rel)), { recursive: true });
    await copyFile(path.join(root, rel), path.join(runtimeRoot, rel));
  }
  if (badProbe) {
    // 用 lock 中已登记哈希的“不可执行”内容顶替 ffprobe → 哈希校验通过但实际执行失败
    const bad = Buffer.from('not an executable\n');
    const c = gateLock.components.find((x) => x.id === 'ffmpeg');
    const f = c.files.find((x) => x.to === 'ffmpeg/bin/ffprobe.cmd');
    f.sha256 = sha256(bad);
    f.size = bad.length;
    await writeFile(path.join(runtimeRoot, 'ffmpeg/bin/ffprobe.cmd'), bad);
  }
  await writeFile(path.join(runtimeRoot, 'lock.json'), canonicalLockBytes(gateLock));
  await writeFile(path.join(runtimeRoot, 'lock.sha256'), lockSha256Of(gateLock));
  await writeFile(gateLockPath, canonicalLockBytes(gateLock));
  return { out, gateLockPath };
}

test('打包门禁：真实执行三个冻结命令（ffprobe -version / whisper-cli --help / tesseract --version）并通过', async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    await prepareMediaRuntime(fixture.lock, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) });
    const packaged = await buildPackagedOutput(fixture, root, fixture.lock);
    const result = await runGate(['--output', packaged.out, '--lock', packaged.gateLockPath, '--probe-shell']);
    assert.equal(result.status, MEDIA_RUNTIME_EXIT.OK, result.output);
    assert.match(result.output, /ffprobe -version: ffprobe version 99\.99\.99/);
    assert.match(result.output, /whisper-cli --help: whisper-cli v9\.9\.9/);
    assert.match(result.output, /tesseract --version: tesseract 5\.5\.5/);
    assert.match(result.output, /门禁通过/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('打包门禁：运行时缺失 → 退出码 MISSING(1)；lock.json 被篡改 → LOCK_MISMATCH(10)', async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    await prepareMediaRuntime(fixture.lock, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) });

    const missing = await buildPackagedOutput(fixture, root, fixture.lock, { dropRuntime: true });
    const resultMissing = await runGate(['--output', missing.out, '--lock', missing.gateLockPath, '--probe-shell']);
    assert.equal(resultMissing.status, MEDIA_RUNTIME_EXIT.MISSING);
    assert.match(resultMissing.output, /MEDIA_RUNTIME_MISSING/);

    // lock.json 与仓库 lock 不一致（内容被篡改但 marker 仍按 gateLock 写 → 字节哈希不符）
    const out = path.join(fixture.dir, 'packaged-tampered');
    const runtimeRoot = path.join(out, 'resources', '.r', 'media-runtime');
    await mkdir(runtimeRoot, { recursive: true });
    for (const rel of ['ffmpeg/bin/ffmpeg.cmd', 'ffmpeg/bin/ffprobe.cmd', 'whisper/bin/whisper-cli.cmd',
      'whisper/models/ggml-small.bin', 'tesseract/bin/tesseract.cmd', 'tesseract/tessdata/eng.traineddata']) {
      await mkdir(path.dirname(path.join(runtimeRoot, rel)), { recursive: true });
      await copyFile(path.join(root, rel), path.join(runtimeRoot, rel));
    }
    await writeFile(path.join(runtimeRoot, 'lock.json'), canonicalLockBytes(fixture.lock).replace('schemaVersion', 'schemaVersion '));
    await writeFile(path.join(runtimeRoot, 'lock.sha256'), lockSha256Of(fixture.lock));
    const gateLockPath = path.join(fixture.dir, 'gate.lock.json');
    await writeFile(gateLockPath, canonicalLockBytes(fixture.lock));
    const resultTampered = await runGate(['--output', out, '--lock', gateLockPath, '--probe-shell']);
    assert.equal(resultTampered.status, MEDIA_RUNTIME_EXIT.LOCK_MISMATCH);
    assert.match(resultTampered.output, /MEDIA_RUNTIME_LOCK_MISMATCH/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('打包门禁：探测命令实际执行失败（文件哈希对但不可执行）→ INSTALL_FAILED(6)', async () => {
  const fixture = await buildFixture();
  try {
    const root = path.join(fixture.dir, 'runtime');
    await prepareMediaRuntime(fixture.lock, { root, runInstaller: fakeInstaller(fixture.artifacts.installedData) });
    const gateLock = structuredClone(fixture.lock);
    const packaged = await buildPackagedOutput(fixture, root, gateLock, { badProbe: true });
    const result = await runGate(['--output', packaged.out, '--lock', packaged.gateLockPath, '--probe-shell']);
    assert.equal(result.status, MEDIA_RUNTIME_EXIT.INSTALL_FAILED, result.output);
    assert.match(result.output, /INSTALL_FAILED/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('zip 读取器：store 与 deflate 条目均可解析（readZipIndex/extractZipEntry 直接单测）', () => {
  const stored = Buffer.from('hello stored');
  const zip = zipBuffer([
    { name: 'a.bin', data: stored, method: 0 },
    { name: 'b.bin', data: Buffer.from('hello deflated'), method: 8 }
  ]);
  const index = readZipIndex(zip);
  assert.equal(index.size, 2);
  assert.equal(extractZipEntry(zip, index.get('a.bin')).toString(), 'hello stored');
  assert.equal(extractZipEntry(zip, index.get('b.bin')).toString(), 'hello deflated');
});

test('真实 lock 文件：media-runtime.lock.json 结构完整、URL 不可变、许可证齐全、SHA 合法', async () => {
  const lock = JSON.parse(await readFile(path.join(REPO_ROOT, 'media-runtime.lock.json'), 'utf8'));
  const errors = validateLock(lock);
  assert.deepEqual(errors, []);
  assert.equal(lock.platform, 'win32-x64');
  assert.equal(lock.cpu, true);
  const ids = lock.components.map((c) => c.id);
  assert.deepEqual(ids, ['ffmpeg', 'whisper-cli', 'whisper-small-model', 'tesseract', 'tessdata-eng', 'tessdata-chi-sim']);
  for (const component of lock.components) {
    assert.match(component.url, /^https:\/\//, `${component.id} URL 必须为不可变 https`);
    assert.doesNotMatch(component.url, /latest/i, `${component.id} 不得使用 latest 可变 URL`);
    assert.ok(component.license, `${component.id} 必须记录许可证`);
    assert.match(component.licenseUrl, /^https:\/\//, `${component.id} licenseUrl`);
    assert.match(component.sha256, /^[0-9a-f]{64}$/);
    for (const file of component.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!path.isAbsolute(file.to), `${component.id} ${file.to} 必须为相对路径`);
    }
  }
  const versionOf = (id) => lock.components.find((c) => c.id === id).version;
  assert.equal(versionOf('ffmpeg'), '8.1.2');
  assert.equal(versionOf('whisper-cli'), 'v1.9.2');
  assert.equal(versionOf('tesseract'), '5.5.3.20260724');
  assert.match(versionOf('whisper-small-model'), /^small@[0-9a-f]{40}$/);
  assert.match(versionOf('tessdata-eng'), /^tessdata@[0-9a-f]{40}$/);
  assert.ok(lock.components.every((c) => c.files.length >= 1));
});
