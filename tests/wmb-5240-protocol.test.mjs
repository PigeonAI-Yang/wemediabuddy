// WMB-5240：Wiki 自然语言操作协议（shared canonical SSOT）聚焦契约测试。
// 覆盖（协议层 fail-closed 全部边界；执行面在 wmb-5240-executor-*.test.mjs）：
// - 围栏解析：最后一个 ```json 围栏、wmb_wiki_action 键、剥离协议块；
// - 七类动作（maintain/ingest/query/lint/search/log/report）形状与必填字段；
// - 批量上界：ingest ≤ WIKI_INGEST_BATCH_MAX（T-BR-1）、search/log limit ≤ 100、
//   query 每类冻结版本 ≤ WIKI_QUERY_VERSIONS_MAX 且至少一个非空列表（T-BR-2 / T-MF-4）；
// - 写动作 authority 必填（maintain start/pause/resume、ingest、lint run=true）→
//   缺失 WIKI_ACTION_AUTHORITY_REQUIRED 零写（T-PI-1 协议面）；
// - 未知动作/未知字段/类型错误/越界/非 http(s) URL（T-URL-1）→ fail-closed 可读拒绝；
// - 固定版本引用不漂移锚：query 声明 id 数组为协议键（与 WMB-5214 同字段名）。
// 运行：node --test --test-concurrency=1 tests/wmb-5240-protocol.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WIKI_ACTION_MANIFEST_KEY,
  WIKI_ACTION_KINDS,
  WIKI_MAINTAIN_SUBACCTIONS,
  WIKI_WRITE_ACTION_KINDS,
  WIKI_INGEST_BATCH_MAX,
  WIKI_SEARCH_LIMIT_MAX,
  WIKI_LOG_LIMIT_MAX,
  WIKI_QUERY_VERSIONS_MAX,
  WIKI_MAINTENANCE_BATCH_LIMIT_MAX,
  WIKI_MAINTENANCE_MAX_TOPICS_MAX,
  WIKI_MAINTENANCE_STALL_LIMIT_MAX,
  WIKI_ACTION_REQUEST_ID_MAX,
  normalizeWikiActionManifest,
  hasWikiActionFence,
  extractWikiActionManifest,
  stripWikiActionBlock
} from '../src/shared/wiki-operator-protocol.ts';

const AUTHORITY = { taskId: 'task-1', grantId: 'grant-1', workerLeaseId: 'lease-1' };

function fence(payload) {
  return `\`\`\`json\n${JSON.stringify({ [WIKI_ACTION_MANIFEST_KEY]: payload })}\n\`\`\``;
}

function expectReject(result, code, label) {
  assert.equal(result.manifest, null, `${label}: manifest 必须为 null`);
  assert.ok(result.reject, `${label}: 必须携带 reject`);
  assert.equal(result.reject.code, code, `${label}: 拒绝码 ${result.reject.code} ≠ ${code}（reason: ${result.reject.reason}）`);
  return result.reject;
}

test('协议常量：七类动作 / 五类 maintain 子动作 / 写动作集合 / 有界常量', () => {
  assert.deepEqual([...WIKI_ACTION_KINDS], ['maintain', 'ingest', 'query', 'lint', 'search', 'log', 'report']);
  assert.deepEqual([...WIKI_MAINTAIN_SUBACCTIONS], ['start', 'status', 'pause', 'resume', 'report']);
  for (const kind of ['maintain', 'ingest', 'lint']) assert.ok(WIKI_WRITE_ACTION_KINDS[kind] === true, `${kind} 应为写动作`);
  for (const kind of ['query', 'search', 'log', 'report']) assert.ok(WIKI_WRITE_ACTION_KINDS[kind] !== true, `${kind} 不应是写动作`);
  assert.equal(WIKI_INGEST_BATCH_MAX, 50, 'ingest 批量上界 50（T-BR-1）');
  assert.equal(WIKI_SEARCH_LIMIT_MAX, 100);
  assert.equal(WIKI_LOG_LIMIT_MAX, 100);
  assert.equal(WIKI_QUERY_VERSIONS_MAX, 64);
  assert.equal(WIKI_MAINTENANCE_BATCH_LIMIT_MAX, 50);
  assert.equal(WIKI_MAINTENANCE_MAX_TOPICS_MAX, 20);
  assert.equal(WIKI_MAINTENANCE_STALL_LIMIT_MAX, 20);
  assert.equal(WIKI_ACTION_REQUEST_ID_MAX, 128);
});

