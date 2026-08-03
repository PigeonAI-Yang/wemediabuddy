import { createHash } from 'node:crypto';
import type { Locator, Page, Response } from 'playwright-core';
import { parseXListId, isXListTimelineResponse, type XListBrowserConfig, xListUrl } from './x-list-primitives.ts';
import { XListNeedsUserError, XListSession, XListSupersededError } from './x-list-session.ts';
import { xMetricEvidenceMap, xMetricValues, type XMetricEvidenceMap } from './metric-value.ts';

import type {
  XListActionHooks, XListCreateInput, XListDetail, XListKind, XListMember,
  XListMemberOutcome, XListObservation, XListPost, XListPostAuthor,
  XListPostDetail, XListRef, XListUpdateInput
} from './x-list-browser-types.ts';
import {
  confirmCreateSelectors, confirmDeleteSelectors, confirmSaveSelectors, createListSelectors,
  deleteListSelectors, detailFromCurrentPage, editListSelectors, expandMainTweet, firstHandle,
  firstVisible, isLikelyVideoMediaUrl, listDescriptionSelectors, listMoreSelectors,
  listNameSelectors, normalizeHandle, normalizeMediaUrl, normalizeStatusUrl, nudgeMainVideo,
  pickPlayableVideoUrl, privateListSelectors, readAccountKey, readArticlePost
} from './x-list-browser-dom.ts';
import { readXListDetail, readXListMembers } from './x-list-browser-read.ts';
import { sleepMs } from './x-list-browser-timeline.ts';
import { XListStopRequestedError, XListUnknownError } from './x-list-browser-types.ts';

export async function readXListPostDetail(config: XListBrowserConfig, statusUrl: string, replyLimit = 30): Promise<{ accountKey: string; post: XListPostDetail }> {
  const normalized = normalizeStatusUrl(statusUrl);
  if (!normalized) throw new Error('无效的帖子链接。');
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      const capturedVideoUrls = new Set<string>();
      const onResponse = (response: Response) => {
        const url = response.url();
        if (isLikelyVideoMediaUrl(url)) capturedVideoUrls.add(url);
      };
      active.page.on('response', onResponse);
      try {
        await active.navigate(normalized, { mode: 'fast' });
        await active.page.locator('main article').first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
        await expandMainTweet(active.page);
        await nudgeMainVideo(active.page);
        const target = Math.max(1, Math.min(replyLimit, 40));
        const posts: XListPost[] = [];
        const seen = new Set<string>();
        let stagnant = 0;
        for (let round = 0; round < 6 && stagnant < 2; round += 1) {
          if (round === 0) {
            await expandMainTweet(active.page);
            await nudgeMainVideo(active.page);
          }
          const articles = active.page.locator('main article');
          const count = await articles.count();
          const before = posts.length;
          for (let index = 0; index < count; index += 1) {
            const post = await readArticlePost(articles.nth(index), { preferFullText: index === 0 && round === 0 });
            if (!post || seen.has(post.url)) continue;
            seen.add(post.url);
            posts.push(post);
          }
          if (posts.length >= target + 1) break;
          if (posts.length === before) stagnant += 1;
          else stagnant = 0;
          await active.page.mouse.wheel(0, 900 + round * 80);
          await active.page.waitForTimeout(220 + round * 40);
        }
        const main = posts.find((item) => item.url.replace(/[?#].*$/, '') === normalized.replace(/[?#].*$/, '')) ?? posts[0];
        if (!main) throw new Error('未能读取帖子详情。');
        const replies = posts.filter((item) => item.url !== main.url).slice(0, target);
        const networkVideoUrl = pickPlayableVideoUrl([...capturedVideoUrls]);
        return {
          accountKey: await readAccountKey(active),
          post: {
            ...main,
            hasVideo: main.hasVideo || Boolean(networkVideoUrl || main.videoUrl),
            videoUrl: pickPlayableVideoUrl([main.videoUrl, networkVideoUrl].filter(Boolean) as string[]),
            images: main.images.map((src) => normalizeMediaUrl(src, 'medium')),
            imageThumbs: main.imageThumbs.map((src) => normalizeMediaUrl(src, 'thumb')),
            replies: replies.map((item) => ({
              ...item,
              images: item.images.map((src) => normalizeMediaUrl(src, 'thumb')),
              imageThumbs: item.imageThumbs.map((src) => normalizeMediaUrl(src, 'thumb'))
            })),
            hasMoreReplies: replies.length >= target
          }
        };
      } finally {
        active.page.off('response', onResponse);
      }
    });
  } finally { await session.close(); }
}
export async function createXList(config: XListBrowserConfig, input: XListCreateInput, hooks: XListActionHooks = {}): Promise<{ accountKey: string; detail: XListDetail }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      const accountKey = await (async () => {
        await active.navigateInitially('https://x.com/home');
        return readAccountKey(active);
      })();
      await active.navigateWithinOperation(`https://x.com/${accountKey.slice(1)}/lists`);
      await active.click(await active.findFirstVisible(createListSelectors));
      await active.typeInto(await active.findFirstVisible(listNameSelectors), input.name);
      if (input.description !== undefined) await active.typeInto(await active.findFirstVisible(listDescriptionSelectors), input.description);
      if (input.isPrivate) await active.click(await active.findFirstVisible(privateListSelectors));
      await assertNotStopped(hooks);
      await hooks.beforeAction?.('create_list');
      await active.click(await active.findFirstVisible(confirmCreateSelectors));
      const listId = parseXListId(active.page.url());
      if (!listId) throw new XListUnknownError('创建 List 后未能从当前页面读回稳定 List ID。');
      return { accountKey, detail: await detailFromCurrentPage(active, listId) };
    });
  } finally { await session.close(); }
}

