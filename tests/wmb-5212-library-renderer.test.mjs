// WMB-5212 资料库知识面原位改造 —— renderer 聚焦合同测试。
// 覆盖：library-view-parts 纯函数（段迁移/标签/回执消化/质量画像/健康严重度/刷新 scope/
// 详情信封归一）与渲染层合同（资料/观察中/待处理/知识健康/移出 tabs、Source 详情 Raw/质量/回执/
// Evidence/关联/批注、持久内联回执、深链、dataChanged 订阅替代轮询、键盘/aria、无平行知识 CRUD）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  annotationIntentLabel,
  asSourceKnowledgeDetail,
  bodyStatusLabel,
  conclusionStatusLabel,
  digestForSource,
  evidenceNatureLabel,
  evidenceRelationLabel,
  healthSeverityCls,
  healthStatusLabel,
  migrateLibrarySection,
  receiptCountsSummary,
  receiptSourceId,
  receiptTriggerLabel,
  shouldRefreshLibrary,
  sourceListBadges,
  sourceQualityProfile,
} from '../src/renderer/library-view-parts.ts';
import { sourceContentEquivalent } from '../src/renderer/source-content-equivalence.ts';

// ---------------------------------------------------------------------------
// 纯逻辑：段迁移与标签
// ---------------------------------------------------------------------------
test('WMB-5212 UI: source copy equivalence ignores presentation whitespace but preserves distinct content', () => {
  assert.equal(sourceContentEquivalent('同一条资料\n\n正文', '  同一条资料 正文  '), true);
  assert.equal(sourceContentEquivalent('标题', '不同的正文'), false);
});


test('WMB-5212 UI: migrateLibrarySection maps old rediscovery section to pending', () => {
  assert.equal(migrateLibrarySection('rediscovery'), 'pending');
  assert.equal(migrateLibrarySection('saved'), 'saved');
  assert.equal(migrateLibrarySection('watching'), 'watching');
  assert.equal(migrateLibrarySection('pending'), 'pending');
  assert.equal(migrateLibrarySection('health'), 'health');
  assert.equal(migrateLibrarySection('removed'), 'removed');
  assert.equal(migrateLibrarySection(null), null);
  assert.equal(migrateLibrarySection('bogus'), null);
});

test('WMB-5212 UI: receipt trigger labels cover every trigger type', () => {
  for (const trigger of ['ingest', 'query', 'lint', 'creation', 'review']) {
    assert.ok(receiptTriggerLabel(trigger).length > 0);
  }
  assert.equal(receiptTriggerLabel('ingest'), '资料摄取');
  assert.equal(receiptTriggerLabel('query'), '问答写回');
  assert.equal(receiptTriggerLabel('lint'), '健康检查');
  assert.equal(receiptTriggerLabel('creation'), '创作引用');
  assert.equal(receiptTriggerLabel('review'), '复盘回流');
});

test('WMB-5212 UI: evidence relation/nature labels cover the taxonomy', () => {
  for (const relation of ['supports', 'contradicts', 'qualifies', 'derived_from']) {
    assert.ok(evidenceRelationLabel(relation).length > 0);
  }
  assert.equal(evidenceRelationLabel('supports'), '支持');
  assert.equal(evidenceRelationLabel('contradicts'), '反驳');
  assert.equal(evidenceRelationLabel('qualifies'), '限定');
  for (const nature of [
    'primary_source', 'secondary_source', 'user_statement', 'user_experience',
    'business_record', 'performance_observation', 'review', 'derived_knowledge', 'ai_inference'
  ]) {
    assert.ok(evidenceNatureLabel(nature).length > 0);
  }
  assert.equal(evidenceNatureLabel('primary_source'), '一手来源');
  assert.equal(evidenceNatureLabel('ai_inference'), 'AI 推断');
});

test('WMB-5212 UI: health status labels and severity classes cover statuses', () => {
  for (const status of ['open', 'repairing', 'resolved', 'accepted_risk', 'false_positive']) {
    assert.ok(healthStatusLabel(status).length > 0);
  }
  assert.equal(healthStatusLabel('open'), '未处理');
  assert.equal(healthStatusLabel('resolved'), '已解决');
  assert.equal(healthSeverityCls('critical'), 'critical');
  assert.equal(healthSeverityCls('high'), 'critical');
  assert.equal(healthSeverityCls('medium'), 'medium');
  assert.equal(healthSeverityCls('low'), 'low');
  assert.equal(healthSeverityCls('info'), 'low');
});

