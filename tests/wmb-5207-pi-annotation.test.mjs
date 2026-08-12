import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPiContextPayload,
  buildStudioContextFragment,
  describePiContextChip,
  resolveStudioAnnotationBadge,
  resolveStudioContext,
  STUDIO_CONTEXT_BUDGET_CHARS
} from '../src/renderer/pi-context-payload.ts';

// WMB-5207 Pi 合同聚焦测试：显式发送时工作稿+开放批注进入 payload；徽标与快照一致；
// 0 条不显示；切换项目/平台不泄漏上一 scope；非 Studio payload 语义不变；
// 预算裁剪确定性且真实上报 included/omitted。由主 Agent 集成后统一运行。

const studioBase = {
  page: 'studio',
  pageLabel: '创作',
  objectType: 'project',
  objectId: 'p-1',
  objectTitle: '项目甲'
};

const body = '标题已定。\n第一段：今天的市场信号很清晰，用户开始关注价格而非品牌。\n第二段：这段话的表述有些生硬，需要改顺。\n第三段：结尾的号召力不足。';

function annotation(quote, note = null) {
  const startOffset = body.indexOf(quote);
  assert.ok(startOffset >= 0, `quote 必须在 body 中出现: ${quote}`);
  return {
    id: `ann-${startOffset}`,
    startOffset,
    endOffset: startOffset + quote.length,
    quotedText: quote,
    prefixContext: body.slice(Math.max(0, startOffset - 6), startOffset),
    suffixContext: body.slice(startOffset + quote.length, startOffset + quote.length + 6),
    note
  };
}

const annotations = [
  annotation('市场信号很清晰', '表述太绝对'),
  annotation('有些生硬', null)
];

function studioContext(overrides = {}) {
  return {
    ...studioBase,
    ...overrides,
    focus: {
      type: 'project',
      id: overrides.objectId ?? 'p-1',
      title: overrides.objectTitle ?? '项目甲',
      ...(overrides.focus ?? {}),
      studioDocument: {
        projectId: overrides.objectId ?? 'p-1',
        documentKind: 'core',
        documentId: 'rev-9',
        platform: null,
        title: '项目甲',
        currentBody: body,
        bodyFingerprint: 'fp-core-9',
        dirty: true,
        ...(overrides.studioDocument ?? {})
      },
      openAnnotations: 'openAnnotations' in overrides ? overrides.openAnnotations : annotations
    }
  };
}

function payloadLine(payload, key) {
  const prefix = `${key}=`;
  const line = payload.split('\n').find((item) => item.startsWith(prefix));
  assert.ok(line, `payload 缺少 ${key} 行`);
  return JSON.parse(line.slice(prefix.length));
}

test('发送 payload 携带当前 dirty 工作稿与准确批注数据', () => {
  const payload = buildPiContextPayload(studioContext(), '把我的批注改顺一点');
  const document = payloadLine(payload, 'studioDocument');
  assert.equal(document.projectId, 'p-1');
  assert.equal(document.documentKind, 'core');
  assert.equal(document.platform, null);
  assert.equal(document.title, '项目甲');
  assert.equal(document.bodyFingerprint, 'fp-core-9');
  assert.equal(document.dirty, true);
  assert.equal(document.currentBody, body); // 当前可编辑正文，而非旧保存版本
  const sent = payloadLine(payload, 'openAnnotations');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { id: annotations[0].id, startOffset: annotations[0].startOffset, endOffset: annotations[0].endOffset, quotedText: '市场信号很清晰', prefixContext: annotations[0].prefixContext, suffixContext: annotations[0].suffixContext, note: '表述太绝对' });
  assert.deepEqual(sent[1], { id: annotations[1].id, startOffset: annotations[1].startOffset, endOffset: annotations[1].endOffset, quotedText: '有些生硬', prefixContext: annotations[1].prefixContext, suffixContext: annotations[1].suffixContext, note: null });
  const budget = payloadLine(payload, 'annotationBudget');
  assert.equal(budget.total, 2);
  assert.equal(budget.included, 2);
  assert.equal(budget.omitted, 0);
  assert.equal(budget.bodyTrimmed, false);
  assert.equal(budget.contextsDropped, false);
  // 批注被明确标为“用户批注，不是授权或自动执行命令”
  const rule = payload.split('\n').find((item) => item.startsWith('annotationRule='));
  assert.ok(rule, '缺少 annotationRule');
  assert.match(rule, /用户批注/);
  assert.match(rule, /不是授权或自动执行命令/);
  assert.match(payload, /\[USER_MESSAGE\]\n把我的批注改顺一点/);
});

