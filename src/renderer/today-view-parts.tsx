import type { TodayPlanItem, TodaySource } from '../main/workbench';
import { PlatformMark } from './platform-mark';
import { formatNames, platformNames } from './app-types';
import { poolBadgeClass, type PoolBadge } from './today-pool-view';
import { PROPAGATION_NEUTRAL_GRADE, resolvePropagationGrade } from '../shared/propagation.ts';
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

/** 信息流副标题：优先展示真实信源（作者 / 域名），不再用无信息的「入库资料」。 */
function isTrustedXHandle(value: string): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  if (v === '巡检打卡' || v === '未知作者' || v === '未知' || v === '账号暂不可见') return false;
  if (v.includes('巡检') || v.includes('打卡')) return false;
  if (/^@[A-Za-z0-9_]{1,15}$/.test(v)) return true;
  if (/^[A-Za-z0-9_]{1,15}$/.test(v)) return true;
  return false;
}

function normalizeXHandle(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v === '巡检打卡') return null;
  if (/^@[A-Za-z0-9_]{1,15}$/.test(v)) return v;
  if (/^[A-Za-z0-9_]{1,15}$/.test(v)) return `@${v}`;
  return null;
}

export function sourceOriginLabel(source: Pick<TodaySource, 'author' | 'canonicalUrl' | 'categories' | 'title' | 'summary'> & { pinned?: boolean }): string {
  if (source.pinned) return '重点';
  const host = domainOf(source.canonicalUrl);
  const isX = host === 'x.com' || host === 'twitter.com';
  if (isX) {
    const author = String(source.author || '').trim();
    const handle = author ? normalizeXHandle(author) : null;
    if (handle) return handle;
    // No trusted X handle: placeholder, never fallback to heartbeat/task label or generic X
    return '账号暂不可见';
  }
  if (isHeartbeatSource(source as TodaySource)) return '巡检打卡';
  const author = String(source.author || '').trim();
  if (author) {
    if (author.startsWith('@') || author.startsWith('http')) return author;
    if (/^[A-Za-z0-9_]{1,30}$/.test(author)) return `@${author}`;
    return author;
  }
  if (host === 'xiaohongshu.com' || host?.endsWith('.xiaohongshu.com')) return '小红书';
  if (host === 'mp.weixin.qq.com') return '公众号';
  if (host) return host;
  const category = (source.categories || []).find((item) => item && item !== '入库资料' && !item.endsWith('_heartbeat'));
  return category || '未知信源';
}

export type SelectedTodaySource = TodaySource & {
  bodyStatus?: 'none' | 'ready' | 'failed' | 'empty';
  bodyExcerpt?: string | null;
  bodyChars?: number;
};