test('WMB-5212 UI: conclusion status and body status labels cover states', () => {
  for (const status of ['unverified', 'supported', 'disputed', 'contradicted', 'superseded', 'not_applicable', 'inference']) {
    assert.ok(conclusionStatusLabel(status).length > 0);
  }
  assert.equal(conclusionStatusLabel('disputed'), '有争议');
  assert.equal(conclusionStatusLabel('inference'), '推断');
  assert.equal(bodyStatusLabel('ready'), '正文已保存');
  assert.equal(bodyStatusLabel('failed'), '正文归档失败');
  assert.equal(bodyStatusLabel('empty'), '无正文');
  assert.equal(bodyStatusLabel('none'), '正文归档中');
});

test('WMB-5212 UI: annotation intent labels cover intent taxonomy', () => {
  for (const intent of [
    'correction', 'qualify', 'downgrade', 'emphasize', 'research_request', 'merge', 'split', 'restore', 'comment'
  ]) {
    assert.ok(annotationIntentLabel(intent).length > 0);
  }
  assert.equal(annotationIntentLabel('correction'), '纠正');
  assert.equal(annotationIntentLabel('comment'), '评论');
});

// ---------------------------------------------------------------------------
// 纯逻辑：回执消化摘要与行内联徽标
// ---------------------------------------------------------------------------

const receipt = (overrides = {}) => ({
  id: 'r1',
  workspaceId: 'ws',
  changeSetId: 'cs1',
  triggerType: 'ingest',
  requestId: 'req-1',
  summary: 'Source s1 r1 知识编译：新增 2 条、更新 1 条。',
  counts: { notesCreated: 2, notesUpdated: 1, wikiPagesCompiled: 1 },
  affectedTopics: ['t1'],
  affectedEntities: [],
  affectedMethods: [],
  affectedSyntheses: [],
  wikiPageVersions: [],
  impact: { sourceId: 's1', sourceRevision: 1, scope: 'lane:demo', topicId: 't1', asOf: '2026-08-12T00:00:00Z' },
  autoResolutions: [],
  retainedDisputes: [],
  failures: [],
  createdBy: 'background_agent',
  createdAt: '2026-08-12T00:00:00.000Z',
  ...overrides
});

test('WMB-5212 UI: receiptSourceId extracts impact.sourceId from compiler receipts', () => {
  assert.equal(receiptSourceId(receipt()), 's1');
  assert.equal(receiptSourceId(receipt({ impact: { scope: 'lane:x' } })), null);
  assert.equal(receiptSourceId(receipt({ impact: null })), null);
});

test('WMB-5212 UI: digestForSource groups receipts by impact.sourceId and picks newest', () => {
  const older = receipt({ id: 'r-old', createdAt: '2026-08-11T00:00:00.000Z', summary: '旧回执' });
  const newer = receipt({ id: 'r-new', createdAt: '2026-08-12T00:00:00.000Z', summary: '新回执' });
  const other = receipt({ id: 'r-other', impact: { sourceId: 's2' }, createdAt: '2026-08-13T00:00:00.000Z' });
  const digest = digestForSource([newer, older, other], 's1');
  assert.equal(digest.receipts.length, 2);
  assert.equal(digest.latest?.id, 'r-new');
  assert.equal(digest.summary, '新回执');
  assert.equal(digest.updatedAt, '2026-08-12T00:00:00.000Z');
  assert.equal(digestForSource([], 's1').latest, null);
  assert.equal(digestForSource(null, 's1').summary, null);
});

test('WMB-5212 UI: receiptCountsSummary renders counts with labels and zero fallback', () => {
  const text = receiptCountsSummary({ notesCreated: 2, notesUpdated: 1, wikiPagesCompiled: 1, evidenceLinks: 3 });
  assert.ok(text.includes('新增 2'));
  assert.ok(text.includes('更新 1'));
  assert.ok(text.includes('重编译 1'));
  assert.ok(text.includes('证据 3'));
  assert.equal(receiptCountsSummary({}), '无知识变化');
  assert.equal(receiptCountsSummary(null), '无知识变化');
});

