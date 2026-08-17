import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';
import type { PiChatMessage } from '../main/pi-conversation';
import type { PiMessageSegment } from '../shared/pi-message';
import { applyPiTranscriptEvent, isPiOrchestration, isPiSystemEvent, mergePiConversationWithLive } from './pi-dock-utils';
import { AppModal } from './app-modal';
import {
  instanceTiming,
  sortInstancesForDisplay,
  instanceStatusWord,
  researchClaimLine,
  type CrewInstance,
  type CrewProjection,
  type EmployeeRole
} from './agents-instance-logic';
import { StatusDot, clock, progressPresentation, roleLabel, type RosterRow } from './agents-roster-parts';

/**
 * 员工明细来自 CrewInstance + task/messages/transcript；主管/遗留任务明细复用同一 roster 行 taskId、
 * getAgentTask 与当前 getPiConversation，并消费同一 onPiEvent 实时流。只读，不新增 schema。
 */
type AgentTaskView = {
  status: string | null;
  phase: string | null;
  intent: string | null;
  businessDate: string | null;
  progress: unknown;
  events: unknown;
  errorCode: string | null;
  errorMessage: string | null;
};

type TaskEventView = { at: string; message: string };
type JobMessageView = { id: string; jobId: string; from: string; body: string; at: string };
type TaskProgressView = { planned?: number; processed?: number; currentSource?: string; message?: string };


function normalizeTask(value: unknown): AgentTaskView | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;
  return {
    status: typeof t.status === 'string' ? t.status : null,
    phase: typeof t.phase === 'string' ? t.phase : null,
    intent: typeof t.intent === 'string' ? t.intent : null,
    businessDate: typeof t.businessDate === 'string' ? t.businessDate : null,
    progress: t.progress ?? null,
    events: t.events ?? null,
    errorCode: typeof t.errorCode === 'string' ? t.errorCode : null,
    errorMessage: typeof t.errorMessage === 'string' ? t.errorMessage : null
  };
}

function taskEvents(value: unknown): TaskEventView[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is TaskEventView =>
      Boolean(e && typeof e === 'object' && typeof (e as TaskEventView).at === 'string' && typeof (e as TaskEventView).message === 'string')
  );
}

function taskProgress(value: unknown): TaskProgressView | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const out: TaskProgressView = {};
  if (typeof p.planned === 'number') out.planned = p.planned;
  if (typeof p.processed === 'number') out.processed = p.processed;
  if (typeof p.currentSource === 'string') out.currentSource = p.currentSource;
  if (typeof p.message === 'string') out.message = p.message;
  return Object.keys(out).length ? out : null;
}

function ToolSegment({ segment }: { segment: Extract<PiMessageSegment, { kind: 'tool' }> }): JSX.Element {
  return (
    <details className={`pi-tool-line${segment.isError ? ' failed' : ' completed'}`}>
      <summary><span className="pi-tool-label">{segment.text}</span></summary>
      {segment.input || segment.output ? (
        <div className="pi-tool-detail">
          {segment.input ? <><b>输入</b><pre>{segment.input}</pre></> : null}
          {segment.output ? <><b>{segment.isError ? '错误' : '输出'}</b><pre>{segment.output}</pre></> : null}
        </div>
      ) : null}
    </details>
  );
}

function transcriptPreview(text: string): string {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '状态已更新';
  return first.length > 64 ? `${first.slice(0, 64)}…` : first;
}

