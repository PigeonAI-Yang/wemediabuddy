import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { PiChatMessage } from '../main/pi-conversation';
import type { PiMessageSegment } from '../shared/pi-message';
import { knowledgeQueryWritebackRequestId, type KnowledgeQueryWritebackSummaryRecord } from '../shared/knowledge-flywheel';
import { coalescePiMessages, filterPiNativeQueueMessages, isPiConversationNearBottom, isPiOrchestration, isPiSystemEvent, mergePiJobNotices, mergePiLocalQueueMessages, nextPiConversationFollowing, piKnowledgeQuestionBefore, piKnowledgeRiskKindLabel, piKnowledgeShortId, piKnowledgeWriteBackDecisionLabel, piLocalQueueEntryId, piMessageSegments, piRetryable, piThinkingSummary, presentPiNativeQueueMessage, type PiLocalQueueItem } from './pi-dock-utils';
import { isValidOrchestrationData, type OrchestrationData } from '../shared/orchestration-envelope';
import { WmbCreatureMark } from './wmb-brand-mark';
import { WmbCreatureMotionAsset, type WmbCreatureMotionAction } from './wmb-creature-motion-asset';

export type PiDockMessage = PiChatMessage;

export type PiNativeQueue = {
  steering: string[];
  followUp: string[];
};

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, {
    async: false,
    gfm: true,
    breaks: true
  }) as string);
}

export function formatPiMessageTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function segmentText(segment: PiMessageSegment): string {
  return segment.kind === 'tool' ? segment.text : segment.text;
}

function PiToolLine({ segment, streaming }: { segment: Extract<PiMessageSegment, { kind: 'tool' }>; streaming: boolean }): React.JSX.Element {
  const running = streaming && !('output' in segment);
  const completed = 'output' in segment;
  return <details className={`pi-tool-line${running ? ' running' : completed ? ' completed' : ''}${segment.isError ? ' failed' : ''}`}>
    <summary aria-busy={running || undefined}><WmbCreatureMark state={running ? 'working' : completed ? 'sleep' : 'idle'}/><span className="pi-tool-label">{segment.text}</span></summary>
    {(segment.input || segment.output) && <div className="pi-tool-detail">
      {segment.input && <><b>输入</b><pre>{segment.input}</pre></>}
      {segment.output && <><b>{segment.isError ? '错误' : '输出'}</b><pre>{segment.output}</pre></>}
    </div>}
  </details>;
}

function PiAssistantSegments({ segments, streaming }: { segments: PiMessageSegment[]; streaming: boolean }): React.JSX.Element {
  const liveThinkingIndex = streaming ? segments.map((segment) => segment.kind).lastIndexOf('thinking') : -1;
  return <>
    {segments.map((segment, index) => segment.kind === 'thinking'
      ? index === liveThinkingIndex
        ? <div className="pi-message-segment thinking live" key={`thinking-${index}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(segment.text) }} />
        : <details className="pi-thinking-line" key={`thinking-${index}`}>
            <summary>{piThinkingSummary(segment.text)}</summary>
            <div className="pi-thinking-detail pi-message-segment thinking" dangerouslySetInnerHTML={{ __html: renderMarkdown(segment.text) }} />
          </details>
      : segment.kind === 'tool'
        ? <PiToolLine segment={segment} streaming={streaming} key={`${segment.toolCallId ?? segment.text}-${index}`}/>
        : <div className="pi-message-segment text" key={`text-${index}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(segment.text) }} />)}
  </>;
}

/** WMB-5205 四态：pending「正在安排主管」/ direct「已安排主管」/ steer·follow_up「已加入主管队列」/ failed「安排失败」。 */
function orchestrationStatusLabel(data: OrchestrationData): string {
  if (data.state === 'failed') return '安排失败';
  if (data.state === 'pending') return '正在安排主管';
  return data.delivery === 'direct' ? '已安排主管' : '已加入主管队列';
}

/** WMB-5214：每轮 Query 写回摘要的 renderer 侧只读缓存（key=requestId；防重复 IPC）。 */
const piKnowledgeSummaryCache = new Map<string, KnowledgeQueryWritebackSummaryRecord | null>();