test('WMB-5212 UI: sourceListBadges composes inline body/digest/health badges', () => {
  assert.deepEqual(sourceListBadges({}), []);
  const badges = sourceListBadges({ bodyStatus: 'ready', digested: true, openHealthIssues: 2 });
  assert.deepEqual(badges, [
    { cls: 'green', text: '正文已保存' },
    { cls: 'green', text: '已消化' },
    { cls: 'amber', text: '健康问题 2' }
  ]);
  const failed = sourceListBadges({ bodyStatus: 'failed', openHealthIssues: 0 });
  assert.deepEqual(failed, [{ cls: 'amber', text: '正文归档失败' }]);
});

test('WMB-5212 UI: sourceQualityProfile maps verification/management into visible labels', () => {
  const profile = sourceQualityProfile({ id: 's1', title: 'x', verificationStatus: 'disputed', managementStatus: 'watching', priority: 2 }, {
    bodyStatus: 'ready', digested: true, evidenceCount: 3, openHealthIssues: 1
  });
  assert.equal(profile.verification.text, '有争议');
  assert.equal(profile.management.text, '观察中');
  assert.equal(profile.priority, 2);
  assert.equal(profile.bodyStatus, 'ready');
  assert.equal(profile.digested, true);
  assert.equal(profile.evidenceCount, 3);
  assert.equal(profile.openHealthIssues, 1);
});

test('WMB-5212 UI: dataChanged refresh scope gate matches library broadcast contract', () => {
  assert.equal(shouldRefreshLibrary(['sources']), true);
  assert.equal(shouldRefreshLibrary(['library']), true);
  assert.equal(shouldRefreshLibrary(['knowledge', 'topics', 'receipt', 'health']), true);
  assert.equal(shouldRefreshLibrary(['today', 'agent']), false);
  assert.equal(shouldRefreshLibrary(['proposals']), false);
  assert.equal(shouldRefreshLibrary(null), true);
});

// ---------------------------------------------------------------------------
// 纯逻辑：Source 详情信封归一（backend 契约 SourceKnowledgeDetail）
// ---------------------------------------------------------------------------

test('WMB-5212 UI: asSourceKnowledgeDetail normalizes backend envelope and tolerates gaps', () => {
  const detail = asSourceKnowledgeDetail({
    sourceId: 's1',
    source: { id: 's1', title: '标题', revision: 2 },
    topics: [{ id: 't1', title: '主题一', status: 'active' }],
    evidence: { items: [{ id: 'e1', relation: 'supports', noteStatement: '一句话', noteConclusionStatus: 'supported' }], total: 1, limit: 20, offset: 0, hasMore: false },
    receipts: { items: [receipt()], total: 1, limit: 20, offset: 0, hasMore: false },
    healthIssues: { items: [{ id: 'h1', issueType: 'stale_claim', status: 'open' }], total: 1, limit: 20, offset: 0, hasMore: false },
    annotations: { items: [{ id: 'a1', targetType: 'knowledge_note_version', targetId: 'nv1', intent: 'correction', body: '批注', processingState: 'open', createdBy: 'user', createdAt: '2026-08-12T00:00:00.000Z' }], total: 1, limit: 20, offset: 0, hasMore: false }
  });
  assert.ok(detail);
  assert.equal(detail?.sourceId, 's1');
  assert.equal(detail?.topics[0]?.id, 't1');
  assert.equal(detail?.evidence.items[0]?.noteStatement, '一句话');
  assert.equal(detail?.receipts.items[0]?.id, 'r1');
  assert.equal(detail?.healthIssues.items[0]?.issueType, 'stale_claim');
  assert.equal(detail?.annotations.items[0]?.intent, 'correction');
  assert.equal(asSourceKnowledgeDetail(null), null);
  assert.equal(asSourceKnowledgeDetail({}), null);
  const sparse = asSourceKnowledgeDetail({ sourceId: 's2' });
  assert.ok(sparse);
  assert.deepEqual(sparse?.evidence.items, []);
  assert.deepEqual(sparse?.receipts.items, []);
  assert.equal(sparse?.source, null);
});

