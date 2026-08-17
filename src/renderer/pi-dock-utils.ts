import { piToolSummary, printableToolValue, type PiMessageSegment } from '../shared/pi-message.ts';
import type { PiChatMessage } from '../main/pi-conversation.ts';
import { extractVisiblePrompt } from '../shared/pi-visible-prompt.ts';
import { isJobEventEnvelope } from '../shared/job-event-envelope.ts';

/** 自动工单终态（JOB_EVENT）投影标记：永不当作用户气泡，也不作为 fork/retry 锚点。 */
export function isPiSystemEvent(message: PiChatMessage): boolean {
  return message.kind === 'system_event';
}

/** 应用代写编排（Owner 触发 + 应用组装 + 确实派发到 Pi）投影标记：永不当作用户气泡，也不作为 fork/retry 锚点。 */
export function isPiOrchestration(message: PiChatMessage): boolean {
  return message.kind === 'orchestration';
}

export type PiNativeQueuePresentation = {
  kind: 'steer' | 'follow' | 'system_event';
  label: '即将处理' | '下一轮' | 'WMB 系统通知';
  text: string;
};

/** 保留 canonical 信封到呈现边界，精确区分自动 JOB_EVENT 与真人队列消息。 */
export function presentPiNativeQueueMessage(raw: string, delivery: 'steer' | 'follow'): PiNativeQueuePresentation {
  const text = extractVisiblePrompt(raw);
  if (isJobEventEnvelope(raw)) return { kind: 'system_event', label: 'WMB 系统通知', text };
  return { kind: delivery, label: delivery === 'steer' ? '即将处理' : '下一轮', text };
}

export type PiJobEventPayload = {
  action?: string;
  jobId?: string;
  roleId?: string;
  status?: string;
  waitReason?: string | null;
};

const JOB_ROLE_LABELS: Record<string, string> = {
  reporter: '记者',
  planner: '策划',
  writer: '写手',
  librarian: '资料员'
};

/** 把主进程 job_event 变成即时、简短的本地系统通知；不混入 Pi 的原生 tool stream。 */
export function piJobEventNotice(event: PiJobEventPayload, createdAt: string): PiChatMessage | null {
  const action = String(event.action || '');
  const jobId = String(event.jobId || '').trim();
  if (!jobId) return null;
  const role = JOB_ROLE_LABELS[String(event.roleId || '')] || '员工';
  const shortId = jobId.slice(0, 8);
  const stateText = action === 'job.started'
    ? '已派发，正在执行。'
    : action === 'job.waiting_resource'
      ? `已排队，等待资源${event.waitReason ? `（${event.waitReason}）` : ''}。`
      : action === 'job.finished'
        ? '已完成。'
        : action === 'job.partial'
          ? '部分完成。'
          : action === 'job.needs_user'
            ? '需要你介入，主管正在整理原因。'
            : action === 'job.failed'
              ? '执行失败，主管正在处理。'
              : action === 'job.cancelled'
                ? '已取消。'
                : null;
  if (!stateText) return null;
  return {
    role: 'user',
    kind: 'system_event',
    entryId: `runtime-job-${jobId}`,
    text: `${role}工单 ${shortId} ${stateText}`,
    createdAt
  };
}

export function upsertPiJobNotice(items: PiChatMessage[], notice: PiChatMessage): PiChatMessage[] {
  const index = items.findIndex((item) => item.entryId === notice.entryId);
  if (index < 0) return [...items, notice];
  const next = items.slice();
  next[index] = notice;
  return next;
}

function jobIdFromSystemEvent(message: PiChatMessage): string | null {
  if (!isPiSystemEvent(message)) return null;
  return /^jobId=([^\s]+)$/m.exec(message.text)?.[1] ?? null;
}

/** 终态 canonical JOB_EVENT 进入会话后，隐藏同工单的瞬态通知；否则按真实时间插入。 */
export function mergePiJobNotices(messages: PiChatMessage[], notices: PiChatMessage[]): PiChatMessage[] {
  if (!notices.length) return messages;
  const durableJobIds = new Set(messages.map(jobIdFromSystemEvent).filter((id): id is string => Boolean(id)));
  const visibleNotices = notices.filter((notice) => {
    const jobId = notice.entryId?.replace(/^runtime-job-/, '') ?? '';
    return !jobId || !durableJobIds.has(jobId);
  });
  if (!visibleNotices.length) return messages;
  return [...messages, ...visibleNotices]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const byTime = String(left.message.createdAt || '').localeCompare(String(right.message.createdAt || ''));
      return byTime || left.index - right.index;
    })
    .map(({ message }) => message);
}

/** 可作为 fork/retry 锚点的 canonical 人类消息（系统通知、应用代写编排与本地乐观气泡除外）。 */
export function piRetryable(message: PiChatMessage): boolean {
  return message.role === 'user' && !isPiSystemEvent(message) && !isPiOrchestration(message) && Boolean(message.entryId) && !message.entryId!.startsWith(PI_LOCAL_QUEUE_ENTRY_PREFIX);
}

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

