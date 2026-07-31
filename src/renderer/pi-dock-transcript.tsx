import type { RefObject } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export type PiDockMessage = {
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  entryId?: string;
  status?: 'streaming' | 'stopped' | 'failed';
  createdAt?: string;
};

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

export function PiDockTranscript({
  messages,
  queue,
  busy,
  configured,
  statusText,
  conversationRef,
  onCopy,
  onFork,
  onRetry
}: {
  messages: PiDockMessage[];
  queue: PiNativeQueue;
  busy: boolean;
  configured: boolean;
  statusText: string;
  conversationRef: RefObject<HTMLDivElement | null>;
  onCopy: (text: string) => void;
  onFork: (entryId: string) => void;
  onRetry: (entryId: string) => void;
}): React.JSX.Element {
  let retryEntryId: string | undefined;
  return <div className="pi-conversation" ref={conversationRef}>
    {messages.length ? messages.map((message, index) => {
        if (message.role === 'user' && message.entryId) retryEntryId = message.entryId;
        const timeLabel = formatPiMessageTime(message.createdAt);
        const showActions = Boolean(message.text || message.thinking) && message.status !== 'streaming';
        const retryId = retryEntryId;
        const thinking = message.thinking?.trim() ?? '';
        const openThinking = message.status === 'streaming' && !message.text && Boolean(thinking);
        return (
          <div className={`pi-bubble-wrap ${message.role}`} key={message.entryId ?? `${message.role}-${index}-${message.createdAt ?? ''}-${message.text.slice(0, 12)}`}>
            {message.role === 'assistant'
              ? <>
                  {thinking ? (
                    <details className={`pi-thinking${message.status === 'streaming' ? ' streaming' : ''}`} open={openThinking || undefined}>
                      <summary>
                        <span>{message.status === 'streaming' && !message.text ? '正在思考' : '思考过程'}</span>
                        <small>{thinking.length > 40 ? `${thinking.slice(0, 40)}…` : thinking}</small>
                      </summary>
                      <pre>{thinking}</pre>
                    </details>
                  ) : null}
                  {message.status === 'streaming' && !message.text
                    ? <div className="assistant pi-bubble streaming pi-activity" role="status" aria-live="polite">
                        <span className="pi-activity-mark" aria-hidden="true"><i /></span>
                        <span className="pi-activity-copy"><strong>{statusText}</strong><small>{thinking ? '边想边组织回复' : 'Pi 正在继续处理'}</small></span>
                      </div>
                    : message.text
                      ? <div className={`assistant pi-bubble${message.status ? ` ${message.status}` : ''}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
                      : null}
                </>
              : <p className="user pi-bubble">{message.text}</p>}
            <div className="pi-bubble-meta">
              <time className="pi-bubble-time">{timeLabel || (message.status === 'streaming' ? '发送中' : '')}</time>
              <div className="pi-bubble-actions" aria-hidden={showActions ? undefined : true} style={showActions ? undefined : { visibility: 'hidden' }}>
                <button type="button" title="复制" aria-label="复制" disabled={!showActions} onClick={() => onCopy([thinking && `思考过程：\n${thinking}`, message.text].filter(Boolean).join('\n\n'))}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
                </button>
                {message.role === 'user' && message.entryId && <button type="button" title="按 Pi 原生分叉撤回" aria-label="按 Pi 原生分叉撤回" disabled={!showActions || busy} onClick={() => onFork(message.entryId!)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 1 1 0 12h-3"/></svg>
                </button>}
                {retryId && <button type="button" title="按 Pi 原生分叉重发" aria-label="按 Pi 原生分叉重发" disabled={!showActions || busy || !configured} onClick={() => onRetry(retryId)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/></svg>
                </button>}
              </div>
            </div>
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
    <div className="pi-conversation-end-spacer" aria-hidden="true" />
  </div>;
}
