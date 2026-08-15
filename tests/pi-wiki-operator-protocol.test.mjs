import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  extractWikiActionManifest,
  hasWikiActionFence,
  normalizeWikiActionManifest,
  stripWikiActionBlock,
  WIKI_ACTION_MANIFEST_KEY,
  WIKI_INGEST_BATCH_MAX,
  WIKI_LOG_LIMIT_MAX,
  WIKI_QUERY_VERSIONS_MAX,
  WIKI_SEARCH_LIMIT_MAX
} from '../src/shared/wiki-operator-protocol.ts';
import { PI_AUTHORITY_SYSTEM_PROMPT } from '../src/main/pi-operator-skill.ts';

const skillPath = new URL('../skills/wemedia-buddy-operator/SKILL.md', import.meta.url);

const AUTHORITY = { taskId: 'task-1', grantId: 'grant-1', workerLeaseId: 'lease-1' };

function fence(body) {
  return `回答正文。\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

function manifestOf(raw) {
  const parsed = normalizeWikiActionManifest(raw);
  assert.equal(parsed.reject, null, `expected accept, got reject ${JSON.stringify(parsed.reject)}`);
  return parsed.manifest;
}

test('WMB-5240: free text never triggers a wiki action; only a strict fence does', () => {
  const plain = extractWikiActionManifest('帮我维护整个 Wiki，顺便把这几篇收录进去。');
  assert.equal(plain.manifest, null);
  assert.equal(plain.reject.code, 'WIKI_ACTION_MISSING');

  const withFence = extractWikiActionManifest(fence({ [WIKI_ACTION_MANIFEST_KEY]: { action: 'report', requestId: 'r1' } }));
  assert.ok(withFence.manifest);
  assert.equal(withFence.reject, null);
  assert.equal(withFence.manifest.action, 'report');
});

test('WMB-5240: only the LAST json fence is read; earlier fences are ignored', () => {
  const text = `第一段。\n\n\`\`\`json\n{"not_the_protocol": 1}\n\`\`\`\n\n最后一段。\n\n\`\`\`json\n${JSON.stringify({ [WIKI_ACTION_MANIFEST_KEY]: { action: 'report', requestId: 'r1' } })}\n\`\`\`\n`;
  const parsed = extractWikiActionManifest(text);
  assert.equal(parsed.reject, null);
  assert.equal(parsed.manifest.action, 'report');
});

test('WMB-5240: a json fence with a different key is a missing manifest, never a guess', () => {
  const parsed = extractWikiActionManifest(fence({ wmb_query_writeback: { classification: 'restatement' } }));
  assert.equal(parsed.manifest, null);
  assert.equal(parsed.reject.code, 'WIKI_ACTION_MISSING');
});

test('WMB-5240: malformed json and non-object payloads fail closed', () => {
  assert.equal(extractWikiActionManifest('```json\n{broken\n```').reject.code, 'WIKI_ACTION_INVALID');
  const array = extractWikiActionManifest(fence([{ action: 'report' }]));
  assert.equal(array.manifest, null);
  assert.equal(array.reject.code, 'WIKI_ACTION_INVALID');
});

test('WMB-5240: unknown action is rejected with a stable code and user-language reason', () => {
  const parsed = normalizeWikiActionManifest({ action: 'publish_to_platform', requestId: 'r1' });
  assert.equal(parsed.manifest, null);
  assert.equal(parsed.reject.code, 'WIKI_ACTION_UNKNOWN_ACTION');
  assert.match(parsed.reject.reason, /未知 Wiki 动作/);
});