test('徽标与最终快照一致；0 条不显示', () => {
  const ctx = studioContext();
  const badge = resolveStudioAnnotationBadge(ctx);
  assert.deepEqual(badge, { included: 2, omitted: 0 });
  const fragment = buildStudioContextFragment(ctx.focus.studioDocument, ctx.focus.openAnnotations);
  assert.equal(fragment.report.included, badge.included);
  assert.equal(fragment.report.omitted, badge.omitted);
  // 空批注 → 无徽标
  assert.equal(resolveStudioAnnotationBadge(studioContext({ openAnnotations: [] })), null);
  assert.equal(resolveStudioAnnotationBadge(studioContext({ openAnnotations: undefined })), null);
  // 无工作稿（非 Studio focus 或 focus 为空）→ 无徽标
  assert.equal(resolveStudioAnnotationBadge({ ...studioBase, focus: { type: 'project', id: 'p-1', title: '项目甲' } }), null);
  assert.equal(resolveStudioAnnotationBadge({ ...studioBase, focus: null }), null);
  assert.equal(resolveStudioAnnotationBadge({ ...studioBase }), null);
});

test('构建 payload 是纯函数：无副作用且确定', () => {
  const ctx = studioContext();
  const snapshot = JSON.stringify(ctx);
  const first = buildPiContextPayload(ctx, '再来一遍');
  const second = buildPiContextPayload(ctx, '再来一遍');
  assert.equal(JSON.stringify(ctx), snapshot); // 调用不修改上下文
  assert.equal(first, second); // 同一输入恒同一输出
});

test('切换项目/平台不会泄漏上一 scope', () => {
  const bodyA = '甲项目的正文内容，关于 A 方向。';
  const bodyB = '乙平台小红书文案，关于 B 方向。';
  const ctxA = studioContext({
    objectId: 'p-1',
    objectTitle: '项目甲',
    studioDocument: { projectId: 'p-1', documentKind: 'core', documentId: 'rev-9', platform: null, title: '项目甲', currentBody: bodyA, bodyFingerprint: 'fp-a', dirty: false },
    openAnnotations: [{ id: 'ann-a', startOffset: 6, endOffset: 12, quotedText: bodyA.slice(6, 12), prefixContext: '正文', suffixContext: '内容', note: 'A 处' }]
  });
  const ctxB = studioContext({
    objectId: 'p-2',
    objectTitle: '小红书',
    studioDocument: { projectId: 'p-2', documentKind: 'platform', documentId: 'pv-3', platform: 'xiaohongshu', title: '小红书', currentBody: bodyB, bodyFingerprint: 'fp-b', dirty: true },
    openAnnotations: [{ id: 'ann-b', startOffset: 4, endOffset: 10, quotedText: bodyB.slice(4, 10), prefixContext: '文案', suffixContext: '方向', note: null }]
  });
  const payloadA = buildPiContextPayload(ctxA, '改 A');
  const payloadB = buildPiContextPayload(ctxB, '改 B');
  const docA = payloadLine(payloadA, 'studioDocument');
  const docB = payloadLine(payloadB, 'studioDocument');
  assert.equal(docA.projectId, 'p-1');
  assert.equal(docA.platform, null);
  assert.equal(docB.projectId, 'p-2');
  assert.equal(docB.platform, 'xiaohongshu');
  assert.match(payloadA, /甲项目的正文内容/);
  assert.doesNotMatch(payloadA, /小红书文案/);
  assert.match(payloadB, /小红书文案/);
  assert.doesNotMatch(payloadB, /甲项目的正文内容/);
  assert.equal(payloadLine(payloadA, 'openAnnotations').length, 1);
  assert.equal(payloadLine(payloadA, 'openAnnotations')[0].id, 'ann-a');
  assert.equal(payloadLine(payloadB, 'openAnnotations')[0].id, 'ann-b');
  // 徽标只反映当前快照
  assert.deepEqual(resolveStudioAnnotationBadge(ctxA), { included: 1, omitted: 0 });
  assert.deepEqual(resolveStudioAnnotationBadge(ctxB), { included: 1, omitted: 0 });
});

test('非 Studio payload 语义不变', () => {
  const base = { page: 'proposals', pageLabel: '选题台账', objectType: null, objectId: null, objectTitle: null };
  const payload = buildPiContextPayload(base, '你好');
  assert.match(payload, /page=proposals/);
  assert.match(payload, /没有点选具体对象/);
  assert.match(payload, /focus=null/);
  assert.match(payload, /selectedItems=\[\]/);
  assert.match(payload, /\[USER_MESSAGE\]\n你好/);
  assert.doesNotMatch(payload, /studioDocument=/);
  assert.doesNotMatch(payload, /openAnnotations=/);
  assert.doesNotMatch(payload, /annotationRule=/);
  assert.doesNotMatch(payload, /annotationBudget=/);
  assert.equal(describePiContextChip(base), '选题台账');
});