export type PiTranscriptEvent = {
  type: string;
  text?: string;
  thinking?: string;
  error?: string;
  streamKey?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  isError?: boolean;
  scope?: 'dock' | 'task';
};

/** 将 dock 原生事件投影为只读实时 transcript；员工 task 事件不得混入主管对话。 */
export function applyPiTranscriptEvent(items: PiChatMessage[], event: PiTranscriptEvent): PiChatMessage[] {
  if (event.scope !== 'dock') return items;
  if (event.type === 'tool') return appendPiStream(items, streamingToolSegment(event.toolName, event.toolCallId, event.toolArgs));
  if (event.type === 'tool-result') return finishPiTool(items, event.toolCallId, event.toolResult, event.isError);
  if (event.type === 'thinking') {
    return appendPiStream(items, { kind: 'thinking', text: event.text ?? '', streamKey: event.streamKey }, { thinking: event.text ?? '' });
  }
  if (event.type === 'delta') {
    return appendPiStream(items, { kind: 'text', text: event.text ?? '', streamKey: event.streamKey }, { text: event.text ?? '' });
  }
  if (event.type !== 'stopped' && event.type !== 'failed' && event.type !== 'idle') return items;
  const next = items.slice();
  const last = next[next.length - 1];
  const fallback = event.type === 'failed' ? 'Pi 回复失败。' : event.type === 'stopped' ? '已停止生成。' : '';
  const text = event.error || event.text || last?.text || fallback;
  if (last?.role === 'assistant' && last.status === 'streaming') {
    next[next.length - 1] = {
      ...last,
      text,
      ...(event.thinking || last.thinking ? { thinking: event.thinking || last.thinking } : {}),
      status: event.type === 'failed' ? 'failed' : event.type === 'stopped' ? 'stopped' : undefined
    };
  } else if (event.type === 'failed') {
    next.push({ role: 'assistant', text, status: 'failed', createdAt: new Date().toISOString() });
  }
  return next;
}

