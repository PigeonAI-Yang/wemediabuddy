// WMB-5207: Studio 正文批注数据与锚点聚焦测试（Data agent）。
// 覆盖：迁移幂等、CRUD 校验/revision 冲突、重叠拒绝、incremental 平移+相交解决、
// replacement 唯一/多候选/删除、文档隔离、保存事务集成。
// 不运行 formatter/linter/项目测试；由主 Agent 集成后统一执行。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createContentProject, createContentProjectWithVersion, deleteContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import {
  bodyFingerprintOf,
  createStudioAnnotation,
  findSingleEdit,
  incrementalMove,
  listStudioAnnotations,
  reconcileStudioAnnotations,
  reopenStudioAnnotation,
  replacementMove,
  resolveStudioAnnotation,
  updateStudioAnnotation
} from '../src/main/studio-annotations.ts';

async function withDb(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5207-'));
  const databasePath = path.join(root, 'wmb.db');
  const database = migrateDatabase(databasePath);
  try {
    await run(database, databasePath);
  } finally {
    database.close();
  }
}

function coreScope(projectId, documentId) {
  return { projectId, documentKind: 'core', documentId, platform: null };
}

function makeProject(database, body) {
  return createContentProjectWithVersion(database, { title: '批注测试项目', body });
}

function create(database, projectId, documentId, body, startOffset, endOffset, note) {
  const result = createStudioAnnotation(database, { ...coreScope(projectId, documentId), body, startOffset, endOffset, note });
  assert.equal(result.ok, true, `创建批注应成功: ${result.ok ? '' : result.error?.message}`);
  return result.data;
}

test('migration idempotent and annotations survive reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5207-reopen-'));
  const databasePath = path.join(root, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const project = makeProject(database, '第一段正文内容');
  const ann = create(database, project.id, project.contentVersionId, '第一段正文内容', 0, 2);
  database.close();

  const reopened = migrateDatabase(databasePath);
  try {
    const listed = listStudioAnnotations(reopened, { ...coreScope(project.id, project.contentVersionId), includeResolved: true });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, ann.id);
    assert.equal(listed[0].quotedText, '第一');
    assert.equal(listed[0].bodyFingerprint, bodyFingerprintOf('第一段正文内容'));
  } finally {
    reopened.close();
  }
});

