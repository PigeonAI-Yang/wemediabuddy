const { app, safeStorage } = require('electron');
const fs = require('fs');
if (process.env.WMB_ACCEPTANCE_USER_DATA) app.setPath('userData', process.env.WMB_ACCEPTANCE_USER_DATA);
app.whenReady().then(() => {
  const cfgPath = process.argv[2];
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const profile = raw.state.profiles.find((p) => p.id === raw.state.activeId) ?? raw.state.profiles[0];
  try {
    const key = safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, 'base64'));
    console.log('DECRYPT_OK', key.length);
  } catch (e) {
    console.log('DECRYPT_FAIL', String(e.message || e));
  }
  app.quit();
}).catch((e) => { console.log('READY_FAIL', String(e)); app.exit(1); });
