import { useEffect, useRef, useState, type JSX } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';
import type { PiChatMessage } from '../main/pi-conversation';
import type { PiMessageSegment } from '../shared/pi-message';
import { applyPiTranscriptEvent, isPiOrchestration, isPiSystemEvent, mergePiConversationWithLive } from './pi-dock-utils';
import {
  instanceTiming,
  sortInstancesForDisplay,
  statusWord,
  type CrewInstance,
  type CrewProjection,
  type EmployeeRole
} from './agents-instance-logic';
import { StatusDot, clock, progressPresentation, roleLabel, type RosterRow } from './agents-roster-parts';

/**
 * 员工明细来自 CrewInstance + task/messages/transcript；主管明细复用 roster taskId、
 * getAgentTask 与当前 getPiConversation，并消费同一 onPiEvent 实时流。只读，不新增 schema。
 */
type AgentTaskView = {
  phase: string | null;
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
    phase: typeof t.phase === 'string' ? t.phase : null,
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

function DeskRunDetail({
  row,
  occupied,
  conflict,
  task,
  transcript
}: {
  row: RosterRow | null;
  occupied: boolean;
  conflict: boolean;
  task: AgentTaskView | null;
  transcript: PiChatMessage[] | null;
}): JSX.Element {
  const running = occupied && !conflict;
  const present = progressPresentation(row?.progressRatio, running);
  const progress = taskProgress(task?.progress);
  const events = taskEvents(task?.events);
  const step = row?.progressLabel ?? progress?.message ?? progress?.currentSource ?? row?.phase ?? null;
  const status = conflict ? 'blocked' : running ? 'running' : 'idle';
  const statusText = conflict ? '受阻' : running ? '工作中' : '当前无任务';
  const visibleTranscript = (transcript ?? []).filter((message) => message.text.trim() || (message.segments?.length ?? 0) > 0).slice(-16);
  return (
    <div className="agents-detail-instance agents-detail-desk">
      <div className="agents-detail-instance-head">
        <StatusDot status={status} />
        <span className="agents-detail-instance-name">主管任务</span>
        <span className={`agents-status-word status-${status}`}>{statusText}</span>
      </div>
      {row?.summary && row.summary !== '当前无任务' ? <p className="agents-detail-brief">{row.summary}</p> : null}
      <div className="agents-detail-progress">
        <span
          className={`agents-work-progress${present.indeterminate ? ' indeterminate' : ''}`}
          role="progressbar"
          aria-label="主管任务进度"
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
        {row?.intent ? <div className="agents-detail-meta-row"><span>意图</span><span>{row.intent}</span></div> : null}
        {(task?.phase ?? row?.phase) ? <div className="agents-detail-meta-row"><span>阶段</span><span>{task?.phase ?? row?.phase}</span></div> : null}
        {task?.errorMessage ? <div className="agents-detail-meta-row"><span>错误</span><span className="agents-detail-error">{task.errorMessage}</span></div> : null}
      </div>
      <section className="agents-detail-section" aria-label="主管任务事件">
        <h3>任务事件</h3>
        {events.length ? (
          <ul className="agents-detail-events">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}><time>{clock(event.at)}</time><span>{event.message}</span></li>
            ))}
          </ul>
        ) : <p className="agents-detail-empty">暂无运行明细</p>}
      </section>
      <section className="agents-detail-section" aria-label="主管实时运行记录">
        <h3>实时运行记录</h3>
        {visibleTranscript.length ? (
          <div className="agents-detail-transcript">
            {visibleTranscript.map((message, index) => (
              <TranscriptMessage key={message.entryId ?? `${message.role}-${index}`} message={message} />
            ))}
          </div>
        ) : <p className="agents-detail-empty">暂无运行明细</p>}
      </section>
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
        <span className={`agents-status-word status-${inst.status}`}>{statusWord(inst.status)}</span>
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
      <section className="agents-detail-section" aria-label="任务事件">
        <h3>任务事件</h3>
        {events.length ? (
          <ul className="agents-detail-events">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}><time>{clock(event.at)}</time><span>{event.message}</span></li>
            ))}
          </ul>
        ) : (
          <p className="agents-detail-empty">暂无运行明细</p>
        )}
      </section>
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
      <section className="agents-detail-section" aria-label="运行记录">
        <h3>运行记录</h3>
        {transcript && transcript.length ? (
          <div className="agents-detail-transcript">
            {transcript.map((m) => (
              <TranscriptMessage key={m.entryId ?? `${m.role}-${m.text.slice(0, 12)}`} message={m} />
            ))}
          </div>
        ) : (
          <p className="agents-detail-empty">暂无运行明细</p>
        )}
      </section>
    </div>
  );
}

/**
 * 同页右侧运行明细抽屉（WMB-5195）：按角色打开，默认选中该角色第一个活动实例，多实例可切换。
 * 数据全部来自共享只读 API；onPiEvent/onDataChanged 只触发选中实例重读，不把事件直接归属；
 * 运行中低频 fallback 刷新，关闭即清理订阅与定时器。
 */
