import { ipcMain } from 'electron';
import type { DataRoot } from './data-root';
import { createForkedPiConversation, readPiConversation } from './pi-conversation';
import { readPiTranscript, syncPiConversation, visiblePiPrompt } from './pi-persistence';
import type { PiRpcSupervisor } from './pi-runtime';
import { broadcastPiEvent } from './app-window';

type Dependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  ensurePi: (dataRoot: DataRoot) => Promise<PiRpcSupervisor>;
  getPi: () => PiRpcSupervisor | null;
  getPiSessionFile: () => string | null;
  setPiSessionFile: (sessionFile: string) => void;
};

let openingTurn: Promise<void> | null = null;
let finishOpeningTurn: (() => void) | null = null;
let stopAfterOpening = false;

function openTurnGate(): void {
  openingTurn = new Promise((resolve) => { finishOpeningTurn = resolve; });
}

function closeTurnGate(): void {
  finishOpeningTurn?.();
  finishOpeningTurn = null;
  openingTurn = null;
}

export function registerPiDockIpc({ loadSelectedDataRoot, ensurePi, getPi, getPiSessionFile, setPiSessionFile }: Dependencies): void {
  ipcMain.handle('pi:chat', async (_event, input: string | { message: string; delivery?: 'steer' | 'followUp' }) => {
    const raw = (typeof input === 'string' ? input : input.message).trim();
    if (!raw) throw new Error('请输入内容。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const pendingOpening = openingTurn;
    const continuesTurn = getPi()?.isActive === true || pendingOpening !== null;
    if (continuesTurn) {
      await pendingOpening;
      const runtime = await ensurePi(dataRoot);
      if (!runtime.isActive) throw new Error('Pi 未接受当前对话。');
      const delivery = typeof input === 'string' ? 'steer' : (input.delivery ?? 'steer');
      await (delivery === 'followUp' ? runtime.followUp(raw) : runtime.steer(raw));
      broadcastPiEvent({ type: 'queued', delivery, scope: 'dock' });
      return { text: '', stopped: false, queued: true, conversation: null };
    }
    openTurnGate();
    broadcastPiEvent({ type: 'starting', scope: 'dock' });
    let runtime: PiRpcSupervisor | null = null;
    try {
      runtime = await ensurePi(dataRoot);
      const conversation = await readPiConversation(dataRoot.path);
      const result = await runtime.promptUntilSettled(raw, {
        onStreaming: () => {
          closeTurnGate();
          if (stopAfterOpening) {
            stopAfterOpening = false;
            void runtime?.abortTurn().catch(() => {});
          }
        }
      });
      const synced = await syncPiConversation(dataRoot.path, conversation, runtime, result.stopped ? 'stopped' : undefined, result.thinking);
      if (synced) setPiSessionFile(synced.sessionFile);
      broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: result.text, thinking: result.thinking, scope: 'dock' });
      return { ...result, queued: false, conversation: synced };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!runtime || getPi() === runtime) {
        broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
      }
      throw error;
    } finally {
      closeTurnGate();
      stopAfterOpening = false;
    }
  });

  ipcMain.handle('pi:stop', async () => {
    if (openingTurn) {
      stopAfterOpening = true;
      return { stopped: true };
    }
    const runtime = getPi();
    if (!runtime?.isActive) return { stopped: false };
    await runtime.abortTurn();
    return { stopped: true };
  });

  ipcMain.handle('pi:fork', async (_event, entryId: string) => {
    if (!entryId) throw new Error('缺少 Pi 会话条目。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const runtime = await ensurePi(dataRoot);
    if (runtime.isActive) throw new Error('Pi 正在回复，完成或停止后再回退。');
    const current = await readPiConversation(dataRoot.path);
    const response = await runtime.fork(entryId);
    const data = response.data && typeof response.data === 'object' ? response.data as { text?: unknown; cancelled?: unknown } : {};
    const text = typeof data.text === 'string' ? visiblePiPrompt(data.text) : '';
    if (data.cancelled === true) return { cancelled: true, text, conversation: current };
    const transcript = await readPiTranscript(runtime);
    const conversation = await createForkedPiConversation(dataRoot.path, {
      sessionFile: transcript.sessionFile ?? getPiSessionFile() ?? current.sessionFile,
      sessionId: transcript.sessionId,
      messages: transcript.messages
    });
    setPiSessionFile(conversation.sessionFile);
    return { cancelled: false, text, conversation };
  });
}