// ---------------------------------------------------------------------------
// 渲染层合同：tabs、详情知识区、持久内联回执、dataChanged、深链、键盘、无平行 CRUD
// ---------------------------------------------------------------------------

const view = await readFile(new URL('../src/renderer/library-view.tsx', import.meta.url), 'utf8');
const parts = await readFile(new URL('../src/renderer/library-view-parts.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/renderer/styles-workflow-library.css', import.meta.url), 'utf8');
const mainTsx = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');

test('WMB-5212 UI: library navigation is 资料/观察中/待处理/知识健康/移出 with tablist semantics', () => {
  assert.match(view, /role="tablist"/);
  assert.match(view, /role="tab"/);
  assert.match(view, /aria-selected=\{section === item\.id\}/);
  for (const label of ['资料', '观察中', '待处理', '知识健康', '移出']) {
    assert.ok(view.includes(label), `缺少 tab 文案 ${label}`);
  }
  const ids = ['saved', 'watching', 'pending', 'health', 'removed'];
  const positions = ids.map((id) => view.indexOf(`id: '${id}'`));
  assert.ok(positions.every((pos) => pos >= 0), '缺少 section id');
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] > positions[index - 1], `section 顺序错误：${ids[index - 1]} 应排在 ${ids[index]} 前`);
  }
  // 键盘 tab 导航：方向键/Home/End
  assert.match(view, /ArrowLeft/);
  assert.match(view, /ArrowRight/);
  assert.match(view, /'Home'/);
  assert.match(view, /'End'/);
});

test('WMB-5212 UI: watching is a top-level tab reusing standard rows, old top board removed', () => {
  assert.ok(view.includes("id: 'watching'"));
  assert.ok(view.includes("label: '观察中'"));
  // 观察中页是独立分支，直接复用标准资料行（lib-row），不再有顶部卡片板块
  assert.match(view, /section === 'watching' \?/);
  assert.match(view, /watching\.map\(renderLibraryRow\)/);
  assert.match(view, /watching\.length \? <div className="library-list">/);
  // 旧顶部观察卡片板块及其专用样式已删除
  assert.doesNotMatch(view, /library-watching-board/);
  assert.doesNotMatch(view, /library-watching-card/);
  assert.doesNotMatch(view, /library-watching-list/);
  assert.doesNotMatch(css, /library-watching-board/);
  assert.doesNotMatch(css, /library-watching-card/);
  assert.doesNotMatch(css, /library-watching-list/);
  // 数据源仍是既有 watching 查询，且观察中页有自己的 dataChanged 订阅
  assert.match(view, /window\.wmb\.listWatchingSources\(\{ limit: 100 \}\)/);
  assert.match(view, /void loadWatching\(\)/);
  assert.match(view, /观察中已自动更新/);
  // 空态清晰：引导用户把资料设为观察中
  assert.ok(view.includes('没有观察中的资料'));
  assert.ok(view.includes('在资料详情中把管理状态设为「观察中」后，会出现在这里；支持打开详情与原文。'));
});

test('WMB-5212 UI: dataChanged subscription replaces polling as the refresh path', () => {
  assert.doesNotMatch(view, /setInterval/);
  assert.doesNotMatch(view, /5000/);
  assert.match(view, /window\.wmb\.onDataChanged/);
  assert.match(view, /shouldRefreshLibrary\(event\.scopes\)/);
  // 自动刷新只宣布不抢焦点：aria-live 简短宣布
  assert.match(view, /aria-live="polite"/);
  assert.match(view, /sr-only/);
});

