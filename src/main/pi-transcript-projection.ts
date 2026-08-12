import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PiChatMessage } from './pi-conversation.ts';
import { isJobEventEnvelope } from '../shared/job-event-envelope.ts';
import { parseOrchestrationEnvelope } from '../shared/orchestration-envelope.ts';
import { extractVisiblePrompt } from '../shared/pi-visible-prompt.ts';
import { piToolSummary, printableToolValue, type PiMessageSegment } from '../shared/pi-message.ts';
import { jobSessionFileRef, readCrewInstanceProjection, type CrewProjectionSource } from './crew-instance-projection.ts';

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
      if (text.trim()) {
        const message: PiChatMessage = {
          role,
          text: extractVisiblePrompt(text),
          ...(typeof item.id === 'string' ? { entryId: item.id } : {}),
          ...(typeof item.timestamp === 'string' ? { createdAt: item.timestamp } : {})
        };
        const orchestration = parseOrchestrationEnvelope(text);
        if (orchestration) {
          message.kind = 'orchestration';
          message.orchestration = orchestration;
          message.text = orchestration.safe.title;
        } else if (isJobEventEnvelope(text)) {
          message.kind = 'system_event';
        }
        messages.push(message);
      }
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

/** daily 会话 id 契约（WMB-5195 §1）：`daily-<date>-<taskId>`；字符集排除分隔符/点号，防注入。 */
const DAILY_SESSION_ID_PATTERN = /^daily-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+$/;

/**
 * WMB-5195：工单 transcript 会话引用解析（fail-closed）。
 * 只接受两种契约内引用：daily `piSessionId` 必须形如 `daily-<date>-<taskId>`（文件固定落在
 * `pi-agent/sessions/<piSessionId>.jsonl`）；employee 会话只接受 `agent/sessions/job-<jobId>.jsonl`
 * 约定（持久面相对 ref 或与 data root 一致的运行句柄绝对路径）。解析结果必须仍落在 data root 内，
 * 任何不匹配一律返回 null（不向 renderer 暴露路径细节）。
 */
export function resolveTaskSessionFile(
  dataRootPath: string,
  jobId: string,
  sessionFile: string | null,
  piSessionId: string | null
): string | null {
  if (typeof jobId !== 'string' || !jobId) return null;
  const root = path.resolve(dataRootPath);
  let file: string;
  if (typeof piSessionId === 'string' && DAILY_SESSION_ID_PATTERN.test(piSessionId)) {
    file = path.resolve(root, 'pi-agent', 'sessions', `${piSessionId}.jsonl`);
  } else if (typeof sessionFile === 'string' && sessionFile) {
    const expectedRef = jobSessionFileRef(jobId);
    const normalized = sessionFile.split(/[\\/]+/).join('/');
    const absoluteExpected = path.join(root, expectedRef).split(/[\\/]+/).join('/');
    if (normalized !== expectedRef && normalized !== absoluteExpected) return null;
    file = path.resolve(root, expectedRef);
  } else {
    return null;
  }
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return file;
}

/** WMB-5195：读取并投影工单 transcript 文件；文件缺失/损坏/解析失败一律返回 null。 */
export async function readTaskTranscriptFile(file: string): Promise<PiChatMessage[] | null> {
  try {
    const text = await readFile(file, 'utf8');
    const entries = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
    return messagesFromPiEntries(entries);
  } catch {
    return null;
  }
}

/**
 * WMB-5195：只读工单 transcript 主路径。仅凭 jobId 在 authoritative crew projection 中反查实例
 * （active 优先，其次 history），再按契约解析会话文件并投影真实 Pi 条目；job 不存在、路径不匹配、
 * 文件缺失或解析失败均返回 null。无任何写操作、不新增 schema/权限。
 */
export async function readTaskTranscriptForJob(
  database: DatabaseSync,
  rootPath: string,
  jobId: string,
  spawner: Pick<CrewProjectionSource, 'pool' | 'getHandle'> | null
): Promise<PiChatMessage[] | null> {
  if (typeof jobId !== 'string' || !jobId.trim()) return null;
  const getHandle = spawner?.getHandle;
  const projection = readCrewInstanceProjection({
    database,
    pool: spawner?.pool ?? null,
    getHandle: getHandle ? (candidateJobId) => getHandle(candidateJobId) : null
  });
  const instance = projection.active.find((item) => item.jobId === jobId)
    ?? projection.history.find((item) => item.jobId === jobId)
    ?? null;
  if (!instance) return null;
  const file = resolveTaskSessionFile(rootPath, jobId, instance.sessionFile, instance.piSessionId);
  if (!file) return null;
  return readTaskTranscriptFile(file);
}