/** WMB-5214：拉取该轮问答的知识使用与沉淀摘要；缓存缺省时发起一次只读 IPC。 */
function usePiKnowledgeSummary(requestId: string | null): KnowledgeQueryWritebackSummaryRecord | null {
  const [summary, setSummary] = useState<KnowledgeQueryWritebackSummaryRecord | null>(() => (requestId ? (piKnowledgeSummaryCache.get(requestId) ?? null) : null));
  useEffect(() => {
    if (!requestId) { setSummary(null); return; }
    if (piKnowledgeSummaryCache.has(requestId)) { setSummary(piKnowledgeSummaryCache.get(requestId) ?? null); return; }
    let cancelled = false;
    const fetchSummary = window.wmb.getQueryWritebackSummary;
    if (typeof fetchSummary !== 'function') { piKnowledgeSummaryCache.set(requestId, null); setSummary(null); return; }
    fetchSummary({ requestId }).then((value) => {
      if (cancelled) return;
      piKnowledgeSummaryCache.set(requestId, value);
      setSummary(value);
    }).catch(() => {
      if (cancelled) return;
      piKnowledgeSummaryCache.set(requestId, null);
      setSummary(null);
    });
    return () => { cancelled = true; };
  }, [requestId]);
  return summary;
}

const QUERY_USED_GROUPS: ReadonlyArray<{ key: 'readWikiVersionIds' | 'readNoteVersionIds' | 'readEvidenceIds'; label: string }> = Object.freeze([
  { key: 'readWikiVersionIds', label: 'Wiki' },
  { key: 'readNoteVersionIds', label: '知识' },
  { key: 'readEvidenceIds', label: '来源' }
]);

/**
 * WMB-5214：assistant 回答下方的“知识使用与沉淀”折叠面板。
 * 只展示本轮固定读取版本的入口、风险、写回决策/未写回原因与回执/变更入口；
 * 绝不混入 tool JSON，也绝不把回答正文/内部候选当作证据。
 * WMB-5231：无 Artifact 但存在 settle 结果（无/非法清单、校验或写回失败）时，
 * 面板显示可读未写原因；无 Artifact 且无 settle（重启后旧轮次）不渲染空壳。
 */
function PiKnowledgePanel({ conversationId, question }: { conversationId: string | null; question: string | null }): React.JSX.Element | null {
  const requestId = conversationId && question ? knowledgeQueryWritebackRequestId(conversationId, question) : null;
  const summary = usePiKnowledgeSummary(requestId);
  const artifact = summary?.artifact ?? null;
  const settle = summary?.settle ?? null;
  if (!artifact && !settle) return null;
  const decision = artifact?.writeBackDecision ?? null;
  const writtenBack = decision === 'created' || decision === 'updated';
  const riskFlags = summary?.riskFlags ?? [];
  const receipt = summary?.receipt ?? null;
  const used = QUERY_USED_GROUPS.map((group) => ({ label: group.label, ids: artifact ? (artifact[group.key] ?? []) : [] })).filter((item) => item.ids.length > 0);
  const receiptEntryId = receipt?.changeSetId ?? artifact?.changeSetId;
  return (
    <details className={`pi-knowledge-panel${writtenBack ? ' written-back' : ' not-written-back'}`} data-decision={decision} aria-label={`知识使用与沉淀：${writtenBack ? '已沉淀' : '未写回'}`}>
      <summary>
        <span className="pi-knowledge-panel-title">知识使用与沉淀</span>
        <span className={`pi-knowledge-panel-badge${writtenBack ? ' ok' : ''}`}>{writtenBack ? '已沉淀' : '未写回'}</span>
      </summary>
      <div className="pi-knowledge-panel-body">
        {artifact && used.length > 0 && <section className="pi-knowledge-used" aria-label="本次使用的知识">
          <h4>本次使用</h4>
          <ul className="pi-knowledge-used-list">
            {used.map((group) => <li key={group.label} className="pi-knowledge-used-group">
              <b>{group.label} {group.ids.length}</b>
              <span className="pi-knowledge-used-ids">{group.ids.map(piKnowledgeShortId).join(' · ')}</span>
            </li>)}
          </ul>
        </section>}
        {artifact && riskFlags.length > 0 && <section className="pi-knowledge-risks" aria-label="知识风险">
          <h4>风险</h4>
          <ul className="pi-knowledge-risk-list">
            {riskFlags.map((flag, index) => <li key={`${flag.kind}-${flag.versionId ?? index}`} className={`pi-risk-chip ${flag.kind}`} title={flag.note ?? undefined}>
              {piKnowledgeRiskKindLabel(flag.kind)}{flag.note ? <span className="pi-risk-note">：{flag.note}</span> : null}
            </li>)}
          </ul>
        </section>}
        <section className="pi-knowledge-writeback" aria-label={writtenBack ? '本次沉淀' : '未写回原因'}>
          <h4>{writtenBack ? '本次沉淀' : '未写回原因'}</h4>
          {artifact ? (
            <>
              <p className="pi-knowledge-decision">{piKnowledgeWriteBackDecisionLabel(decision)}</p>
              {!writtenBack && artifact.skipReason && <p className="pi-knowledge-skip-reason">{artifact.skipReason}</p>}
              {receipt && <div className="pi-knowledge-receipt">
                <p className="pi-knowledge-receipt-summary">{receipt.summary}</p>
                {receiptEntryId && <p className="pi-knowledge-receipt-entry">回执 {piKnowledgeShortId(receipt.id)} · 变更 {piKnowledgeShortId(receiptEntryId)}</p>}
              </div>}
            </>
          ) : (
            <p className="pi-knowledge-settle-reason">{settle?.reason ?? '本轮未产生知识写回。'}</p>
          )}
        </section>
      </div>
    </details>
  );
}