test('WMB-5212 UI: source detail consumes the backend aggregate and deep link channels', () => {
  assert.match(view, /window\.wmb\.getSourceKnowledgeDetail\(\{/);
  assert.match(view, /evidenceLimit: 20/);
  assert.match(view, /receiptLimit: 20/);
  assert.match(view, /healthLimit: 20/);
  assert.match(view, /annotationLimit: 20/);
  assert.match(view, /window\.wmb\.resolveKnowledgeDeepLink\(\{ objectType: issue\.affectedObjectType, objectId: issue\.affectedObjectId \}/);
  // 行内联知识面：正文缓存状态批量读取 + 回执消化 + 未处理健康问题
  assert.match(view, /window\.wmb\.listSourceBodyCaches\(ids\)/);
  assert.match(view, /window\.wmb\.listUpdateReceipts\(\{ limit: 200 \}\)/);
  assert.match(view, /window\.wmb\.listHealthIssues\(\{ status: 'open', limit: 200 \}\)/);
  // 知识健康页筛选（severity/status/type）
  assert.match(view, /listHealthIssues\(\{/);
  assert.match(view, /healthSeverityFilter/);
  assert.match(view, /healthStatusFilter/);
  assert.match(view, /healthTypeFilter/);
});

test('WMB-5212 UI: source detail prioritizes reading and keeps diagnostics available on demand', () => {
  const summaryIndex = view.indexOf('className="library-source-summary"');
  const bodyIndex = view.indexOf('className="library-source-primary-body"');
  const mediaIndex = view.indexOf('<SourceMediaSection');
  const diagnosticsIndex = view.indexOf('className="library-source-diagnostics"');
  assert.ok(summaryIndex >= 0 && summaryIndex < bodyIndex, '摘要应在正文前');
  assert.ok(bodyIndex < mediaIndex, '正文应在媒体前');
  assert.ok(mediaIndex < diagnosticsIndex, '媒体应在诊断信息前');
  assert.match(view, /<button className="secondary-button library-source-detail-back"[^>]*>← 返回<\/button>/);
  assert.match(view, /const showSummary = Boolean\(summaryText\) && !sourceContentEquivalent\(summaryText, titleText\)/);
  assert.match(view, /const bodyDuplicatesVisibleCopy = Boolean\(archivedText/);
  assert.match(view, /\{showSummary \? <section className="library-source-summary"/);
  assert.match(view, /\{!bodyDuplicatesVisibleCopy \? <section className="library-source-primary-body"/);
  assert.match(view, /<details className="library-source-diagnostics">/);
  assert.match(view, /<span>资料信息与诊断<\/span>/);
  assert.match(view, /<details open=\{sourceDetailLoading \? undefined : \(detail\?\.receipts\.items\.length \?\? 0\) > 0\}>/);
  assert.match(view, /receiptTriggerLabel\(receipt\.triggerType\)/);
  assert.match(view, /receiptCountsSummary\(receipt\.counts\)/);
  assert.match(view, /onOpenTopic\?\.\(topicId\)/);
  assert.ok(view.includes('尚无摄取回执'));
});

test('WMB-5212 UI: detail sections use available width while images keep intrinsic size', () => {
  assert.match(css, /\.library-source-detail-intro\s*\{[^}]*max-width:\s*none/s);
  assert.match(css, /\.library-source-primary-body\s*\{[^}]*max-width:\s*none/s);
  assert.match(css, /\.library-media-image\s*\{[^}]*width:\s*auto[^}]*height:\s*auto/s);
  assert.match(css, /\.library-media-figure\s*\{[^}]*width:\s*fit-content[^}]*max-width:\s*100%/s);
  assert.match(css, /\.library-media-viewer\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.library-source-detail h1\s*\{[^}]*text-wrap:\s*wrap/s);
  assert.match(css, /\.library-source-summary p\s*\{[^}]*max-width:\s*none/s);
});

test('WMB-5212 UI: source detail has Raw/质量/Evidence/关联/批注/健康 regions', () => {
  assert.ok(view.includes('来源质量'));
  assert.ok(view.includes('正文'));
  assert.ok(view.includes('证据贡献'));
  assert.ok(view.includes('关联'));
  assert.ok(view.includes('批注'));
  assert.ok(view.includes('健康问题'));
  // 质量画像：正文/消化/证据/健康 全部可见
  assert.match(view, /bodyStatusLabel\(quality\.bodyStatus\)/);
  assert.match(view, /quality\.digested \? '已消化' : '未消化'/);
  assert.match(view, /quality\.evidenceCount/);
  assert.match(view, /quality\.openHealthIssues/);
  // Evidence 只读：展示证据链与所支撑知识版本，不编辑 EvidenceLink
  assert.match(view, /evidenceRelationLabel\(entry\.relation\)/);
  assert.match(view, /evidenceNatureLabel\(entry\.sourceNature\)/);
  assert.match(view, /conclusionStatusLabel\(entry\.noteConclusionStatus\)/);
  assert.match(view, /entry\.noteStatement/);
});

test('WMB-5212 UI: stale/failed/disputed/inference are visible via labels, not color alone', () => {
  assert.ok(view.includes('有争议')); // disputed（核验下拉与徽标）
  assert.ok(view.includes('正文归档失败')); // failed body
  // 推断/stale 语义标签定义在映射并在视图中被使用（不只用颜色）
  assert.match(parts, /inference: '推断'/);
  assert.match(parts, /contradicted: '被反驳'/);
  assert.match(view, /conclusionStatusLabel\(entry\.noteConclusionStatus\)/);
  assert.match(view, /issueTypeLabel\(issue\.issueType\)/);
  assert.match(view, /severityLabel\(issue\.severity\)/);
  assert.match(view, /healthStatusLabel\(issue\.status\)/);
});

test('WMB-5212 UI: existing source management flows stay intact', () => {
  assert.match(view, /window\.wmb\.listKnowledgeSources\(\{/);
  assert.match(view, /window\.wmb\.updateKnowledgeSource\(\{/);
  assert.match(view, /window\.wmb\.deleteKnowledgeSource\(\{/);
  assert.match(view, /window\.wmb\.laneRestoreSource\(\{ sourceId: source\.id, expectedRevision: source\.revision \}\)/);
  assert.match(view, /window\.wmb\.fetchSourceBody\(\{ sourceId: source\.id, force, maxChars: 20000 \}\)/);
  assert.match(view, /window\.wmb\.getSourceBodyCache\(source\.id\)/);
  assert.match(view, /window\.wmb\.getKnowledgeContext\(\{ sourceId: source\.id \}\)/);
  assert.match(view, /window\.wmb\.listWatchingSources\(\{ limit: 100 \}\)/);
  assert.match(view, /window\.wmb\.getRediscovery\(\)/);
  assert.match(view, /window\.wmb\.openExternal\(/);
});

test('WMB-5212 UI: renderer never writes formal knowledge directly (no KnowledgeNote CRUD)', () => {
  // 唯一正式写入口是 ChangeSet（由编译器/后台执行）；资料库视图零写
  assert.doesNotMatch(view, /submitKnowledgeChangeSet/);
  assert.doesNotMatch(view, /applyKnowledgeChangeSet/);
  // 不出现用户维护 KnowledgeNote 的创建/编辑表单
  assert.doesNotMatch(view, /createKnowledgeNote/);
  assert.doesNotMatch(view, /saveKnowledgeNote/);
  // 行内联状态与健康问题都是只读投影
  assert.match(view, /sourceListBadges\(/);
});


test('WMB-5212 UI: pending tab surfaces reason, evidence change and next-step actions', () => {
  assert.match(view, /PENDING_POOLS/);
  assert.match(view, /高价值但尚未创作/);
  assert.match(view, /持续观察/);
  assert.match(view, /待核验超过 7 天/);
  assert.match(view, /item\.latestReceipt/);
  assert.match(view, /receiptTriggerLabel\(item\.latestReceipt\.triggerType\)/);
  assert.match(view, /openPendingTopic\(item\)/);
  assert.match(view, /openSourceDrawer\(item\)/);
});

test('WMB-5212 UI: health tab resolves affected objects and deep links', () => {
  assert.match(view, /loadHealthIssues\(\)/);
  assert.match(view, /loadAffectedIndex\(\)/);
  assert.match(view, /affectedLabel\(issue\)/);
  assert.match(view, /openHealthAffected\(issue\)/);
  assert.match(view, /issueTypeLabel\(issue\.issueType\)/);
  assert.match(view, /severityLabel\(issue\.severity\)/);
  assert.match(view, /healthStatusLabel\(issue\.status\)/);
});
