import test from 'node:test';
import assert from 'node:assert/strict';
import { initSystemProxy, currentSystemProxy, proxyEnvForChildren, __test } from '../src/main/proxy-config.ts';

test('parseResolveProxy extracts PROXY host:port as http URL', () => {
  assert.equal(__test.parseResolveProxy('PROXY 127.0.0.1:17890'), 'http://127.0.0.1:17890');
  assert.equal(__test.parseResolveProxy('HTTPS proxy.example.com:8443'), 'http://proxy.example.com:8443');
});

test('parseResolveProxy returns null for DIRECT and PAC paths', () => {
  assert.equal(__test.parseResolveProxy('DIRECT'), null);
  assert.equal(__test.parseResolveProxy(''), null);
  assert.equal(__test.parseResolveProxy('file:///C:/proxy.pac'), null);
});

test('parseResolveProxy takes first usable entry from semicolon chain', () => {
  assert.equal(__test.parseResolveProxy('PROXY a:1;PROXY b:2;DIRECT'), 'http://a:1');
  assert.equal(__test.parseResolveProxy('DIRECT;PROXY b:2'), 'http://b:2'); // 首段 DIRECT 跳过，次段命中
});

test('isLoopbackUrl exempts loopback and private ranges, flags public', () => {
  assert.equal(__test.isLoopbackUrl('http://127.0.0.1:8080/mcp'), true);
  assert.equal(__test.isLoopbackUrl('http://localhost/health'), true);
  assert.equal(__test.isLoopbackUrl('http://192.168.1.5/x'), true);
  assert.equal(__test.isLoopbackUrl('http://172.16.0.9/x'), true);
  assert.equal(__test.isLoopbackUrl('http://172.32.0.9/x'), false);
  assert.equal(__test.isLoopbackUrl('https://api.github.com/'), false);
  assert.equal(__test.isLoopbackUrl('ftp://example.com/'), true); // 非 http(s) 一律不走代理
});

test('initSystemProxy with env proxy preserves distinct child variables', async () => {
  const previous = { ...process.env };
  process.env.HTTP_PROXY = 'http://http-proxy.test:8080';
  process.env.HTTPS_PROXY = 'http://https-proxy.test:8443';
  process.env.ALL_PROXY = 'http://fallback-proxy.test:1080';
  try {
    const config = await initSystemProxy();
    assert.equal(config.source, 'env');
    assert.equal(config.proxyUrl, 'http://https-proxy.test:8443');
    const childEnv = proxyEnvForChildren();
    assert.equal(childEnv.HTTPS_PROXY, 'http://https-proxy.test:8443');
    assert.equal(childEnv.HTTP_PROXY, 'http://http-proxy.test:8080');
    assert.equal(childEnv.ALL_PROXY, 'http://fallback-proxy.test:1080');
    assert.match(childEnv.NO_PROXY, /127\.0\.0\.1/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});


test('initSystemProxy without env or resolver stays direct and emits no child env', async () => {
  const previous = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, ALL_PROXY: process.env.ALL_PROXY };
  delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY; delete process.env.ALL_PROXY;
  delete process.env.https_proxy; delete process.env.http_proxy; delete process.env.all_proxy;
  try {
    const config = await initSystemProxy(async () => 'DIRECT');
    assert.deepEqual(config, { proxyUrl: null, source: 'none' });
    assert.deepEqual(proxyEnvForChildren(), {});
    assert.equal(currentSystemProxy().source, 'none');
  } finally {
    Object.assign(process.env, previous);
  }
});

test('initSystemProxy adopts resolver verdict when system proxy present', async () => {
  const previous = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, ALL_PROXY: process.env.ALL_PROXY };
  delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY; delete process.env.ALL_PROXY;
  delete process.env.https_proxy; delete process.env.http_proxy; delete process.env.all_proxy;
  try {
    const config = await initSystemProxy(async () => 'PROXY 10.0.0.2:7890');
    assert.equal(config.source, 'system');
    assert.equal(config.proxyUrl, 'http://10.0.0.2:7890');
    assert.equal(proxyEnvForChildren().HTTP_PROXY, 'http://10.0.0.2:7890');
  } finally {
    Object.assign(process.env, previous);
    // 还原 dispatcher 为直连，避免污染后续测试
    await initSystemProxy(async () => 'DIRECT');
  }
});