export async function updateXList(config: XListBrowserConfig, input: XListUpdateInput, hooks: XListActionHooks = {}): Promise<{ accountKey: string; detail: XListDetail }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      await active.navigateInitially(xListUrl(input.listId));
      const accountKey = await readAccountKey(active);
      await openListEditor(active);
      if (input.name !== undefined) await active.typeInto(await active.findFirstVisible(listNameSelectors), input.name);
      if (input.description !== undefined) await active.typeInto(await active.findFirstVisible(listDescriptionSelectors), input.description);
      if (input.isPrivate !== undefined) await setPrivacy(active, input.isPrivate);
      await assertNotStopped(hooks);
      await hooks.beforeAction?.('update_list');
      await active.click(await active.findFirstVisible(confirmSaveSelectors));
      return { accountKey, detail: await detailFromCurrentPage(active, input.listId) };
    });
  } finally { await session.close(); }
}

export async function deleteXList(config: XListBrowserConfig, listId: string, hooks: XListActionHooks = {}): Promise<{ accountKey: string; deletedListId: string; evidenceUrl: string }> {
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      await active.navigateInitially(xListUrl(listId));
      const accountKey = await readAccountKey(active);
      await openListEditor(active);
      await active.click(await active.findFirstVisible(deleteListSelectors));
      await assertNotStopped(hooks);
      await hooks.beforeAction?.('delete_list');
      await active.click(await active.findFirstVisible(confirmDeleteSelectors));
      if (parseXListId(active.page.url()) === listId) throw new XListUnknownError('删除确认后当前页面仍指向原 List，无法确认删除结果。');
      return { accountKey, deletedListId: listId, evidenceUrl: active.page.url() };
    });
  } finally { await session.close(); }
}