test('CRUD validation, note trim and revision conflict', async () => {
  await withDb(async (database) => {
    const project = makeProject(database, '这是需要标记的正文内容');
    const body = '这是需要标记的正文内容';
    const scope = coreScope(project.id, project.contentVersionId);

    // 空/越界/反向区间拒绝
    const emptyBody = createStudioAnnotation(database, { ...scope, body: '   ', startOffset: 0, endOffset: 1 });
    assert.equal(emptyBody.ok, false);
    assert.equal(emptyBody.error.code, 'VALIDATION_ERROR');
    const badRange = createStudioAnnotation(database, { ...scope, body, startOffset: 5, endOffset: 5 });
    assert.equal(badRange.ok, false);
    assert.equal(badRange.error.code, 'VALIDATION_ERROR');
    const outOfBounds = createStudioAnnotation(database, { ...scope, body, startOffset: 4, endOffset: 99 });
    assert.equal(outOfBounds.ok, false);
    assert.equal(outOfBounds.error.code, 'VALIDATION_ERROR');
    const whitespace = createStudioAnnotation(database, { ...scope, body: 'a b', startOffset: 1, endOffset: 2 });
    assert.equal(whitespace.ok, false);
    assert.equal(whitespace.error.code, 'VALIDATION_ERROR');

    // 创建：note 去除首尾空白，quotedText 与区间一致
    const created = createStudioAnnotation(database, { ...scope, body, startOffset: 2, endOffset: 6, note: '  太营销  ' });
    assert.equal(created.ok, true);
    assert.equal(created.data.note, '太营销');
    assert.equal(created.data.quotedText, body.slice(2, 6));
    assert.equal(created.data.revision, 1);
    assert.equal(created.data.status, 'open');
    assert.equal(created.data.resolvedReason, null);
    assert.equal(created.data.resolvedAt, null);

    // 更新说明：空串归一为 null，revision +1
    const updated = updateStudioAnnotation(database, { id: created.data.id, expectedRevision: 1, note: '  ' });
    assert.equal(updated.ok, true);
    assert.equal(updated.data.note, null);
    assert.equal(updated.data.revision, 2);

    // 过期 revision 冲突返回当前记录
    const conflict = updateStudioAnnotation(database, { id: created.data.id, expectedRevision: 1, note: 'x' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'REVISION_CONFLICT');
    assert.equal(conflict.error.details.current.id, created.data.id);

    // resolve + 幂等
    const resolved = resolveStudioAnnotation(database, { id: created.data.id, expectedRevision: 2, reason: 'user_removed' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.data.status, 'resolved');
    assert.equal(resolved.data.resolvedReason, 'user_removed');
    assert.ok(resolved.data.resolvedAt);
    const again = resolveStudioAnnotation(database, { id: created.data.id, expectedRevision: 3, reason: 'user_removed' });
    assert.equal(again.ok, true);

    // reopen：当前正文中唯一定位成功
    const reopened = reopenStudioAnnotation(database, { id: created.data.id, expectedRevision: 3, body });
    assert.equal(reopened.ok, true);
    assert.equal(reopened.data.status, 'open');
    assert.equal(reopened.data.resolvedReason, null);
    assert.equal(reopened.data.startOffset, 2);

    // reopen：正文中找不到原文 → 拒绝并提示重新选择
    const resolvedAgain = resolveStudioAnnotation(database, { id: created.data.id, expectedRevision: 4, reason: 'user_removed' });
    assert.equal(resolvedAgain.ok, true);
    const failReopen = reopenStudioAnnotation(database, { id: created.data.id, expectedRevision: 5, body: '完全不同的正文' });
    assert.equal(failReopen.ok, false);
    assert.equal(failReopen.error.code, 'VALIDATION_ERROR');
  });
});

test('open annotation overlap rejected; adjacent and resolved-range allowed', async () => {
  await withDb(async (database) => {
    const project = makeProject(database, '一二三四五六七八九十');
    const body = '一二三四五六七八九十';
    const scope = coreScope(project.id, project.contentVersionId);
    create(database, project.id, project.contentVersionId, body, 0, 4);

    const overlap = createStudioAnnotation(database, { ...scope, body, startOffset: 2, endOffset: 6 });
    assert.equal(overlap.ok, false);
    assert.equal(overlap.error.code, 'VALIDATION_ERROR');

    const adjacent = createStudioAnnotation(database, { ...scope, body, startOffset: 4, endOffset: 8 });
    assert.equal(adjacent.ok, true);

    const resolved = resolveStudioAnnotation(database, { id: adjacent.data.id, expectedRevision: 1, reason: 'user_removed' });
    assert.equal(resolved.ok, true);
    const afterResolve = createStudioAnnotation(database, { ...scope, body, startOffset: 4, endOffset: 8 });
    assert.equal(afterResolve.ok, true);
  });
});

test('incremental: edit strictly before marker moves; boundary/interior edit resolves', async () => {
  await withDb(async (database) => {
    // Flow A: 编辑严格完全在标记之前 → 平移
    const bodyA = 'alpha beta gamma delta';
    const projectA = makeProject(database, bodyA);
    const scopeA = coreScope(projectA.id, projectA.contentVersionId);
    create(database, projectA.id, projectA.contentVersionId, bodyA, 6, 10); // 'beta'
    const nextA = 'X alpha beta gamma delta';
    const resultA = reconcileStudioAnnotations(database, { ...scopeA, previousBody: bodyA, nextBody: nextA, mode: 'incremental' });
    assert.equal(resultA.ok, true);
    const listedA = listStudioAnnotations(database, { ...scopeA });
    assert.equal(listedA.length, 1);
    assert.equal(listedA[0].status, 'open');
    assert.equal(listedA[0].startOffset, 8);
    assert.equal(nextA.slice(listedA[0].startOffset, listedA[0].endOffset), 'beta');

    // Flow B: 插入恰在标记起点（边界相交）→ resolve（edited）
    const bodyB = 'alpha beta gamma delta';
    const projectB = makeProject(database, bodyB);
    const scopeB = coreScope(projectB.id, projectB.contentVersionId);
    create(database, projectB.id, projectB.contentVersionId, bodyB, 6, 10);
    const nextB = 'alpha X beta gamma delta';
    const resultB = reconcileStudioAnnotations(database, { ...scopeB, previousBody: bodyB, nextBody: nextB, mode: 'incremental' });
    assert.equal(resultB.ok, true);
    const listedB = listStudioAnnotations(database, { ...scopeB, includeResolved: true });
    assert.equal(listedB.length, 1);
    assert.equal(listedB[0].status, 'resolved');
    assert.equal(listedB[0].resolvedReason, 'edited');

    // Flow C: 编辑在标记内部 → resolve（edited）
    const bodyC = 'alpha beta gamma delta';
    const projectC = makeProject(database, bodyC);
    const scopeC = coreScope(projectC.id, projectC.contentVersionId);
    create(database, projectC.id, projectC.contentVersionId, bodyC, 6, 10);
    const nextC = 'alpha beTa gamma delta';
    const resultC = reconcileStudioAnnotations(database, { ...scopeC, previousBody: bodyC, nextBody: nextC, mode: 'incremental' });
    assert.equal(resultC.ok, true);
    const listedC = listStudioAnnotations(database, { ...scopeC, includeResolved: true });
    assert.equal(listedC.length, 1);
    assert.equal(listedC[0].status, 'resolved');
    assert.equal(listedC[0].resolvedReason, 'edited');

    // 纯函数：编辑严格在标记之前 → 平移
    const edit = findSingleEdit('abcdef', 'abXcdef');
    assert.deepEqual(edit, { start: 2, endPrevious: 2, endNext: 3, delta: 1 });
    assert.deepEqual(incrementalMove({ startOffset: 4, endOffset: 6, quotedText: 'ef' }, edit, 'abXcdef'), { kind: 'moved', startOffset: 5, endOffset: 7 });
    // 纯函数：边界相交（插入恰在标记起点）→ resolve
    assert.deepEqual(incrementalMove({ startOffset: 2, endOffset: 4, quotedText: 'cd' }, edit, 'abXcdef'), { kind: 'resolve' });
    // 纯函数：内部相交 → resolve
    assert.deepEqual(incrementalMove({ startOffset: 1, endOffset: 3, quotedText: 'bc' }, edit, 'abXcdef'), { kind: 'resolve' });
    // 纯函数：编辑严格在标记之后 → 不变
    const afterEdit = findSingleEdit('abcdef', 'abcXdef');
    assert.deepEqual(afterEdit, { start: 3, endPrevious: 3, endNext: 4, delta: 1 });
    assert.deepEqual(incrementalMove({ startOffset: 0, endOffset: 2, quotedText: 'ab' }, afterEdit, 'abcXdef'), { kind: 'moved', startOffset: 0, endOffset: 2 });
    // 无编辑
    assert.equal(findSingleEdit('same', 'same'), null);
  });
});

test('replacement: unique anchored match migrates', async () => {
  await withDb(async (database) => {
    const body = '甲重要的事情乙';
    const project = makeProject(database, body);
    const scope = coreScope(project.id, project.contentVersionId);
    create(database, project.id, project.contentVersionId, body, 1, 6); // '重要的事情'

    const next = '开头加一句。甲重要的事情乙';
    const result = reconcileStudioAnnotations(database, { ...scope, previousBody: body, nextBody: next, mode: 'replacement' });
    assert.equal(result.ok, true);
    const listed = listStudioAnnotations(database, { ...scope });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'open');
    assert.equal(next.slice(listed[0].startOffset, listed[0].endOffset), '重要的事情');
    assert.equal(listed[0].bodyFingerprint, bodyFingerprintOf(next));

    // 纯函数路径
    const moved = replacementMove(
      { startOffset: 1, endOffset: 6, quotedText: '重要的事情', prefixContext: '甲', suffixContext: '乙' },
      body,
      '开头加一句。甲重要的事情乙'
    );
    assert.deepEqual(moved, { kind: 'moved', startOffset: 7, endOffset: 12 });
  });
});

test('replacement: multiple plausible candidates resolve ambiguous', async () => {
  await withDb(async (database) => {
    const body = '甲重要的事情乙';
    const project = makeProject(database, body);
    const scope = coreScope(project.id, project.contentVersionId);
    create(database, project.id, project.contentVersionId, body, 1, 6);

    // 两个候选的上下文（前 1 字 + 后 1 字）完全一致 → ambiguous
    const dup = '甲重要的事情乙甲重要的事情乙';
    const result = reconcileStudioAnnotations(database, { ...scope, previousBody: body, nextBody: dup, mode: 'replacement' });
    assert.equal(result.ok, true);
    const listed = listStudioAnnotations(database, { ...scope, includeResolved: true });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'resolved');
    assert.equal(listed[0].resolvedReason, 'ambiguous');

    // 纯函数：唯一候选但上下文不匹配 → ambiguous（宁可自动解决，不挂错句子）
    const rewritten = replacementMove(
      { startOffset: 1, endOffset: 6, quotedText: '重要的事情', prefixContext: '甲', suffixContext: '乙' },
      body,
      '完全不相关的重要的事情出现在另一处'
    );
    assert.equal(rewritten, 'ambiguous');
  });
});

