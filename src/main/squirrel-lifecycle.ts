import { spawn } from 'node:child_process';
import path from 'node:path';

const SQUIRREL_EVENTS = new Set([
  '--squirrel-install',
  '--squirrel-updated',
  '--squirrel-uninstall',
  '--squirrel-obsolete'
]);

export function handleSquirrelLifecycle(input: {
  argv?: string[];
  execPath?: string;
  quit: () => void;
  spawnProcess?: typeof spawn;
}): boolean {
  const argv = input.argv ?? process.argv;
  const event = argv[1];
  if (!event || !SQUIRREL_EVENTS.has(event)) return false;

  if (event === '--squirrel-obsolete') {
    input.quit();
    return true;
  }

  const execPath = input.execPath ?? process.execPath;
  const updateExe = path.resolve(path.dirname(execPath), '..', 'Update.exe');
  const shortcutCommand = event === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut';
  const child = (input.spawnProcess ?? spawn)(updateExe, [shortcutCommand, path.basename(execPath)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.once('error', () => input.quit());
  child.once('spawn', () => {
    child.unref();
    input.quit();
  });
  return true;
}