export function AgentsDetailDrawer({
  roleId,
  projection,
  selectedJobId,
  deskRow,
  deskOccupied,
  deskConflict,
  onSelectJobId,
  onClose,
  onCopyJobId,
  onPickAvatar
}: {
  roleId: RoleId;
  projection: CrewProjection;
  selectedJobId: string | null;
  deskRow?: RosterRow | null;
  deskOccupied?: boolean;
  deskConflict?: boolean;
  onSelectJobId: (jobId: string) => void;
  onClose: () => void;
  onCopyJobId: (jobId: string) => void;
  onPickAvatar?: (roleId: RoleId) => void;
}): JSX.Element {
  const meta = roleId === 'desk' ? ROLE_CATALOG.desk : ROLE_CATALOG[roleId];
  const roleKey: EmployeeRole | null = roleId === 'desk' ? null : (roleId as EmployeeRole);
  const active = roleKey ? (projection.byRole[roleKey]?.active ?? []) : [];
  const ordered = sortInstancesForDisplay(active);
  const selected = ordered.find((i) => i.jobId === selectedJobId) ?? ordered[0] ?? null;
  const deskActive = roleId === 'desk' && Boolean(deskOccupied || deskConflict || deskRow?.status === 'running' || deskRow?.status === 'blocked');

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
      if (roleId === 'desk') {
        if (!deskActive) return;
        const [rawTask, conversation] = await Promise.all([
          deskRow?.taskId ? window.wmb.getAgentTask({ id: deskRow.taskId }).catch(() => null) : Promise.resolve(null),
          window.wmb.getPiConversation().catch(() => null)
        ]);
        if (!activeRequest) return;
        setTask(normalizeTask(rawTask));
        if (conversation) {
          const disk = Array.isArray(conversation.messages) ? conversation.messages as PiChatMessage[] : [];
          setTranscript((current) => mergePiConversationWithLive(disk, current));
        }
        return;
      }
      if (!selected) return;
      const [rawTask, rawMessages, rawTranscript] = await Promise.all([
        selected.taskId ? window.wmb.getAgentTask({ id: selected.taskId }).catch(() => null) : Promise.resolve(null),
        window.wmb.jobsMessages(selected.jobId).catch(() => []),
        window.wmb.getAgentTaskTranscript(selected.jobId).catch(() => null)
      ]);
      if (!activeRequest) return;
      setTask(normalizeTask(rawTask));
      setMessages(Array.isArray(rawMessages) ? (rawMessages as JobMessageView[]) : []);
      setTranscript(Array.isArray(rawTranscript) ? rawTranscript : null);
    };
    reloadRef.current = () => { void load(); };
    void load();
    return () => { activeRequest = false; };
  }, [roleId, deskActive, deskRow?.taskId, selected?.jobId, selected?.taskId]);

  // 员工事件触发 authoritative job 重读；主管消费同一 dock 实时流，并在数据变更/低频轮询时对账磁盘。
  useEffect(() => {
    const reload = () => reloadRef.current();
    const offPi = window.wmb.onPiEvent?.((event) => {
      if (roleId === 'desk') {
        setTranscript((items) => applyPiTranscriptEvent(items ?? [], event));
      } else {
        reload();
      }
    });
    const offData = window.wmb.onDataChanged?.((event) => {
      if (event.scopes?.includes('agent') || event.scopes?.includes('today')) reload();
    });
    const activelyRunning = roleId === 'desk' ? deskActive && !deskConflict : selected?.status === 'running';
    const timer = activelyRunning ? window.setInterval(reload, 5000) : null;
    return () => {
      offPi?.();
      offData?.();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [roleId, deskActive, deskConflict, selected?.jobId, selected?.status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="sources-panel open agents-detail-panel" id="agents-detail-panel" aria-label={`${meta.labelZh}运行明细`}>
      <div className="panel-heading agents-detail-head">
        <p className="eyebrow">运行明细 · {meta.roomZh}</p>
        <div>
          <h2>{meta.labelZh}</h2>
          <button type="button" className="close-sources" aria-label="关闭运行明细" onClick={onClose}>×</button>
        </div>
      </div>
      {onPickAvatar ? (
        <button type="button" className="agents-detail-avatar-edit" onClick={() => onPickAvatar(roleId)}>设置头像</button>
      ) : null}
      <div className="agents-detail-body">
        {roleId === 'desk' ? (
          deskActive ? (
            <DeskRunDetail
              row={deskRow ?? null}
              occupied={Boolean(deskOccupied)}
              conflict={Boolean(deskConflict)}
              task={task}
              transcript={transcript}
            />
          ) : <p className="agents-detail-empty">暂无运行明细</p>
        ) : ordered.length === 0 ? (
          <p className="agents-detail-empty">暂无运行明细</p>
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
                    #{inst.displayNumber || index + 1} · {statusWord(inst.status)}
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
    </aside>
  );
}