test('replacement: quoted text deleted resolves deleted', async () => {
  await withDb(async (database) => {
    const body = '这是需要删除的句子。';
    const project = makeProject(database, body);
    const scope = coreScope(project.id, project.contentVersionId);
    create(database, project.id, project.contentVersionId, body, 2, 5); // '需要删除'

    const gone = '整篇改写了，没有原句。';
    const result = reconcileStudioAnnotations(database, { ...scope, previousBody: body, nextBody: gone, mode: 'replacement' });
    assert.equal(result.ok, true);
    const listed = listStudioAnnotations(database, { ...scope, includeResolved: true });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'resolved');
    assert.equal(listed[0].resolvedReason, 'deleted');

    // 纯函数
    assert.equal(replacementMove({ startOffset: 0, endOffset: 2, quotedText: '这是', prefixContext: '', suffixContext: '需要' }, body, '没有了'), 'deleted');
  });
});

test('document isolation between core and platform versions', async () => {
  await withDb(async (database) => {
    const project = makeProject(database, 'core body one');
    const coreAnn = create(database, project.id, project.contentVersionId, 'core body one', 0, 4);

    const platform = savePlatformVersion(database, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'x', body: 'platform body' });
    assert.equal(platform.ok, true);
    const platformScope = { projectId: project.id, documentKind: 'platform', documentId: platform.data.id, platform: 'x' };
    const platCreated = createStudioAnnotation(database, { ...platformScope, body: 'platform body', startOffset: 0, endOffset: 8 });
    assert.equal(platCreated.ok, true);

    const platList = listStudioAnnotations(database, { ...platformScope });
    assert.equal(platList.length, 1);
    assert.equal(platList[0].id, platCreated.data.id);

    const coreList = listStudioAnnotations(database, { ...coreScope(project.id, project.contentVersionId) });
    assert.equal(coreList.length, 1);
    assert.equal(coreList[0].id, coreAnn.id);

    // core 不允许绑定平台；platform 不允许缺少平台/版本 ID
    const invalidCore = createStudioAnnotation(database, { projectId: project.id, documentKind: 'core', documentId: project.contentVersionId, platform: 'x', body: 'x', startOffset: 0, endOffset: 1 });
    assert.equal(invalidCore.ok, false);
    assert.equal(invalidCore.error.code, 'VALIDATION_ERROR');
    const invalidPlatform = createStudioAnnotation(database, { projectId: project.id, documentKind: 'platform', documentId: null, platform: 'wechat', body: 'x', startOffset: 0, endOffset: 1 });
    assert.equal(invalidPlatform.ok, false);
    assert.equal(invalidPlatform.error.code, 'VALIDATION_ERROR');
    // 平台与版本平台不一致拒绝
    const wrongPlatform = createStudioAnnotation(database, { projectId: project.id, documentKind: 'platform', documentId: platform.data.id, platform: 'wechat', body: 'x', startOffset: 0, endOffset: 1 });
    assert.equal(wrongPlatform.ok, false);
    assert.equal(wrongPlatform.error.code, 'VALIDATION_ERROR');
  });
});