test('WMB-5240: unknown/extra fields fail closed on every action', () => {
  const cases = [
    [{ action: 'report', requestId: 'r1', publish: true }, 'publish'],
    [{ action: 'search', requestId: 'r1', query: 'x', sql: 'SELECT 1' }, 'sql'],
    [{ action: 'maintain', requestId: 'r1', subaction: 'status', workspaceId: 'ws-1' }, 'workspaceId'],
    [{ action: 'query', requestId: 'r1', wikiVersionRefs: ['wiki_page:p1:v1'], workspaceRootPath: 'C:/secret' }, 'workspaceRootPath'],
    [{ action: 'ingest', requestId: 'r1', ...AUTHORITY, items: [{ title: 't', originalUrl: 'https://a.com', feedId: 'feed-1' }] }, 'items[0].feedId'],
    [{ action: 'log', requestId: 'r1', filter: { eventType: 'compile', rawSql: 'x' } }, 'filter.rawSql'],
    [{ action: 'maintain', requestId: 'r1', subaction: 'start', ...AUTHORITY, config: { batchLimit: 10, queuePriority: 9 } }, 'config.queuePriority']
  ];
  for (const [raw, field] of cases) {
    const parsed = normalizeWikiActionManifest(raw);
    assert.equal(parsed.manifest, null, `expected reject for ${JSON.stringify(raw)}`);
    assert.equal(parsed.reject.code, 'WIKI_ACTION_EXTRA_FIELD', JSON.stringify(parsed.reject));
    assert.equal(parsed.reject.field, field);
  }
});

test('WMB-5240: missing required fields fail closed', () => {
  const cases = [
    [{ action: 'report' }, 'requestId'],
    [{ requestId: 'r1' }, 'action'],
    [{ action: 'search', requestId: 'r1' }, 'query'],
    [{ action: 'maintain', requestId: 'r1', ...AUTHORITY }, 'subaction'],
    [{ action: 'ingest', requestId: 'r1', ...AUTHORITY }, 'items'],
    [{ action: 'ingest', requestId: 'r1', ...AUTHORITY, items: [] }, 'items'],
    [{ action: 'ingest', requestId: 'r1', ...AUTHORITY, items: [{ originalUrl: 'https://a.com' }] }, 'items[0].title'],
    [{ action: 'ingest', requestId: 'r1', ...AUTHORITY, items: [{ title: 't' }] }, 'items[0].originalUrl']
  ];
  for (const [raw, field] of cases) {
    const parsed = normalizeWikiActionManifest(raw);
    assert.equal(parsed.manifest, null, `expected reject for ${JSON.stringify(raw)}`);
    assert.equal(parsed.reject.code, 'WIKI_ACTION_MISSING_FIELD', JSON.stringify(parsed.reject));
    assert.equal(parsed.reject.field, field);
  }
});

test('WMB-5240: query requires at least one non-empty frozen version ref list (fixed version required)', () => {
  const missing = normalizeWikiActionManifest({ action: 'query', requestId: 'r1', question: '这版写了什么？' });
  assert.equal(missing.manifest, null);
  assert.equal(missing.reject.code, 'WIKI_ACTION_QUERY_VERSION_REQUIRED');

  const empty = normalizeWikiActionManifest({ action: 'query', requestId: 'r1', wikiVersionRefs: [] });
  assert.equal(empty.manifest, null);
  assert.equal(empty.reject.code, 'WIKI_ACTION_QUERY_VERSION_REQUIRED');

  const okWiki = manifestOf({ action: 'query', requestId: 'r1', wikiVersionRefs: ['wiki_page:p1:v9'] });
  assert.deepEqual(okWiki.wikiVersionRefs, ['wiki_page:p1:v9']);

  const okNote = manifestOf({ action: 'query', requestId: 'r1', noteVersionRefs: ['knowledge_note:n1:v2'], evidenceRefs: ['evidence:e1'] });
  assert.deepEqual(okNote.noteVersionRefs, ['knowledge_note:n1:v2']);
  assert.deepEqual(okNote.evidenceRefs, ['evidence:e1']);

  const badSyntax = normalizeWikiActionManifest({ action: 'query', requestId: 'r1', wikiVersionRefs: ['p1:v9'] });
  assert.equal(badSyntax.manifest, null);
  assert.equal(badSyntax.reject.code, 'WIKI_ACTION_INVALID_VALUE');

  const wrongType = normalizeWikiActionManifest({ action: 'query', requestId: 'r1', noteVersionRefs: ['wiki_page:p1:v9'] });
  assert.equal(wrongType.manifest, null);
  assert.equal(wrongType.reject.code, 'WIKI_ACTION_INVALID_VALUE');

  // 写回围栏的裸 id 字段（readWikiVersionIds 等）不属于本协议：fail-closed 拒绝
  const leak = normalizeWikiActionManifest({ action: 'query', requestId: 'r1', readWikiVersionIds: ['v1'] });
  assert.equal(leak.manifest, null);
  assert.equal(leak.reject.code, 'WIKI_ACTION_EXTRA_FIELD');

  const tooMany = normalizeWikiActionManifest({
    action: 'query', requestId: 'r1',
    wikiVersionRefs: Array.from({ length: WIKI_QUERY_VERSIONS_MAX + 1 }, (_, i) => `wiki_page:p1:v${i}`)
  });
  assert.equal(tooMany.manifest, null);
  assert.equal(tooMany.reject.code, 'WIKI_ACTION_BOUND_VIOLATION');
});