export async function ensureXListMember(config: XListBrowserConfig, input: { listId: string; handle: string; desiredState: 'present' | 'absent' }, hooks: XListActionHooks = {}): Promise<{ accountKey: string; outcome: XListMemberOutcome; evidenceUrl: string }> {
  const normalizedHandle = normalizeHandle(input.handle);
  const session = await XListSession.open(config);
  try {
    return await session.run(async (active) => {
      // Short modal workflow; keep navigation light and stay in Edit List manager sheet.
      await active.navigateInitially(xListUrl(input.listId), { mode: 'browse' });
      const accountKey = await readAccountKey(active);

      if (input.desiredState === 'present') {
        await openManagedMembers(active, input.listId, 'suggested');
        const outcome = await addMemberInOpenSheet(active, input.listId, normalizedHandle, hooks);
        return { accountKey, outcome, evidenceUrl: active.page.url() };
      }

      await openManagedMembers(active, input.listId, 'members');
      if (!await hasMember(active, normalizedHandle)) {
        return { accountKey, outcome: 'already_absent', evidenceUrl: active.page.url() };
      }
      await removeMember(active, input.listId, normalizedHandle, hooks);
      if (await hasMember(active, normalizedHandle)) {
        throw new XListUnknownError(`移除 ${normalizedHandle} 后仍显示在成员页。`);
      }
      return { accountKey, outcome: 'removed', evidenceUrl: active.page.url() };
    }, { timeoutMs: 90_000 });
  } finally {
    await session.close();
  }
}

export async function openListEditor(session: XListSession): Promise<void> {
  const edit = await firstVisible(session.page.locator('a[href$="/info"], a:has-text("编辑列表"), a:has-text("Edit List")'));
  if (edit) {
    await session.click(edit);
    return;
  }
  await session.click(await session.findFirstVisible(listMoreSelectors));
  await session.click(await session.findFirstVisible(editListSelectors));
}

export async function setPrivacy(session: XListSession, isPrivate: boolean): Promise<void> {
  const control = await session.findFirstVisible(privateListSelectors);
  const current = await control.getAttribute('aria-checked') ?? await control.getAttribute('data-state');
  const enabled = current === 'true' || current === 'checked';
  if (enabled !== isPrivate) await session.click(control);
}

export async function openManagedMembers(session: XListSession, listId: string, tab: 'members' | 'suggested' = 'members'): Promise<void> {
  if (!listId) throw new Error('List ID 缺失，无法打开成员管理。');

  // Reuse manager sheet when possible.
  if (await membersSheetReady(session, tab)) return;
  if (tab === 'suggested' && await membersSheetReady(session, 'members')) {
    // If this is the read-only "列表成员" sheet, it has no Suggested tab.
    const hasSuggested = await firstVisible(session.page.locator('[role="dialog"] a:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("已推荐")'));
    if (hasSuggested) {
      await switchMembersTab(session, listId, 'suggested');
      if (await membersSheetReady(session, 'suggested')) return;
    }
  }
  if (tab === 'members' && await membersSheetReady(session, 'suggested')) {
    await switchMembersTab(session, listId, 'members');
    if (await membersSheetReady(session, 'members')) return;
  }

  // Reset to clean list page.
  for (let i = 0; i < 2; i += 1) {
    await session.page.keyboard.press('Escape').catch(() => {});
    await sleepMs(120);
  }
  if (!session.page.url().includes(`/i/lists/${listId}`) || session.page.url().includes('/members') || session.page.url().includes('/info') || session.page.url().includes('/home')) {
    await session.navigateWithinOperation(xListUrl(listId), { mode: 'browse' });
  }

  // Canonical write path: Edit List -> Manage members -> Members/Suggested tabs.
  await session.page.locator(
    `a[href="/i/lists/${listId}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`
  ).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  let edit = await firstVisible(session.page.locator(
    `a[href="/i/lists/${listId}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`
  ));
  if (!edit) {
    await session.navigateWithinOperation(xListUrl(listId), { mode: 'browse' });
    edit = await firstVisible(session.page.locator(
      `a[href="/i/lists/${listId}/info"], a:has-text("编辑列表"), a:has-text("Edit List")`
    ));
  }
  if (!edit) throw new XListNeedsUserError('X 列表页未出现“编辑列表”入口；请接管浏览器后重试。');

  await session.click(edit, { force: true });
  await session.page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: /编辑列表|Edit List|管理成员|Manage members/ }).last()
    .waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
  await sleepMs(500);

  let manage = await firstVisible(session.page.locator(
    `[role="dialog"] a[href="/i/lists/${listId}/members"], [role="dialog"] a[data-testid="pivot"][href*="/members"], [role="dialog"] [role="tab"]:has-text("管理成员"), [role="dialog"] a:has-text("管理成员")`
  ));
  if (!manage) {
    // One retry: re-click edit if the sheet closed under us.
    await session.click(edit, { force: true });
    await sleepMs(800);
    manage = await firstVisible(session.page.locator(
      `[role="dialog"] a[href="/i/lists/${listId}/members"], [role="dialog"] [role="tab"]:has-text("管理成员"), [role="dialog"] a:has-text("管理成员")`
    ));
  }
  if (!manage) throw new XListNeedsUserError('X 列表页未出现“管理成员”入口；请接管浏览器后重试。');
  await session.click(manage, { force: true, preserveOverlay: true });
  await session.page.locator(
    '[role="dialog"] [data-testid="UserCell"], [role="dialog"] button:has-text("移除"), [role="dialog"] a:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("已推荐")'
  ).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  if (!await membersSheetReady(session, tab)) await switchMembersTab(session, listId, tab);

  if (!await membersSheetReady(session, tab)) {
    throw new XListNeedsUserError('X 成员管理页未出现可操作控件；请接管浏览器后重试。');
  }
}