function TranscriptMessage({ message }: { message: PiChatMessage }): JSX.Element {
  const text = message.text.trim();
  const segments = message.segments ?? [];
  if (isPiSystemEvent(message)) {
    return text ? (
      <details className="agents-detail-bubble agents-detail-entry system-event">
        <summary>
          <span className="agents-detail-entry-type">系统通知</span>
          <span className="agents-detail-entry-summary">{transcriptPreview(text)}</span>
        </summary>
        <p className="agents-detail-entry-body technical">{text}</p>
      </details>
    ) : <></>;
  }
  if (isPiOrchestration(message)) {
    const data = message.orchestration;
    const state = data?.state === 'failed' ? '安排失败' : data?.state === 'pending' ? '正在安排' : '已安排';
    const title = data?.safe.title.trim() || transcriptPreview(text);
    return (
      <article className={`agents-detail-bubble agents-detail-entry orchestration${data?.state === 'failed' ? ' failed' : ''}`}>
        <div className="agents-detail-entry-head">
          <span className="agents-detail-entry-type">安排记录</span>
          <span className="agents-detail-entry-state">{state}</span>
        </div>
        <p className="agents-detail-entry-body">{title}</p>
        {data ? (
          <dl className="agents-detail-requirements">
            <div><dt>目标</dt><dd>{data.safe.goal}</dd></div>
            <div><dt>验收</dt><dd>{data.safe.acceptance}</dd></div>
          </dl>
        ) : null}
        {text && text !== title ? (
          <details className="agents-detail-raw-record">
            <summary>查看原始记录</summary>
            <pre>{text}</pre>
          </details>
        ) : null}
      </article>
    );
  }
  if (message.role === 'user') {
    if (!text) return <></>;
    const isLongInput = text.length > 360 || text.split('\n').length > 8;
    return (
      <article className="agents-detail-bubble agents-detail-entry user">
        <div className="agents-detail-entry-head"><span className="agents-detail-entry-type">任务输入</span></div>
        {isLongInput ? (
          <details className="agents-detail-expandable">
            <summary><span className="agents-detail-entry-summary">{transcriptPreview(text)}</span></summary>
            <p className="agents-detail-entry-body">{text}</p>
          </details>
        ) : <p className="agents-detail-entry-body">{text}</p>}
      </article>
    );
  }
  if (!segments.length) {
    return text ? (
      <article className="agents-detail-bubble agents-detail-entry assistant">
        <div className="agents-detail-entry-head"><span className="agents-detail-entry-type">智能体回复</span></div>
        <p className="agents-detail-entry-body">{text}</p>
      </article>
    ) : <></>;
  }
  const stateLabel = message.status === 'streaming' ? '执行中' : message.status === 'failed' ? '执行失败' : message.status === 'stopped' ? '已停止' : null;
  return (
    <article className={`agents-detail-bubble agents-detail-entry assistant${message.status ? ` ${message.status}` : ''}`}>
      <div className="agents-detail-entry-head">
        <span className="agents-detail-entry-type">智能体执行</span>
        {stateLabel ? <span className="agents-detail-entry-state">{stateLabel}</span> : null}
      </div>
      <div className="agents-detail-segments">
        {segments.map((segment, index) => {
          if (segment.kind === 'tool') {
            return (
              <div className={`agents-detail-segment tool${segment.isError ? ' failed' : ''}`} key={segment.toolCallId ?? `${segment.text}-${index}`}>
                <span className="agents-detail-segment-kind">{segment.isError ? '错误' : '工具'}</span>
                <ToolSegment segment={segment} />
              </div>
            );
          }
          if (segment.kind === 'thinking') {
            const first = segment.text.split('\n')[0]?.trim().slice(0, 60) || '思考过程';
            return (
              <div className="agents-detail-segment thinking" key={`thinking-${index}`}>
                <span className="agents-detail-segment-kind">思考</span>
                <details className="pi-thinking-line">
                  <summary>{first}</summary>
                  <div className="pi-thinking-detail agents-detail-thinking">{segment.text}</div>
                </details>
              </div>
            );
          }
          return (
            <div className="agents-detail-segment response" key={`text-${index}`}>
              <span className="agents-detail-segment-kind">回复</span>
              <p className="agents-detail-text">{segment.text}</p>
            </div>
          );
        })}
      </div>
    </article>
  );
}

type RunLogItem =
  | { kind: 'event'; key: string; at: string; atMs: number; order: number; event: TaskEventView }
  | { kind: 'transcript'; key: string; at: string | null; atMs: number; order: number; message: PiChatMessage };

function runLogItems(events: TaskEventView[], transcript: PiChatMessage[]): RunLogItem[] {
  const items: RunLogItem[] = [];
  for (const [index, event] of events.entries()) {
    const atMs = Date.parse(event.at);
    items.push({ kind: 'event', key: `event-${event.at}-${index}`, at: event.at, atMs: Number.isFinite(atMs) ? atMs : Number.POSITIVE_INFINITY, order: items.length, event });
  }
  for (const [index, message] of transcript.entries()) {
    const at = message.createdAt ?? null;
    const atMs = at ? Date.parse(at) : Number.NaN;
    items.push({ kind: 'transcript', key: message.entryId ?? `transcript-${index}`, at, atMs: Number.isFinite(atMs) ? atMs : Number.POSITIVE_INFINITY, order: items.length, message });
  }
  return items.sort((left, right) => left.atMs - right.atMs || left.order - right.order);
}

