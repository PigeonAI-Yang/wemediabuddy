import electron from 'electron';
import type { DataRoot } from './data-root.ts';
import { createForkedPiConversation, readPiConversation, writePiConversation, type PiConversationSnapshot } from './pi-conversation.ts';
import { readPiTranscript, syncPiConversation, visiblePiPrompt } from './pi-persistence.ts';
import type { PiRpcSupervisor } from './pi-runtime.ts';
import { broadcastPiEvent } from './app-window.ts';
import { routePiSkillPrompt } from './pi-skill-routing.ts';
import { readPiCommands } from './pi-commands.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { ensurePageAuthority, type PageAuthorityResult } from './pi-page-authority.ts';
import { pageAuthoritySpec, isPageAuthorityView } from '../shared/page-authority.ts';
const { ipcMain } = electron;

type Dependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  ensurePi: (dataRoot: DataRoot, options?: { skipProfileIds?: Iterable<string> }) => Promise<PiRpcSupervisor>;
  getPi: () => PiRpcSupervisor | null;
  getLastPiProfileId?: () => string | null;
  getPiSessionFile: () => string | null;
  setPiSessionFile: (sessionFile: string) => void;
  getActiveRuntime?: () => ActiveWorkspaceRuntime | null;
};

let openingTurn: Promise<void> | null = null;
let finishOpeningTurn: (() => void) | null = null;
let stopAfterOpening = false;

function openTurnGate(): void {
  openingTurn = new Promise<void>((resolve) => { finishOpeningTurn = resolve; });
}

function closeTurnGate(): void {
  finishOpeningTurn?.();
  finishOpeningTurn = null;
  openingTurn = null;
}

let lastAuthorityStatus: PageAuthorityResult | null = null;


type DockPromptDeps = Dependencies;
let dockPromptDeps: DockPromptDeps | null = null;

/** 主管真回合：与手动 chat 同一 ensurePi + promptUntilSettled + onPiEvent 通道。 */
export async function runDockManagerPrompt(input: {
  message: string;
  page?: string;
  pageLabel?: string;
  objectType?: string;
  objectId?: string;
}): Promise<{ text: string; stopped: boolean; conversation: PiConversationSnapshot | null }> {
  const deps = dockPromptDeps;
  if (!deps) throw new Error('Pi dock 尚未注册。');
  const dataRoot = await deps.loadSelectedDataRoot();
  if (!dataRoot) throw new Error('请先选择数据根目录。');

  const page = input.page || 'agents';
  const pageLabel = input.pageLabel || '班组';
  const objectType = input.objectType || 'manager_task';
  const objectId = input.objectId || '';
  const wrapped =
    `[WMB_CONTEXT]\npage=${page}\npageLabel=${pageLabel}\nobjectType=${objectType}\nobjectId=${objectId}\n` +
    `contextRule=你是桌助。自动编排是你的工具：scan/judge/full 用 wmb_run_daily_stage；采完要续策划用 wmb_continue_after_scan；也可 wmb_spawn_job 派单项。先 readiness，再按你的判断选用工具；用 list_jobs/roster 监工并汇报。\n` +
    `[USER_MESSAGE]\n${input.message}`;

  // 若已有真 Pi 回合，插入 steer，不另开冲突回合
  const existing = deps.getPi();
  if (existing?.isActive) {
    const active = deps.getActiveRuntime?.() ?? null;
    const authorize = async (message: string): Promise<string> => {
      if (!active) return message;
      const result = await ensurePageAuthority(active, dataRoot, deps.ensurePi, message);
      lastAuthorityStatus = result.status;
      return result.message;
    };
    const routed = routePiSkillPrompt(await authorize(wrapped));
    await existing.steer(routed);
    broadcastPiEvent({ type: 'queued', delivery: 'steer', scope: 'dock' });
    return { text: '', stopped: false, conversation: null };
  }

  openTurnGate();
  broadcastPiEvent({ type: 'starting', scope: 'dock' });
  let runtime: PiRpcSupervisor | null = null;
  let conversation: PiConversationSnapshot | null = null;
  try {
    // 先拉起 Pi，再写入 streaming 气泡，避免 ensurePi 读会话时误 recover 中断。
    runtime = await deps.ensurePi(dataRoot);
    const current = await readPiConversation(dataRoot.path);
    const createdAt = new Date().toISOString();
    const title = current.title === '新会话' || current.title === 'Pi' ? '主管 · 今日情报' : current.title;
    conversation = await writePiConversation(dataRoot.path, {
      id: current.id,
      title,
      sessionFile: current.sessionFile,
      sessionId: current.sessionId,
      messages: [
        ...current.messages,
        { role: 'user', text: visiblePiPrompt(wrapped), createdAt },
        { role: 'assistant', text: '', status: 'streaming', createdAt }
      ],
      createdAt: current.createdAt,
      makeActive: true
    });
    const active = deps.getActiveRuntime?.() ?? null;
    const authorize = async (message: string): Promise<string> => {
      if (!active) return message;
      const result = await ensurePageAuthority(active, dataRoot, deps.ensurePi, message);
      lastAuthorityStatus = result.status;
      return result.message;
    };
    const result = await runtime.promptUntilSettled(routePiSkillPrompt(await authorize(wrapped)), {
      onStreaming: () => {
        closeTurnGate();
        if (stopAfterOpening) {
          stopAfterOpening = false;
          void runtime?.abortTurn().catch(() => {});
        }
      }
    });
    const synced = await syncPiConversation(dataRoot.path, conversation, runtime, result.stopped ? 'stopped' : undefined, result.thinking);
    if (synced) deps.setPiSessionFile(synced.sessionFile);
    broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: result.text, thinking: result.thinking, scope: 'dock' });
    return { text: result.text, stopped: result.stopped, conversation: synced };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (conversation) {
      const messages = conversation.messages.slice();
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.status === 'streaming') {
        messages[messages.length - 1] = { ...last, text: message, status: 'failed', segments: [{ kind: 'text', text: message }] };
      }
      await writePiConversation(dataRoot.path, {
        id: conversation.id,
        title: conversation.title,
        sessionFile: conversation.sessionFile,
        sessionId: conversation.sessionId,
        messages,
        createdAt: conversation.createdAt,
        makeActive: true
      }).catch(() => {});
    }
    if (!runtime || deps.getPi() === runtime) {
      broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
    }
    throw error;
  } finally {
    closeTurnGate();
    stopAfterOpening = false;
  }
}

