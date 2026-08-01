import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { setDataChangedPublisher, type DataChangedEvent } from './data-changed.ts';

export type { DataChangedEvent, DataChangedScope } from './data-changed.ts';
export { broadcastDataChanged } from './data-changed.ts';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export function createWindow(): void {
  const window = new BrowserWindow({
    show: process.env.WMB_ACCEPTANCE_HEADLESS !== '1',
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    icon: path.join(app.getAppPath(), 'images', 'logo.png'),
    backgroundColor: '#090c11',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

export function broadcastPiEvent(event: Record<string, unknown>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pi:event', event);
  }
}

setDataChangedPublisher((event: DataChangedEvent) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('data:changed', event);
  }
});

export function broadcastPiRuntimeProgress(event: Record<string, unknown>, scope: 'dock' | 'task' = 'task'): void {
  if (event.type === 'wmb_text_delta') broadcastPiEvent({ type: 'delta', text: String(event.text ?? ''), scope });
  if (event.type === 'wmb_thinking_delta') broadcastPiEvent({ type: 'thinking', text: String(event.text ?? ''), scope });
  if (event.type === 'agent_start') broadcastPiEvent({ type: 'running', scope });
  if (event.type === 'tool_execution_start') broadcastPiEvent({ type: 'tool', toolName: String(event.toolName ?? ''), scope });
  if (event.type === 'tool_execution_end') broadcastPiEvent({ type: 'running', scope });
  if (event.type === 'queue_update') {
    broadcastPiEvent({
      type: 'queue',
      steering: Array.isArray(event.steering) ? event.steering.map(String) : [],
      followUp: Array.isArray(event.followUp) ? event.followUp.map(String) : [],
      scope
    });
  }
}
