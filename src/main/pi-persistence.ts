import {
  readPiConversation,
  writePiConversation,
  type PiChatMessage,
  type PiConversationSnapshot
} from './pi-conversation';
import type { PiRpcSupervisor } from './pi-runtime';

type PiEntry = {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
};

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const item = part as { type?: unknown; text?: unknown };
    return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).join('');
}

function messageThinking(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const item = part as { type?: unknown; thinking?: unknown };
    return item.type === 'thinking' && typeof item.thinking === 'string' ? item.thinking : '';
  }).filter(Boolean).join('\n\n');
}

export function visiblePiPrompt(text: string): string {
  const marker = '[USER_MESSAGE]\n';
  const index = text.indexOf(marker);
  return (index >= 0 ? text.slice(index + marker.length) : text).trim();
}

function messagesFromEntries(entries: unknown[]): PiChatMessage[] {
  return entries.flatMap((entry): PiChatMessage[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as PiEntry;
    if (item.type !== 'message' || !item.message || typeof item.message !== 'object') return [];
    const role = (item.message as { role?: unknown }).role;
    if (role !== 'user' && role !== 'assistant') return [];
    const text = messageText(item.message);
    const thinking = role === 'assistant' ? messageThinking(item.message) : '';
    if (!text.trim() && !thinking.trim()) return [];
    return [{
      role,
      text: role === 'user' ? visiblePiPrompt(text) : text,
      ...(thinking.trim() ? { thinking } : {}),
      ...(typeof item.id === 'string' ? { entryId: item.id } : {}),
      ...(typeof item.timestamp === 'string' ? { createdAt: item.timestamp } : {})
    }];
  });
}

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
    messages: messagesFromEntries(entries),
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
