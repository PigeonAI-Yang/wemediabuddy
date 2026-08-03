import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:27401');
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'));
assert.ok(page, 'packaged WMB page not found');
await page.waitForFunction(() => document.title === 'WeMediaBuddy' && Boolean(document.querySelector('#root')));
const composer = page.locator('.pi-composer textarea');
await composer.waitFor({ state: 'visible' });
await page.waitForFunction(() => !(document.querySelector('.pi-composer textarea')?.disabled ?? true));

const openPalette = async (query = '/') => {
  await composer.fill('');
  await composer.fill(query);
  await page.waitForSelector('.pi-command-palette', { state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.pi-command-palette header small')?.textContent?.includes('正在读取'), null, { timeout: 60000 });
};
const rows = () => page.locator('.pi-command-options [role="option"]');
const commandNames = async () => rows().locator('b').allTextContents();

const before = await page.evaluate(async () => ({
  conversation: await window.wmb.getPiConversation(),
  sessions: await window.wmb.listPiConversations(),
  skills: await window.wmb.listPiSkills()
}));
const restoreConversationId = before.sessions.find((item) => !item.title.startsWith('/skill:wmb-slash-acceptance'))?.id ?? before.conversation.id;

await page.setViewportSize({ width: 1100, height: 700 });
await openPalette();
const initialNames = await commandNames();
const expectedSkills = before.skills.map((skill) => `/skill:${skill.name}`);
for (const expected of expectedSkills) assert.ok(initialNames.includes(expected), `missing ${expected}`);
assert.equal(initialNames.includes('/settings'), false);
assert.equal(initialNames.includes('/hotkeys'), false);
const palette1100 = await page.locator('.pi-command-palette').boundingBox();
assert.ok(palette1100 && palette1100.x >= 0 && palette1100.x + palette1100.width <= 1100 && palette1100.y >= 0);
await page.screenshot({ path: '.ai/wmb-2603-palette-1100.png' });

await openPalette('/writer');
assert.equal((await commandNames())[0], '/skill:evidence-grounded-writer');
await composer.press('Enter');
assert.equal(await composer.inputValue(), '/skill:evidence-grounded-writer ');
assert.equal(await page.locator('.pi-command-palette').count(), 0);
const afterInsert = await page.evaluate(async () => ({ conversation: await window.wmb.getPiConversation(), sessions: await window.wmb.listPiConversations() }));
assert.equal(afterInsert.conversation.messages.length, before.conversation.messages.length);
assert.deepEqual(afterInsert.sessions.map((item) => item.id), before.sessions.map((item) => item.id));

await openPalette();
await composer.press('Escape');
assert.equal(await composer.inputValue(), '/');
assert.equal(await page.locator('.pi-command-palette').count(), 0);

await openPalette('/wemedia');
const operatorRow = rows().filter({ hasText: '/skill:wemedia-buddy-operator' }).first();
await operatorRow.click();
assert.equal(await composer.inputValue(), '/skill:wemedia-buddy-operator ');

await page.setViewportSize({ width: 1920, height: 900 });
await openPalette();
const palette1920 = await page.locator('.pi-command-palette').boundingBox();
assert.ok(palette1920 && palette1920.x >= 0 && palette1920.x + palette1920.width <= 1920 && palette1920.y >= 0);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth);
assert.equal(overflow, false);

const temporary = 'wmb-slash-acceptance';
const saveTemporary = (description, instructions, originalName) => page.evaluate(({ description, instructions, originalName, temporary }) => window.wmb.savePiSkill({ originalName, name: temporary, description, instructions }), { description, instructions, originalName, temporary });
try {
  await composer.fill('');
  await saveTemporary('Slash acceptance revision one.', '# Slash acceptance\n\nReply exactly SLASH_SKILL_LOADED and do nothing else.');
  await openPalette('/wmb-slash');
  assert.equal((await rows().first().locator('small').textContent())?.trim(), 'Slash acceptance revision one.');

  await composer.fill('');
  await saveTemporary('Slash acceptance revision two.', '# Slash acceptance\n\nReply exactly SLASH_SKILL_LOADED and do nothing else.', temporary);
  await openPalette('/wmb-slash');
  assert.equal((await rows().first().locator('small').textContent())?.trim(), 'Slash acceptance revision two.');

  await composer.fill('');
  await page.evaluate(() => window.wmb.newPiConversation());
  await openPalette('/wmb-slash');
  await composer.press('Enter');
  const exactTurn = '/skill:wmb-slash-acceptance 请只按 Skill 回复。';
  await composer.fill(exactTurn);
  await composer.press('Enter');
  await page.waitForFunction(() => {
    const phase = document.querySelector('.pi-dock-header [data-phase]')?.getAttribute('data-phase');
    return phase === 'idle' || phase === 'failed' || phase === 'stopped';
  }, null, { timeout: 180000 });
  const acceptanceConversation = await page.evaluate(() => window.wmb.getPiConversation());
  const visibleUser = [...acceptanceConversation.messages].reverse().find((message) => message.role === 'user')?.text;
  assert.equal(visibleUser, exactTurn);
  const raw = await readFile(acceptanceConversation.sessionFile, 'utf8');
  assert.match(raw, /<skill name=\\"wmb-slash-acceptance\\"/);
  assert.match(raw, /SLASH_SKILL_LOADED/);
} finally {
  await composer.fill('');
  await page.evaluate((name) => window.wmb.deletePiSkill(name).catch(() => null), temporary);
  if (restoreConversationId) await page.evaluate((id) => window.wmb.switchPiConversation(id), restoreConversationId);
}

await openPalette('/wmb-slash');
assert.equal(await rows().count(), 0);
assert.match(await page.locator('.pi-command-state').textContent(), /没有匹配/);
await composer.fill('');
const finalSkills = await page.evaluate(() => window.wmb.listPiSkills());
assert.equal(finalSkills.some((skill) => skill.name === temporary), false);

console.log(JSON.stringify({
  title: await page.title(),
  expectedSkills,
  initialNames,
  zeroSend: true,
  keyboardInsert: '/skill:evidence-grounded-writer ',
  pointerInsert: '/skill:wemedia-buddy-operator ',
  responsive: { palette1100, palette1920, overflow },
  crudRefresh: ['created', 'updated', 'deleted'],
  nativeSkillLoaded: true
}, null, 2));
await browser.close();
