import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cubicBezier, isPyaireaderXProfile, isXHomeUrl, parseXListId, xListUrl } from '../src/main/platforms/x-list-primitives.ts';
import { hasUsableDocumentText } from '../src/main/platforms/x-list-session-support.ts';
import { xListMutationErrorMessage, xProfileHrefMatchesHandle } from '../src/main/platforms/x-list-browser-actions.ts';
import { memberCountFromManagerText } from '../src/main/platforms/x-list-browser-read.ts';
import { listDescriptionFromHeaderLines } from '../src/main/platforms/x-list-browser-dom.ts';

test('X List session accepts only the Pyaireader profile and stable List URLs', () => {
  assert.equal(isPyaireaderXProfile({ id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334/' }), true);
  assert.equal(isPyaireaderXProfile({ id: 'edge:wmb-installation' }), true);
  assert.equal(isPyaireaderXProfile({ id: 'edge:Default', cdpUrl: 'http://127.0.0.1:9334' }), false);
  assert.equal(parseXListId('https://x.com/i/lists/1234567890'), '1234567890');
  assert.equal(parseXListId('https://x.com/i/lists/not-a-list'), null);
  assert.equal(xListUrl('1234567890'), 'https://x.com/i/lists/1234567890');
  assert.equal(isXHomeUrl('https://x.com/home'), true);
  assert.equal(isXHomeUrl('https://x.com/i/lists/1234567890'), false);
});

test('human pointer curve starts and ends at the intended coordinates', () => {
  const start = { x: 10, y: 20 };
  const end = { x: 110, y: 220 };
  assert.deepEqual(cubicBezier(start, { x: 20, y: 80 }, { x: 90, y: 160 }, end, 0), start);
  assert.deepEqual(cubicBezier(start, { x: 20, y: 80 }, { x: 90, y: 160 }, end, 1), end);
});

test('same-URL navigation reuses only a document with readable content', () => {
  assert.equal(hasUsableDocumentText(''), false);
  assert.equal(hasUsableDocumentText('  \n '), false);
  assert.equal(hasUsableDocumentText('Home'), true);
});

test('member search accepts only the exact profile URL handle', () => {
  assert.equal(xProfileHrefMatchesHandle('/UKVIgovuk', '@UKVIgovuk'), true);
  assert.equal(xProfileHrefMatchesHandle('https://x.com/ukvigovuk/', '@UKVIgovuk'), true);
  assert.equal(xProfileHrefMatchesHandle('/UKVIgovukNews', '@UKVIgovuk'), false);
  assert.equal(xProfileHrefMatchesHandle('/someone/status/1', '@someone'), false);
});

test('member manager count is parsed from the owned-list sheet', () => {
  assert.equal(memberCountFromManagerText('管理成员\n成员 (8)\n已推荐'), 8);
  assert.equal(memberCountFromManagerText('Manage members\nMembers (1,234)\nSuggested'), 1234);
  assert.equal(memberCountFromManagerText('列表页面'), null);
});

test('member mutation surfaces a platform GraphQL rejection', () => {
  assert.equal(xListMutationErrorMessage({ data: {}, errors: [{ message: 'not allowed' }] }), 'not allowed');
  assert.equal(xListMutationErrorMessage({ data: { list: { member_count: 1 } }, errors: [{ message: 'non-fatal' }] }), null);
  assert.equal(xListMutationErrorMessage({ data: {} }), null);
});

test('List detail distinguishes a description from the owner display name', () => {
  assert.equal(listDescriptionFromHeaderLines('社区', ['社区', '真实描述', '亵渎', '@Owner']), '真实描述');
  assert.equal(listDescriptionFromHeaderLines('社区', ['社区', '亵渎', '@Owner']), '');
});

test('shared X session queues later reads instead of preempting an active operation', async () => {
  const source = await readFile(new URL('../src/main/platforms/x-list-session.ts', import.meta.url), 'utf8');
  const runStart = source.indexOf('async run<T>');
  const executeStart = source.indexOf('const execute = async () => {', runStart);
  const activation = source.indexOf('this.currentOp = opId;', runStart);
  assert.ok(runStart >= 0 && executeStart > runStart && activation > executeStart);
  assert.doesNotMatch(source.slice(runStart, executeStart), /window\.stop|this\.currentOp = opId/);
  const clickStart = source.indexOf('async click(locator: Locator');
  const forceClick = source.indexOf('if (options.force)', clickStart);
  const boxRead = source.indexOf('const box = await locator.boundingBox()', clickStart);
  assert.ok(forceClick > clickStart && boxRead > forceClick);
  assert.match(source.slice(clickStart, boxRead), /element is not visible/);
  assert.match(source.slice(clickStart, boxRead), /element as HTMLElement\)\.click\(\)/);
  assert.match(source, /!\(error instanceof XListCooldownError\)/);
});

test('member reads never fall back to unrelated main-page UserCells', async () => {
  const actions = await readFile(new URL('../src/main/platforms/x-list-browser-actions.ts', import.meta.url), 'utf8');
  const reads = await readFile(new URL('../src/main/platforms/x-list-browser-read.ts', import.meta.url), 'utf8');
  assert.match(actions, /if \(!await membersSheetReady\(session, tab\)\) await switchMembersTab/);
  assert.match(actions, /locator\('\[data-wmb-members-root-missing\]'\)/);
  assert.match(actions, /const outcome = await addMemberInOpenSheet/);
  assert.match(actions, /return 'already_present'/);
  assert.match(actions, /return 'added'/);
  assert.match(actions, /const cells = \(await membersRoot\(session\)\)\.locator/);
  assert.match(reads, /const root = await membersRoot\(active\)/);
  assert.match(reads, /X 成员读取不完整/);
});
