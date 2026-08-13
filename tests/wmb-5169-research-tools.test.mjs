import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AGENT_CAPABILITIES,
  roleReadTools,
  TASK_INTENT_NEEDED_CAPS
} from '../src/shared/agent-capabilities.ts';
import {
  assertPublicDns,
  assertPublicUrl,
  hostnameOf,
  resolveWebsiteCandidates
} from '../src/main/website-channel.ts';
import { guardResearchDocument, headlessRenderPublicPage, readWebPage, searchWeb } from '../src/main/research-web-read.ts';
import { startMcp } from '../src/main/mcp.ts';

const WHITELIST = [
  'wmb_search_web',
  'wmb_read_web_page',
  'wmb_read_x_list_index',
  'wmb_read_x_list_detail',
  'wmb_read_x_list_members',
  'wmb_read_x_list_timeline',
  'xhs_check_login_status',
  'xhs_search_feeds',
  'xhs_get_feed_detail',
  'xhs_user_profile',
  'wmb_get_source',
  'wmb_search_sources'
];

const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const staticOk = (body, { status = 200, contentType = 'text/html' } = {}) => async () =>
  new Response(body, { status, headers: { 'content-type': contentType } });
const publicDns = () => async () => [{ address: '93.184.216.34', family: 4 }];

// ---- Capability registry -------------------------------------------------

test('cap.research entry matches the legislated contract exactly', () => {
  const cap = AGENT_CAPABILITIES.find((candidate) => candidate.id === 'cap.research');
  assert.ok(cap, 'cap.research must be registered');
  assert.equal(cap.displayName, '研究补料');
  assert.deepEqual([...cap.commands], ['sources.upsert_batch']);
  assert.deepEqual([...cap.readProfiles], ['sources', 'x_lists']);
  assert.deepEqual([...cap.readToolWhitelist], WHITELIST);
  // WMB-5182：cap.research 绑定 desk（supervisor 全站 standing 含研究命令，CAP-028 §1 / 2026-08-10 flip）。
  assert.deepEqual(cap.defaultRoleBindings, { reporter: true, desk: true });
  assert.deepEqual(cap.grantKinds, { task: ['research'] });
  assert.equal(cap.precise, false);
  assert.equal(cap.agentGrantable, true);
  assert.equal(cap.owner, 'intelligence');
  assert.equal(cap.since, '2026-08-10');
});

test('readToolWhitelist is optional and only cap.research carries it', () => {
  const whitelisted = AGENT_CAPABILITIES.filter((cap) => cap.readToolWhitelist !== undefined);
  assert.equal(whitelisted.length, 1);
  assert.equal(whitelisted[0].id, 'cap.research');
  for (const cap of AGENT_CAPABILITIES) {
    if (cap.id === 'cap.research') continue;
    assert.equal(cap.readToolWhitelist, undefined, `${cap.id} must stay whitelist-free`);
  }
});

test('roleReadTools projects the whitelist for reporter and empty sets for employees', () => {
  assert.deepEqual(roleReadTools('reporter'), [...WHITELIST].sort());
  // WMB-5182：cap.research 绑定 desk（supervisor 全站 standing 含研究命令，CAP-028 §1）→ desk 投影同白名单。
  assert.deepEqual(roleReadTools('desk'), [...WHITELIST].sort(), 'desk must project the research read-tool set');
  for (const role of ['planner', 'writer', 'librarian']) {
    assert.deepEqual(roleReadTools(role), [], `${role} must project an empty read-tool set`);
  }
});

test('grant/intent wiring is live (research intent requires cap.research)', () => {
  assert.deepEqual(TASK_INTENT_NEEDED_CAPS.research, ['cap.research']);
});

// ---- Tool mounting -------------------------------------------------------

