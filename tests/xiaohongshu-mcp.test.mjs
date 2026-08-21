import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startXhsMcp, XHS_FORBIDDEN_TOOLS, XHS_REQUIRED_TOOLS } from '../src/main/xiaohongshu-mcp.ts';

const vendorDir = path.resolve('resources/xiaohongshu-mcp');
const XHS_MAIN_BINARY = path.join(vendorDir, 'xiaohongshu-mcp-windows-amd64.exe');
const XHS_LOGIN_BINARY = path.join(vendorDir, 'xiaohongshu-login-windows-amd64.exe');

async function xhsBinariesAvailable() {
  try {
    await access(XHS_MAIN_BINARY);
    await access(XHS_LOGIN_BINARY);
    return true;
  } catch {
    return false;
  }
}

async function skipIfXhsBinaryMissing(t) {
  if (await xhsBinariesAvailable()) return false;
  const reason =
    `跳过：缺少受管二进制 ${XHS_MAIN_BINARY}（及 ${XHS_LOGIN_BINARY}），` +
    '请先运行 npm run verify:xhs-resources 同步资源（校验见 scripts/verify-xiaohongshu-mcp-resources.mjs：manifest version v2.1.1 / Apache-2.0，逐 asset 校验 size+sha256，禁止 cookies.json 落盘）';
  t.skip(reason);
  return true;
}

test('xhs supervisor starts on loopback, exposes four required tools, and blocks write tools', async (t) => {
  if (await skipIfXhsBinaryMissing(t)) return;
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'wmb-xhs-data-'));
  let runtime = null;
  try {
    runtime = await startXhsMcp(dataRoot, { vendorDir });
    const status = runtime.status();
    assert.ok(['ready', 'needs_user', 'tool_mismatch', 'process_failed'].includes(status.status), status.status);
    assert.ok(status.url?.startsWith('http://127.0.0.1:'));
    assert.equal(status.runtimeDir, path.join(dataRoot, 'xiaohongshu-mcp'));
    assert.ok(status.cookiesPath?.endsWith(`${path.sep}xiaohongshu-mcp${path.sep}cookies.json`));
    assert.ok(status.pid && status.pid > 0);
    for (const tool of XHS_REQUIRED_TOOLS) assert.ok(status.tools.includes(tool), tool);
    assert.equal(status.requiredToolsPresent, true);
    // cookies file should only appear under data root runtime dir, not vendor
    assert.ok(!status.cookiesPath?.includes(`${path.sep}resources${path.sep}xiaohongshu-mcp${path.sep}`));

    await assert.rejects(
      () => runtime.callTool('publish_content', { title: 'x' }),
      /禁止调用|not allowed|写工具/
    );
    await assert.rejects(
      () => runtime.callTool('delete_cookies', {}),
      /禁止调用|not allowed|写工具/
    );

    // required tool call path should not throw tool_mismatch/process path if service up
    if (status.status === 'ready' || status.status === 'needs_user') {
      const login = await runtime.callTool('check_login_status', {});
      assert.ok(login !== undefined);
    }
  } finally {
    await runtime?.stop().catch(() => {});
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
test('xhs supervisor stop leaves no listening child and can restart under new data root', async (t) => {
  if (await skipIfXhsBinaryMissing(t)) return;
  const rootA = await mkdtemp(path.join(os.tmpdir(), 'wmb-xhs-a-'));
  const rootB = await mkdtemp(path.join(os.tmpdir(), 'wmb-xhs-b-'));
  let runtimeA = null;
  let runtimeB = null;
  try {
    runtimeA = await startXhsMcp(rootA, { vendorDir });
    const statusA = runtimeA.status();
    assert.ok(statusA.port);
    const oldPort = statusA.port;
    await runtimeA.stop();
    // old port should no longer serve health
    let dead = false;
    try {
      await fetch(`http://127.0.0.1:${oldPort}/health`);
    } catch {
      dead = true;
    }
    assert.equal(dead, true);

    runtimeB = await startXhsMcp(rootB, { vendorDir });
    const statusB = runtimeB.status();
    assert.ok(statusB.port);
    assert.notEqual(statusB.port, oldPort);
    assert.equal(statusB.runtimeDir, path.join(rootB, 'xiaohongshu-mcp'));
  } finally {
    await runtimeA?.stop().catch(() => {});
    await runtimeB?.stop().catch(() => {});
    await rm(rootA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(rootB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('forbidden tools list includes publish and interaction mutations', () => {
  for (const name of [
    'publish_content',
    'publish_with_video',
    'like_feed',
    'favorite_feed',
    'post_comment_to_feed',
    'delete_cookies'
  ]) {
    assert.ok(XHS_FORBIDDEN_TOOLS.includes(name), name);
  }
  assert.deepEqual([...XHS_REQUIRED_TOOLS], [
    'check_login_status',
    'search_feeds',
    'get_feed_detail',
    'user_profile'
  ]);
});


test('xhs supervisor recovers after child process kill on next ensureReady', async (t) => {
  if (await skipIfXhsBinaryMissing(t)) return;
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'wmb-xhs-kill-'));
  let runtime = null;
  try {
    runtime = await startXhsMcp(dataRoot, { vendorDir });
    const first = runtime.status();
    assert.ok(first.pid);
    process.kill(first.pid);
    // wait for exit observation
    await new Promise((r) => setTimeout(r, 500));
    const recovered = await runtime.ensureReady();
    assert.ok(['ready', 'needs_user', 'tool_mismatch', 'process_failed'].includes(recovered.status));
    if (recovered.status === 'process_failed') {
      assert.ok(recovered.lastError);
    } else {
      assert.ok(recovered.pid);
      assert.notEqual(recovered.pid, first.pid);
      assert.ok(recovered.url?.startsWith('http://127.0.0.1:'));
    }
  } finally {
    await runtime?.stop().catch(() => {});
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
