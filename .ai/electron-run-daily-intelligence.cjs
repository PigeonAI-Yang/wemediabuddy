const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Guard: if this process was launched as plain Node, electron APIs are unavailable.
if (!process.versions.electron) {
  console.error('This entry must be launched with the Electron binary, not Node.');
  process.exit(1);
}

const electron = require('electron');
const app = electron.app;
if (!app) {
  console.error('electron.app unavailable. ELECTRON_RUN_AS_NODE=', process.env.ELECTRON_RUN_AS_NODE);
  process.exit(1);
}

// Must match packaged/dev app identity so safeStorage can decrypt pi-api-config.
app.setName('WeMediaBuddy');
app.setPath('userData', path.join(app.getPath('appData'), 'WeMediaBuddy'));

app.whenReady().then(async () => {
  try {
    const runner = pathToFileURL(path.resolve(__dirname, 'run-daily-intelligence-once.mjs')).href;
    await import(runner);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    setTimeout(() => app.exit(process.exitCode || 0), 50);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
