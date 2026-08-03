import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((item) => item.url().includes('/i/lists/2084093837790843218')) ?? pages[0];
  const selectors = ['a[href="/i/lists/2084093837790843218/info"]', 'a:has-text("编辑列表")', '[role="dialog"] a[href="/i/lists/2084093837790843218/members"]'];
  const controls = [];
  for (const selector of selectors) {
    const item = page.locator(selector).first();
    controls.push({ selector, count: await item.count(), visible: await item.isVisible().catch(() => false), box: await item.boundingBox().catch(() => null), text: await item.innerText().catch(() => '') });
  }
  console.log(JSON.stringify({ url: page.url(), title: await page.title(), viewport: page.viewportSize(), dialogs: await page.locator('[role="dialog"],[aria-modal="true"]').count(), controls }, null, 2));
} finally { await browser.close(); }