test('research tools are mounted and reachable through the MCP server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5169-mcp-'));
  const mcp = await startMcp(root);
  try {
    const initialized = await mcpRequest(mcp.url, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmb-5169-test', version: '1' }
    });
    // The SDK's createMcpHandler modern leg is per-request/stateless: initialize returns 200
    // with no mcp-session-id, and every request stands alone — no session header is used below.
    const listed = await mcpRequest(mcp.url, 'tools/list', {});
    const names = listed.data.tools.map((tool) => tool.name);
    assert.ok(names.includes('research.search_web'), 'research.search_web must be listed');
    assert.ok(names.includes('research.read_web_page'), 'research.read_web_page must be listed');
    // Fresh root without a workspace profile must not 500 at initialize (mcpRequest asserts 2xx)
    // and must fail-closed: the AI-only route is not exposed, research tools still are.
    assert.equal(names.includes('sources.wire_health_get'), false, 'AI-only routes must not be exposed without a workspace profile');

    // End-to-end through the real mounted handler; a private URL fails before any request.
    const searchCall = await mcpRequest(mcp.url, 'tools/call', {
      name: 'research.search_web', arguments: { query: 'http://10.0.0.1/x' }
    });
    const searchPayload = JSON.parse(searchCall.data.content[0].text);
    assert.equal(searchPayload.ok, false);
    assert.equal(searchPayload.error.reason, 'ssrf');

    const readCall = await mcpRequest(mcp.url, 'tools/call', {
      name: 'research.read_web_page', arguments: { url: 'http://127.0.0.1/private' }
    });
    const readPayload = JSON.parse(readCall.data.content[0].text);
    assert.equal(readPayload.ok, false);
    assert.equal(readPayload.error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(readPayload.error.reason, 'ssrf');
  } finally {
    // McpRuntime.close awaits the MCP handler's close (aborts in-flight sessions) before the
    // HTTP server shuts down; the bounded retry covers Windows handle-recycling timing. A leaked
    // handler keeps wmb.db locked and rm throws EBUSY persistently (11s of retries failed before
    // the fix), so the retry never masks a real leak.
    await mcp.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Pi extension registers wmb_search_web and wmb_read_web_page', async () => {
  process.env.WMB_MCP_URL = 'http://127.0.0.1:1/mcp';
  process.env.WMB_XHS_MCP_URL = 'http://127.0.0.1:1/xhs';
  const tools = new Map();
  const extension = (await import(`../.pi/extensions/wmb-mcp/index.ts?research=${Date.now()}`)).default;
  extension({ registerTool: (tool) => tools.set(tool.name, tool) });
  const search = tools.get('wmb_search_web');
  const read = tools.get('wmb_read_web_page');
  assert.ok(search, 'wmb_search_web must be registered by the Pi extension');
  assert.ok(read, 'wmb_read_web_page must be registered by the Pi extension');
  assert.equal(search.parameters.required[0], 'query');
  assert.equal(read.parameters.required[0], 'url');
});

// ---- search_web ----------------------------------------------------------

const bingHtml = (entries) => entries
  .map(([title, href]) => `<li class="b_algo"><h2><a href="${href}">${title}</a></h2></li>`)
  .join('');