function RunLogSection({ events, transcript, followKey }: { events: TaskEventView[]; transcript: PiChatMessage[]; followKey: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followingLatestRef = useRef(true);
  const previousFollowKeyRef = useRef(followKey);
  const items = runLogItems(events, transcript);
  const lastEvent = events[events.length - 1];
  const lastMessage = transcript[transcript.length - 1];
  const segmentVersion = lastMessage?.segments?.map((segment) => segment.text.length).join(',') ?? '';
  const contentVersion = `${events.length}:${lastEvent?.at ?? ''}:${lastEvent?.message ?? ''}:${transcript.length}:${lastMessage?.entryId ?? ''}:${lastMessage?.text.length ?? 0}:${segmentVersion}`;

  useLayoutEffect(() => {
    if (previousFollowKeyRef.current !== followKey) {
      previousFollowKeyRef.current = followKey;
      followingLatestRef.current = true;
    }
    const scroller = scrollRef.current;
    if (scroller && followingLatestRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [followKey, contentVersion]);

  if (!items.length) {
    return (
      <section className="agents-detail-section" aria-label="运行记录">
        <h3>运行记录</h3>
        <p className="agents-detail-empty">暂无运行明细</p>
      </section>
    );
  }

  return (
    <section className="agents-detail-section" aria-label="运行记录">
      <h3>运行记录</h3>
      <div
        ref={scrollRef}
        className="agents-detail-transcript agents-detail-run-log"
        role="log"
        aria-label="实时运行记录"
        aria-live="polite"
        aria-relevant="additions text"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          followingLatestRef.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 24;
        }}
      >
        {items.map((item) => item.kind === 'event' ? (
          <article className="agents-detail-bubble agents-detail-entry task-event" key={item.key}>
            <div className="agents-detail-entry-head">
              <span className="agents-detail-entry-type">任务状态</span>
              <time className="agents-detail-entry-state">{clock(item.at)}</time>
            </div>
            <p className="agents-detail-entry-body">{item.event.message}</p>
          </article>
        ) : <TranscriptMessage key={item.key} message={item.message} />)}
      </div>
    </section>
  );
}

/**
 * 主管/遗留任务运行明细：数据全部来自 roster 行 + getAgentTask + 当前 dock 会话，
 * 只读真实任务字段（status/progress/events/phase/intent/businessDate），不伪造文案。
 */
function RosterRunDetail({
  name,
  status,
  statusText,
  row,
  task,
  transcript
}: {
  name: string;
  status: string;
  statusText: string;
  row: RosterRow | null;
  task: AgentTaskView | null;
  transcript: PiChatMessage[] | null;
}): JSX.Element {
  const running = status === 'running';
  const present = progressPresentation(row?.progressRatio, running);
  const progress = taskProgress(task?.progress);
  const events = taskEvents(task?.events);
  const step = row?.progressLabel ?? progress?.message ?? progress?.currentSource ?? row?.phase ?? task?.phase ?? null;
  const visibleTranscript = (transcript ?? []).filter((message) => message.text.trim() || (message.segments?.length ?? 0) > 0);
  return (
    <div className="agents-detail-instance agents-detail-desk">
      <div className="agents-detail-instance-head">
        <StatusDot status={status} />
        <span className="agents-detail-instance-name">{name}</span>
        <span className={`agents-status-word status-${status}`}>{statusText}</span>
      </div>
      {row?.summary && row.summary !== '当前无任务' ? <p className="agents-detail-brief">{row.summary}</p> : null}
      <div className="agents-detail-progress">
        <span
          className={`agents-work-progress${present.indeterminate ? ' indeterminate' : ''}`}
          role="progressbar"
          aria-label="任务进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={present.determinate && present.ratio != null ? Math.round(present.ratio * 100) : undefined}
          style={present.determinate && present.ratio != null ? { ['--progress' as string]: present.ratio } : undefined}
        >
          <i />
        </span>
        <span className="agents-detail-pct">{present.percent}</span>
      </div>
      {step ? <p className="agents-instance-step">{step}</p> : null}
      <div className="agents-detail-meta">
        {row?.taskId ? <div className="agents-detail-meta-row"><span>任务标识</span><span>{row.taskId}</span></div> : null}
        {(task?.intent ?? row?.intent) ? <div className="agents-detail-meta-row"><span>意图</span><span>{task?.intent ?? row?.intent}</span></div> : null}
        {task?.businessDate ? <div className="agents-detail-meta-row"><span>业务日</span><span>{task.businessDate}</span></div> : null}
        {(task?.phase ?? row?.phase) ? <div className="agents-detail-meta-row"><span>阶段</span><span>{task?.phase ?? row?.phase}</span></div> : null}
        {task?.errorMessage ? <div className="agents-detail-meta-row"><span>错误</span><span className="agents-detail-error">{task.errorMessage}</span></div> : null}
      </div>
      <RunLogSection events={events} transcript={visibleTranscript} followKey={row?.taskId ?? name} />
    </div>
  );
}

function InstanceRunDetail({
  inst,
  task,
  messages,
  transcript,
  onCopyJobId
}: {
  inst: CrewInstance;
  task: AgentTaskView | null;
  messages: JobMessageView[];
  transcript: PiChatMessage[] | null;
  onCopyJobId: (jobId: string) => void;
}): JSX.Element {
  const present = progressPresentation(inst.progressRatio, inst.status === 'running');
  const timing = instanceTiming(inst);
  const progress = taskProgress(task?.progress);
  const step = inst.progressLabel ?? (progress ? `已完成 ${progress.processed}/${progress.planned ?? '?'}` : null) ?? inst.phase;
  const events = taskEvents(task?.events);
  const taskError = task?.errorMessage ?? inst.error;
  return (
    <div className="agents-detail-instance">
      <div className="agents-detail-instance-head">
        <StatusDot status={inst.status} />
        <span className="agents-detail-instance-name">
          {roleLabel(inst.roleId)}
          {inst.displayNumber > 0 ? ` #${inst.displayNumber}` : ''}
        </span>
        <span className={`agents-status-word status-${inst.status}`}>{instanceStatusWord(inst)}</span>
        <button type="button" className="agents-row-action" onClick={() => onCopyJobId(inst.jobId)}>复制任务编号</button>
      </div>
      <p className="agents-detail-brief" title={inst.brief}>{inst.brief}</p>
      <div className="agents-detail-progress">
        <span
          className={`agents-work-progress${present.indeterminate ? ' indeterminate' : ''}`}
          role="progressbar"
          aria-label={`${roleLabel(inst.roleId)}任务进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={present.determinate && present.ratio != null ? Math.round(present.ratio * 100) : undefined}
          style={present.determinate && present.ratio != null ? { ['--progress' as string]: present.ratio } : undefined}
        >
          <i />
        </span>
        <span className="agents-detail-pct">{present.percent}</span>
      </div>
      {step ? <p className="agents-instance-step">{step}</p> : null}
      {researchClaimLine(inst.research) ? <p className="agents-instance-claims">{researchClaimLine(inst.research)}</p> : null}
      <div className="agents-detail-meta">
        <div className="agents-detail-meta-row"><span>任务编号</span><code className="agents-detail-jobid">{inst.jobId}</code></div>
        {inst.taskId ? <div className="agents-detail-meta-row"><span>任务标识</span><span>{inst.taskId}</span></div> : null}
        {inst.intent ? <div className="agents-detail-meta-row"><span>意图</span><span>{inst.intent}</span></div> : null}
        {inst.businessDate ? <div className="agents-detail-meta-row"><span>业务日</span><span>{inst.businessDate}</span></div> : null}
        {inst.projectId ? <div className="agents-detail-meta-row"><span>项目</span><span>{inst.projectId}</span></div> : null}
        {inst.code ? <div className="agents-detail-meta-row"><span>状态码</span><span>{inst.code}</span></div> : null}
        {taskError ? <div className="agents-detail-meta-row"><span>错误</span><span className="agents-detail-error">{taskError}</span></div> : null}
        <div className="agents-detail-meta-row"><span>耗时</span><span>{timing.prefix} {timing.label}</span></div>
        <div className="agents-detail-meta-row"><span>排队</span><span>{clock(inst.queuedAt)}</span></div>
        {inst.startedAt ? <div className="agents-detail-meta-row"><span>开始</span><span>{clock(inst.startedAt)}</span></div> : null}
        {inst.finishedAt ? <div className="agents-detail-meta-row"><span>结束</span><span>{clock(inst.finishedAt)}</span></div> : null}
      </div>
      
      <section className="agents-detail-section" aria-label="最新消息">
        <h3>最新消息</h3>
        {messages.length ? (
          <ul className="agents-detail-msgs">
            {messages.map((m) => (
              <li key={m.id}>
                <span className="agents-detail-msg-from">{m.from === 'desk' ? '主管' : m.from}</span>
                <span className="agents-detail-msg-body">{m.body}</span>
                <time>{clock(m.at)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="agents-detail-empty">暂无运行明细</p>
        )}
      </section>
      <RunLogSection events={events} transcript={transcript ?? []} followKey={inst.jobId} />
    </div>
  );
}

/**
 * 智能体任务详情弹窗（WMB-5251，由 WMB-5195 右侧抽屉迁移）：按角色打开，
 * 默认选中该角色第一个活动实例，多实例可切换。数据全部来自共享只读 API；
 * onPiEvent/onDataChanged 只触发选中实例重读，不把事件直接归属；运行中低频
 * fallback 刷新，关闭即清理订阅与定时器。遮罩/焦点/ Esc /滚动锁由共享 AppModal 承担；
 * 关闭仅清 UI 状态，绝不取消运行中任务。
 *
 * WMB-5273：卡片与弹窗共用同一 roster 行（getAgentsRoster 权威投影）。当该角色
 * 无投影实例（daily 编排/页任务等不经 JobPool 的遗留 Pi 任务）但 roster 行 running/
 * blocked 时，弹窗照常渲染真实任务（getAgentTask 同 taskId + 当前 dock 会话），
 * 不再落入「暂无运行明细」空态；实例优先，遗留行只是回落，不重复 API。
 */
export function AgentsDetailModal({
  roleId,
  projection,
  selectedJobId,
  deskRow,
  roleRow,
  deskOccupied,
  deskConflict,
  avatarUrl,
  onSelectJobId,
  onClose,
  onCopyJobId,
  onPickAvatar,
  returnFocusRef
}: {
  roleId: RoleId;
  projection: CrewProjection;
  selectedJobId: string | null;
  deskRow?: RosterRow | null;
  roleRow?: RosterRow | null;
  deskOccupied?: boolean;
  deskConflict?: boolean;
  avatarUrl?: string | null;
  onSelectJobId: (jobId: string) => void;
  onClose: () => void;
  onCopyJobId: (jobId: string) => void;
  onPickAvatar?: (roleId: RoleId) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const meta = roleId === 'desk' ? ROLE_CATALOG.desk : ROLE_CATALOG[roleId];
  const roleKey: EmployeeRole | null = roleId === 'desk' ? null : (roleId as EmployeeRole);
  const active = roleKey ? (projection.byRole[roleKey]?.active ?? []) : [];
  const ordered = sortInstancesForDisplay(active);
  const selected = ordered.find((i) => i.jobId === selectedJobId) ?? ordered[0] ?? null;
  const deskActive = roleId === 'desk' && Boolean(deskOccupied || deskConflict || deskRow?.status === 'running' || deskRow?.status === 'blocked');
  // 与角色卡同一 roster 行投影：running/blocked 且带 taskId 即视为权威活动行；
  // 实例优先，遗留行只在无投影实例时渲染（与 RoleOverviewRow legacyBusy 语义一致）。
  const row = roleId === 'desk' ? (deskRow ?? null) : (roleRow ?? null);
  const rowActive = Boolean(row && row.taskId && (row.status === 'running' || row.status === 'blocked'));
  const rowBacked = roleId === 'desk' ? deskActive : ordered.length === 0 && rowActive;

  const [task, setTask] = useState<AgentTaskView | null>(null);
  const [messages, setMessages] = useState<JobMessageView[]>([]);
  const [transcript, setTranscript] = useState<PiChatMessage[] | null>(null);
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let activeRequest = true;
    setTask(null);
    setMessages([]);
    setTranscript(null);
    const load = async () => {
      if (selected) {
        const [rawTask, rawMessages, rawTranscript] = await Promise.all([
          selected.taskId ? window.wmb.getAgentTask({ id: selected.taskId }).catch(() => null) : Promise.resolve(null),
          window.wmb.jobsMessages(selected.jobId).catch(() => []),
          window.wmb.getAgentTaskTranscript(selected.jobId).catch(() => null)
        ]);
        if (!activeRequest) return;
        setTask(normalizeTask(rawTask));
        setMessages(Array.isArray(rawMessages) ? (rawMessages as JobMessageView[]) : []);
        setTranscript(Array.isArray(rawTranscript) ? rawTranscript : null);
        return;
      }
      // 遗留行（主管席 / 不经 JobPool 的 Pi 任务）：taskId 读真实任务，dock 会话即运行记录。
      if (roleId === 'desk' ? !deskActive : !rowActive) return;
      const [rawTask, conversation] = await Promise.all([
        row?.taskId ? window.wmb.getAgentTask({ id: row.taskId }).catch(() => null) : Promise.resolve(null),
        window.wmb.getPiConversation().catch(() => null)
      ]);
      if (!activeRequest) return;
      setTask(normalizeTask(rawTask));
      if (conversation) {
        const disk = Array.isArray(conversation.messages) ? conversation.messages as PiChatMessage[] : [];
        setTranscript((current) => mergePiConversationWithLive(disk, current));
      }
    };
    reloadRef.current = () => { void load(); };
    void load();
    return () => { activeRequest = false; };
  }, [roleId, deskActive, rowActive, row?.taskId, selected?.jobId, selected?.taskId]);

  // 事件驱动重读：实例/遗留行都订阅同一 agent/today 数据流；row-backed 消费 dock 实时流，
  // 其余触发 authoritative 重读；运行中低频轮询对账磁盘，关闭即清理订阅与定时器。
  useEffect(() => {
    const reload = () => reloadRef.current();
    const offPi = window.wmb.onPiEvent?.((event) => {
      if (rowBacked) {
        setTranscript((items) => applyPiTranscriptEvent(items ?? [], event));
      } else {
        reload();
      }
    });
    const offData = window.wmb.onDataChanged?.((event) => {
      if (event.scopes?.includes('agent') || event.scopes?.includes('today')) reload();
    });
    const activelyRunning = roleId === 'desk'
      ? rowBacked && !deskConflict
      : rowBacked || selected?.status === 'running';
    const timer = activelyRunning ? window.setInterval(reload, 5000) : null;
    return () => {
      offPi?.();
      offData?.();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [roleId, rowBacked, deskConflict, selected?.jobId, selected?.status]);

  return (
    <AppModal
      open
      title={`${meta.labelZh}运行明细`}
      size="standard"
      className="agents-detail-modal"
      testId="agents-detail-modal"
      ariaDescription={`运行明细 · ${meta.roomZh}`}
      onRequestClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className="agents-detail-body">
        {onPickAvatar ? (
          <button
            type="button"
            className="agents-detail-avatar"
            onClick={() => onPickAvatar(roleId)}
            aria-label={`设置${meta.labelZh}头像`}
            title={`设置${meta.labelZh}头像`}
          >
            {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{meta.labelZh.slice(0, 1)}</span>}
          </button>
        ) : null}
        {roleId === 'desk' ? (
          deskActive ? (
            <RosterRunDetail
              name="主管任务"
              status={deskConflict ? 'blocked' : deskOccupied ? 'running' : 'idle'}
              statusText={deskConflict ? '受阻' : deskOccupied ? '工作中' : '当前无任务'}
              row={deskRow ?? null}
              task={task}
              transcript={transcript}
            />
          ) : <p className="agents-detail-empty">暂无运行明细</p>
        ) : ordered.length === 0 ? (
          rowBacked ? (
            <RosterRunDetail
              name={`${meta.labelZh}任务`}
              status={row?.status === 'blocked' ? 'blocked' : 'running'}
              statusText={row?.status === 'blocked' ? '受阻' : '工作中'}
              row={row}
              task={task}
              transcript={transcript}
            />
          ) : <p className="agents-detail-empty">暂无运行明细</p>
        ) : (
          <>
            {ordered.length > 1 ? (
              <div className="agents-detail-switch" role="group" aria-label="任务切换">
                {ordered.map((inst, index) => (
                  <button
                    key={inst.jobId}
                    type="button"
                    className={`agents-detail-switch-item${selected?.jobId === inst.jobId ? ' active' : ''}`}
                    aria-pressed={selected?.jobId === inst.jobId}
                    onClick={() => onSelectJobId(inst.jobId)}
                  >
                    #{inst.displayNumber || index + 1} · {instanceStatusWord(inst)}
                  </button>
                ))}
              </div>
            ) : null}
            {selected ? (
              <InstanceRunDetail
                inst={selected}
                task={task}
                messages={messages}
                transcript={transcript}
                onCopyJobId={onCopyJobId}
              />
            ) : null}
          </>
        )}
      </div>
    </AppModal>
  );
}
