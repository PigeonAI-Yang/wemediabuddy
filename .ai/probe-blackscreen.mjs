const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];

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
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    events.push({ type: 'exception', detail: msg.params?.exceptionDetails });
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    events.push({
      type: 'console',
      text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    });
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await new Promise((r) => setTimeout(r, 1500));

const expression = `(() => {
  const root = document.getElementById('root');
  return {
    url: location.href,
    title: document.title,
    childCount: root ? root.childElementCount : -1,
    rootHtml: root ? root.innerHTML.slice(0, 1000) : null,
    text: (document.body && document.body.innerText || '').slice(0, 1000),
    hasMain: !!document.querySelector('main.app-shell'),
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 10)
  };
})()`;

const evaled = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true
});

console.log(JSON.stringify({ page: evaled.result?.value ?? evaled, events }, null, 2));
ws.close();
