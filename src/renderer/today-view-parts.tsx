import type { PiFocusObject } from './app-types';
import { useEffect, useRef, useState } from 'react';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import type { IntelligenceChannelsSummary } from '../main/intelligence-channels';
import { SourceMark } from './source-mark';
import { PlatformMark } from './platform-mark';
import { formatNames, platformNames } from './app-types';
import { dailyPreflightMessage } from './intelligence-channel-ui';
export function formatSourcePublishedAt(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

export function domainOf(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return null; }
}

export type SelectedTodaySource = TodaySource & {
  bodyStatus?: 'none' | 'ready' | 'failed' | 'empty';
  bodyExcerpt?: string | null;
  bodyChars?: number;
};

export const phaseLabels: Record<string, string> = {
  starting: '正在启动', resume_pending: '等待恢复', resuming: '正在恢复', planning_sources: '正在规划来源',
  channel_preflight: '正在准备情报渠道', scanning_sources: '正在扫描来源', channel_scanned: '渠道扫描已完成',
  running_pi: '正在生成今日运营方案', judging_opportunities: '正在生成今日运营方案',
  synthesizing: '正在整理内容机会', validating: '正在核验结果', completed: '已完成', partial: '部分完成',
  failed: '运行失败', cancelled: '已取消', interrupted: '已中断'
};

export const MAX_SELECTED_SOURCES = 5;
export const BODY_EXCERPT_CHARS = 4000;

export function isHeartbeatSource(source: TodaySource): boolean {
  const title = source.title || '';
  if (title.startsWith('[官宣巡检]')) return true;
  const categories = source.categories || [];
  if (categories.includes('wire_heartbeat') || categories.includes('official_heartbeat')) return true;
  const summary = (source.summary || '').trim();
  if (!summary) return true;
  if (summary.length < 80 && title && summary.includes(title.replace(/^\[官宣巡检\]\s*/, '').slice(0, 12))) return true;
  return false;
}

export function sortFeedSources(sources: TodaySource[]): TodaySource[] {
  return [...sources].sort((a, b) => {
    const ah = isHeartbeatSource(a) ? 1 : 0;
    const bh = isHeartbeatSource(b) ? 1 : 0;
    if (ah !== bh) return ah - bh;
    return String(b.collectedAt || '').localeCompare(String(a.collectedAt || ''));
  });
}

export function bodyToSelectedFields(body: {
  status: 'ready' | 'failed' | 'empty';
  extractedText: string;
  extractedChars: number;
} | null | undefined): Pick<SelectedTodaySource, 'bodyStatus' | 'bodyExcerpt' | 'bodyChars'> {
  if (!body) return { bodyStatus: 'none', bodyExcerpt: null, bodyChars: 0 };
  if (body.status === 'ready' && body.extractedText.trim()) {
    return {
      bodyStatus: 'ready',
      bodyExcerpt: body.extractedText.slice(0, BODY_EXCERPT_CHARS),
      bodyChars: body.extractedChars || body.extractedText.length
    };
  }
  return {
    bodyStatus: body.status,
    bodyExcerpt: null,
    bodyChars: body.extractedChars || 0
  };
}

export function latestSourceTime(sourceIds: string[], sources: TodaySource[]): { at: string | null; kind: 'published' | 'collected' | null } {
  let bestPublishedMs = Number.NEGATIVE_INFINITY;
  let bestPublished: string | null = null;
  let bestCollectedMs = Number.NEGATIVE_INFINITY;
  let bestCollected: string | null = null;
  for (const id of sourceIds) {
    const source = sources.find((item) => item.id === id);
    if (!source) continue;
    if (source.publishedAt) {
      const ms = Date.parse(source.publishedAt);
      if (!Number.isNaN(ms) && ms >= bestPublishedMs) {
        bestPublishedMs = ms;
        bestPublished = source.publishedAt;
      } else if (Number.isNaN(ms) && !bestPublished) {
        bestPublished = source.publishedAt;
      }
    }
    if (source.collectedAt) {
      const ms = Date.parse(source.collectedAt);
      if (!Number.isNaN(ms) && ms >= bestCollectedMs) {
        bestCollectedMs = ms;
        bestCollected = source.collectedAt;
      }
    }
  }
  if (bestPublished) return { at: bestPublished, kind: 'published' };
  if (bestCollected) return { at: bestCollected, kind: 'collected' };
  return { at: null, kind: null };
}

