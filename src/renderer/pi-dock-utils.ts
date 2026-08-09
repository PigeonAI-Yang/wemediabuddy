import { piToolSummary, printableToolValue, type PiMessageSegment } from '../shared/pi-message.ts';
import type { PiChatMessage } from '../main/pi-conversation.ts';

export function piToolActivity(toolName?: string): string {
  if (!toolName) return '正在处理';
  if (['read', 'grep', 'find', 'ls'].includes(toolName)) return '正在查阅资料';
  if (toolName === 'bash') return '正在执行任务';
  if (toolName === 'edit' || toolName === 'write') return '正在整理内容';
  if (toolName.includes('search')) return '正在搜索资料';
  if (toolName.includes('source') || toolName.includes('workbench')) return '正在读取工作台';
  if (toolName.includes('save')) return '正在保存成果';
  return '正在使用工具';
}

export function piThinkingSummary(text: string): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `思考 · ${compact.length > 64 ? `${compact.slice(0, 64)}…` : compact || '整理中'}`;
}

export function updatePiMessageSegment(message: PiChatMessage, segment: PiMessageSegment): PiChatMessage {
  const segments = [...(message.segments ?? [])];
  const last = segments[segments.length - 1];
  const streamIndex = segment.kind !== 'tool' && segment.streamKey
    ? segments.findIndex((item) => item.kind !== 'tool' && item.streamKey === segment.streamKey)
    : -1;
  if (streamIndex >= 0) segments[streamIndex] = segment;
  else if (segment.kind !== 'tool' && last?.kind === segment.kind && segment.text.startsWith(last.text)) segments[segments.length - 1] = segment;
  else if (segment.kind === 'tool' && last?.kind === 'tool' && segment.toolCallId && last.toolCallId === segment.toolCallId) segments[segments.length - 1] = { ...last, ...segment };
  else segments.push(segment);
  return { ...message, segments };
}

export function streamingToolSegment(toolName?: string, toolCallId?: string, args?: unknown): PiMessageSegment {
  const name = toolName || 'tool';
  return {
    kind: 'tool', toolName: name, text: piToolSummary(name, args),
    ...(toolCallId ? { toolCallId } : {}),
    ...(args === undefined ? {} : { input: printableToolValue(args) })
  };
}

export function appendPiStream(items: PiChatMessage[], segment: PiMessageSegment, patch: Partial<PiChatMessage> = {}): PiChatMessage[] {
  const next = items.slice();
  const last = next[next.length - 1];
  const base = last?.role === 'assistant' && last.status === 'streaming'
    ? last
    : { role: 'assistant' as const, text: '', status: 'streaming' as const, createdAt: new Date().toISOString() };
  const updated = updatePiMessageSegment(base, segment);
  if (last === base) next[next.length - 1] = { ...updated, ...patch };
  else next.push({ ...updated, ...patch });
  return next;
}

export function finishPiTool(items: PiChatMessage[], toolCallId: string | undefined, output: unknown, isError?: boolean): PiChatMessage[] {
  if (!toolCallId) return items;
  const next = items.slice();
  const last = next[next.length - 1];
  if (last?.role !== 'assistant' || !last.segments?.length) return items;
  const segments = last.segments.map((segment) => segment.kind === 'tool' && segment.toolCallId === toolCallId
    ? { ...segment, output: printableToolValue(output), ...(isError ? { isError: true } : {}) }
    : segment);
  next[next.length - 1] = { ...last, segments };
  return next;
}

export function piMessageSegments(message: PiChatMessage): PiMessageSegment[] {
  if (message.segments?.length) return message.segments;
  return [
    ...(message.thinking?.trim() ? [{ kind: 'thinking' as const, text: message.thinking }] : []),
    ...(message.text?.trim() ? [{ kind: 'text' as const, text: message.text }] : [])
  ];
}

export function coalescePiMessages(messages: PiChatMessage[]): PiChatMessage[] {
  const result: PiChatMessage[] = [];
  for (const message of messages) {
    const last = result[result.length - 1];
    if (message.role !== 'assistant' || last?.role !== 'assistant') {
      result.push(message);
      continue;
    }
    result[result.length - 1] = {
      ...last,
      text: `${last.text}${message.text}`,
      thinking: [last.thinking, message.thinking].filter(Boolean).join('\n\n') || undefined,
      segments: [...piMessageSegments(last), ...piMessageSegments(message)],
      status: message.status ?? last.status
    };
  }
  return result;
}

export function piErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || 'Pi 回复失败。';
}

export function isPiConversationNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight - scrollTop <= 48;
}

export function nextPiConversationFollowing(current: boolean, userScrollIntent: boolean, nearBottom: boolean): boolean {
  return nearBottom || (!userScrollIntent && current);
}
