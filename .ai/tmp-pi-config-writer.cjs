/** One-shot: write pi-api-config.json encrypted under the given userData (safeStorage same-context). */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
if (process.env.WMB_ACCEPTANCE_USER_DATA) app.setPath('userData', process.env.WMB_ACCEPTANCE_USER_DATA);
const outPath = process.argv[2];
const apiKey = process.argv[3];
app.whenReady().then(() => {
  const encrypted = safeStorage.encryptString(apiKey).toString('base64');
  const cfg = {
    version: 1,
    state: {
      activeId: 'opencode-go',
      profiles: [
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          model: 'deepseek-v4-flash',
          api: 'openai-responses',
          thinking: 'max',
          nativeSearch: true,
          contextWindow: 1000000,
          maxTokens: 384000,
          encryptedApiKey: encrypted
        }
      ],
      fallbackOrder: []
    }
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2));
  console.log('PI_CONFIG_WRITTEN', outPath, 'keyLen', apiKey.length);
  app.quit();
}).catch((e) => { console.error('WRITE_FAIL', String(e)); app.exit(1); });