test('maintain start：合法清单 + config 有界 + authority 必填', () => {
  const okResult = normalizeWikiActionManifest({
    action: 'maintain', subaction: 'start', requestId: 'r1',
    ...AUTHORITY,
    config: { batchLimit: 10, maxTopicsPerSource: 5, stallLimit: 3 }
  });
  assert.ok(okResult.manifest, '合法 maintain start 必须通过');
  assert.equal(okResult.manifest.action, 'maintain');
  assert.equal(okResult.manifest.subaction, 'start');
  assert.equal(okResult.manifest.config.batchLimit, 10);

  // authority 缺失 → 零写拒绝（T-PI-1 协议面）
  const noAuth = normalizeWikiActionManifest({ action: 'maintain', subaction: 'start', requestId: 'r2' });
  expectReject(noAuth, 'WIKI_ACTION_AUTHORITY_REQUIRED', 'maintain start 缺 authority');

  // config 越界
  const bound = normalizeWikiActionManifest({
    action: 'maintain', subaction: 'start', requestId: 'r3', ...AUTHORITY,
    config: { batchLimit: 51 }
  });
  expectReject(bound, 'WIKI_ACTION_BOUND_VIOLATION', 'batchLimit 越界');

  // config 只在 start 合法
  const configOnStatus = normalizeWikiActionManifest({ action: 'maintain', subaction: 'status', requestId: 'r4', config: { batchLimit: 5 } });
  expectReject(configOnStatus, 'WIKI_ACTION_EXTRA_FIELD', 'config 出现在 status');

  // status/report 是只读，不需要 authority
  const statusOk = normalizeWikiActionManifest({ action: 'maintain', subaction: 'status', requestId: 'r5' });
  assert.ok(statusOk.manifest, 'maintain status 只读不需要 authority');
  const reportOk = normalizeWikiActionManifest({ action: 'maintain', subaction: 'report', requestId: 'r6' });
  assert.ok(reportOk.manifest, 'maintain report 只读不需要 authority');
});

test('ingest：批量 1..50、条目必填 title/originalUrl、URL 必须 http(s)、authority 必填', () => {
  const one = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'i1', ...AUTHORITY,
    items: [{ title: '标题', originalUrl: 'https://example.com/a' }]
  });
  assert.ok(one.manifest, '单条 ingest 必须通过');

  // 50 条批量通过
  const fifty = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'i2', ...AUTHORITY,
    items: Array.from({ length: 50 }, (_, index) => ({ title: `t${index}`, originalUrl: `https://example.com/${index}` }))
  });
  assert.ok(fifty.manifest, '50 条批量必须通过');

  // 51 条 → 超限零写（T-BR-1）
  const over = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'i3', ...AUTHORITY,
    items: Array.from({ length: 51 }, (_, index) => ({ title: `t${index}`, originalUrl: `https://example.com/${index}` }))
  });
  expectReject(over, 'WIKI_ACTION_BATCH_OVER_LIMIT', '51 条超限');

  // 空数组 → 拒绝
  const empty = normalizeWikiActionManifest({ action: 'ingest', requestId: 'i4', ...AUTHORITY, items: [] });
  expectReject(empty, 'WIKI_ACTION_MISSING_FIELD', '空 items');

  // 缺 authority → 零写
  const noAuth = normalizeWikiActionManifest({ action: 'ingest', requestId: 'i5', items: [{ title: 't', originalUrl: 'https://example.com/x' }] });
  expectReject(noAuth, 'WIKI_ACTION_AUTHORITY_REQUIRED', 'ingest 缺 authority');

  // 非 http(s) URL（file://、相对路径）→ 零写（T-URL-1 协议面）
  for (const bad of ['file:///etc/passwd', 'C:\\tmp\\x.html', '//host/share', 'javascript:alert(1)', 'not-a-url']) {
    const rejectResult = normalizeWikiActionManifest({
      action: 'ingest', requestId: `i6-${bad}`, ...AUTHORITY,
      items: [{ title: 't', originalUrl: bad }]
    });
    expectReject(rejectResult, 'WIKI_ACTION_INVALID_VALUE', `URL ${bad} 拒绝`);
  }

  // 条目缺 title
  const noTitle = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'i7', ...AUTHORITY,
    items: [{ originalUrl: 'https://example.com/x' }]
  });
  expectReject(noTitle, 'WIKI_ACTION_MISSING_FIELD', '缺 title');

  // 未知字段 → fail-closed
  const extra = normalizeWikiActionManifest({
    action: 'ingest', requestId: 'i8', ...AUTHORITY,
    items: [{ title: 't', originalUrl: 'https://example.com/x', feedId: 'feed-1' }]
  });
  expectReject(extra, 'WIKI_ACTION_EXTRA_FIELD', 'feedId 禁止（T-BR 研究边界）');
});