export async function switchMembersTab(session: XListSession, listId: string, tab: 'members' | 'suggested'): Promise<void> {
  if (tab === 'suggested') {
    const suggested = await firstVisible(session.page.locator(
      `[role="dialog"] a[href="/i/lists/${listId}/members/suggested"], [role="dialog"] a[data-testid="pivot"][href*="suggested"], [role="dialog"] [role="tab"]:has-text("已推荐"), [role="dialog"] [role="tab"]:has-text("Suggested"), [role="dialog"] a:has-text("已推荐"), [role="dialog"] a:has-text("Suggested")`
    ));
    if (suggested) await session.click(suggested, { force: true, preserveOverlay: true });
  } else {
    const members = await firstVisible(session.page.locator(
      `[role="dialog"] a[href="/i/lists/${listId}/members"]:not([href*="suggested"]), [role="dialog"] a[data-testid="pivot"][href*="/members"]:not([href*="suggested"]), [role="dialog"] [role="tab"]:has-text("成员"), [role="dialog"] [role="tab"]:has-text("Members"), [role="dialog"] a:has-text("成员")`
    ));
    if (members) await session.click(members, { force: true, preserveOverlay: true });
  }
  const waitSelector = tab === 'suggested'
    ? '[role="dialog"] input[placeholder*="搜索用户"], [role="dialog"] input[placeholder*="Search people"]'
    : '[role="dialog"] [data-testid="UserCell"], [role="dialog"] button:has-text("移除"), [role="dialog"] button:has-text("添加")';
  await session.page.locator(waitSelector).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  await sleepMs(350);
}

export async function membersSheetReady(session: XListSession, tab: 'members' | 'suggested'): Promise<boolean> {
  if (tab === 'suggested') {
    // Members-sheet people search only — never the global top nav search box.
    const search = session.page.locator(
      '[role="dialog"] input[placeholder*="搜索用户"], [aria-modal="true"] input[placeholder*="搜索用户"], [role="dialog"] input[placeholder*="Search people"], [role="dialog"] input[placeholder*="Search users"]'
    );
    return search.first().isVisible().catch(() => false);
  }
  const root = await membersRoot(session);
  const cells = root.locator('[data-testid="UserCell"]');
  if (await cells.first().isVisible().catch(() => false)) return true;
  const action = root.locator('button:has-text("添加"), button:has-text("Add"), button:has-text("移除"), button:has-text("Remove"), button[aria-label="添加"], button[aria-label="移除"]');
  return action.first().isVisible().catch(() => false);
}

