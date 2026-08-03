import {
  readPiConversation,
  writePiConversation,
  type PiChatMessage,
  type PiConversationSnapshot
} from './pi-conversation.ts';
import type { PiRpcSupervisor } from './pi-runtime';
export { messagesFromPiEntries, visiblePiPrompt } from './pi-transcript-projection.ts';
import { messagesFromPiEntries } from './pi-transcript-projection.ts';

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

export async function syncPiConversation(
  dataRootPath: string,
  conversation: PiConversationSnapshot,
  supervisor: PiRpcSupervisor,
  lastAssistantStatus?: 'stopped',
  lastAssistantThinking?: string
): Promise<PiConversationSnapshot | null> {
  const transcript = await readPiTranscript(supervisor);
  const active = await readPiConversation(dataRootPath);
  if (active.id !== conversation.id) return null;
  const messages = transcript.messages.slice();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue;
    const current = messages[index]!;
    messages[index] = {
      ...current,
      ...(lastAssistantStatus ? { status: lastAssistantStatus } : {}),
      ...(!current.thinking && lastAssistantThinking?.trim() ? { thinking: lastAssistantThinking.trim() } : {})
    };
    break;
  }
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
