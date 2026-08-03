import http from 'node:http';
import { chromium } from 'playwright-core';

const version = await new Promise((resolve, reject) => http.get('http://127.0.0.1:9371/json/version', (response) => {
  let body = '';
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => resolve(JSON.parse(body)));
}).on('error', reject));
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
try {
  const page = browser.contexts()[0].pages()[0];
  const conversation = page.locator('.pi-conversation');
  await conversation.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const button = page.locator('.pi-jump-latest');
  await button.waitFor();
  await button.hover();
  const before = await button.evaluate((node) => ({ rect: node.getBoundingClientRect().toJSON(), transform: getComputedStyle(node).transform }));
  await page.mouse.down();
  const down = await button.evaluate((node) => ({ rect: node.getBoundingClientRect().toJSON(), transform: getComputedStyle(node).transform }));
  await page.mouse.move(0, 0);
  await page.mouse.up();
  const center = (rect) => rect.x + rect.width / 2;
  const result = { before, down, centerDelta: center(down.rect) - center(before.rect), pressedFeedback: down.rect.height < before.rect.height };
  console.log(JSON.stringify(result, null, 2));
  if (Math.abs(result.centerDelta) > 1 || !result.pressedFeedback) process.exitCode = 1;
} finally {
  await browser.close();
}