export const phaseLabels: Record<string, string> = {
  starting: '正在启动', resume_pending: '等待恢复', resuming: '正在恢复', planning_sources: '正在规划来源',
  channel_preflight: '正在准备情报渠道', scanning_sources: '正在扫描来源', channel_scanned: '渠道扫描已完成',
  running_pi: '正在评估新资料并更新选题池', judging_opportunities: '正在评估新资料并更新选题池',
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
// Single shared pure resolver: visible propagation grade derives solely from completed score thresholds.
// Priority remains internal scheduling order only and is never used for display grade.
export type PropagationDisplayGrade = string;
export function resolveDisplayGrade(item: unknown): PropagationDisplayGrade {
  if (item && typeof item === 'object') {
    const status = (item as { planningStatus?: unknown }).planningStatus;
    if (status === 'ready_for_review') return '待审批';
    if (status === 'approved') return '已批准';
  }
  return resolvePropagationGrade(item);
}
export function isPendingDisplay(item: unknown): boolean {
  return resolvePropagationGrade(item) === PROPAGATION_NEUTRAL_GRADE;
}
export function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.JSX.Element> = {
    today: <><path d="M3 5h18v16H3z"/><path d="M7 3v4M17 3v4M3 10h18"/></>,
    agents: <><circle cx="8" cy="9" r="2.5"/><circle cx="16" cy="9" r="2.5"/><circle cx="12" cy="15.5" r="2.5"/><path d="M4 19c.8-2 2.6-3 4-3s3.2 1 4 3M12 19c.8-2 2.6-3 4-3s3.2 1 4 3"/></>,
    library: <><path d="M3 4h7l2 3h9v13H3z"/></>,
    discover: <><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.3 4.7-4.7 2.3 2.3-4.7z"/></>,
    proposals: <><path d="M6 3.5h12a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M9 8.5h6M9 12.5h6M9 16.5h3.5"/></>,
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

export function CreateIconButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return <button
    type="button"
    className="icon-action-button create-action"
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

export function DismissIconButton({ onClick, dismissLabel }: { onClick: () => void; dismissLabel?: string }): React.JSX.Element {
  const label = dismissLabel ?? '否掉这个机会';
  return <button
    type="button"
    className="icon-action-button dismiss-action"
    aria-label={label}
    title={`${label}，不再出现`}
    onClick={(event) => { event.stopPropagation(); onClick(); }}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
      <path d="M7 7l10 10" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round"/>
      <path d="M17 7L7 17" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round"/>
    </svg>
  </button>;
}

export function Opportunity({ item, primary, selected, onToggle, onCreate, sources, badges, onDismiss, dismissLabel }: {
  item: TodayPlanItem; primary?: boolean; selected: boolean; onToggle: (item: TodayPlanItem) => void;
  onCreate?: (item: TodayPlanItem) => void; sources: TodaySource[];
  badges?: PoolBadge[]; onDismiss?: () => void; dismissLabel?: string;
}): React.JSX.Element {
  const trend = item.trendEvidence.find((value) => value.viewsPerHour.status === 'value'); const trendText = trend?.viewsPerHour.status === 'value' ? `浏览 +${Math.round(trend.viewsPerHour.value).toLocaleString('zh-CN')}/小时${trend.velocityChange.status === 'value' ? ` · 加速 ${Math.round(trend.velocityChange.value).toLocaleString('zh-CN')}` : ''}` : null;
  const trendTitle = trend?.viewsPerHour.status === 'value' ? `快照 ${(trend.velocityChange.status === 'value' ? trend.velocityChange.snapshotIds : trend.viewsPerHour.snapshotIds).join('、')} · 最近采集 ${trend.snapshots.at(-1)?.capturedAt ?? '未知'}` : undefined;
  const sourceTime = latestSourceTime(item.sourceIds, sources);
  const timeText = formatSourcePublishedAt(sourceTime.at);
  const timeLabel = timeText
    ? (sourceTime.kind === 'collected' ? `入库 ${timeText}` : timeText)
    : '时间未知';
  const badgePills = badges?.length ? badges.map((badge) => <span key={badge.kind} className={`pill ${poolBadgeClass(badge)}`}>{badge.text}</span>) : null;
  const dismissButton = onDismiss ? <DismissIconButton onClick={onDismiss} dismissLabel={dismissLabel} /> : null;
  const actionCluster = () => (
    <div className="opp-actions" onClick={(event) => event.stopPropagation()}>
      {dismissButton}
      {onCreate ? <CreateIconButton onClick={() => onCreate(item)}/> : null}
    </div>
  );
  if (!primary) return <article data-opportunity-card className={`opp-row${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>
    <strong className="opp-grade" data-grade={resolveDisplayGrade(item)}>{resolveDisplayGrade(item)}</strong>
    <div className="opp-main">
      <div className="opp-title">{item.title}</div>
      <div className="opp-why">{item.whyNow}</div>
      <div className="opp-meta">
        {item.platforms.map((value) => <span className={`pf-tag ${value}`} key={value}><PlatformMark platform={value}/>{platformNames[value] || value}</span>)}
        <span className="pill gray">引用资料 ×{item.sourceIds.length}</span>
        {badgePills}
        {trendText && <span className="pill violet" title={trendTitle}>{trendText}</span>}
      </div>
    </div>

    {actionCluster()}
  </article>;
  return <article data-opportunity-card className={`opportunity-primary hero-card${selected ? ' selected' : ''}`} onClick={() => onToggle(item)} aria-selected={selected}>

    <div className="opportunity-tags hero-tags">
      <strong data-grade={resolveDisplayGrade(item)}>{resolveDisplayGrade(item)}</strong>
      {item.platforms.map((value) => <span className={`pf-tag ${value}`} key={value}><PlatformMark platform={value}/>{platformNames[value] || value}</span>)}
      <span className="pill violet">时效 {item.timeliness}</span>
      {badgePills}
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
      {actionCluster()}
    </footer>
  </article>;
}
