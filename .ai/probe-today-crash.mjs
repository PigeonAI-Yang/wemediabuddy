const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const pick = targets.find((t) => t.type === 'page') || null;
if (!pick) {
  console.log(JSON.stringify({ targets }, null, 2));
  throw new Error('no page target');
}

const ws = new WebSocket(pick.webSocketDebuggerUrl);
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
    events.push({
      type: 'exception',
      text: msg.params?.exceptionDetails?.exception?.description
        || msg.params?.exceptionDetails?.text
        || 'unknown',
      url: msg.params?.exceptionDetails?.url,
      line: msg.params?.exceptionDetails?.lineNumber
    });
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params?.type)) {
    events.push({
      type: msg.params.type,
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
await new Promise((r) => setTimeout(r, 2000));

await send('Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button,a,[role=button]')];
    const today = btns.find((b) => /今日|Today/i.test(b.textContent || ''));
    if (today) today.click();
    return true;
  })()`,
  returnByValue: true
});

await new Promise((r) => setTimeout(r, 2000));

const page = await send('Runtime.evaluate', {
  expression: `(() => {
    const bodyText = document.body?.innerText || '';
    const todayMain = document.querySelector('.today-main');
    const feed = document.querySelector('.feed-list');
    return {
      url: location.href,
      title: document.title,
      text: bodyText.slice(0, 2500),
      hasToday: !!document.querySelector('.today-layout, .today-main'),
      feedCount: document.querySelectorAll('.feed-item').length,
      stylesheets: [...document.styleSheets].length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      todayDisplay: todayMain ? getComputedStyle(todayMain).display : null,
      feedDisplay: feed ? getComputedStyle(feed).display : null,
      rootHtml: (document.getElementById('root')?.innerHTML || '').slice(0, 1200)
    };
  })()`,
  returnByValue: true,
  awaitPromise: true
});

console.log(JSON.stringify({
  target: { title: pick.title, url: pick.url },
  page: page.result?.value ?? page,
  events
}, null, 2));
ws.close();
