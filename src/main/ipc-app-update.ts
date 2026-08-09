import { BrowserWindow, type IpcMain } from 'electron';
import type { UpdateManager } from './app-update.ts';

export function registerAppUpdateIpc(ipcMain: Pick<IpcMain, 'handle'>, manager: UpdateManager): () => void {
  ipcMain.handle('app-update:get-state', () => manager.getState());
  ipcMain.handle('app-update:check', () => manager.checkForUpdates().then(() => manager.getState()));
  ipcMain.handle('app-update:download', () => manager.downloadUpdate().then(() => manager.getState()));
  ipcMain.handle('app-update:install-now', () => manager.installNow().then(() => manager.getState()));
  ipcMain.handle('app-update:install-on-quit', () => manager.installOnQuit().then(() => manager.getState()));
  ipcMain.handle('app-update:remind-later', () => manager.remindLater().then(() => manager.getState()));
  ipcMain.handle('app:renderer-ready', () => manager.markBootOk());
  return manager.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('app-update:state', state);
    }
  });
}
