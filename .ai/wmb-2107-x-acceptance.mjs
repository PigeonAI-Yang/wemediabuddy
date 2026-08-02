import assert from 'node:assert/strict';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveBrowserConfig } from '../src/main/browser.ts';

const pyaireaderBrowser = {
  id: 'edge:pyaireader-default',
  label: 'Edge · Pyaireader 默认 X 登录态',
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userDataDir: path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'Pyaireader', 'default-profile'),
  profileDirectory: 'Default',
  cdpUrl: 'http://127.0.0.1:9334'
};

export function configureRealXBrowser(rootPath) {
  const database = migrateDatabase(path.join(rootPath, 'wmb.db'));
  try { saveBrowserConfig(database, pyaireaderBrowser); }
  finally { database.close(); }
}

export async function exerciseRealXViaUi({ page, rootPath, counts, goChannels, confirmFirstProposal }) {
  const saved = await page.evaluate(() => window.wmb.configureBrowser('edge:pyaireader-default'));
  assert.equal(saved.id, 'edge:pyaireader-default');
  await goChannels(page);

  const byName = await resolve(page, 'AI前沿');
  assert.equal(byName.ok, true, byName.ok ? '' : byName.error.message);
  assert.ok(byName.data.candidates.length > 0, 'current account must return the requested List name');
  const candidate = byName.data.candidates[0];
  // X intentionally uses latest-wins on the shared browser page, so probes
  // must follow the same serial interaction model as the UI.
  const byUrl = await resolve(page, candidate.canonicalUrl);
  const byId = await resolve(page, candidate.listId);
  assert.equal(byUrl.ok, true);
  assert.equal(byId.ok, true);
  assert.deepEqual(byUrl.data.candidates.map((item) => item.listId), [candidate.listId]);
  assert.deepEqual(byId.data.candidates.map((item) => item.listId), [candidate.listId]);

  const staleBefore = counts(rootPath);
  const staleAccount = await page.evaluate(async ({ resolution, candidate: selected }) => {
    try {
      await window.wmb.prepareIntelligenceChannelProposal({
        requestId: crypto.randomUUID(),
        changes: [{ action: 'add', module: 'x_lists', resolution, candidate: { ...selected, accountKey: '@NotCurrent' } }]
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) };
    }
  }, { resolution: byName.data, candidate });
  assert.equal(staleAccount.ok, false, 'a stale account candidate must not be prepared');
  assert.match(staleAccount.message, /当前工作空间解析结果|当前 X 账号/);
  const staleAfter = counts(rootPath);
  assert.deepEqual(staleAfter, staleBefore, 'a stale account candidate must write zero rows');

  const ui = await queueXListFromUi(page, candidate);
  assert.equal(ui.candidateCount, byName.data.candidates.length, 'the UI must render every same-name candidate');
  await confirmFirstProposal(page);
  const channels = await page.evaluate(() => window.wmb.getIntelligenceChannels());
  const binding = channels.summary.sources.find((item) => item.module === 'x_lists'
    && item.accountKey === candidate.accountKey && item.listId === candidate.listId && item.canonicalUrl === candidate.canonicalUrl);
  assert.ok(binding, 'confirmed UI proposal must read back as the exact X binding');
  const bound = counts(rootPath);
  assert.equal(bound.bindings, staleBefore.bindings + 1, 'UI confirmation must create exactly one local binding');

  const duplicate = await page.evaluate(async ({ resolution, candidate: selected }) => {
    try {
      await window.wmb.prepareIntelligenceChannelProposal({
        requestId: crypto.randomUUID(),
        changes: [{ action: 'add', module: 'x_lists', resolution, candidate: selected }]
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) };
    }
  }, { resolution: byName.data, candidate });
  assert.equal(duplicate.ok, false, 'the exact existing binding must be reused rather than duplicated');
  assert.match(duplicate.message, /来源已存在/);
  const duplicateAfter = counts(rootPath);
  assert.deepEqual(duplicateAfter, bound, 'an existing X binding must not create rows again');

  return {
    currentAccount: {
      accountKey: candidate.accountKey,
      listId: candidate.listId,
      canonicalUrl: candidate.canonicalUrl,
      name: candidate.name,
      ownerHandle: candidate.ownerHandle,
      kind: candidate.kind
    },
    nameUrlIdResolution: { name: candidate.name, urlIds: byUrl.data.candidates.map((item) => item.listId), idIds: byId.data.candidates.map((item) => item.listId) },
    sameName: { candidateCount: byName.data.candidates.length, allRenderedByUi: true, notApplicableInCurrentAccount: byName.data.candidates.length === 1 },
    staleAccount: { rejected: true, transportCode: staleAccount.code, message: staleAccount.message, countsBefore: staleBefore, countsAfter: staleAfter },
    uiExactBinding: { sourceId: binding.sourceId, sourceFeedId: binding.sourceFeedId, listId: binding.listId, canonicalUrl: binding.canonicalUrl },
    duplicateExactBinding: { rejected: true, transportCode: duplicate.code, message: duplicate.message, countsBefore: bound, countsAfter: duplicateAfter }
  };
}

async function resolve(page, inputText) {
  return page.evaluate(async (input) => window.wmb.resolveXListCandidates({ inputText: input }), inputText);
}

async function queueXListFromUi(page, candidate) {
  const form = page.locator('[aria-labelledby="add-x-list-title"]');
  await form.locator('input').fill(candidate.name);
  await form.getByRole('button', { name: '查找 List', exact: true }).click();
  const candidates = form.locator('[aria-label="X List 候选"]');
  await candidates.waitFor({ timeout: 30_000 });
  const row = candidates.locator('label').filter({ hasText: candidate.canonicalUrl });
  assert.equal(await row.count(), 1, 'the selected List must have one exact UI candidate');
  const candidateCount = await candidates.locator('label').count();
  await row.locator('input').check();
  const add = form.getByRole('button', { name: '加入待确认清单', exact: true });
  await add.click();
  await page.locator('.channel-proposal-list').waitFor({ timeout: 20_000 });
  return { candidateCount };
}