test('query：固定版本引用必填（wikiVersionRefs/noteVersionRefs/evidenceRefs，≥1 非空、每类 ≤64、type:objectId:versionRef 语法）', () => {
  // 无版本 → 固定版本必填拒绝
  const noVersion = normalizeWikiActionManifest({ action: 'query', requestId: 'q1', question: 'AgentForge 支持什么？' });
  expectReject(noVersion, 'WIKI_ACTION_QUERY_VERSION_REQUIRED', 'query 无冻结版本引用');

  // 合法：noteVersionRefs 非空
  const ok = normalizeWikiActionManifest({
    action: 'query', requestId: 'q2', question: 'AgentForge 支持什么？',
    noteVersionRefs: ['knowledge_note:note-1:version-1']
  });
  assert.ok(ok.manifest, 'query 带冻结版本引用必须通过');
  assert.deepEqual(ok.manifest.noteVersionRefs, ['knowledge_note:note-1:version-1']);

  // 每类 64 个通过、65 个拒绝
  const atMax = normalizeWikiActionManifest({
    action: 'query', requestId: 'q3',
    wikiVersionRefs: Array.from({ length: 64 }, (_, index) => `wiki_page:w${index}:v${index}`)
  });
  assert.ok(atMax.manifest, '每类 64 个必须通过');
  const over = normalizeWikiActionManifest({
    action: 'query', requestId: 'q4',
    evidenceRefs: Array.from({ length: 65 }, (_, index) => `evidence:e${index}:v${index}`)
  });
  expectReject(over, 'WIKI_ACTION_BOUND_VIOLATION', '每类 65 个拒绝');

  // 非法引用语法（type:objectId:versionRef）→ 拒绝（T-MF-4：引用不漂移）
  for (const bad of ['note-1:version-1', 'knowledge_note:note-1', 'hack:note-1:version-1', 'knowledge_note:note-1:']) {
    const badRef = normalizeWikiActionManifest({
      action: 'query', requestId: `q5-${bad.length}`, noteVersionRefs: [bad]
    });
    expectReject(badRef, 'WIKI_ACTION_INVALID_VALUE', `非法引用 ${bad} 拒绝`);
  }
  // 空白字符串引用 → BOUND_VIOLATION（非空字符串数组校验先于语法）
  const blankRef = normalizeWikiActionManifest({
    action: 'query', requestId: 'q5b', noteVersionRefs: ['   ']
  });
  expectReject(blankRef, 'WIKI_ACTION_BOUND_VIOLATION', '空白引用拒绝');

  // 裸 readWikiVersionIds 等在 wmb_wiki_action 内 fail-closed 拒绝（仍属 wmb_query_writeback 围栏）
  const bare = normalizeWikiActionManifest({
    action: 'query', requestId: 'q6', readNoteVersionIds: ['note:v1']
  });
  expectReject(bare, 'WIKI_ACTION_EXTRA_FIELD', '裸 read* 字段在 wmb_wiki_action 内拒绝');

  // query 是只读动作：不需要 authority
  const queryNoAuth = normalizeWikiActionManifest({
    action: 'query', requestId: 'q7', wikiVersionRefs: ['wiki_page:w1:v1']
  });
  assert.ok(queryNoAuth.manifest, 'query 只读不需要 authority');
});