test('save-core migrates annotations in same transaction; failure leaves them untouched', async () => {
  await withDb(async (database) => {
    const project = makeProject(database, '原稿正文内容');
    const scope = coreScope(project.id, project.contentVersionId);
    create(database, project.id, project.contentVersionId, '原稿正文内容', 2, 6); // '正文内容'

    const saved = saveCoreVersion(database, { projectId: project.id, body: '开头加一句。原稿正文内容', expectedRevision: project.revision, author: 'user' });
    assert.equal(saved.ok, true);
    // 批注跟随新版本锚点并重新定位
    const all = listStudioAnnotations(database, { projectId: project.id, documentKind: 'core', documentId: saved.data.id, platform: null, includeResolved: true });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'open');
    assert.equal(all[0].documentId, saved.data.id);
    assert.equal('开头加一句。原稿正文内容'.slice(all[0].startOffset, all[0].endOffset), '正文内容');

    // 保存失败（revision 冲突）→ 批注原样保留
    const before = listStudioAnnotations(database, { projectId: project.id, documentKind: 'core', documentId: saved.data.id, platform: null, includeResolved: true });
    const conflict = saveCoreVersion(database, { projectId: project.id, body: '变了的正文', expectedRevision: project.revision, author: 'user' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'REVISION_CONFLICT');
    const after = listStudioAnnotations(database, { projectId: project.id, documentKind: 'core', documentId: saved.data.id, platform: null, includeResolved: true });
    assert.deepEqual(after, before);
  });
});