test('search_web parses public candidates and direct URLs', async () => {
  const searched = await searchWeb({
    query: 'GLM 5.2 official pricing',
    fetchImpl: async () => new Response(bingHtml([
      ['GLM 5.2 official pricing', 'https://zhipuai.cn/pricing'],
      ['OpenRouter GLM model page', 'https://openrouter.ai/models/zhipu/glm-5.2']
    ]), { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(searched.ok, true);
  assert.equal(searched.data.resultCount, 2);
  assert.equal(searched.data.candidates[0].url, 'https://zhipuai.cn/pricing');
  assert.equal(searched.data.candidates[0].origin, 'bing_search');

  const direct = await searchWeb({ query: 'https://example.com/updates/' });
  assert.equal(direct.ok, true);
  assert.equal(direct.data.resultCount, 1);
  assert.equal(direct.data.candidates[0].canonicalUrl, 'https://example.com/updates');
});

test('search_web limit supports 1..40 while the channel default stays 8', async () => {
  const many = Array.from({ length: 12 }, (_, index) => [`Result ${index}`, `https://example.com/r/${index}`]);
  const fetchImpl = async () => new Response(bingHtml(many), { status: 200, headers: { 'content-type': 'text/html' } });

  const wide = await searchWeb({ query: 'many results', limit: 40, fetchImpl });
  assert.equal(wide.ok, true);
  assert.equal(wide.data.resultCount, 12);

  const channelDefault = await resolveWebsiteCandidates({ inputText: 'many results', fetchImpl });
  assert.equal(channelDefault.length, 8, 'channel default candidate cap must stay 8');
  const channelWide = await resolveWebsiteCandidates({ inputText: 'many results', fetchImpl, maxCandidates: 12 });
  assert.equal(channelWide.length, 12);
});

test('search_web fails closed on private-only results, missing input and search failure', async () => {
  const privateOnly = await searchWeb({
    query: 'private',
    fetchImpl: async () => new Response(bingHtml([['Private', 'http://127.0.0.1/x']]), { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(privateOnly.ok, false);
  assert.equal(privateOnly.error.reason, 'ssrf');

  const empty = await searchWeb({ query: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.reason, 'invalid_url');

  const down = await searchWeb({ query: 'down', fetchImpl: async () => new Response('down', { status: 503 }) });
  assert.equal(down.ok, false);
  assert.equal(down.error.reason, 'network');
});

// ---- read_web_page: static path ------------------------------------------

test('read_web_page static success returns title and body without fallback', async () => {
  let renders = 0;
  const result = await readWebPage({
    url: 'https://example.com/news/2026/glm52',
    lookupImpl: publicDns(),
    fetchImpl: staticOk(html('GLM 5.2 pricing page', '<h1>Official pricing</h1><p>智谱官方发布 GLM 5.2 定价调整说明，正文足够长以供阅读与引用。</p>')),
    renderFn: async () => { renders += 1; throw new Error('must not render'); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.renderMode, 'static');
  assert.equal(result.data.title, 'GLM 5.2 pricing page');
  assert.match(result.data.bodyText, /Official pricing/);
  assert.equal(renders, 0);
});

test('read_web_page rejects private/loopback/internal/link-local URLs without any request', async () => {
  const privateUrls = [
    'http://127.0.0.1/x', 'http://10.0.0.1/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x',
    'http://169.254.169.254/x', 'http://localhost/x', 'http://api.localhost/x',
    'http://[::1]/x', 'http://[fd00::1]/x', 'http://[fe80::1]/x'
  ];
  for (const url of privateUrls) {
    let fetched = 0;
    let rendered = 0;
    const result = await readWebPage({
      url,
      fetchImpl: async () => { fetched += 1; return new Response('x', { status: 200 }); },
      renderFn: async () => { rendered += 1; return { status: 200, contentType: 'text/html', finalUrl: url, title: 'x', bodyText: 'x' }; }
    });
    assert.equal(result.ok, false, url);
    assert.equal(result.error.reason, 'ssrf', url);
    assert.equal(fetched, 0, `must not fetch ${url}`);
    assert.equal(rendered, 0, `must not render ${url}`);
  }
});

test('read_web_page rejects malformed URLs as invalid_url', async () => {
  const result = await readWebPage({ url: 'not a url', lookupImpl: publicDns() });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'invalid_url');
});

test('read_web_page rejects DNS rebinding hosts before any request', async () => {
  let fetched = 0;
  const result = await readWebPage({
    url: 'https://evil.example.com/page',
    lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }],
    fetchImpl: async () => { fetched += 1; return new Response('x', { status: 200 }); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'dns');
  assert.equal(fetched, 0);

  const unresolved = await readWebPage({
    url: 'https://nx.example.com/page',
    lookupImpl: async () => { throw new Error('ENOTFOUND'); },
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.error.reason, 'dns');
});

test('read_web_page re-validates every redirect hop and rejects private targets', async () => {
  const calls = [];
  const result = await readWebPage({
    url: 'https://a.example/start',
    lookupImpl: publicDns(),
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'ssrf');
  assert.deepEqual(calls, ['https://a.example/start']);

  const protocol = await readWebPage({
    url: 'https://a.example/start',
    lookupImpl: publicDns(),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } })
  });
  assert.equal(protocol.ok, false);
  assert.equal(protocol.error.reason, 'redirect');

  const loop = await readWebPage({
    url: 'https://a.example/start',
    lookupImpl: publicDns(),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://b.example/next' } })
  });
  assert.equal(loop.ok, false);
  assert.equal(loop.error.reason, 'redirect');
});

test('read_web_page follows a safe redirect chain and returns the final page', async () => {
  const result = await readWebPage({
    url: 'https://a.example/start',
    lookupImpl: publicDns(),
    fetchImpl: async (url) => url === 'https://a.example/start'
      ? new Response(null, { status: 301, headers: { location: 'https://b.example/final' } })
      : new Response(html('Final page', '<p>Redirected target body text with enough content.</p>'), { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.renderMode, 'static');
  assert.equal(result.data.url, 'https://b.example/final');
});

test('read_web_page streams and rejects oversized bodies at the 2 MiB cap', async () => {
  let streamed = 0;
  const counting = new TransformStream({
    transform(chunk, controller) { streamed += chunk.byteLength; controller.enqueue(chunk); }
  });
  const infinite = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); }
  }).pipeThrough(counting);
  const result = await readWebPage({
    url: 'https://big.example/page',
    lookupImpl: publicDns(),
    timeoutMs: 2000,
    fetchImpl: async () => new Response(infinite, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'too_large');
  assert.ok(streamed >= 2 * 1024 * 1024, `cap reached at ${streamed} bytes`);
  assert.ok(streamed < 4 * 1024 * 1024, `must not swallow the infinite body (${streamed} bytes)`);
});

test('read_web_page enforces the document-type whitelist and sniffs untyped HTML', async () => {
  const png = await readWebPage({
    url: 'https://img.example/x.png',
    lookupImpl: publicDns(),
    fetchImpl: async () => new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'image/png' } })
  });
  assert.equal(png.ok, false);
  assert.equal(png.error.reason, 'unsupported_type');

  const sniffed = await readWebPage({
    url: 'https://sniff.example/page',
    lookupImpl: publicDns(),
    fetchImpl: async () => new Response(html('Sniff', '<p>HTML sniffed without a content type header.</p>'), { status: 200 })
  });
  assert.equal(sniffed.ok, true);
  assert.equal(sniffed.data.title, 'Sniff');
});

test('read_web_page enforces the deadline on both static and fallback paths', async () => {
  const result = await readWebPage({
    url: 'https://slow.example/page',
    lookupImpl: publicDns(),
    timeoutMs: 150,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    renderFn: async () => new Promise(() => {})
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'timeout');
});

test('read_web_page fails auth walls without fallback and never leaks credentials', async () => {
  for (const status of [401, 403, 429]) {
    let rendered = 0;
    const result = await readWebPage({
      url: 'https://wall.example/page',
      lookupImpl: publicDns(),
      fetchImpl: async () => new Response('sign in required', { status, headers: { 'content-type': 'text/html' } }),
      renderFn: async () => { rendered += 1; return { status: 200, contentType: 'text/html', finalUrl: 'https://wall.example/page', title: 'x', bodyText: 'x' }; }
    });
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(result.error.reason, 'auth_required', `status ${status}`);
    assert.equal(rendered, 0, `status ${status} must not trigger fallback`);
  }

  const challenge = await readWebPage({
    url: 'https://cf.example/page',
    lookupImpl: publicDns(),
    fetchImpl: staticOk('<html><body>Checking your browser... cf-browser-verification... just a moment</body></html>')
  });
  assert.equal(challenge.ok, false);
  assert.equal(challenge.error.reason, 'auth_required');
});

test('read_web_page strips embedded credentials and never echoes them', async () => {
  let requested = '';
  const result = await readWebPage({
    url: 'https://user:supersecret@example.com/page',
    lookupImpl: publicDns(),
    fetchImpl: (url) => { requested = url; return new Response(html('Cred', '<p>public page body text long enough to be read.</p>'), { status: 200, headers: { 'content-type': 'text/html' } }); }
  });
  assert.equal(result.ok, true);
  assert.ok(!requested.includes('supersecret'), `fetch URL must not carry credentials: ${requested}`);
  assert.ok(!requested.includes('user:'));
  assert.ok(!JSON.stringify(result).includes('supersecret'));
});

// ---- read_web_page: fallback path ----------------------------------------

test('read_web_page falls back to render when static read yields no content', async () => {
  let renderedUrl = '';
  const result = await readWebPage({
    url: 'https://spa.example/app',
    lookupImpl: publicDns(),
    fetchImpl: staticOk('<div id="root"></div>'),
    renderFn: async (url) => {
      renderedUrl = url;
      return { status: 200, contentType: 'text/html', finalUrl: 'https://spa.example/app', title: 'SPA App', bodyText: 'Dynamically rendered content for research evidence.' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.renderMode, 'fallback');
  assert.equal(renderedUrl, 'https://spa.example/app');
  assert.equal(result.data.title, 'SPA App');
});

test('read_web_page fallback degrades fail-closed on walls, size, errors and rebound finals', async () => {
  const shell = staticOk('<div id="root"></div>');

  const walled = await readWebPage({
    url: 'https://spa.example/private', lookupImpl: publicDns(), fetchImpl: shell,
    renderFn: async () => ({ status: 403, contentType: 'text/html', finalUrl: 'https://spa.example/private', title: 'Sign in', bodyText: 'Please sign in to continue reading.' })
  });
  assert.equal(walled.ok, false);
  assert.equal(walled.error.reason, 'auth_required');

  const challenge = await readWebPage({
    url: 'https://spa.example/challenge', lookupImpl: publicDns(), fetchImpl: shell,
    renderFn: async () => ({ status: 200, contentType: 'text/html', finalUrl: 'https://spa.example/challenge', title: 'Just a moment', bodyText: 'Just a moment... verifying you are human.' })
  });
  assert.equal(challenge.ok, false);
  assert.equal(challenge.error.reason, 'auth_required');

  const huge = await readWebPage({
    url: 'https://spa.example/huge', lookupImpl: publicDns(), fetchImpl: shell,
    renderFn: async () => ({ status: 200, contentType: 'text/html', finalUrl: 'https://spa.example/huge', title: 'Huge', bodyText: 'x'.repeat(2 * 1024 * 1024 + 1) })
  });
  assert.equal(huge.ok, false);
  assert.equal(huge.error.reason, 'too_large');

  const broken = await readWebPage({
    url: 'https://spa.example/broken', lookupImpl: publicDns(), fetchImpl: shell,
    renderFn: async () => { throw new Error('browser crashed'); }
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.error.reason, 'render');
  assert.match(broken.error.message, /browser crashed/);

  const rebound = await readWebPage({
    url: 'https://spa.example/rebound',
    lookupImpl: async (host) => host === 'spa.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '10.0.0.9', family: 4 }],
    fetchImpl: shell,
    renderFn: async () => ({ status: 200, contentType: 'text/html', finalUrl: 'https://rebound.example/final', title: 'x', bodyText: 'x' })
  });
  assert.equal(rebound.ok, false);
  assert.equal(rebound.error.reason, 'dns');

  const privateFinal = await readWebPage({
    url: 'https://spa.example/evil', lookupImpl: publicDns(), fetchImpl: shell,
    renderFn: async () => ({ status: 200, contentType: 'text/html', finalUrl: 'http://127.0.0.1/steal', title: 'x', bodyText: 'x' })
  });
  assert.equal(privateFinal.ok, false);
  assert.equal(privateFinal.error.reason, 'ssrf');
});

// ---- IPv6 classification: DNS responses and embedded IPv4 tails -------------

test('assertPublicDns accepts public AAAA and rejects private AAAA responses', async () => {
  await assertPublicDns('aaaa.example', async () => [{ address: '2001:db8::1', family: 6 }]);
  await assert.rejects(assertPublicDns('aaaa.example', async () => [{ address: 'fd00::1', family: 6 }]), /WEBSITE_DNS_REBINDING/);
  await assert.rejects(assertPublicDns('aaaa.example', async () => [{ address: 'fe80::1', family: 6 }]), /WEBSITE_DNS_REBINDING/);

  const viaRead = await readWebPage({
    url: 'https://aaaa.example/page',
    lookupImpl: async () => [{ address: 'fd00::1', family: 6 }],
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  assert.equal(viaRead.ok, false);
  assert.equal(viaRead.error.reason, 'dns');
});

test('IPv4-embedded IPv6 literals and DNS responses are classified fail-closed', async () => {
  for (const url of [
    'https://[::ffff:7f00:1]/x', // mapped hex tail -> 127.0.0.1
    'https://[::7f00:1]/x', // compatible hex tail -> 127.0.0.1
    'https://[::ffff:127.0.0.1]/x', // mapped dotted quad
    'https://[::127.0.0.1]/x', // compatible dotted quad
    'https://[::ffff:a9fe:a9fe]/x' // mapped hex tail -> 169.254.169.254
  ]) {
    const result = await readWebPage({ url, fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.equal(result.ok, false, url);
    assert.equal(result.error.reason, 'ssrf', url);
  }
  assert.doesNotThrow(() => assertPublicUrl('https://[::ffff:5db8:d822]/x')); // ::ffff:93.184.216.34 is public
  await assert.doesNotReject(assertPublicDns('ok.example', async () => [{ address: '::ffff:5db8:d822', family: 6 }]));
  await assert.rejects(assertPublicDns('rebind.example', async () => [{ address: '::ffff:7f00:1', family: 6 }]), /WEBSITE_DNS_REBINDING/);
  await assert.rejects(assertPublicDns('rebind.example', async () => [{ address: '::7f00:1', family: 6 }]), /WEBSITE_DNS_REBINDING/);
});

// ---- fallback route guard ---------------------------------------------------

test('fallback document guard aborts non-public hops and passes subresources through', async () => {
  const validateUrl = async (value) => {
    assertPublicUrl(value);
    await assertPublicDns(hostnameOf(new URL(value)), publicDns());
  };
  const run = (name, request, validate = validateUrl) => {
    const calls = [];
    return guardResearchDocument(request, {
      continue: async () => calls.push(`${name}:continue`),
      abort: async () => calls.push(`${name}:abort`)
    }, validate).then((error) => ({ error, calls }));
  };

  const image = await run('img', { url: () => 'https://img.example/a.png', resourceType: () => 'image' });
  assert.equal(image.error, null);
  assert.deepEqual(image.calls, ['img:continue']);

  const okDoc = await run('ok', { url: () => 'https://ok.example/page', resourceType: () => 'document' });
  assert.equal(okDoc.error, null);
  assert.deepEqual(okDoc.calls, ['ok:continue']);

  const privateDoc = await run('bad', { url: () => 'http://127.0.0.1/steal', resourceType: () => 'document' });
  assert.ok(privateDoc.error instanceof Error);
  assert.match(privateDoc.error.message, /WEBSITE_URL_NOT_PUBLIC/);
  assert.deepEqual(privateDoc.calls, ['bad:abort']);

  const dnsHop = await run('dns', { url: () => 'https://rebind.example/next', resourceType: () => 'document' }, async (value) => {
    await assertPublicDns(hostnameOf(new URL(value)), async () => [{ address: '10.0.0.9', family: 4 }]);
  });
  assert.ok(dnsHop.error instanceof Error);
  assert.match(dnsHop.error.message, /WEBSITE_DNS_REBINDING/);
  assert.deepEqual(dnsHop.calls, ['dns:abort']);

  // sync validateUrl (injection-compatible) also aborts
  const syncDoc = await run('sync', { url: () => 'http://10.0.0.1/x', resourceType: () => 'document' }, (value) => { assertPublicUrl(value); });
  assert.ok(syncDoc.error instanceof Error);
  assert.deepEqual(syncDoc.calls, ['sync:abort']);
});

// ---- fallback byte cap ------------------------------------------------------

test('fallback enforces the 2 MiB cap by UTF-8 bytes, not JS length', async () => {
  const shell = staticOk('<div id="root"></div>');
  const multibyte = '😀'.repeat(700000); // 4 UTF-8 bytes each ≈ 2.8 MiB; JS length 700k stays under 2 MiB
  const result = await readWebPage({
    url: 'https://spa.example/multibyte', lookupImpl: publicDns(), fetchImpl: shell,
    renderFn: async () => ({ status: 200, contentType: 'text/html', finalUrl: 'https://spa.example/multibyte', title: 'MB', bodyText: multibyte })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'too_large');

  const under = 'a'.repeat(2 * 1024 * 1024 - 1);
  const ok = await readWebPage({
    url: 'https://spa.example/under', lookupImpl: publicDns(), fetchImpl: shell,
    renderFn: async () => ({ status: 200, contentType: 'text/html', finalUrl: 'https://spa.example/under', title: 'Under', bodyText: under })
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.renderMode, 'fallback');
});

// ---- real browser fallback lifecycle (WMB-5175) ----------------------------

const DYNAMIC_SHELL = '<!doctype html><html><head><title>Dynamic Shell</title></head><body><div id="root"></div>'
  + '<script>document.getElementById("root").innerText = "GLM-5.2 pricing: input 0.60 CNY / output 3.80 CNY per 1M tokens (rendered at runtime)";</script></body></html>';

async function renderTempLeaks(snapshot) {
  const now = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('wmb-research-render-')));
  return [...now].filter((name) => !snapshot.has(name));
}

test('playwright-core 1.62 rejects the legacy --user-data-dir launch combo (WMB-5175)', async () => {
  const { chromium } = createRequire(import.meta.url)('playwright-core');
  await assert.rejects(
    chromium.launch({ executablePath: 'C:/definitely/not/here.exe', args: ['--user-data-dir=C:/tmp/legacy-profile'] }),
    /Pass userDataDir parameter to 'browserType\.launchPersistentContext\(userDataDir, options\)'/
  );
});

test('headless fallback renders a dynamic shell via launchPersistentContext (WMB-5175)', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DYNAMIC_SHELL);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/pricing`;
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('wmb-research-render-')));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let rendered;
    try {
      rendered = await headlessRenderPublicPage(url, {
        signal: controller.signal,
        deadlineMs: Date.now() + 30000,
        maxBytes: 2 * 1024 * 1024,
        // Local fixture: the SSRF/DNS guard is injected separately and covered by the
        // dedicated fail-closed tests below; the live readback passes the real guard.
        validateUrl: async () => {}
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(rendered.status, 200);
    assert.equal(rendered.title, 'Dynamic Shell');
    assert.match(rendered.bodyText, /rendered at runtime/);
    assert.equal(rendered.finalUrl, url);
  } catch (error) {
    if (error?.code === 'WEBSITE_RENDER_UNAVAILABLE') return t.skip('no headless render executable installed');
    throw error;
  } finally {
    server.close();
    assert.deepEqual(await renderTempLeaks(before), [], 'launchPersistentContext temp profile dir must be removed on success');
  }
});

test('headless fallback aborts a document hop the validator rejects and still cleans up (WMB-5175)', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DYNAMIC_SHELL);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/pricing`;
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('wmb-research-render-')));
  const guard = Object.assign(new Error('SSRF guard: private target rejected'), { code: 'WEBSITE_URL_NOT_PUBLIC' });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let rejected;
    try {
      await headlessRenderPublicPage(url, {
        signal: controller.signal,
        deadlineMs: Date.now() + 30000,
        maxBytes: 2 * 1024 * 1024,
        validateUrl: async () => { throw guard; }
      });
    } catch (error) {
      rejected = error;
    } finally {
      clearTimeout(timer);
    }
    assert.ok(rejected, 'validator rejection must surface from the render');
    assert.equal(rejected.message, guard.message);
  } catch (error) {
    if (error?.code === 'WEBSITE_RENDER_UNAVAILABLE') return t.skip('no headless render executable installed');
    throw error;
  } finally {
    server.close();
    assert.deepEqual(await renderTempLeaks(before), [], 'temp profile dir must be removed even when the navigation is aborted');
  }
});

// ---- helpers -------------------------------------------------------------

async function mcpRequest(url, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  });
  assert.ok(response.ok, `${method} returned ${response.status}`);
  const body = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
  if (payload.error) throw new Error(payload.error.message);
  return { data: payload.result, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}