export function registerPiDockIpc({ loadSelectedDataRoot, ensurePi, getPi, getPiSessionFile, setPiSessionFile, getActiveRuntime }: Dependencies): void {
  dockPromptDeps = { loadSelectedDataRoot, ensurePi, getPi, getPiSessionFile, setPiSessionFile, getActiveRuntime };
  ipcMain.handle('pi:commands', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    return readPiCommands(await (await ensurePi(dataRoot)).getCommands());
  });

  ipcMain.handle('pi:chat', async (_event, input: string | { message: string; delivery?: 'steer' | 'followUp' }) => {
    const raw = (typeof input === 'string' ? input : input.message).trim();
    if (!raw) throw new Error('请输入内容。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const pendingOpening = openingTurn;
    const continuesTurn = getPi()?.isActive === true || pendingOpening !== null;
    const authorize = async (message: string): Promise<string> => {
      const active = getActiveRuntime?.() ?? null;
      if (!active) {
        lastAuthorityStatus = { ok: false, reason: 'runtime_unavailable' };
        return message;
      }
      const result = await ensurePageAuthority(active, dataRoot, ensurePi, message);
      lastAuthorityStatus = result.status;
      return result.message;
    };
    if (continuesTurn) {
      await pendingOpening;
      const runtime = await ensurePi(dataRoot);
      if (!runtime.isActive) throw new Error('Pi 未接受当前对话。');
      const delivery = typeof input === 'string' ? 'steer' : (input.delivery ?? 'steer');
      const routed = routePiSkillPrompt(await authorize(raw));
      await (delivery === 'followUp' ? runtime.followUp(routed) : runtime.steer(routed));
      broadcastPiEvent({ type: 'queued', delivery, scope: 'dock' });
      return { text: '', stopped: false, queued: true, conversation: null };
    }
    openTurnGate();
    broadcastPiEvent({ type: 'starting', scope: 'dock' });
    let runtime: PiRpcSupervisor | null = null;
    let conversation: PiConversationSnapshot | null = null;
    try {
      const current = await readPiConversation(dataRoot.path);
      const createdAt = new Date().toISOString();
      conversation = await writePiConversation(dataRoot.path, {
        id: current.id,
        title: current.title,
        sessionFile: current.sessionFile,
        sessionId: current.sessionId,
        messages: [...current.messages, { role: 'user', text: visiblePiPrompt(raw), createdAt }, { role: 'assistant', text: '', status: 'streaming', createdAt }],
        createdAt: current.createdAt,
        makeActive: true
      });
      runtime = await ensurePi(dataRoot);
      const result = await runtime.promptUntilSettled(routePiSkillPrompt(await authorize(raw)), {
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
      if (conversation) {
        const messages = conversation.messages.slice();
        const last = messages.at(-1);
        if (last?.role === 'assistant' && last.status === 'streaming') messages[messages.length - 1] = { ...last, text: message, status: 'failed', segments: [{ kind: 'text', text: message }] };
        await writePiConversation(dataRoot.path, { id: conversation.id, title: conversation.title, sessionFile: conversation.sessionFile, sessionId: conversation.sessionId, messages, createdAt: conversation.createdAt, makeActive: true }).catch(() => {});
      }
      if (!runtime || getPi() === runtime) {
        broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
      }
      throw error;
    } finally {
      closeTurnGate();
      stopAfterOpening = false;
    }
  });

  ipcMain.handle('pi:authority-status', async () => {
    const page = lastAuthorityStatus && 'page' in lastAuthorityStatus ? lastAuthorityStatus.page : null;
    const spec = typeof page === 'string' && isPageAuthorityView(page) ? pageAuthoritySpec(page) : null;
    return {
      status: lastAuthorityStatus,
      chipLabel: lastAuthorityStatus && 'chipLabel' in lastAuthorityStatus
        ? lastAuthorityStatus.chipLabel
        : (spec?.chipLabel ?? '—'),
      chipTone: lastAuthorityStatus && lastAuthorityStatus.ok && lastAuthorityStatus.mode === 'granted'
        ? 'write'
        : (spec?.chipTone ?? 'readonly')
    };
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
