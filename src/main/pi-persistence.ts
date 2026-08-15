import {
  readPiConversation,
  writePiConversation,
  type PiChatMessage,
  type PiConversationSnapshot
} from './pi-conversation.ts';
import type { PiRpcSupervisor } from './pi-runtime.ts';
export { messagesFromPiEntries } from './pi-transcript-projection.ts';
import { messagesFromPiEntries } from './pi-transcript-projection.ts';
import { reconcileOrchestrationRows } from './pi-orchestration-store.ts';

function stringStateField(data: unknown, field: 'sessionId' | 'sessionFile'): string | null {
  if (!data || typeof data !== 'object') return null;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' && value ? value : null;
}

export type PiTranscript = {
  messages: PiChatMessage[];
  sessionId: string | null;
  sessionFile: string | null;
};

export async function readPiTranscript(supervisor: PiRpcSupervisor): Promise<PiTranscript> {
  const [entriesResult, stateResult] = await Promise.all([
    supervisor.getEntries(),
    supervisor.getState()
  ]);
  const entriesData = entriesResult.data;
  const entries = entriesData && typeof entriesData === 'object'
    ? (entriesData as { entries?: unknown }).entries
    : undefined;
  if (!Array.isArray(entries)) throw new Error('Pi RPC 未返回会话条目。');
  return {
    messages: messagesFromPiEntries(entries),
    sessionId: stringStateField(stateResult.data, 'sessionId'),
    sessionFile: stringStateField(stateResult.data, 'sessionFile')
  };
}

type PiConversationSettlement = {
  status?: 'stopped';
  thinking?: string;
  text?: string;
};

function settleLatestAssistant(messages: PiChatMessage[], settlement: PiConversationSettlement): PiChatMessage[] {
  const finalText = settlement.text?.trim() ? settlement.text : '';
  const finalThinking = settlement.thinking?.trim() ? settlement.thinking.trim() : '';
  if (!finalText && !finalThinking && !settlement.status) return messages;

  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (lastAssistantIndex < 0 && messages[index]?.role === 'assistant') lastAssistantIndex = index;
    if (messages[index]?.role === 'user') { lastUserIndex = index; break; }
  }
  const assistantIndex = lastAssistantIndex > lastUserIndex ? lastAssistantIndex : -1;
  const current: PiChatMessage = assistantIndex >= 0
    ? messages[assistantIndex]!
    : { role: 'assistant', text: '' };
  const thinking = current.thinking?.trim() ? current.thinking : finalThinking;
  let segments = current.segments?.map((segment) => ({ ...segment })) ?? [];
  if (!segments.length) {
    if (thinking) segments.push({ kind: 'thinking', text: thinking });
    if (current.text.trim()) segments.push({ kind: 'text', text: current.text });
  } else if (thinking && !segments.some((segment) => segment.kind === 'thinking')) {
    segments.push({ kind: 'thinking', text: thinking });
  }
  if (finalText) {
    const renderedText = segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('');
    // settlement 文本权威：围栏剥离/注解追加/续写收尾都会给出最终可见文本；
    // 只要与当前流式文本不一致，就把文本段整体替换为 finalText（保留 thinking 段），
    // 绝不把最终文本追加到原始流式文本之后（否则协议围栏会泄漏到用户可见正文）。
    if (renderedText !== finalText) {
      segments = [
        ...segments.filter((segment) => segment.kind !== 'text').map((segment) => ({ ...segment })),
        { kind: 'text', text: finalText }
      ];
    }
  }
  const text = segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('') || finalText || current.text;
  const settled: PiChatMessage = {
    ...current,
    text,
    ...(thinking ? { thinking } : {}),
    ...(segments.length ? { segments } : {}),
    status: settlement.status
  };
  if (assistantIndex < 0) return [...messages, settled];
  const next = messages.slice();
  next[assistantIndex] = settled;
  return next;
}

export async function syncPiConversation(
  dataRootPath: string,
  conversation: PiConversationSnapshot,
  supervisor: PiRpcSupervisor,
  settlement: PiConversationSettlement = {}
): Promise<PiConversationSnapshot | null> {
  const transcript = await readPiTranscript(supervisor);
  const active = await readPiConversation(dataRootPath);
  if (active.id !== conversation.id) return null;
  // WMB-5178 §11：raw transcript 整体覆盖前先对账——queue-ack-only accepted 行（尚无 raw entry）必须保留，
  // 同 dispatchId raw 投影只对账不新增第二行；live 行状态权威。
  const messages = settleLatestAssistant(
    reconcileOrchestrationRows(conversation.messages, transcript.messages),
    settlement
  );
  return writePiConversation(dataRootPath, {
    id: conversation.id,
    title: conversation.title,
    sessionFile: transcript.sessionFile ?? conversation.sessionFile,
    sessionId: transcript.sessionId ?? conversation.sessionId,
    messages,
    createdAt: conversation.createdAt,
    makeActive: true
  });
}
