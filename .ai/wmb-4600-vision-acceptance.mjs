import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const executable = 'J:\\PigeonYang\\WeMediaBuddy\\out\\WeMediaBuddy-win32-x64\\WeMediaBuddy.exe';
const port = 29546;
const imagePath = 'J:\\PigeonYang\\WeMediaBuddy\\images\\VI.png';
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(port), WMB_ACCEPTANCE_HEADLESS: '1' };
const child = spawn(executable, [], { cwd: 'J:\\PigeonYang\\WeMediaBuddy\\out\\WeMediaBuddy-win32-x64', env, stdio: 'ignore' });
const taskkill = promisify(execFile);

async function cdpReady() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
      response.resume();
      response.statusCode === 200 ? resolve() : reject(new Error(`CDP HTTP ${response.statusCode}`));
    }).on('error', reject);
  });
}

async function waitForCdp() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await cdpReady(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error('packaged CDP did not start');
}

async function chat(page, message) {
  return Promise.race([
    page.evaluate((text) => window.wmb.chatPi(text), message),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Pi turn timed out')), 180_000))
  ]);
}

let browser;
try {
  await waitForCdp();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt += 1) {
    page = browser.contexts()[0]?.pages()[0];
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('packaged page did not open');
  await page.waitForSelector('#root', { timeout: 30_000 });
  if (process.argv.includes('--startup-only')) {
    const [commands, settings] = await Promise.all([
      page.evaluate(() => window.wmb.listPiCommands()),
      page.evaluate(() => window.wmb.getSettings())
    ]);
    const registry = JSON.parse(await readFile('J:\\PigeonYang\\WeMediaBuddy\\data\\ukcontentdata\\pi-agent\\models.json', 'utf8'));
    const models = registry.providers['wmb-api'].models;
    const result = { title: await page.title(), mainModel: settings.pi.model, visionCommand: commands.some((item) => item.name === 'vision'), models };
    console.log(JSON.stringify(result, null, 2));
    if (result.title !== 'WeMediaBuddy' || result.mainModel !== 'deepseek-v4-flash' || !result.visionCommand || !models.some((item) => item.id === 'mimo-v2.5' && item.input.includes('image'))) process.exitCode = 1;
  } else {
  await page.evaluate(() => {
    window.__wmb4600Events = [];
    window.wmb.onPiEvent((event) => window.__wmb4600Events.push(event));
  });
  await page.evaluate(() => window.wmb.newPiConversation());
  const textResult = await chat(page, '这是纯文本测试。不要调用任何工具，只回复：文本正常');
  const afterText = await page.evaluate(() => window.__wmb4600Events);
  const visionStart = afterText.length;
  const visionResult = await chat(page, `必须调用 describe_image 读取本地图片 ${imagePath}，然后告诉我图片中的英文品牌名称和主背景颜色。不要凭文件名猜。`);
  const visionEvents = await page.evaluate((start) => window.__wmb4600Events.slice(start), visionStart);
  const state = await page.evaluate(() => window.wmb.getPiConversation());
  const tools = visionEvents.filter((event) => event.type === 'tool' || event.type === 'tool-result');
  const textToolCalls = afterText.filter((event) => event.toolName === 'describe_image').length;
  const visionToolCalls = tools.filter((event) => event.toolName === 'describe_image');
  const toolText = JSON.stringify(visionToolCalls);
  const result = {
    title: await page.title(),
    textResult,
    textDescribeImageCalls: textToolCalls,
    visionResult,
    visionDescribeImageEvents: visionToolCalls.length,
    visionProviderModel: /wmb-api[\\/\s]+mimo-v2\.5|mimo-v2\.5/.test(toolText),
    finalAssistantText: [...state.messages].reverse().find((message) => message.role === 'assistant')?.text ?? ''
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.title !== 'WeMediaBuddy' || textToolCalls !== 0 || visionToolCalls.length < 2 || !result.visionProviderModel || !/WeMediaBuddy/i.test(result.finalAssistantText) || !/黑/.test(result.finalAssistantText)) process.exitCode = 1;
  }
} finally {
  await browser?.close().catch(() => {});
  await taskkill('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
}
