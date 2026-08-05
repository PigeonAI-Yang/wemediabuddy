const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

app.setName('WeMediaBuddy');
app.setPath('userData', path.join(process.env.APPDATA, 'WeMediaBuddy'));
const resultPath = 'J:\\PigeonYang\\WeMediaBuddy\\.ai\\wmb-4600-mimo-provider-result.json';
writeFileSync(resultPath, JSON.stringify({ stage: 'started' }), 'utf8');

app.whenReady().then(async () => {
  writeFileSync(resultPath, JSON.stringify({ stage: 'ready' }), 'utf8');
  const configPath = path.join(process.env.APPDATA, 'WeMediaBuddy', 'pi-api-config.json');
  const envelope = JSON.parse(readFileSync(configPath, 'utf8'));
  const profile = envelope.state.profiles.find((item) => item.id === envelope.state.activeId);
  const apiKey = safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, 'base64'));
  if (process.argv.includes('--list')) {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000)
    });
    const body = await response.json();
    const models = (body.data ?? []).filter((item) => /mimo/i.test(item.id ?? item.name ?? ''));
    writeFileSync(resultPath, `${JSON.stringify({ status: response.status, models }, null, 2)}\n`, 'utf8');
    app.exit(response.ok ? 0 : 1);
    return;
  }
  const model = process.argv.find((value) => value.startsWith('--model='))?.slice('--model='.length) || 'mimo-v2-omni';
  const image = readFileSync('J:\\PigeonYang\\WeMediaBuddy\\images\\VI.png').toString('base64');
  const messages = process.argv.includes('--text')
    ? [{ role: 'user', content: '只回复：文本正常' }]
    : [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
      { type: 'text', text: '只回答图片中的英文品牌名称和主背景颜色。' }
    ] }];
  const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 256,
      temperature: 0
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const body = await response.text();
  let content = body;
  try { content = JSON.parse(body).choices?.[0]?.message?.content ?? body; } catch {}
  const receipt = JSON.stringify({ status: response.status, model, content: String(content).slice(0, 500) }, null, 2);
  writeFileSync(resultPath, `${receipt}\n`, 'utf8');
  console.log(receipt);
  app.exit(response.ok && /WeMediaBuddy/i.test(String(content)) && /黑/.test(String(content)) ? 0 : 1);
}).catch((error) => { writeFileSync(resultPath, JSON.stringify({ stage: 'failed', error: String(error.message || error) }), 'utf8'); console.error(error.stack || error); app.exit(1); });