test('save after UI incremental reconcile does not double-migrate (core)', async () => {
  await withDb(async (database) => {
    const body = 'alpha beta gamma delta';
    const project = makeProject(database, body);
    create(database, project.id, project.contentVersionId, body, 6, 10); // 'beta'
    const draft = 'X alpha beta gamma delta';
    const reconciled = reconcileStudioAnnotations(database, { ...coreScope(project.id, project.contentVersionId), previousBody: body, nextBody: draft, mode: 'incremental' });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.data[0].startOffset, 8);
    assert.equal(reconciled.data[0].bodyFingerprint, bodyFingerprintOf(draft));

    const saved = saveCoreVersion(database, { projectId: project.id, body: draft, expectedRevision: project.revision, author: 'user' });
    assert.equal(saved.ok, true);
    const all = listStudioAnnotations(database, { projectId: project.id, documentKind: 'core', documentId: saved.data.id, platform: null });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'open');
    assert.equal(all[0].startOffset, 8); // 保存不二次平移
    assert.equal(draft.slice(all[0].startOffset, all[0].endOffset), 'beta');
  });
});

test('save-platform after UI incremental reconcile keeps range (platform)', async () => {
  await withDb(async (database) => {
    const project = makeProject(database, 'core body');
    const created = savePlatformVersion(database, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'x', body: 'ab platform body' });
    assert.equal(created.ok, true);
    const scope = { projectId: project.id, documentKind: 'platform', documentId: created.data.id, platform: 'x' };
    const ann = createStudioAnnotation(database, { ...scope, body: 'ab platform body', startOffset: 3, endOffset: 11 });
    assert.equal(ann.ok, true);

    const draft = 'X ab platform body';
    const reconciled = reconcileStudioAnnotations(database, { ...scope, previousBody: 'ab platform body', nextBody: draft, mode: 'incremental' });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.data[0].startOffset, 5);

    const updated = savePlatformVersion(database, {
      projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'x',
      body: draft, expectedRevision: 1, id: created.data.id
    }, true);
    assert.equal(updated.ok, true);
    const listed = listStudioAnnotations(database, { ...scope });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'open');
    assert.equal(listed[0].startOffset, 5); // 保存不二次平移
    assert.equal(draft.slice(listed[0].startOffset, listed[0].endOffset), 'platform');
  });
});

test('unsaved draft annotations anchor to first saved core version', async () => {
  await withDb(async (database) => {
    const project = createContentProject(database, { title: '未保存草稿' });
    const draft = createStudioAnnotation(database, { ...coreScope(project.id, null), body: '草稿正文', startOffset: 0, endOffset: 2 });
    assert.equal(draft.ok, true);

    const saved = saveCoreVersion(database, { projectId: project.id, body: '草稿正文', expectedRevision: project.revision, author: 'user' });
    assert.equal(saved.ok, true);
    const listed = listStudioAnnotations(database, { projectId: project.id, documentKind: 'core', documentId: saved.data.id, platform: null });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].documentId, saved.data.id);
    assert.equal(listed[0].status, 'open');
    assert.equal('草稿正文'.slice(listed[0].startOffset, listed[0].endOffset), '草稿');
  });
});

test('save-platform reconciles annotations on update and project delete removes them', async () => {
  await withDb(async (database) => {
    const project = makeProject(database, 'core body');
    const created = savePlatformVersion(database, { projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'x', body: '平台原文' });
    assert.equal(created.ok, true);
    const scope = { projectId: project.id, documentKind: 'platform', documentId: created.data.id, platform: 'x' };
    const ann = createStudioAnnotation(database, { ...scope, body: '平台原文', startOffset: 0, endOffset: 2 });
    assert.equal(ann.ok, true);

    const updated = savePlatformVersion(database, {
      projectId: project.id, contentVersionId: project.contentVersionId, platform: 'x', format: 'x',
      body: '加前缀平台原文', expectedRevision: 1, id: created.data.id
    }, true);
    assert.equal(updated.ok, true);
    const listed = listStudioAnnotations(database, { ...scope });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'open');
    assert.equal('加前缀平台原文'.slice(listed[0].startOffset, listed[0].endOffset), '平台');

    // 项目硬删除 → 批注随项目删除（deleteContentProject 仅允许删除无平台版本的项目）
    const bare = createContentProjectWithVersion(database, { title: '可删除项目', body: '删除正文' });
    create(database, bare.id, bare.contentVersionId, '删除正文', 0, 2);
    const deleted = deleteContentProject(database, { projectId: bare.id, expectedRevision: bare.revision });
    assert.equal(deleted.ok, true);
    const rows = database.prepare('SELECT COUNT(*) AS count FROM studio_annotations WHERE project_id = ?').get(bare.id);
    assert.equal(rows.count, 0);
  });
});
