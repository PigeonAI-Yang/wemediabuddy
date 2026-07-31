import assert from 'node:assert/strict';
import { readXListIndex } from '../src/main/platforms/x-list-browser.ts';
import { XListSession } from '../src/main/platforms/x-list-session.ts';

const config = { id: 'edge:pyaireader-default', cdpUrl: 'http://127.0.0.1:9334' };

if (process.argv.includes('--inspect')) {
  const session = await XListSession.open(config);
  try {
    console.log(JSON.stringify({
      pageUrl: session.page.url(),
      title: await session.page.title(),
      visibleText: (await session.visibleText()).slice(0, 2_000),
      controls: {
        accountSwitcher: {
          count: await session.page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').count(),
          text: await session.page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').innerText().catch(() => ''),
          avatarTestId: await session.page.locator('[data-testid="SideNav_AccountSwitcher_Button"] [data-testid^="UserAvatar-Container-"]').getAttribute('data-testid').catch(() => null)
        },
        main: await session.page.locator('main').count(),
        listLinks: await session.page.locator('main a[href*="/i/lists/"]').count(),
        listCells: await session.page.locator('[data-testid="listCell"]').count()
      }
    }, null, 2));
  } finally { await session.close(); }
} else {
  const result = await readXListIndex(config);
  assert.match(result.accountKey, /^@[A-Za-z0-9_]{1,15}$/);
  assert.match(result.observation.fingerprint, /^[a-f0-9]{64}$/);
  console.log(JSON.stringify({ accountKey: result.accountKey, listCount: result.lists.length, lists: result.lists, observation: result.observation }, null, 2));
}
