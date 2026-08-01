// Pi 扩展修复验证:live DB 副本 + 真实 Electron + 真实 Pi 对话(机器级 safeStorage 解密在副本上同样有效)
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

// 直接使用 live 数据根(dev 实例已停止,不会再有 MCP 端口冲突)
const root = 'J:\\PigeonYang\\WeMediaBuddyData';
const CDP = 9350;
const env = { ...process.env, WMB_ACCEPTANCE_CDP_PORT: String(CDP) };
delete env.WMB_ACCEPTANCE_HEADLESS;
const electronBin = new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const child = spawn(electronBin, ['.'], { env, cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', () => {});
const cleanup = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} };
process.on('exit', cleanup);
const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
});
for (let i = 0; i < 240; i++) { try { await getJson('/json/version'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
const page = browser.contexts()[0].pages()[0];
await page.goto('file:///J:/PigeonYang/WeMediaBuddy/.vite/renderer/main_window/index.html');
await page.waitForSelector('.sidebar button', { state: 'attached', timeout: 45000 });
await page.waitForTimeout(2500);

// 1) 扩展布局:子目录包,顶层无扁平坏文件(preparePiExtension 在首个 Pi 请求时执行)
const extRoot = path.join(root, 'pi-agent', 'extensions');
await page.waitForSelector('.pi-composer textarea', { state: 'attached', timeout: 20000 });
await page.fill('.pi-composer textarea', '只回复两个字:正常');
await page.evaluate(() => {
  const btn = document.querySelector('.pi-send-button');
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(8000);
const layout = {
  flat: existsSync(extRoot) ? readdirSync(extRoot, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : ['<missing>'],
  pkg: existsSync(path.join(extRoot, 'wmb-mcp')) ? readdirSync(path.join(extRoot, 'wmb-mcp')) : []
};
console.log('extension layout:', JSON.stringify(layout));

// 2) 真实对话:Pi 不再因扩展加载失败退出
let reply = '';
let failed = false;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  const state = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.pi-conversation .assistant')];
    const last = bubbles[bubbles.length - 1];
    const status = [...document.querySelectorAll('.status-item')].map((el) => el.textContent ?? '').join(' ');
    return { text: last?.textContent ?? '', streaming: last?.classList.contains('streaming') ?? false, status };
  });
  if (/已退出|调用失败/.test(state.status)) { failed = true; break; }
  if (!state.streaming && state.text.trim().length >= 2 && !/正在思考|正在继续处理/.test(state.text)) { reply = state.text; break; }
}
writeFileSync('.ai/wmb-pi-fix-reply.png', await page.screenshot());
console.log(JSON.stringify({ failed, reply: reply.slice(0, 120) }, null, 1));
await browser.close();
cleanup();
await new Promise((r) => setTimeout(r, 1500));
const layoutOk = layout.flat.length === 0 && layout.pkg.includes('index.ts') && layout.pkg.length === 4;
process.exit(layoutOk && !failed && reply.trim().length >= 2 ? 0 : 1);