export async function membersRoot(session: XListSession) {
  const candidates = session.page.locator('[role="dialog"], [aria-modal="true"]');
  const count = await candidates.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const hasControls = await candidate.locator(
      '[data-testid="UserCell"], [data-testid="TypeaheadUser"], [data-testid="typeaheadResult"], input[placeholder*="搜索用户"], input[placeholder*="Search people"], button:has-text("添加"), button:has-text("移除"), button:has-text("Add"), button:has-text("Remove"), a:has-text("已推荐"), a:has-text("Suggested"), a:has-text("管理成员")'
    ).first().isVisible().catch(() => false);
    if (hasControls) return candidate;
  }
  return session.page.locator('[data-wmb-members-root-missing]');
}

/** Add one handle inside an already-open members manager sheet (serial). */
export async function addMemberInOpenSheet(session: XListSession, listId: string, handle: string, hooks: XListActionHooks): Promise<'already_present' | 'added'> {
  const bare = handle.replace(/^@/, '');
  // Prefer staying in the current sheet and switching to Suggested.
  if (!await membersSheetReady(session, 'suggested')) {
    if (await membersSheetReady(session, 'members')) {
      await switchMembersTab(session, listId, 'suggested');
    }
  }
  if (!await membersSheetReady(session, 'suggested')) {
    await openManagedMembers(session, listId, 'suggested');
  }

  const search = await firstVisible(session.page.locator([
    '[role="dialog"] input[placeholder*="搜索用户"]',
    '[aria-modal="true"] input[placeholder*="搜索用户"]',
    '[role="dialog"] input[placeholder*="Search people"]',
    '[role="dialog"] input[placeholder*="Search users"]'
  ].join(', ')));
  if (!search) throw new XListNeedsUserError('X 成员推荐页未出现搜索框。');

  // Clear + type directly; human typing is unnecessarily slow inside this modal.
  await search.click({ force: true });
  await session.page.keyboard.press('Control+A').catch(() => {});
  await session.page.keyboard.press('Backspace').catch(() => {});
  await search.fill(bare);
  await sleepMs(1600);

  let rows = session.page.locator(
    '[role="dialog"] [data-testid="typeaheadResult"], [role="dialog"] [data-testid="TypeaheadUser"], [role="dialog"] [role="option"], [aria-modal="true"] [data-testid="typeaheadResult"], [aria-modal="true"] [data-testid="TypeaheadUser"]'
  );
  await rows.first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
  let row = await exactHandleRow(rows, bare);
  if (!row) {
    // Retry once with slow type in case fill was ignored.
    await search.click({ force: true });
    await search.fill('');
    await search.pressSequentially(bare, { delay: 40 }).catch(async () => {
      await session.page.keyboard.type(bare, { delay: 40 });
    });
    await sleepMs(1800);
    rows = session.page.locator(
      '[role="dialog"] [data-testid="typeaheadResult"], [role="dialog"] [data-testid="TypeaheadUser"], [role="dialog"] [role="option"]'
    );
    await rows.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    row = await exactHandleRow(rows, bare);
  }
  if (!row || !await row.isVisible().catch(() => false)) {
    const sample = await session.page.locator('[role="dialog"]').last().innerText().catch(() => '');
    throw new XListNeedsUserError(`X 搜索 ${handle} 后未出现对应用户。sheet=${sample.slice(0, 180).replace(/\s+/g, ' ')}`);
  }

  const removeBtn = row.locator(
    'button[aria-label="移除"], button[aria-label="Remove"], button:has-text("移除"), button:has-text("Remove")'
  ).first();
  if (await removeBtn.isVisible().catch(() => false)) return 'already_present';

  // IMPORTANT: do not match the whole TypeaheadUser row button (its innerText also contains "添加").
  // Only the compact control with aria-label 添加/Add performs membership changes.
  let action = await firstVisible(row.locator(
    'button[aria-label="添加"], button[aria-label="Add"], div[role="button"][aria-label="添加"], div[role="button"][aria-label="Add"]'
  ));
  if (!action) {
    action = await firstVisible(row.locator('button').filter({ hasText: /^\s*添加\s*$|^\s*Add\s*$/ }));
  }
  if (!action) throw new XListNeedsUserError(`X 未显示 ${handle} 的安全添加控件。`);

  await assertNotStopped(hooks);
  await hooks.beforeAction?.('add_member');
  // Prefer a real center click on the compact Add control; force-click on layered X sheets is flaky.
  const box = await action.boundingBox();
  if (!box) throw new XListNeedsUserError(`X 未显示 ${handle} 的安全添加控件。`);
  await session.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleepMs(1000);
  await removeBtn.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (!await removeBtn.isVisible().catch(() => false)) {
    // Second try through session click path.
    await session.click(action, { force: true, preserveOverlay: true });
    await sleepMs(900);
  }
  if (!await removeBtn.isVisible().catch(() => false)) {
    throw new XListUnknownError(`点击添加 ${handle} 后按钮未变为移除。`);
  }
  return 'added';
}