/** 磁盘轮询不得覆盖尚未持久化的最后一条 streaming tool/text 消息。 */
export function mergePiConversationWithLive(disk: PiChatMessage[], current: PiChatMessage[] | null): PiChatMessage[] {
  const live = current?.[current.length - 1];
  if (live?.role !== 'assistant' || live.status !== 'streaming') return disk;
  const diskBase = disk[disk.length - 1]?.role === 'assistant' && disk[disk.length - 1]?.status === 'streaming'
    ? disk.slice(0, -1)
    : disk;
  return [...diskBase, live];
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

/** WMB-5204：忙时人工消息的 renderer 瞬态投影；正文必须进入主时间线，但绝不持久化。 */
export type PiLocalQueueItem = {
  localId: string;
  text: string;
  delivery: 'steer' | 'followUp';
  status: 'pending' | 'accepted' | 'failed';
  createdAt: string;
};

type PiNativeQueueSnapshot = {
  steering: string[];
  followUp: string[];
};

const PI_LOCAL_QUEUE_ENTRY_PREFIX = 'local-queue:';

export function piLocalQueueEntryId(localId: string): string {
  return `${PI_LOCAL_QUEUE_ENTRY_PREFIX}${localId}`;
}

/** 忙时人工提交立即创建：仅 trimmed 人类输入、投递方式与本地 UUID。 */
export function createPiLocalQueueItem(text: string, delivery: 'steer' | 'followUp' = 'steer'): PiLocalQueueItem {
  return {
    localId: crypto.randomUUID(),
    text: text.trim(),
    delivery,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
}

/**
 * native 队列确认只把本地人工气泡从 pending 原地升级为 accepted；
 * 不再删除正文。重复文本按 delivery + FIFO 一对一匹配，失败项与重放均保持幂等。
 */
export function reconcilePiLocalQueue(queue: PiNativeQueueSnapshot, locals: PiLocalQueueItem[]): PiLocalQueueItem[] {
  const visible = {
    steer: queue.steering.map((raw) => extractVisiblePrompt(raw)),
    followUp: queue.followUp.map((raw) => extractVisiblePrompt(raw))
  };
  const consumed = { steer: new Set<number>(), followUp: new Set<number>() };
  return locals.map((local) => {
    if (local.status !== 'pending') return local;
    const texts = visible[local.delivery];
    const used = consumed[local.delivery];
    const index = texts.findIndex((text, candidate) => !used.has(candidate) && text === local.text);
    if (index < 0) return local;
    used.add(index);
    return { ...local, status: 'accepted' };
  });
}

/** 已由本地人工气泡承载的 native 队列正文不再重复显示；外部消息与系统通知仍留在运输队列。 */
export function filterPiNativeQueueMessages(natives: string[], delivery: 'steer' | 'followUp', locals: PiLocalQueueItem[]): string[] {
  const candidates = locals.filter((item) => item.status !== 'failed' && item.delivery === delivery);
  const consumed = new Set<number>();
  return natives.filter((raw) => {
    if (isJobEventEnvelope(raw)) return true;
    const text = extractVisiblePrompt(raw);
    const index = candidates.findIndex((item, candidate) => !consumed.has(candidate) && item.text === text);
    if (index < 0) return true;
    consumed.add(index);
    return false;
  });
}

function canonicalUserMatchesLocal(message: PiChatMessage, local: PiLocalQueueItem): boolean {
  if (message.role !== 'user' || isPiSystemEvent(message) || isPiOrchestration(message) || message.text !== local.text || !message.entryId) return false;
  const canonicalTime = Date.parse(message.createdAt ?? '');
  const localTime = Date.parse(local.createdAt);
  return Number.isFinite(canonicalTime) && Number.isFinite(localTime) && canonicalTime >= localTime;
}

function unclaimedPiLocalQueueItems(messages: PiChatMessage[], locals: PiLocalQueueItem[]): PiLocalQueueItem[] {
  const claimedCanonical = new Set<number>();
  return locals.filter((local) => {
    const canonicalIndex = messages.findIndex((message, index) => !claimedCanonical.has(index) && canonicalUserMatchesLocal(message, local));
    if (canonicalIndex < 0) return true;
    claimedCanonical.add(canonicalIndex);
    return false;
  });
}

/** canonical 用户条目到达后才回收对应本地项；idle/failed 事件本身不得制造可见性断档。 */
export function prunePiLocalQueue(messages: PiChatMessage[], locals: PiLocalQueueItem[]): PiLocalQueueItem[] {
  if (!locals.length) return locals;
  const remaining = unclaimedPiLocalQueueItems(messages, locals);
  return remaining.length === locals.length ? locals : remaining;
}

/**
 * 主时间线投影：canonical 用户条目按文本、提交时间与 FIFO 接管对应本地气泡；
 * 尚未接管的本地项以稳定 entryId 插入真实时间位置，因此 native 消费期间也不会消失。
 */
export function mergePiLocalQueueMessages(messages: PiChatMessage[], locals: PiLocalQueueItem[]): PiChatMessage[] {
  const remaining = unclaimedPiLocalQueueItems(messages, locals);
  if (!remaining.length) return messages;
  const optimistic = remaining.map((local): PiChatMessage => ({ role: 'user', text: local.text, entryId: piLocalQueueEntryId(local.localId), createdAt: local.createdAt }));
  const result = messages.slice();
  for (const message of optimistic) {
    const insertAt = result.findIndex((candidate) => Boolean(candidate.createdAt) && candidate.createdAt! > message.createdAt!);
    if (insertAt < 0) result.push(message);
    else result.splice(insertAt, 0, message);
  }
  return result;
}

// ============================================================
// WMB-5214：Pi 知识使用与沉淀面板的纯投影辅助（只读；不新增任何写路径）
// ============================================================

/**
 * 从 assistant 回合向前回溯最近一条真实用户问题（系统通知/编排行/本地乐观气泡跳过）。
 * 返回与 writeback 服务同源的 `message.text` 原样值（未 trim，由 shared 派生统一 trim），
 * 找不到合格问题返回 null —— 面板据此决定是否派生 requestId。
 */
export function piKnowledgeQuestionBefore(messages: readonly PiChatMessage[], assistantIndex: number): string | null {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user' || isPiSystemEvent(message) || isPiOrchestration(message)) continue;
    if (message.entryId?.startsWith(PI_LOCAL_QUEUE_ENTRY_PREFIX)) continue;
    if (typeof message.text === 'string' && message.text.trim()) return message.text;
  }
  return null;
}

const QUERY_WRITE_BACK_DECISION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  created: '已沉淀：本次形成新知识',
  updated: '已沉淀：本次更新既有知识',
  skipped_repetition: '未写回：纯复述既有知识',
  skipped_low_value: '未写回：内容价值不足',
  skipped_transient: '未写回：一次性/低复用内容',
  no_write_back: '未写回：本次无可沉淀增量'
});

/** 写回决策的可读文案（只读映射，不创建第二套身份）。 */
export function piKnowledgeWriteBackDecisionLabel(decision: string | null | undefined): string {
  return QUERY_WRITE_BACK_DECISION_LABELS[String(decision ?? '')] ?? String(decision ?? '未写回');
}

const KNOWLEDGE_RISK_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  disputed: '有争议',
  contradicted: '被反驳',
  inference: '推断',
  stale: '已过期',
  unverified: '未验证'
});

/** 风险种类的可读文案（只读映射）。 */
export function piKnowledgeRiskKindLabel(kind: string | null | undefined): string {
  return KNOWLEDGE_RISK_KIND_LABELS[String(kind ?? '')] ?? String(kind ?? '风险');
}

/** 稳定短 id 展示：保留前缀 + 尾部，供回执/变更入口展示；不暴露任何内部 JSON。 */
export function piKnowledgeShortId(id: string | null | undefined): string {
  const value = String(id ?? '');
  if (!value) return '';
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}
