import fs from 'node:fs';

const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Page.enable');
await send('Runtime.enable');

const expression = `(() => {
  const cs = getComputedStyle(document.body);
  const main = document.querySelector('main.app-shell');
  const mcs = main ? getComputedStyle(main) : null;
  const workspace = document.querySelector('.workspace');
  const wcs = workspace ? getComputedStyle(workspace) : null;
  const pageEl = document.querySelector('.library-page, .today-main, .page');
  const pcs = pageEl ? getComputedStyle(pageEl) : null;
  return {
    theme: document.documentElement.dataset.theme || null,
    bodyBg: cs.backgroundColor,
    bodyColor: cs.color,
    bodyOpacity: cs.opacity,
    bodyVisibility: cs.visibility,
    mainDisplay: mcs ? mcs.display : null,
    mainOpacity: mcs ? mcs.opacity : null,
    mainBg: mcs ? mcs.backgroundColor : null,
    workspaceBg: wcs ? wcs.backgroundColor : null,
    workspaceOpacity: wcs ? wcs.opacity : null,
    pageBg: pcs ? pcs.backgroundColor : null,
    pageColor: pcs ? pcs.color : null,
    ww: window.innerWidth,
    wh: window.innerHeight,
    textSample: (document.body.innerText || '').slice(0, 120)
  };
})()`;

const metrics = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true
});
console.log(JSON.stringify(metrics.result?.value ?? metrics, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
const out = new URL('./blackscreen-probe.png', import.meta.url);
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('screenshot', out.pathname, Buffer.from(shot.data, 'base64').length);
ws.close();