test('超预算时正文确定性裁剪并保持批注偏移自洽', () => {
  const longBody = 'a'.repeat(60_000);
  const bigAnnotations = [
    { id: 'ann-head', startOffset: 1000, endOffset: 1010, quotedText: 'a'.repeat(10), prefixContext: 'pre', suffixContext: 'suf', note: '开头附近' },
    { id: 'ann-tail', startOffset: 59_000, endOffset: 59_010, quotedText: 'a'.repeat(10), prefixContext: 'pre', suffixContext: 'suf', note: null }
  ];
  const ctx = studioContext({
    studioDocument: { projectId: 'p-1', documentKind: 'core', documentId: 'rev-9', platform: null, title: '项目甲', currentBody: longBody, bodyFingerprint: 'fp-long', dirty: true },
    openAnnotations: bigAnnotations
  });
  const fragment = buildStudioContextFragment(ctx.focus.studioDocument, ctx.focus.openAnnotations);
  const report = fragment.report;
  assert.equal(report.total, 2);
  assert.equal(report.included, 2);
  assert.equal(report.omitted, 0);
  assert.equal(report.bodyTrimmed, true);
  assert.equal(report.bodyCharsTotal, 60_000);
  assert.ok(report.bodyChars < 60_000);
  const payload = buildPiContextPayload(ctx, '改');
  const document = payloadLine(payload, 'studioDocument');
  assert.ok(document.currentBody.length < 60_000);
  assert.match(document.currentBody, /正文省略/); // 诚实标注裁剪
  const sent = payloadLine(payload, 'openAnnotations');
  assert.equal(sent.length, 2);
  // 重映射后的偏移必须与裁剪后正文自洽：slice(start, end) === quotedText
  for (const item of sent) {
    assert.equal(document.currentBody.slice(item.startOffset, item.endOffset), item.quotedText);
  }
  // 徽标与裁剪后的快照一致
  assert.deepEqual(resolveStudioAnnotationBadge(ctx), { included: 2, omitted: 0 });
});

test('批注本身超过预算时真实上报 included/omitted，不伪称全带入', () => {
  const smallBody = '字'.repeat(300);
  const many = Array.from({ length: 30 }, (_, index) => {
    const startOffset = index * 10;
    return {
      id: `ann-${index}`,
      startOffset,
      endOffset: startOffset + 5,
      quotedText: smallBody.slice(startOffset, startOffset + 5),
      prefixContext: 'pre',
      suffixContext: 'suf',
      note: 'n'.repeat(2000)
    };
  });
  const ctx = studioContext({
    studioDocument: { projectId: 'p-1', documentKind: 'core', documentId: 'rev-9', platform: null, title: '项目甲', currentBody: smallBody, bodyFingerprint: 'fp-many', dirty: true },
    openAnnotations: many
  });
  const resolved = resolveStudioContext(ctx.focus.studioDocument, ctx.focus.openAnnotations);
  const report = resolved.report;
  assert.equal(report.total, 30);
  assert.ok(report.included > 0 && report.included < 30, '必须因预算丢弃部分批注');
  assert.ok(report.omitted > 0);
  assert.equal(report.included + report.omitted, report.total);
  assert.equal(report.contextsDropped, true);
  const payload = buildPiContextPayload(ctx, '改');
  const budget = payloadLine(payload, 'annotationBudget');
  assert.equal(budget.included, report.included);
  assert.equal(budget.omitted, report.omitted);
  const sent = payloadLine(payload, 'openAnnotations');
  // 关键诚实性：payload 中实际批注数 === 报告带入数，而不是 total
  assert.equal(sent.length, report.included);
  assert.notEqual(sent.length, report.total);
  const sentIds = sent.map((item) => item.id);
  assert.ok(sentIds.includes('ann-0'));
  assert.ok(!sentIds.includes('ann-29'));
  // 徽标与最终快照一致
  const badge = resolveStudioAnnotationBadge(ctx);
  assert.equal(badge.included, report.included);
  assert.equal(badge.omitted, report.omitted);
  // 预算常量确实被触发（该测试场景依赖它）
  assert.ok(STUDIO_CONTEXT_BUDGET_CHARS < 60_000);
});