function PiOrchestrationRow({ message }: { message: PiChatMessage }): React.JSX.Element | null {
  const data = message.orchestration;
  if (!data || !isValidOrchestrationData(data)) return null;
  const visualState = data.state === 'failed' ? 'failed' : data.state === 'pending' ? 'pending' : 'accepted';
  const motionAction: WmbCreatureMotionAction = visualState === 'failed' ? 'sleep' : visualState === 'pending' ? 'connect' : 'settle';
  const status = orchestrationStatusLabel(data);
  return (
    <article className={`pi-orchestration-wrap ${visualState}`} data-state={visualState} aria-label={`编排任务：${status}，${data.safe.title}`}>
      <div className="pi-orchestration-mascot">
        <WmbCreatureMotionAsset action={motionAction} className="pi-orchestration-motion"/>
      </div>
      <div className="pi-orchestration-body">
        <header className="pi-orchestration-head">
          <span className="pi-orchestration-status">{status}</span>
          <time className="pi-orchestration-time">{formatPiMessageTime(message.createdAt)}</time>
        </header>
        <strong className="pi-orchestration-title">{data.safe.title}</strong>
        {visualState === 'failed' && data.error && <p className="pi-orchestration-error">{data.error}</p>}
        <details className="pi-orchestration-details">
          <summary>查看任务要求</summary>
          <dl className="pi-orchestration-requirements">
            <div className="pi-orchestration-requirement"><dt>来源</dt><dd>{data.safe.originLabel}</dd></div>
            <div className="pi-orchestration-requirement"><dt>标题</dt><dd>{data.safe.title}</dd></div>
            <div className="pi-orchestration-requirement"><dt>目标</dt><dd>{data.safe.goal}</dd></div>
            <div className="pi-orchestration-requirement"><dt>验收</dt><dd>{data.safe.acceptance}</dd></div>
          </dl>
        </details>
      </div>
    </article>
  );
}