export type PriorityGrade = 'SSS' | 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export function priorityGrade(value: number | null | undefined): PriorityGrade {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'F';
  if (n === 0) return 'SSS';
  if (n === 1) return 'S';
  if (n === 2) return 'A';
  if (n === 3) return 'B';
  if (n === 4) return 'C';
  if (n === 5) return 'D';
  if (n === 6) return 'E';
  return 'F';
}

export function priorityLabel(value: number | null | undefined): string {
  return priorityGrade(value);
}
export function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.JSX.Element> = {
    today: <><path d="M3 5h18v16H3z"/><path d="M7 3v4M17 3v4M3 10h18"/></>,
    library: <><path d="M3 4h7l2 3h9v13H3z"/></>,
    discover: <><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.3 4.7-4.7 2.3 2.3-4.7z"/></>,
    knowledge: <><circle cx="12" cy="12" r="3"/><circle cx="4.5" cy="5" r="2"/><circle cx="19.5" cy="5" r="2"/><circle cx="4.5" cy="19" r="2"/><circle cx="19.5" cy="19" r="2"/><path d="m6 6.5 4.2 3.7M18 6.5l-4.2 3.7M6 17.5l4.2-3.7M18 17.5l-4.2-3.7"/></>,
    canvas: <><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.4 10.8 7.2-4.6M8.4 13.2l7.2 4.6"/></>,
    studio: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"/><path d="m13.5 7 3.5 3.5"/></>,
    publish: <><path d="m3 11 18-8-7 18-3-7z"/><path d="m11 14 10-11"/></>,
    results: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    diagnosis: <><path d="M12 2v4M5 5l3 3M2 12h4M5 19l3-3M12 22v-4M19 19l-3-3M22 12h-4M19 5l-3 3"/><circle cx="12" cy="12" r="3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></>
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

export function SourceList({ sources, open, close, openLibrary, aiSourcePresentation }: {
  sources: TodaySource[];
  open: boolean; close: () => void;
  openLibrary: (sourceId?: string) => void;
  aiSourcePresentation: boolean;
}): React.JSX.Element {
  const ordered = sortFeedSources(sources);
  return <aside className={`sources-panel${open ? ' open' : ''}`} aria-label="今日资料">
    <div className="panel-heading">
      <p className="eyebrow">今日资料 · {ordered.length}</p>
      <div><h2>完整入库列表</h2><button className="close-sources" aria-label="关闭今日资料" onClick={close}>×</button></div>
      <p>首页只展示最新最重要；这里看今日全部资料</p>
    </div>
    <div className="source-list">
      {ordered.map((source) => <article className="source-row" key={source.id}>
        <SourceMark canonicalUrl={source.canonicalUrl} aiSourcePresentation={aiSourcePresentation}/>
        <div>
          <span className="source-type">{isHeartbeatSource(source) ? '巡检打卡' : (source.categories[0] || '入库资料')}</span>
          <h3>{source.title}</h3>
          <p>{formatSourcePublishedAt(source.publishedAt) ?? (formatSourcePublishedAt(source.collectedAt) ? `入库 ${formatSourcePublishedAt(source.collectedAt)}` : '时间未知')}{source.author ? ` · ${source.author}` : (domainOf(source.canonicalUrl) ? ` · ${domainOf(source.canonicalUrl)}` : '')}</p>
        </div>
        {source.canonicalUrl && <button className="text-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}
      </article>)}
      {!ordered.length && <p className="empty-copy">今日还没有入库资料。</p>}
    </div>
    <button className="wide-secondary" onClick={() => openLibrary()}>打开资料库 <span>›</span></button>
  </aside>;
}


export function CreateIconButton({ onClick, primary }: { onClick: () => void; primary?: boolean }): React.JSX.Element {
  return <button
    type="button"
    className={`icon-action-button create-action${primary ? ' primary' : ''}`}
    aria-label="开始创作"
    title="开始创作"
    onClick={(event) => { event.stopPropagation(); onClick(); }}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
      <path
        d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m13.5 7 3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>;
}

export function Opportunity({ item, primary, selected, onToggle, onCreate, sources }: {
  item: TodayPlanItem; primary?: boolean; selected: boolean; onToggle: (item: TodayPlanItem) => void;
  onCreate: (item: TodayPlanItem) => void; sources: TodaySource[];
}): React.JSX.Element {
  const trend = item.trendEvidence.find((value) => value.viewsPerHour.status === 'value'); const trendText = trend?.viewsPerHour.status === 'value' ? `浏览 +${Math.round(trend.viewsPerHour.value).toLocaleString('zh-CN')}/小时${trend.velocityChange.status === 'value' ? ` · 加速 ${Math.round(trend.velocityChange.value).toLocaleString('zh-CN')}` : ''}` : null;
  const trendTitle = trend?.viewsPerHour.status === 'value' ? `快照 ${(trend.velocityChange.status === 'value' ? trend.velocityChange.snapshotIds : trend.viewsPerHour.snapshotIds).join('、')} · 最近采集 ${trend.snapshots.at(-1)?.capturedAt ?? '未知'}` : undefined;
  const sourceTime = latestSourceTime(item.sourceIds, sources);
  const timeText = formatSourcePublishedAt(sourceTime.at);
  const timeLabel = timeText
    ? (sourceTime.kind === 'collected' ? `入库 ${timeText}` : timeText)
    : '时间未知';
  if (!primary) return <article data-opportunity-card className={`opp-row${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>
    <strong className="opp-grade" data-grade={priorityGrade(item.priority)}>{priorityGrade(item.priority)}</strong>
    <div className="opp-main">
      <div className="opp-title">{item.title}</div>
      <div className="opp-why">{item.whyNow}</div>
      <div className="opp-meta">
        {item.platforms.map((value) => <span className={`pf-tag ${value}`} key={value}><PlatformMark platform={value}/>{platformNames[value] || value}</span>)}
        <span className="pill gray">引用资料 ×{item.sourceIds.length}</span>
        {trendText && <span className="pill violet" title={trendTitle}>{trendText}</span>}
      </div>
    </div>
    <span className="opportunity-check" aria-hidden="true">✓</span>
    <CreateIconButton onClick={() => onCreate(item)}/>
  </article>;
  return <article data-opportunity-card className={`opportunity-primary hero-card${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>
    <span className="opportunity-check" aria-hidden="true">✓</span>
    <div className="opportunity-tags hero-tags">
      <strong data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong>
      {item.platforms.map((value) => <span className={`pf-tag ${value}`} key={value}><PlatformMark platform={value}/>{platformNames[value] || value}</span>)}
      <span className="pill violet">时效 {item.timeliness}</span>
      <time dateTime={sourceTime.at ?? undefined}>{timeLabel}</time>
    </div>
    <h2>{item.title}</h2>
    <p className="hero-why">入选理由：{item.whyNow}</p>
    <div className="editorial-brief">
      <dl className="brief-core">
        <div><dt>表达角度</dt><dd>{item.angle}</dd></div>
        <div><dt>核心观点</dt><dd>{item.pointOfView}</dd></div>
      </dl>
      <section className="how-to">
        <h3>怎么讲</h3>
        <dl className="brief-how">
          <div><dt>标题</dt><dd>{item.titleGuidance}</dd></div>
          <div><dt>开头</dt><dd>{item.openingGuidance}</dd></div>
          <div><dt>结构</dt><dd>{item.structureGuidance}</dd></div>
        </dl>
      </section>
    </div>
    <footer className="hero-meta">
      <span className="pill gray">目标：{item.targetAudience}</span>
      <span className="pill gray">形式：{item.formats.map((value) => formatNames[value] || value).join('、')}</span>
      <span className="pill gray">引用资料 ×{item.sourceIds.length}</span>
      {trendText && <span className="pill violet" title={trendTitle}>{trendText}</span>}
      <CreateIconButton primary onClick={() => onCreate(item)}/>
    </footer>
  </article>;
}