async function exactHandleRow(rows: Locator, handle: string): Promise<Locator | null> {
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const hrefs = await row.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    if (hrefs.some((href) => xProfileHrefMatchesHandle(href, handle))) return row;
  }
  return null;
}

export function xProfileHrefMatchesHandle(href: string, handle: string): boolean {
  try {
    const pathname = new URL(href, 'https://x.com').pathname.replace(/\/$/, '');
    return pathname.toLowerCase() === `/${handle.replace(/^@/, '').toLowerCase()}`;
  } catch { return false; }
}

export async function addMember(session: XListSession, listId: string, handle: string, hooks: XListActionHooks): Promise<void> {
  await openManagedMembers(session, listId, 'suggested');
  await addMemberInOpenSheet(session, listId, handle, hooks);
}

export async function removeMember(session: XListSession, listId: string, handle: string, hooks: XListActionHooks): Promise<void> {
  if (!listId) throw new Error('List ID 缺失，无法移除成员。');
  await openManagedMembers(session, listId, 'members');
  const bare = handle.replace(/^@/, '');
  const profile = await firstVisible(session.page.locator(
    `[data-testid="UserCell"] a[href="/${bare}"], [role="dialog"] a[href="/${bare}"], main a[href="/${bare}"]`
  ));
  if (!profile) throw new XListNeedsUserError(`成员页未找到 ${handle}。`);
  const row = profile.locator('xpath=ancestor::*[@data-testid="UserCell" or @role="button"][1]');
  const action = await firstVisible(row.locator('button:has-text("移除"), button:has-text("Remove"), button[aria-label*="移除"], button[aria-label*="Remove"]'));
  if (!action) throw new XListNeedsUserError(`X 未显示 ${handle} 的安全移除控件。`);
  await assertNotStopped(hooks);
  await hooks.beforeAction?.('remove_member');
  await session.click(action, { force: true });
  const confirm = await firstVisible(session.page.locator('[role="dialog"] button:has-text("Remove"), [role="dialog"] button:has-text("移除")'));
  if (confirm) await session.click(confirm, { force: true });
}

export async function hasMember(session: XListSession, handle: string): Promise<boolean> {
  const cells = (await membersRoot(session)).locator('[data-testid="UserCell"]');
  const count = await cells.count();
  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    const text = (await cell.innerText().catch(() => '')).trim();
    if (!/(移除|Remove)/i.test(text)) continue;
    if (await cell.locator(`a[href="/${handle.slice(1)}"]`).count() > 0) return true;
    if (firstHandle(text)?.toLowerCase() === handle.toLowerCase()) return true;
  }
  return false;
}

export async function assertNotStopped(hooks: XListActionHooks): Promise<void> {
  if (await hooks.shouldStop?.()) throw new XListStopRequestedError('用户请求在当前页面动作完成后停止。');
}