test('WMB-5240: ingest batch is bounded (1..50)', () => {
  const atMax = Array.from({ length: WIKI_INGEST_BATCH_MAX }, (_, i) => ({ title: `t${i}`, originalUrl: `https://a.com/${i}` }));
  const parsedMax = normalizeWikiActionManifest({ action: 'ingest', requestId: 'r1', ...AUTHORITY, items: atMax });
  assert.equal(parsedMax.reject, null, JSON.stringify(parsedMax.reject));
  assert.equal(parsedMax.manifest.items.length, WIKI_INGEST_BATCH_MAX);

  const overMax = Array.from({ length: WIKI_INGEST_BATCH_MAX + 1 }, (_, i) => ({ title: `t${i}`, originalUrl: `https://a.com/${i}` }));
  const parsedOver = normalizeWikiActionManifest({ action: 'ingest', requestId: 'r1', ...AUTHORITY, items: overMax });
  assert.equal(parsedOver.manifest, null);
  assert.equal(parsedOver.reject.code, 'WIKI_ACTION_BATCH_OVER_LIMIT');
  assert.match(parsedOver.reject.reason, /批量超过上限/);
});

test('WMB-5240: write actions require taskId/grantId/workerLeaseId; reads do not', () => {
  const writeCases = [
    { action: 'maintain', requestId: 'r1', subaction: 'start' },
    { action: 'maintain', requestId: 'r1', subaction: 'pause', taskId: 't', workerLeaseId: 'l' },
    { action: 'maintain', requestId: 'r1', subaction: 'resume', taskId: 't', grantId: 'g' },
    { action: 'ingest', requestId: 'r1', items: [{ title: 't', originalUrl: 'https://a.com' }] },
    { action: 'lint', requestId: 'r1', run: true }
  ];
  for (const raw of writeCases) {
    const parsed = normalizeWikiActionManifest(raw);
    assert.equal(parsed.manifest, null, `expected authority reject for ${JSON.stringify(raw)}`);
    assert.equal(parsed.reject.code, 'WIKI_ACTION_AUTHORITY_REQUIRED', JSON.stringify(parsed.reject));
  }

  const readCases = [
    { action: 'maintain', requestId: 'r1', subaction: 'status' },
    { action: 'maintain', requestId: 'r1', subaction: 'report' },
    { action: 'lint', requestId: 'r1' },
    { action: 'lint', requestId: 'r1', run: false },
    { action: 'search', requestId: 'r1', query: 'x' },
    { action: 'log', requestId: 'r1' },
    { action: 'report', requestId: 'r1' },
    { action: 'query', requestId: 'r1', wikiVersionRefs: ['wiki_page:p1:v1'] }
  ];
  for (const raw of readCases) {
    const parsed = normalizeWikiActionManifest(raw);
    assert.equal(parsed.reject, null, `expected accept for ${JSON.stringify(raw)} -> ${JSON.stringify(parsed.reject)}`);
  }

  const withAuthority = manifestOf({ action: 'maintain', requestId: 'r1', subaction: 'start', ...AUTHORITY });
  assert.equal(withAuthority.taskId, 'task-1');
  assert.equal(withAuthority.grantId, 'grant-1');
  assert.equal(withAuthority.workerLeaseId, 'lease-1');
});

