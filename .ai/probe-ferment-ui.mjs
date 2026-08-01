const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = tabs.find((tab) => /localhost:27391/i.test(tab.url)) || tabs[0];
if (!page?.webSocketDebuggerUrl) {
  console.log(JSON.stringify({ ok: false, error: 'no page', tabs: tabs.map((tab) => tab.url) }));
  process.exit(1);
}

const { default: WebSocket } = await import('ws');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

let nextId = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const onMessage = (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id !== id) return;
    ws.off('message', onMessage);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  };
  ws.on('message', onMessage);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');
const evaluated = await send('Runtime.evaluate', {
  expression: `(() => {
    const stats = [...document.querySelectorAll('.stat-label')].map((el) => el.textContent.trim());
    const rail = document.querySelector('.fermenting-rail, [aria-label="仍在发酵"]');
    const bodyHas = document.body.innerText.includes('仍在发酵');
    const today = !!document.querySelector('.today-layout');
    return {
      url: location.href,
      today,
      stats,
      bodyHas,
      hasRail: !!rail,
      railPreview: rail ? rail.innerText.slice(0, 300) : null,
      oppCount: document.querySelectorAll('.opportunity-primary, .opp-row, [data-opportunity-card]').length
    };
  })()`,
  returnByValue: true,
  awaitPromise: false
});

console.log(JSON.stringify({ ok: true, page: page.url, value: evaluated.result?.value ?? evaluated }, null, 2));
ws.close();
