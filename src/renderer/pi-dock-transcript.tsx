import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { PiChatMessage } from '../main/pi-conversation';
import type { PiMessageSegment } from '../shared/pi-message';
import { coalescePiMessages, isPiConversationNearBottom, nextPiConversationFollowing, piMessageSegments, piThinkingSummary } from './pi-dock-utils';
import { WmbCreatureMark } from './wmb-brand-mark';

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

export function PiDockTranscript({
  messages,
  queue,
  busy,
  pendingAction,
  configured,
  connecting,
  statusText,
  conversationRef,
  onCopy,
  onFork,
  onRetry
}: {
  messages: PiDockMessage[];
  queue: PiNativeQueue;
  busy: boolean;
  pendingAction: { entryId: string; retry: boolean } | null;
  configured: boolean;
  connecting: boolean;
  statusText: string;
  conversationRef: RefObject<HTMLDivElement | null>;
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
  const displayMessages = coalescePiMessages(messages);
  useLayoutEffect(() => {
    const node = conversationRef.current;
    if (node && followingLatest.current) {
      node.scrollTop = node.scrollHeight;
      userScrollIntent.current = false;
      setShowLatest(false);
    }
  }, [messages, queue, conversationRef]);
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
        if (message.role === 'user' && message.entryId) retryEntryId = message.entryId;
        const timeLabel = formatPiMessageTime(message.createdAt);
        const segments = piMessageSegments(message);
        const activityOnly = message.role === 'assistant' && message.status === 'streaming' && !segments.length;
        const showActions = Boolean(segments.length) && message.status !== 'streaming';
        const retryId = retryEntryId;
        const forkPending = pendingAction?.entryId === message.entryId && pendingAction?.retry === false;
        const retryPending = pendingAction?.entryId === retryId && pendingAction?.retry === true;
        return (
          <div className={`pi-bubble-wrap ${message.role}`} key={message.entryId ?? `${message.role}-${index}-${message.createdAt ?? ''}-${message.text.slice(0, 12)}`}>
            {message.role === 'assistant'
              ? <>
                  {activityOnly
                    ? <div className="pi-activity" role="status" aria-live="polite" aria-label={statusText}>
                        <WmbCreatureMark state={connecting ? 'connect' : 'working'} className="pi-activity-mark"/>
                      </div>
                    : segments.length
                      ? <div className={`assistant pi-bubble${message.status ? ` ${message.status}` : ''}`}><PiAssistantSegments segments={segments} streaming={message.status === 'streaming'} /></div>
                      : null}
                </>
              : <p className="user pi-bubble">{message.text}</p>}
            {!activityOnly && <div className="pi-bubble-meta">
              <time className="pi-bubble-time">{timeLabel || (message.status === 'streaming' ? '发送中' : '')}</time>
              <div className="pi-bubble-actions" aria-hidden={showActions ? undefined : true} style={showActions ? undefined : { visibility: 'hidden' }}>
                <button type="button" title="复制" aria-label="复制" disabled={!showActions} onClick={() => onCopy(segments.map(segmentText).join('\n\n'))}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
                </button>
                {message.role === 'user' && message.entryId && <button type="button" className={forkPending ? 'pending' : undefined} title={forkPending ? '正在创建分支' : '按 Pi 原生分叉撤回'} aria-label="按 Pi 原生分叉撤回" aria-busy={forkPending || undefined} disabled={!showActions || busy} onClick={() => onFork(message.entryId!)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 1 1 0 12h-3"/></svg>
                </button>}
                {retryId && <button type="button" className={retryPending ? 'pending' : undefined} title={retryPending ? '正在重新发送' : '按 Pi 原生分叉重发'} aria-label="按 Pi 原生分叉重发" aria-busy={retryPending || undefined} disabled={!showActions || busy || !configured} onClick={() => onRetry(retryId)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>
                </button>}
              </div>
            </div>}
          </div>
        );
    }) : <p className="pi-empty">{configured ? '现在可以直接和我对话。' : '请先在设置中填写 Pi API。'}</p>}
    {(queue.steering.length || queue.followUp.length) > 0 && <section className="pi-native-queue" aria-label="Pi 原生消息队列" aria-live="polite">
      <header><strong>Pi 队列</strong><small>原生</small></header>
      <ol>
        {queue.steering.map((message, index) => <li key={`steer-${index}-${message.slice(0, 12)}`} data-kind="steer"><span aria-hidden="true">↥</span><div><b>即将处理</b><p>{message}</p></div></li>)}
        {queue.followUp.map((message, index) => <li key={`follow-${index}-${message.slice(0, 12)}`} data-kind="follow"><span aria-hidden="true">↳</span><div><b>下一轮</b><p>{message}</p></div></li>)}
      </ol>
    </section>}
  </div>{showLatest && <button type="button" className={`pi-jump-latest${latestLeaving ? ' leaving' : ''}`} onClick={jumpToLatest}>回到最新</button>}</div>;
}