test('WMB-5240: bounds are enforced for search/log limits, config, requestId, cursor', () => {
  const cases = [
    [{ action: 'search', requestId: 'r1', query: 'x', limit: WIKI_SEARCH_LIMIT_MAX + 1 }, 'WIKI_ACTION_BOUND_VIOLATION'],
    [{ action: 'search', requestId: 'r1', query: 'x', limit: 0 }, 'WIKI_ACTION_BOUND_VIOLATION'],
    [{ action: 'log', requestId: 'r1', limit: WIKI_LOG_LIMIT_MAX + 1 }, 'WIKI_ACTION_BOUND_VIOLATION'],
    [{ action: 'log', requestId: 'r1', filter: { limit: 101 } }, 'WIKI_ACTION_BOUND_VIOLATION'],
    [{ action: 'maintain', requestId: 'r1', subaction: 'start', ...AUTHORITY, config: { batchLimit: 51 } }, 'WIKI_ACTION_BOUND_VIOLATION'],
    [{ action: 'maintain', requestId: 'r1', subaction: 'start', ...AUTHORITY, config: { maxTopicsPerSource: 21 } }, 'WIKI_ACTION_BOUND_VIOLATION'],
    [{ action: 'maintain', requestId: 'r1', subaction: 'start', ...AUTHORITY, config: { stallLimit: 0 } }, 'WIKI_ACTION_BOUND_VIOLATION'],
    [{ action: 'report', requestId: 'x'.repeat(129) }, 'WIKI_ACTION_BOUND_VIOLATION']
  ];
  for (const [raw, code] of cases) {
    const parsed = normalizeWikiActionManifest(raw);
    assert.equal(parsed.manifest, null, `expected reject for ${JSON.stringify(raw)}`);
    assert.equal(parsed.reject.code, code, JSON.stringify(parsed.reject));
  }
});

test('WMB-5240: ingest items validate URL scheme and reject host credentials', () => {
  const badUrl = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'r1', ...AUTHORITY,
    items: [{ title: 't', originalUrl: 'file:///C:/secret' }]
  });
  assert.equal(badUrl.manifest, null);
  assert.equal(badUrl.reject.code, 'WIKI_ACTION_INVALID_VALUE');

  const creds = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'r1', ...AUTHORITY,
    items: [{ title: 't', originalUrl: 'https://user:pass@host.com/x' }]
  });
  assert.equal(creds.manifest, null);
  assert.equal(creds.reject.code, 'WIKI_ACTION_INVALID_VALUE');

  const good = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'r1', ...AUTHORITY,
    items: [{ title: 't', originalUrl: 'https://host.com/x?a=1#frag' }]
  });
  assert.equal(good.reject, null);
});

test('WMB-5240: maintain config is only valid on start; enum subactions are closed', () => {
  const configOnStatus = normalizeWikiActionManifest({ action: 'maintain', requestId: 'r1', subaction: 'status', config: { batchLimit: 10 } });
  assert.equal(configOnStatus.manifest, null);
  assert.equal(configOnStatus.reject.code, 'WIKI_ACTION_EXTRA_FIELD');

  const badSubaction = normalizeWikiActionManifest({ action: 'maintain', requestId: 'r1', subaction: 'restart', ...AUTHORITY });
  assert.equal(badSubaction.manifest, null);
  assert.equal(badSubaction.reject.code, 'WIKI_ACTION_MISSING_FIELD');

  const good = manifestOf({ action: 'maintain', requestId: 'r1', subaction: 'start', ...AUTHORITY, config: { batchLimit: 10, maxTopicsPerSource: 5, stallLimit: 3 } });
  assert.deepEqual(good.config, { batchLimit: 10, maxTopicsPerSource: 5, stallLimit: 3 });
});

test('WMB-5240: search objectTypes are restricted to the six indexed types', () => {
  const bad = normalizeWikiActionManifest({ action: 'search', requestId: 'r1', query: 'x', objectTypes: ['wiki_page', 'secret_table'] });
  assert.equal(bad.manifest, null);
  assert.equal(bad.reject.code, 'WIKI_ACTION_INVALID_VALUE');

  const good = manifestOf({ action: 'search', requestId: 'r1', query: 'x', limit: 5, objectTypes: ['wiki_page', 'source'] });
  assert.deepEqual(good.objectTypes, ['wiki_page', 'source']);
  assert.equal(good.limit, 5);
});