test('lint：run=true 写动作需 authority；run=false/缺省只读', () => {
  const write = normalizeWikiActionManifest({ action: 'lint', run: true, requestId: 'l1' });
  expectReject(write, 'WIKI_ACTION_AUTHORITY_REQUIRED', 'lint run=true 缺 authority');
  const writeOk = normalizeWikiActionManifest({ action: 'lint', run: true, requestId: 'l2', ...AUTHORITY });
  assert.ok(writeOk.manifest, 'lint run=true 带 authority 通过');
  const read = normalizeWikiActionManifest({ action: 'lint', requestId: 'l3' });
  assert.ok(read.manifest, 'lint 缺省只读');
  const readFalse = normalizeWikiActionManifest({ action: 'lint', run: false, requestId: 'l4' });
  assert.ok(readFalse.manifest, 'lint run=false 只读');
  const badType = normalizeWikiActionManifest({ action: 'lint', run: 'yes', requestId: 'l5' });
  expectReject(badType, 'WIKI_ACTION_INVALID_VALUE', 'run 非布尔');
});

test('search：query 必填、limit 1..100、objectTypes 枚举受限、只读', () => {
  const ok = normalizeWikiActionManifest({ action: 'search', requestId: 's1', query: 'AgentForge', limit: 20, objectTypes: ['wiki_page', 'knowledge_note'] });
  assert.ok(ok.manifest, '合法 search 通过');
  const noQuery = normalizeWikiActionManifest({ action: 'search', requestId: 's2' });
  expectReject(noQuery, 'WIKI_ACTION_MISSING_FIELD', 'search 缺 query');
  const overLimit = normalizeWikiActionManifest({ action: 'search', requestId: 's3', query: 'x', limit: 101 });
  expectReject(overLimit, 'WIKI_ACTION_BOUND_VIOLATION', 'limit 101 拒绝');
  const badType = normalizeWikiActionManifest({ action: 'search', requestId: 's4', query: 'x', objectTypes: ['hack'] });
  expectReject(badType, 'WIKI_ACTION_INVALID_VALUE', '未知 objectType');
  const noAuth = normalizeWikiActionManifest({ action: 'search', requestId: 's5', query: 'x' });
  assert.ok(noAuth.manifest, 'search 只读不需要 authority');
});

test('log：limit 有界、cursor 有界、filter 枚举受限、只读', () => {
  const ok = normalizeWikiActionManifest({ action: 'log', requestId: 'g1', limit: 20, filter: { eventType: 'change_set' } });
  assert.ok(ok.manifest, '合法 log 通过');
  const overLimit = normalizeWikiActionManifest({ action: 'log', requestId: 'g2', limit: 101 });
  expectReject(overLimit, 'WIKI_ACTION_BOUND_VIOLATION', 'log limit 101 拒绝');
  const badEvent = normalizeWikiActionManifest({ action: 'log', requestId: 'g3', filter: { eventType: 'hack' } });
  expectReject(badEvent, 'WIKI_ACTION_INVALID_VALUE', '未知 eventType');
  const badCursor = normalizeWikiActionManifest({ action: 'log', requestId: 'g4', cursor: 'x'.repeat(257) });
  expectReject(badCursor, 'WIKI_ACTION_BOUND_VIOLATION', 'cursor 超长拒绝');
  const filterExtra = normalizeWikiActionManifest({ action: 'log', requestId: 'g5', filter: { evil: true } });
  expectReject(filterExtra, 'WIKI_ACTION_EXTRA_FIELD', 'filter 未知字段');
});

