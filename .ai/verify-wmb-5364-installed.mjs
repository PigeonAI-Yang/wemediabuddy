import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const port = 9322;
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const outputPath = 'J:/wmb-out/wmb-5364-installed-readback.json';
const screenshotPath = 'J:/wmb-out/wmb-5364-installed-today.png';

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  assert.ok(page, 'installed Electron renderer is unavailable');

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const todayNav = page.locator('[data-nav="today"], [data-testid="nav-today"], button:has-text("今日"), a:has-text("今日")').first();
  if (await todayNav.count()) await todayNav.click();
  await page.waitForTimeout(2_000);

  const readback = await page.evaluate(async (today) => {
    const result = await window.wmb.getToday(today);
    const bodyText = document.body.innerText || '';
    const cards = [...document.querySelectorAll('[data-opportunity-card]')].map((card) => ({
      text: card.innerText,
      buttons: [...card.querySelectorAll('button')].map((button) => ({
        text: button.innerText,
        ariaLabel: button.getAttribute('aria-label'),
        disabled: button.disabled,
      })),
    }));
    return {
      url: location.href,
      title: document.title,
      appShell: Boolean(document.querySelector('.app-shell')),
      todayLayout: Boolean(document.querySelector('.today-layout, .today-overview')),
      result,
      cards,
      bodyText,
    };
  }, date);

  const recentDates = Array.from({ length: 14 }, (_, offset) => {
    const value = new Date();
    value.setDate(value.getDate() - offset);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
  });
  const recentReadback = await page.evaluate(async (dates) => Promise.all(
    dates.map(async (planDate) => {
      const value = await window.wmb.getToday(planDate);
      return {
        planDate,
        primary: value?.recommendation?.primary ?? null,
        counts: value?.recommendation?.counts ?? null,
        emptyReason: value?.recommendation?.emptyReason ?? null,
      };
    }),
  ), recentDates);

  assert.ok(readback.url.includes('index.html'), `unexpected renderer URL: ${readback.url}`);
  assert.equal(readback.appShell, true, 'app shell did not render');
  assert.equal(readback.todayLayout, true, 'Today view did not render');

  const primary = readback.result?.recommendation?.primary ?? null;
  if (primary) {
    for (const field of ['title', 'whyNow', 'targetAudience', 'angle', 'pointOfView', 'structureGuidance']) {
      assert.ok(String(primary[field] ?? '').trim(), `Today primary is missing ${field}`);
    }
    const cardText = readback.cards[0]?.text ?? '';
    for (const field of ['whyNow', 'targetAudience', 'angle', 'pointOfView']) {
      assert.ok(cardText.includes(String(primary[field]).trim()), `Today card does not render ${field}`);
    }
  }

  const invalidApprovals = readback.cards.flatMap((card) =>
    card.buttons.filter((button) => /批准|开始创作/.test(`${button.text} ${button.ariaLabel ?? ''}`) && /待评分|无效|继续评分/.test(card.text) && !button.disabled),
  );
  assert.equal(invalidApprovals.length, 0, 'pending or invalid card exposes an enabled approval action');

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const evidence = {
    checkedAt: new Date().toISOString(),
    date,
    installedRenderer: { url: readback.url, title: readback.title },
    shell: { appShell: readback.appShell, todayLayout: readback.todayLayout },
    recommendation: {
      primary,
      counts: readback.result?.recommendation?.counts ?? null,
      emptyReason: readback.result?.recommendation?.emptyReason ?? null,
    },
    recentReadback,
    cards: readback.cards,
    pendingInvalidApprovalViolations: invalidApprovals,
    consoleErrors,
    pageErrors,
    screenshotPath,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