test('WMB-5240: log action accepts only the protocol filter subset', () => {
  const good = manifestOf({ action: 'log', requestId: 'r1', filter: { eventType: 'compile', limit: 20 }, limit: 10, cursor: 'abc' });
  assert.deepEqual(good.filter, { eventType: 'compile', limit: 20 });
  assert.equal(good.limit, 10);
  assert.equal(good.cursor, 'abc');

  const badEvent = normalizeWikiActionManifest({ action: 'log', requestId: 'r1', filter: { eventType: 'truncate' } });
  assert.equal(badEvent.manifest, null);
  assert.equal(badEvent.reject.code, 'WIKI_ACTION_INVALID_VALUE');
});

test('WMB-5240: strip removes only the wiki-action fence; has detects any json fence', () => {
  const text = '正文。\n\n```json\n{"wmb_wiki_action": {"action": "report", "requestId": "r1"}}\n```\n';
  assert.equal(hasWikiActionFence(text), true);
  const stripped = stripWikiActionBlock(text);
  assert.equal(stripped, '正文。');
  assert.equal(stripWikiActionBlock('没有围栏的正文'), '没有围栏的正文');
  // 非本协议的围栏原样保留（含换行，与 query-writeback strip 语义一致）
  const foreign = '正文。\n\n```json\n{"wmb_query_writeback": {"classification": "restatement"}}\n```\n';
  assert.equal(stripWikiActionBlock(foreign), foreign);
});

test('WMB-5240: canonical Skill documents the natural-language routing and strict protocol', async () => {
  const skill = await readFile(skillPath, 'utf8');
  assert.match(skill, /### Wiki 自然语言操作（wmb_wiki_action 协议，WMB-5240）/);
  assert.match(skill, /自由文本永不触发/);
  assert.match(skill, /固定版本必填/);
  assert.match(skill, /批量超过上限/);
  assert.match(skill, /最终发布仍只由用户/);
  assert.match(skill, /一个轮次至多一个协议围栏/);
  // 路由表：六类意图 → 动作
  for (const intent of ['维护整个 Wiki', '批量摄取', '固定版本', '全局 Lint', '统一搜索', '维护报告']) {
    assert.match(skill, new RegExp(intent));
  }
});

test('WMB-5240: PI authority prompt registers the wiki-action protocol (write boundary, publish ban)', () => {
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /wmb_wiki_action/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /自由文本不触发/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /最终发布/);
});

test('WMB-5240: canonical Skill tool list documents exactly the ten registered wmb_wiki_* tools', async () => {
  const skill = await readFile(skillPath, 'utf8');
  const expected = [
    'wmb_wiki_maintenance_start',
    'wmb_wiki_maintenance_status',
    'wmb_wiki_maintenance_pause',
    'wmb_wiki_maintenance_resume',
    'wmb_wiki_maintenance_report',
    'wmb_wiki_ingest',
    'wmb_wiki_lint',
    'wmb_wiki_search',
    'wmb_wiki_log',
    'wmb_wiki_report'
  ];
  for (const name of expected) {
    assert.match(skill, new RegExp(`\`${name}\``), `SKILL.md must document ${name} in backticks`);
  }
  // 协议键永远不以反引号出现在 SKILL.md（避免被工具 parity 误判为工具）
  assert.doesNotMatch(skill, new RegExp(`\`${WIKI_ACTION_MANIFEST_KEY}\``));
});

test('WMB-5240: manifest round-trip keeps exact typed fields (typed result shape)', () => {
  const raw = {
    action: 'ingest',
    requestId: 'r42',
    ...AUTHORITY,
    items: [
      { title: ' 标题 ', originalUrl: ' https://a.com/x ', summary: '摘要', categories: ['ai', '工具'], priority: 3 }
    ]
  };
  const parsed = normalizeWikiActionManifest(raw);
  const manifest = parsed.manifest;
  assert.ok(manifest, JSON.stringify(parsed.reject));
  assert.equal(manifest.action, 'ingest');
  assert.equal(manifest.requestId, 'r42');
  assert.equal(manifest.items[0].title, '标题');
  assert.equal(manifest.items[0].originalUrl, 'https://a.com/x');
  assert.deepEqual(manifest.items[0].categories, ['ai', '工具']);
  assert.equal(manifest.items[0].priority, 3);
});