test('report：只读、无额外字段', () => {
  const ok = normalizeWikiActionManifest({ action: 'report', requestId: 'p1' });
  assert.ok(ok.manifest, 'report 通过');
  const extra = normalizeWikiActionManifest({ action: 'report', requestId: 'p2', limit: 5 });
  expectReject(extra, 'WIKI_ACTION_EXTRA_FIELD', 'report 额外字段');
  const noAuth = normalizeWikiActionManifest({ action: 'report', requestId: 'p3' });
  assert.ok(noAuth.manifest, 'report 只读不需要 authority');
});

test('fail-closed：未知动作 / 非对象 / requestId 超长 / 未知字段 / 类型错误', () => {
  const unknown = normalizeWikiActionManifest({ action: 'explode', requestId: 'f1' });
  expectReject(unknown, 'WIKI_ACTION_UNKNOWN_ACTION', '未知动作');
  const nonObject = normalizeWikiActionManifest('maintain');
  expectReject(nonObject, 'WIKI_ACTION_INVALID', '非对象清单');
  const longRequest = normalizeWikiActionManifest({ action: 'report', requestId: 'x'.repeat(129) });
  expectReject(longRequest, 'WIKI_ACTION_BOUND_VIOLATION', 'requestId 超长');
  const missingRequest = normalizeWikiActionManifest({ action: 'report' });
  expectReject(missingRequest, 'WIKI_ACTION_MISSING_FIELD', '缺 requestId');
  const extraTop = normalizeWikiActionManifest({ action: 'report', requestId: 'f2', surprise: 1 });
  expectReject(extraTop, 'WIKI_ACTION_EXTRA_FIELD', '顶层未知字段');
});

test('围栏解析：只认最后一个 ```json 围栏、剥离协议块、无围栏诚实拒绝', () => {
  const text = '回答正文。\n' + fence({ action: 'search', requestId: 'w1', query: 'AgentForge' });
  assert.ok(hasWikiActionFence(text));
  const parsed = extractWikiActionManifest(text);
  assert.ok(parsed.manifest, '最后一个围栏解析成功');
  assert.equal(parsed.manifest.action, 'search');
  const stripped = stripWikiActionBlock(text);
  assert.ok(!stripped.includes(WIKI_ACTION_MANIFEST_KEY), '剥离后不含协议键');
  assert.ok(!stripped.includes('```'), '剥离后不含围栏');

  // 无围栏 → 诚实拒绝（不猜自由文本）
  const noFence = extractWikiActionManifest('请维护整个 Wiki');
  expectReject(noFence, 'WIKI_ACTION_MISSING', '无围栏拒绝');
  assert.equal(stripWikiActionBlock('请维护整个 Wiki'), '请维护整个 Wiki');

  // JSON 非法 → 拒绝
  const badJson = extractWikiActionManifest('```json\n{not json\n```');
  expectReject(badJson, 'WIKI_ACTION_INVALID', '非法 JSON 拒绝');

  // 围栏存在但键不对（如 wmb_query_writeback）→ 清单缺失拒绝
  const otherKey = extractWikiActionManifest('```json\n{"wmb_query_writeback": {"classification": "restatement"}}\n```');
  expectReject(otherKey, 'WIKI_ACTION_MISSING', '非 wmb_wiki_action 键拒绝');
});

test('协议键命名：SKILL.md 内不得以反引号书写 wmb_wiki_action（防工具 parity 误判）', async () => {
  const { readFile } = await import('node:fs/promises');
  const skill = await readFile(new URL('../skills/wemedia-buddy-operator/SKILL.md', import.meta.url), 'utf8');
  // 协议键以普通文本登记（像 wmb_query_writeback 一样不带反引号）；工具名以反引号登记
  assert.ok(skill.includes('wmb_wiki_action'), 'SKILL.md 必须登记 wmb_wiki_action 协议键');
  assert.doesNotMatch(skill, /`wmb_wiki_action`/, '协议键不得以反引号书写（避免被误判为工具名）');
});

test('协议键与动作清单登记在 Pi authority prompt（NL 能力声明）', async () => {
  const { PI_AUTHORITY_SYSTEM_PROMPT } = await import('../src/main/pi-operator-skill.ts');
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /wmb_wiki_action/);
  assert.match(PI_AUTHORITY_SYSTEM_PROMPT, /维护整个 Wiki|维护/);
});
