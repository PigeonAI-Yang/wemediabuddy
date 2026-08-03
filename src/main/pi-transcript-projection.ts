import type { PiChatMessage } from './pi-conversation.ts';
import { piToolSummary, printableToolValue, type PiMessageSegment } from '../shared/pi-message.ts';

type PiEntry = { type?: unknown; id?: unknown; timestamp?: unknown; message?: unknown };

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part && typeof part === 'object'
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
    ? String((part as { text: string }).text) : '').join('');
}

export function visiblePiPrompt(text: string): string {
  const marker = '[USER_MESSAGE]\n';
  const index = text.indexOf(marker);
  return (index >= 0 ? text.slice(index + marker.length) : text).trim();
}

export function messagesFromPiEntries(entries: unknown[]): PiChatMessage[] {
  const messages: PiChatMessage[] = [];
  const tools = new Map<string, Extract<PiMessageSegment, { kind: 'tool' }>>();
  let assistant: PiChatMessage | null = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as PiEntry;
    if (item.type !== 'message' || !item.message || typeof item.message !== 'object') continue;
    const role = (item.message as { role?: unknown }).role;
    if (role === 'toolResult') {
      const result = item.message as { toolCallId?: unknown; content?: unknown; details?: unknown; isError?: unknown };
      const segment = typeof result.toolCallId === 'string' ? tools.get(result.toolCallId) : undefined;
      if (segment) {
        segment.output = printableToolValue(result.details ?? result.content);
        if (result.isError === true) segment.isError = true;
      }
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(item.message);
    if (role === 'user') {
      assistant = null;
      if (text.trim()) messages.push({ role, text: visiblePiPrompt(text), ...(typeof item.id === 'string' ? { entryId: item.id } : {}), ...(typeof item.timestamp === 'string' ? { createdAt: item.timestamp } : {}) });
      continue;
    }
    const content = (item.message as { content?: unknown }).content;
    const segments: PiMessageSegment[] = [];
    if (Array.isArray(content)) for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const value = part as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (value.type === 'thinking' && typeof value.thinking === 'string' && value.thinking.trim()) segments.push({ kind: 'thinking', text: value.thinking });
      if (value.type === 'text' && typeof value.text === 'string' && value.text.trim()) segments.push({ kind: 'text', text: value.text });
      if (value.type === 'toolCall' && typeof value.name === 'string') {
        const tool: Extract<PiMessageSegment, { kind: 'tool' }> = { kind: 'tool', toolName: value.name, text: piToolSummary(value.name, value.arguments), ...(typeof value.id === 'string' ? { toolCallId: value.id } : {}), ...(value.arguments === undefined ? {} : { input: printableToolValue(value.arguments) }) };
        segments.push(tool);
        if (tool.toolCallId) tools.set(tool.toolCallId, tool);
      }
    }
    if (!segments.length) continue;
    if (!assistant) {
      assistant = { role: 'assistant', text: '', segments: [], ...(typeof item.id === 'string' ? { entryId: item.id } : {}), ...(typeof item.timestamp === 'string' ? { createdAt: item.timestamp } : {}) };
      messages.push(assistant);
    }
    assistant.segments!.push(...segments);
    assistant.text += segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('');
    const thinking = segments.filter((segment) => segment.kind === 'thinking').map((segment) => segment.text).join('\n\n');
    if (thinking) assistant.thinking = [assistant.thinking, thinking].filter(Boolean).join('\n\n');
  }
  return messages;
}
