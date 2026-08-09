import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPiContextPayload, describePiContextChip } from '../src/renderer/pi-context-payload.ts';
import { toggleSingleFocus } from '../src/renderer/pi-focus.ts';

const base = {
  page: 'proposals',
  pageLabel: '选题台账',
  objectType: null,
  objectId: null,
  objectTitle: null
};

test('toggleSingleFocus replaces or clears', () => {
  const a = { id: '1', title: 'A' };
  const b = { id: '2', title: 'B' };
  assert.deepEqual(toggleSingleFocus(null, a), a);
  assert.deepEqual(toggleSingleFocus(a, a), null);
  assert.deepEqual(toggleSingleFocus(a, b), b);
});

test('empty proposals page payload is honest', () => {
  const text = buildPiContextPayload(base, '你好');
  assert.match(text, /page=proposals/);
  assert.match(text, /没有点选具体对象/);
  assert.match(text, /selectedItems=\[\]/);
  assert.match(text, /\[USER_MESSAGE\]\n你好/);
  assert.equal(describePiContextChip(base), '选题台账');
});

test('selected plan item enters selectedItems and chip title', () => {
  const item = {
    id: 'pi-1',
    title: '公开商业化 Day1',
    priority: 1,
    whyNow: '现在',
    angle: '角度',
    pointOfView: '观点',
    titleGuidance: '标题',
    openingGuidance: '开头',
    structureGuidance: '结构',
    sourceIds: ['s1']
  };
  const ctx = {
    ...base,
    objectType: 'plan_item',
    objectId: item.id,
    objectTitle: item.title,
    selectedItems: [item]
  };
  const text = buildPiContextPayload(ctx, '总结这个选题');
  assert.match(text, /点选不等于进入详情/);
  assert.match(text, /公开商业化 Day1/);
  assert.match(text, /"id":"pi-1"/);
  assert.equal(describePiContextChip(ctx), '选题台账 · 公开商业化 Day1');
});

test('focus object uses focus contextRule', () => {
  const ctx = {
    ...base,
    page: 'results',
    pageLabel: '结果',
    objectType: 'publication',
    objectId: 'pub-1',
    objectTitle: '已发帖',
    focus: { type: 'publication', id: 'pub-1', title: '已发帖', summary: '摘要' }
  };
  const text = buildPiContextPayload(ctx, '复盘');
  assert.match(text, /focus 是用户点选的当前对象/);
  assert.match(text, /"id":"pub-1"/);
  assert.equal(describePiContextChip(ctx), '结果 · 已发帖');
});