export function PiDockTranscript({
  messages,
  jobNotices,
  queue,
  localQueue,
  busy,
  pendingAction,
  configured,
  connecting,
  statusText,
  conversationRef,
  conversationId,
  onCopy,
  onFork,
  onRetry
}: {
  messages: PiDockMessage[];
  jobNotices: PiDockMessage[];
  queue: PiNativeQueue;
  localQueue: PiLocalQueueItem[];
  busy: boolean;
  pendingAction: { entryId: string; retry: boolean } | null;
  configured: boolean;
  connecting: boolean;
  statusText: string;
  conversationRef: RefObject<HTMLDivElement | null>;
  /** WMB-5214：Pi 会话 snapshot id，派生 Query 写回 requestId 的唯一会话键。 */
  conversationId?: string | null;
  onCopy: (text: string) => void;
  onFork: (entryId: string) => void;
  onRetry: (entryId: string) => void;
}): React.JSX.Element {
  const followingLatest = useRef(true);
  const userScrollIntent = useRef(false);
  const jumpingLatest = useRef(false);
  const jumpFrame = useRef<number | null>(null);
  const hideLatestTimer = useRef<number | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [latestLeaving, setLatestLeaving] = useState(false);
  let retryEntryId: string | undefined;
  const localQueueByEntryId = new Map(localQueue.map((item) => [piLocalQueueEntryId(item.localId), item]));
  const displayMessages = coalescePiMessages(mergePiLocalQueueMessages(mergePiJobNotices(messages, jobNotices), localQueue));
  const visibleSteering = filterPiNativeQueueMessages(queue.steering, 'steer', localQueue);
  const visibleFollowUp = filterPiNativeQueueMessages(queue.followUp, 'followUp', localQueue);
  useLayoutEffect(() => {
    const node = conversationRef.current;
    if (node && followingLatest.current) {
      node.scrollTop = node.scrollHeight;
      userScrollIntent.current = false;
      setShowLatest(false);
    }
  }, [messages, jobNotices, queue, localQueue, conversationRef]);
  useEffect(() => () => {
    if (jumpFrame.current !== null) cancelAnimationFrame(jumpFrame.current);
    if (hideLatestTimer.current !== null) window.clearTimeout(hideLatestTimer.current);
  }, []);
  const updateFollowing = () => {
    const node = conversationRef.current;
    if (!node || jumpingLatest.current) return;
    const nearBottom = isPiConversationNearBottom(node.scrollTop, node.scrollHeight, node.clientHeight);
    followingLatest.current = nextPiConversationFollowing(followingLatest.current, userScrollIntent.current, nearBottom);
    if (nearBottom) userScrollIntent.current = false;
    setShowLatest(!followingLatest.current);
  };
  const jumpToLatest = () => {
    const node = conversationRef.current;
    if (!node || jumpingLatest.current) return;
    jumpingLatest.current = true;
    followingLatest.current = false;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    const deadline = performance.now() + 900;
    const watch = () => {
      const atBottom = isPiConversationNearBottom(node.scrollTop, node.scrollHeight, node.clientHeight);
      if (!atBottom && performance.now() < deadline) {
        jumpFrame.current = requestAnimationFrame(watch);
        return;
      }
      if (!atBottom) node.scrollTop = node.scrollHeight;
      followingLatest.current = true;
      userScrollIntent.current = false;
      setLatestLeaving(true);
      hideLatestTimer.current = window.setTimeout(() => {
        jumpingLatest.current = false;
        setShowLatest(false);
        setLatestLeaving(false);
      }, 160);
    };
    jumpFrame.current = requestAnimationFrame(watch);
  };
  return <div className="pi-conversation-shell"><div className="pi-conversation" ref={conversationRef} onScroll={updateFollowing}
    onWheel={(event) => { if (event.deltaY) userScrollIntent.current = true; }}
    onTouchMove={() => { userScrollIntent.current = true; }}
    onPointerDown={(event) => {
      const node = event.currentTarget;
      const scrollbarWidth = node.offsetWidth - node.clientWidth;
      if (scrollbarWidth > 0 && event.clientX >= node.getBoundingClientRect().right - scrollbarWidth) userScrollIntent.current = true;
    }}>
    {displayMessages.length ? displayMessages.map((message, index) => {
        const isSystemEvent = isPiSystemEvent(message);
        const isOrchestration = isPiOrchestration(message);
        const localItem = localQueueByEntryId.get(message.entryId ?? '');
        if (piRetryable(message)) retryEntryId = message.entryId;
        const timeLabel = formatPiMessageTime(message.createdAt);
        const localStatusLabel = localItem?.status === 'failed'
          ? '发送失败'
          : localItem?.status === 'accepted'
            ? (localItem.delivery === 'followUp' ? 'Pi 已接收 · 下一轮' : 'Pi 已接收 · 当前回复')
            : localItem ? '发送中' : '';
        const segments = piMessageSegments(message);
        const activityOnly = message.role === 'assistant' && message.status === 'streaming' && !segments.length;
        const showActions = Boolean(segments.length) && message.status !== 'streaming' && !localItem;
        const retryId = retryEntryId;
        const forkPending = pendingAction?.entryId === message.entryId && pendingAction?.retry === false;
        const retryPending = pendingAction?.entryId === retryId && pendingAction?.retry === true;
        const messageKey = message.entryId ?? `${message.role}-${index}-${message.createdAt ?? ''}-${message.text.slice(0, 12)}`;
        return isOrchestration
          ? <PiOrchestrationRow key={messageKey} message={message} />
          : (
            <div className={`pi-bubble-wrap ${isSystemEvent ? 'system-event' : message.role}`} key={messageKey} data-local-status={localItem?.status}>
            {isSystemEvent
              ? <div className="pi-system-event" role="status">
                  <div className="pi-system-event-label">WMB 系统通知</div>
                  <div className="pi-system-event-text">{message.text}</div>
                </div>
              : message.role === 'assistant'
                ? <>
                    {activityOnly
                      ? <div className="pi-activity" role="status" aria-live="polite" aria-label={statusText}>
                          <WmbCreatureMark state={connecting ? 'connect' : 'working'} className="pi-activity-mark"/>
                        </div>
                      : segments.length
                        ? <div className={`assistant pi-bubble${message.status ? ` ${message.status}` : ''}`}><PiAssistantSegments segments={segments} streaming={message.status === 'streaming'} /></div>
                        : null}
                    {!activityOnly && message.status !== 'streaming' && <PiKnowledgePanel conversationId={conversationId ?? null} question={piKnowledgeQuestionBefore(displayMessages, index)} />}
                  </>
                : <p className="user pi-bubble">{message.text}</p>}
            {!activityOnly && <div className="pi-bubble-meta">
              {localItem
                ? <span className="pi-bubble-time" role="status">{localStatusLabel}</span>
                : <time className="pi-bubble-time">{timeLabel || (message.status === 'streaming' ? '发送中' : '')}</time>}
              {!isSystemEvent && <div className="pi-bubble-actions" aria-hidden={showActions ? undefined : true} style={showActions ? undefined : { visibility: 'hidden' }}>
                <button type="button" title="复制" aria-label="复制" disabled={!showActions} onClick={() => onCopy(segments.map(segmentText).join('\n\n'))}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
                </button>
                {message.role === 'user' && message.entryId && !localItem && <button type="button" className={forkPending ? 'pending' : undefined} title={forkPending ? '正在创建新对话' : '从此消息新建对话'} aria-label="从此消息新建对话" aria-busy={forkPending || undefined} disabled={!showActions || busy} onClick={() => onFork(message.entryId!)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 1 1 0 12h-3"/></svg>
                </button>}
                {retryId && <button type="button" className={retryPending ? 'pending' : undefined} title={retryPending ? '正在重新发送' : '重新发送这条消息'} aria-label="重新发送这条消息" aria-busy={retryPending || undefined} disabled={!showActions || busy || !configured} onClick={() => onRetry(retryId)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>
                </button>}
              </div>}
            </div>}
          </div>
        );
    }) : <p className="pi-empty">{configured ? '现在可以直接和我对话。' : '请先在设置中填写 Pi API。'}</p>}
    {(visibleSteering.length || visibleFollowUp.length) > 0 && <section className="pi-native-queue" aria-label="Pi 消息队列" aria-live="polite">
      <header><strong>Pi 队列</strong></header>
      <ol>
        {visibleSteering.map((message, index) => {
          const item = presentPiNativeQueueMessage(message, 'steer');
          return <li key={`${item.kind}-${index}-${item.text.slice(0, 12)}`} data-kind={item.kind}><span aria-hidden="true">{item.kind === 'system_event' ? 'i' : '↥'}</span><div><b>{item.label}</b><p>{item.text}</p></div></li>;
        })}
        {visibleFollowUp.map((message, index) => {
          const item = presentPiNativeQueueMessage(message, 'follow');
          return <li key={`${item.kind}-${index}-${item.text.slice(0, 12)}`} data-kind={item.kind}><span aria-hidden="true">{item.kind === 'system_event' ? 'i' : '↳'}</span><div><b>{item.label}</b><p>{item.text}</p></div></li>;
        })}
      </ol>
    </section>}
  </div>{showLatest && <button type="button" className={`pi-jump-latest${latestLeaving ? ' leaving' : ''}`} onClick={jumpToLatest}>回到最新</button>}</div>;
}
