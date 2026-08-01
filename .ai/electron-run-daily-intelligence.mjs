import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { app } = require('electron');

app.whenReady().then(async () => {
  try {
    const runner = pathToFileURL(path.resolve('.ai/run-daily-intelligence-once.mjs')).href;
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
