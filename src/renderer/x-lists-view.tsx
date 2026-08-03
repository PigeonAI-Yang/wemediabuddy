import { useEffect, useMemo, useRef, useState } from 'react';
import type { XListPiContext } from './app-types';
import { workspaceStorageKey } from './workspace-storage';
import { parseVisibleXListIds } from './x-list-visibility';
type ListIndex = Awaited<ReturnType<typeof window.wmb.readXListIndex>>;
type ListRef = ListIndex['lists'][number];
type Binding = Awaited<ReturnType<typeof window.wmb.listXListBindings>>[number];
type Detail = Awaited<ReturnType<typeof window.wmb.readXListDetail>>['detail'];
type TimelinePost = {
  url: string;
  authorHandle: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  text: string;
  postedAt: string | null;
  images?: string[];
  imageThumbs?: string[];
  hasVideo?: boolean;
  videoPoster?: string | null;
  videoUrl?: string | null;
  postKind?: 'tweet' | 'repost' | 'quote';
  repostedBy?: { handle: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  quotedPost?: TimelinePost | null;
  origin?: 'browse' | 'collect' | 'live';
  stale?: boolean;
  metrics?: {
    replies?: number | null;
    reposts?: number | null;
    likes?: number | null;
    bookmarks?: number | null;
    views?: number | null;
  };
};
type TimelinePostDetail = TimelinePost & { replies: TimelinePost[]; hasMoreReplies?: boolean };
const groupLabels: Record<ListRef['kind'], string> = { owned: '我创建的', following: '我关注的', member: '我在其中', unknown: '待确认' };
function toThumbUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/twimg\.com$/i.test(url.hostname) && !/\.twimg\.com$/i.test(url.hostname)) return value;
    url.searchParams.set('name', 'thumb');
    if (!url.searchParams.get('format')) url.searchParams.set('format', 'jpg');
    return url.toString();
  } catch {
    return value.replace(/([?&])name=\w+/i, '$1name=thumb');
  }
}
function postThumbs(post: { images?: string[] | null; imageThumbs?: string[] | null }): string[] {
  const source = (post.imageThumbs && post.imageThumbs.length ? post.imageThumbs : post.images) ?? [];
  return [...new Set(source.map(toThumbUrl))].slice(0, 4);
}
const TIMELINE_PAGE = 20;
function emptyMetrics(): NonNullable<TimelinePost['metrics']> {
  return { replies: null, reposts: null, likes: null, bookmarks: null, views: null };
}
function normalizeMetrics(value?: TimelinePost['metrics'] | null): NonNullable<TimelinePost['metrics']> {
  return {
    replies: value?.replies ?? null,
    reposts: value?.reposts ?? null,
    likes: value?.likes ?? null,
    bookmarks: value?.bookmarks ?? null,
    views: value?.views ?? null
  };
}
function formatMetric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(value % 100_000_000 === 0 ? 0 : 1)}亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(abs >= 100_000 ? 0 : 1)}万`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`.replace(/\.0K$/, 'K');
  return String(Math.round(value));
}
function MetricIcon({ name }: { name: 'reply' | 'repost' | 'like' | 'bookmark' | 'views' }): React.JSX.Element {
  if (name === 'reply') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.046 2.242l-4.148-.01h-.002c-4.374 0-7.8 3.427-7.8 7.802 0 4.098 3.186 7.206 7.465 7.37v3.828c0 .108.044.286.12.403.142.225.384.347.632.347.138 0 .277-.038.402-.118.264-.168 6.473-4.14 8.088-5.506 1.902-1.61 3.04-3.97 3.043-6.312v-.017c-.006-4.367-3.43-7.787-7.8-7.788z"/></svg>;
  }
  if (name === 'repost') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.77 15.67c-.292-.293-.767-.293-1.06 0l-2.22 2.22V7.65c0-2.068-1.683-3.75-3.75-3.75h-5.85c-.414 0-.75.336-.75.75s.336.75.75.75h5.85c1.24 0 2.25 1.01 2.25 2.25v10.24l-2.22-2.22c-.293-.293-.768-.293-1.061 0s-.293.768 0 1.061l3.5 3.5c.145.147.337.22.53.22s.383-.072.53-.22l3.5-3.5c.294-.292.294-.767.001-1.06zM13.44 18.85h-5.85c-1.24 0-2.25-1.01-2.25-2.25V6.36l2.22 2.22c.148.147.34.22.532.22s.384-.073.53-.22c.293-.293.293-.768 0-1.061l-3.5-3.5c-.293-.294-.768-.294-1.061 0l-3.5 3.5c-.294.292-.294.767 0 1.06s.767.294 1.06 0l2.22-2.22V16.6c0 2.068 1.683 3.75 3.75 3.75h5.85c.414 0 .75-.336.75-.75s-.337-.75-.75-.75z"/></svg>;
  }
  if (name === 'like') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.638h-.014C9.403 21.59 1.95 14.856 1.95 8.478c0-3.064 2.525-5.754 5.403-5.754 2.29 0 3.83 1.58 4.646 2.73.814-1.148 2.354-2.73 4.645-2.73 2.88 0 5.404 2.69 5.404 5.755 0 6.376-7.454 13.11-10.037 13.157H12z"/></svg>;
  }
  if (name === 'bookmark') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z"/></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10H6v10H4zm9.248 0v-7h2v7h-2z"/></svg>;
}
function PostMetrics({ metrics, emphasize = false }: { metrics?: TimelinePost['metrics'] | null; emphasize?: boolean }): React.JSX.Element {
  const values = normalizeMetrics(metrics);
  const items: Array<{ key: keyof NonNullable<TimelinePost['metrics']>; icon: 'reply' | 'repost' | 'like' | 'bookmark' | 'views'; label: string }> = [
    { key: 'replies', icon: 'reply', label: '回复' },
    { key: 'reposts', icon: 'repost', label: '转帖' },
    { key: 'likes', icon: 'like', label: '喜欢' },
    { key: 'bookmarks', icon: 'bookmark', label: '书签' },
    { key: 'views', icon: 'views', label: '查看' }
  ];
  return (
    <div className={`x-post-metrics${emphasize ? ' detail' : ''}`} aria-label="互动数据">
      {items.map((item) => {
        const raw = values[item.key] ?? null;
        const text = formatMetric(raw);
        return (
          <span key={item.key} className={`x-post-metric metric-${item.key}${raw == null ? ' empty' : ''}`} title={raw == null ? item.label : `${item.label} ${raw.toLocaleString('zh-CN')}`}>
            <MetricIcon name={item.icon} />
            <em>{text || (emphasize ? '—' : '')}</em>
          </span>
        );
      })}
    </div>
  );
}
const LIVE_PAGE = 20;
function PostVideo({ post, detail = false }: { post: Pick<TimelinePost, 'hasVideo' | 'videoPoster' | 'videoUrl' | 'url'>; detail?: boolean }): React.JSX.Element | null {
  if (!post.hasVideo && !post.videoUrl) return null;
  if (post.videoUrl && !/\.m3u8(?:$|\?)/i.test(post.videoUrl)) {
    return (
      <div className={`x-timeline-video player${detail ? ' detail' : ''}`}>
        <video
          src={post.videoUrl}
          poster={post.videoPoster || undefined}
          controls
          playsInline
          preload={detail ? 'metadata' : 'none'}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    );
  }
  return (
    <div className={`x-timeline-video${detail ? ' detail' : ''}`}>
      {post.videoPoster ? <img src={post.videoPoster} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span />}
      <em>▶ 视频</em>
      {detail && (
        <button type="button" className="x-video-open" onClick={(event) => { event.stopPropagation(); void window.wmb.openExternal(post.url); }}>
          在 X 播放
        </button>
      )}
    </div>
  );
}
function displayNameOf(post: Pick<TimelinePost, 'displayName' | 'authorHandle'>): string {
  const handle = post.authorHandle ?? '';
  return (post.displayName || (handle.startsWith('@') ? handle.slice(1) : handle) || '未知').trim();
}

function initialOf(name: string): string {
  return (name[0] || '?').toUpperCase();
}

function formatPostTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN');
}

function TimelineMedia({ post, detail = false }: { post: TimelinePost; detail?: boolean }): React.JSX.Element | null {
  const thumbs = postThumbs(post);
  if (!thumbs.length && !post.hasVideo && !post.videoUrl) return null;
  return (
    <div className={`x-timeline-media${detail ? ' detail' : ''} count-${Math.max(thumbs.length || (post.hasVideo || post.videoUrl ? 1 : 0), 1)}`}>
      {thumbs.map((src) => <div key={src} className="x-timeline-image"><img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" /></div>)}
      <PostVideo post={post} detail={detail} />
    </div>
  );
}

function QuoteCard({ post, onOpen }: { post: TimelinePost; onOpen?: (post: TimelinePost) => void }): React.JSX.Element {
  const handle = post.authorHandle ?? '未知作者';
  const display = displayNameOf(post);
  return (
    <div
      className="x-quote-card"
      role={onOpen ? 'link' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={(event) => {
        if (!onOpen) return;
        event.stopPropagation();
        onOpen(post);
      }}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onOpen(post);
        }
      }}
    >
      <header>
        <span className="x-quote-avatar" aria-hidden="true">
          {post.avatarUrl ? <img src={post.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : initialOf(display)}
        </span>
        <strong>{display}</strong>
        <span>{handle}</span>
        {post.postedAt ? <small>· {formatPostTime(post.postedAt)}</small> : null}
      </header>
      {!!post.text && <p>{post.text}</p>}
      <TimelineMedia post={post} />
    </div>
  );
}

function TimelineCard({
  post,
  onOpen,
  className = '',
  fullText = false,
  emphasizeMetrics = false
}: {
  post: TimelinePost;
  onOpen?: (post: TimelinePost) => void;
  className?: string;
  fullText?: boolean;
  emphasizeMetrics?: boolean;
}): React.JSX.Element {
  const handle = post.authorHandle ?? '未知作者';
  const display = displayNameOf(post);
  const reposter = post.postKind === 'repost' ? post.repostedBy : null;
  const reposterName = reposter
    ? (reposter.displayName || (reposter.handle?.startsWith('@') ? reposter.handle.slice(1) : reposter.handle) || '有人')
    : '';
  return (
    <article
      className={`x-timeline-item${className ? ` ${className}` : ''}${post.postKind === 'repost' ? ' is-repost' : ''}${post.postKind === 'quote' ? ' is-quote' : ''}`}
      onClick={onOpen ? () => onOpen(post) : undefined}
    >
      {reposter ? (
        <div className="x-social-context" aria-label="转发">
          <MetricIcon name="repost" />
          <span>{reposterName} 转帖了</span>
        </div>
      ) : null}
      <div className="x-timeline-main">
        <div className="x-timeline-avatar" aria-hidden="true">
          {post.avatarUrl ? <img src={post.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : initialOf(display)}
        </div>
        <div className="x-timeline-body">
          <header>
            <strong>{display}</strong>
            <span>{handle}</span>
            {post.postedAt ? <small>· {formatPostTime(post.postedAt)}</small> : null}
          </header>
          {!!post.text && <p className={fullText ? 'x-post-full-text' : undefined}>{post.text}</p>}
          <TimelineMedia post={post} detail={fullText} />
          {post.quotedPost ? <QuoteCard post={post.quotedPost} onOpen={onOpen} /> : null}
          <footer>
            <PostMetrics metrics={post.metrics} emphasize={emphasizeMetrics} />
          </footer>
        </div>
      </div>
    </article>
  );
}

export function XListsView({ workspaceId, onStatusChange, onContextChange }: {
  workspaceId: string; onStatusChange?: (status: { text: string; running?: boolean } | null) => void; onContextChange?: (context: XListPiContext | null) => void;
}): React.JSX.Element {
  const [index, setIndex] = useState<ListIndex | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const selectedListStorageKey = workspaceStorageKey(workspaceId, 'xListSelectedId'); const [selectedListId, setSelectedListId] = useState<string | null>(() => localStorage.getItem(selectedListStorageKey));
  const visibleListStorageKey = workspaceStorageKey(workspaceId, 'xListVisibleIds'); const [visibleListIds] = useState<string[] | null>(() => parseVisibleXListIds(localStorage.getItem(visibleListStorageKey)));
  const [kindFilter, setKindFilter] = useState<ListRef['kind'] | 'all'>(() => {
    const stored = localStorage.getItem('wmb.xListKindFilter');
    return stored === 'owned' || stored === 'following' || stored === 'member' || stored === 'unknown' || stored === 'all' ? stored : 'all';
  });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof window.wmb.readXListMembers>>['members'] | null>(null);
  const [posts, setPosts] = useState<TimelinePost[] | null>(null);
  const [postsHasMore, setPostsHasMore] = useState(false);
  const [postsOffset, setPostsOffset] = useState(0);
  const [postsMeta, setPostsMeta] = useState<{ origin: 'browse' | 'collect' | 'live'; fetchedAt?: string; stale?: boolean } | null>(null);
  const [selectedPost, setSelectedPost] = useState<TimelinePostDetail | null>(null);
  const [loadingPost, setLoadingPost] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const timelineRequestId = useRef(0);
  const indexRequestId = useRef(0);
  const selectedListIdRef = useRef<string | null>(selectedListId);
  const isIgnorableIndexError = (message: string) => /已切换到更新的 X 操作|旧请求已取消|superseded/i.test(message);

  const loadLocal = async (accountKey?: string) => {
    setBindings(await window.wmb.listXListBindings(accountKey));
  };
  useEffect(() => {
    const requestId = ++indexRequestId.current;
    const stillCurrent = () => requestId === indexRequestId.current;
    void (async () => {
      let cached: Awaited<ReturnType<typeof window.wmb.getCachedXListIndex>> = null;
      try { cached = await window.wmb.getCachedXListIndex(); }
      catch (error) { if (stillCurrent()) setNote((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '')); return; }
      if (!stillCurrent()) return;
      if (cached?.lists?.length) {
        setIndex(cached);
        setSelectedListId((current) => current && cached.lists.some((item) => item.listId === current) ? current : null);
        setNote(`已加载缓存 · ${cached.accountKey} · ${cached.lists.length} 个 List · ${new Date(cached.observation.capturedAt).toLocaleString('zh-CN')}`);
        await loadLocal(cached.accountKey);
        if (!stillCurrent()) return;
      }
    })();
    return () => {
      // Invalidate in-flight cache load if the view unmounts or remounts.
      if (indexRequestId.current === requestId) indexRequestId.current += 1;
    };
  }, []);

  const selected = index?.lists.find((item) => item.listId === selectedListId) ?? null;
  const selectedBinding = selected && index ? bindings.find((item) => item.accountKey.toLowerCase() === index.accountKey.toLowerCase() && item.listId === selected.listId) ?? null : null;
  const displayedListIds = visibleListIds ?? bindings.map((item) => item.listId);
  const displayedIdStamp = displayedListIds.join('|');
  const managedLists = useMemo(() => (index?.lists ?? []).filter((item) => displayedListIds.includes(item.listId)), [index, displayedIdStamp]);
  const groups = useMemo(() => (['owned', 'following', 'member', 'unknown'] as const).map((kind) => ({ kind, lists: managedLists.filter((item) => item.kind === kind) })).filter((group) => group.lists.length > 0), [managedLists]);
    const visibleLists = useMemo(() => {
    const rank = (kind: ListRef['kind']) => kind === 'owned' ? 0 : kind === 'member' ? 1 : kind === 'following' ? 2 : 3;
    const lists = [...managedLists].sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, 'zh-CN'));
    const filtered = kindFilter === 'all' ? lists : lists.filter((item) => item.kind === kindFilter);
    // Collapse exact same name+owner duplicates, keep higher-priority kind.
    const out: ListRef[] = [];
    const seen = new Set<string>();
    for (const item of filtered) {
      const key = `${(item.ownerHandle || '').toLowerCase()}::${item.name.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }, [managedLists, kindFilter]);
  const listLabel = (list: ListRef): string => {
    const sameName = (index?.lists ?? []).filter((item) => item.name === list.name).length > 1;
    if (!sameName) return list.name;
    const short = list.listId.slice(-4);
    const kind = groupLabels[list.kind] || list.kind;
    return `${list.name} · ${kind} · ${short}`;
  };
  useEffect(() => { selectedListIdRef.current = selectedListId; }, [selectedListId]);
  useEffect(() => {
    if (selectedListId) localStorage.setItem(selectedListStorageKey, selectedListId);
    else localStorage.removeItem(selectedListStorageKey);
  }, [selectedListId, selectedListStorageKey]);
  useEffect(() => { localStorage.setItem('wmb.xListKindFilter', kindFilter); }, [kindFilter]);
    useEffect(() => {
    if (!index) return;
    if (selectedListId && visibleLists.some((item) => item.listId === selectedListId)) return;
    // Prefer a same-name higher-priority list when the stored id was a dead duplicate.
    const current = index.lists.find((item) => item.listId === selectedListId) ?? null;
    if (current) {
      const better = visibleLists.find((item) => item.name === current.name && item.listId !== current.listId);
      if (better) {
        setSelectedListId(better.listId);
        return;
      }
    }
    setSelectedListId(visibleLists[0]?.listId ?? null);
  }, [index, kindFilter, visibleLists, selectedListId]);
  useEffect(() => {
    const indexStamp = index
      ? `${index.accountKey} · 列表更新于 ${new Date(index.observation.capturedAt).toLocaleString('zh-CN')}`
      : null;
    if (note) {
      onStatusChange?.({ text: note, running: working || loading });
      return;
    }
    if (!index) {
      onStatusChange?.(null);
      return;
    }
    if (!selected) {
      onStatusChange?.({ text: indexStamp!, running: working || loading });
      return;
    }
    const origin = postsMeta?.origin === 'browse'
      ? `缓存${postsMeta.stale ? '·旧' : ''}`
      : postsMeta?.origin === 'collect'
        ? '已采集'
        : postsMeta?.origin === 'live'
          ? '刚刚读取'
          : '未加载动态';
    const parts = [
      indexStamp,
      origin,
      postsMeta?.fetchedAt ? `动态更新于 ${new Date(postsMeta.fetchedAt).toLocaleString('zh-CN')}` : null,
      `ID ${selected.listId}`,
      detail?.isPrivate ? '私密' : '公开'
    ].filter(Boolean);
    onStatusChange?.({ text: parts.join(' · '), running: working || loading });
  }, [note, working, loading, onStatusChange, selected, postsMeta, detail?.isPrivate, index]);

  useEffect(() => {
    if (!onContextChange) return;
    const loaded = posts ?? [];
    // Adaptive text budget: more posts => shorter excerpts, but never silently drop loaded items.
    const textLimit = loaded.length > 80 ? 120
      : loaded.length > 40 ? 180
      : loaded.length > 20 ? 280
      : 500;
    const compact = (post: TimelinePost, replies?: TimelinePost[], limit = textLimit): XListPiContext['selectedPost'] | XListPiContext['visiblePosts'][number] => ({
      url: post.url,
      authorHandle: post.authorHandle ?? null,
      displayName: post.displayName ?? null,
      text: (post.text || '').slice(0, limit),
      postedAt: post.postedAt ?? null,
      hasVideo: !!post.hasVideo,
      imageCount: (post.images?.length || post.imageThumbs?.length || 0),
      ...(replies ? {
        replyCount: replies.length,
        replies: replies.slice(0, 30).map((reply) => ({
          url: reply.url,
          authorHandle: reply.authorHandle ?? null,
          displayName: reply.displayName ?? null,
          text: (reply.text || '').slice(0, 220),
          postedAt: reply.postedAt ?? null,
          hasVideo: !!reply.hasVideo,
          imageCount: (reply.images?.length || reply.imageThumbs?.length || 0)
        }))
      } : {})
    });
    if (selectedPost) {
      onContextChange({
        accountKey: index?.accountKey ?? null,
        listId: selectedListId,
        listName: selected?.name ?? detail?.name ?? null,
        listKind: selected?.kind ?? detail?.kind ?? null,
        mode: 'post',
        selectedPost: compact(selectedPost, selectedPost.replies, 2_000) as XListPiContext['selectedPost'],
        visiblePosts: [],
        loadedCount: loaded.length
      });
      return;
    }
    onContextChange({
      accountKey: index?.accountKey ?? null,
      listId: selectedListId,
      listName: selected?.name ?? detail?.name ?? null,
      listKind: selected?.kind ?? detail?.kind ?? null,
      mode: 'page',
      selectedPost: null,
      visiblePosts: loaded.map((post) => compact(post) as XListPiContext['visiblePosts'][number]),
      loadedCount: loaded.length
    });
  }, [onContextChange, index?.accountKey, selectedListId, selected?.name, selected?.kind, detail?.name, detail?.kind, selectedPost, posts]);

  useEffect(() => () => { onContextChange?.(null); }, [onContextChange]);
  useEffect(() => () => { onStatusChange?.(null); }, [onStatusChange]);


  const applyIndex = async (next: ListIndex, label: string) => {
    setIndex(next);
    setSelectedListId((current) => next.lists.some((item) => item.listId === current) ? current : null);
    setDetail(null); setMembers(null); setPosts(null); setPostsHasMore(false); setPostsOffset(0); setPostsMeta(null);
    await loadLocal(next.accountKey);
    setNote(label);
  };
  const loadIndex = async () => {
    const requestId = ++indexRequestId.current;
    const stillCurrent = () => requestId === indexRequestId.current;
    setLoading(true); setNote('');
    try {
      const next = await window.wmb.readXListIndex();
      if (!stillCurrent()) return;
      await applyIndex(next, `已读取 ${next.accountKey} 的 ${next.lists.length} 个可见 List。`);
    } catch (error) {
      if (!stillCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (isIgnorableIndexError(message)) return;
      setNote(message);
    } finally {
      if (stillCurrent()) setLoading(false);
    }
  };
  const loadCollectedTimeline = async (accountKey: string, listId: string, offset = 0, append = false) => {
    const page = await window.wmb.listCachedXListTimeline({ accountKey, listId, limit: TIMELINE_PAGE, offset });
    const mapped: TimelinePost[] = page.items.map((item) => ({
      url: item.originalUrl ?? item.id,
      authorHandle: item.author,
      displayName: item.author,
      avatarUrl: null,
      text: item.summary || item.title,
      postedAt: item.publishedAt ?? item.collectedAt,
      images: [],
      imageThumbs: [],
      hasVideo: false,
      videoPoster: null,
      videoUrl: null,
      metrics: emptyMetrics(),
      origin: 'collect' as const
    }));
    setPosts((current) => append && current ? [...current, ...mapped.filter((post) => !current.some((item) => item.url === post.url))] : mapped);
    setPostsHasMore(page.hasMore);
    setPostsOffset(offset + mapped.length);
    setPostsMeta({ origin: 'collect' });
    setMembers(null);
    return page;
  };
  const browseCacheRef = useRef<{
    accountKey: string;
    listId: string;
    posts: TimelinePost[];
    fetchedAt?: string;
    stale?: boolean;
  } | null>(null);

  const mapBrowsePost = (post: {
    url: string;
    authorHandle?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    text: string;
    postedAt?: string | null;
    images?: string[];
    imageThumbs?: string[];
    hasVideo?: boolean;
    videoPoster?: string | null;
    videoUrl?: string | null;
    postKind?: 'tweet' | 'repost' | 'quote';
    repostedBy?: { handle: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
    quotedPost?: {
      url: string;
      authorHandle?: string | null;
      displayName?: string | null;
      avatarUrl?: string | null;
      text: string;
      postedAt?: string | null;
      images?: string[];
      imageThumbs?: string[];
      hasVideo?: boolean;
      videoPoster?: string | null;
      videoUrl?: string | null;
      metrics?: Parameters<typeof normalizeMetrics>[0];
    } | null;
    metrics?: Parameters<typeof normalizeMetrics>[0];
  }, stale?: boolean): TimelinePost => ({
    url: post.url,
    authorHandle: post.authorHandle ?? null,
    displayName: post.displayName ?? post.authorHandle ?? null,
    avatarUrl: post.avatarUrl ?? null,
    text: post.text,
    postedAt: post.postedAt ?? null,
    images: post.images ?? [],
    imageThumbs: post.imageThumbs ?? post.images ?? [],
    hasVideo: Boolean(post.hasVideo),
    videoPoster: post.videoPoster ?? null,
    videoUrl: post.videoUrl ?? null,
    postKind: post.postKind ?? 'tweet',
    repostedBy: post.repostedBy ?? null,
    quotedPost: post.quotedPost ? mapBrowsePost(post.quotedPost, stale) : null,
    metrics: normalizeMetrics(post.metrics),
    origin: 'browse' as const,
    stale
  });

  const loadBrowseTimeline = async (accountKey: string, listId: string) => {
    const cached = await window.wmb.getCachedXListTimeline({ accountKey, listId });
    if (!cached?.payload?.posts?.length) {
      browseCacheRef.current = null;
      return null;
    }
    const all = cached.payload.posts.map((post) => mapBrowsePost(post, cached.stale));
    browseCacheRef.current = {
      accountKey,
      listId,
      posts: all,
      fetchedAt: cached.fetchedAt,
      stale: cached.stale
    };
    const first = all.slice(0, TIMELINE_PAGE);
    setPosts(first);
    // Cache-first UI: keep hasMore true while local cache or live feed may still have more.
    setPostsHasMore(all.length > first.length || true);
    setPostsOffset(first.length);
    setPostsMeta({ origin: 'browse', fetchedAt: cached.fetchedAt, stale: cached.stale });
    setMembers(null);
    return cached;
  };

  const applyLiveTimeline = (result: Awaited<ReturnType<typeof window.wmb.readXListTimeline>>, append = false) => {
    const mapped = result.posts.map((post) => ({ ...post, metrics: normalizeMetrics(post.metrics), origin: 'live' as const }));
    // Keep memory/cache page aligned with what the UI already has, so next load-more can stay local.
    if (index && selectedListId) {
      const previous = browseCacheRef.current;
      const sameList = previous && previous.accountKey === index.accountKey && previous.listId === selectedListId;
      const base = sameList ? previous.posts : [];
      const seen = new Set(base.map((item) => item.url.replace(/[?#].*$/, '')));
      const merged = [...base];
      for (const post of mapped) {
        const key = post.url.replace(/[?#].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(post);
      }
      browseCacheRef.current = {
        accountKey: index.accountKey,
        listId: selectedListId,
        posts: merged,
        fetchedAt: result.detail.observation?.capturedAt,
        stale: false
      };
    }
    setPosts((current) => {
      if (!append || !current?.length) return mapped;
      const seen = new Set(current.map((item) => item.url));
      return [...current, ...mapped.filter((item) => !seen.has(item.url))];
    });
    setPostsHasMore(mapped.length > 0 && Boolean(result.hasMore));
    setPostsOffset((current) => append ? current + mapped.length : mapped.length);
    setPostsMeta({ origin: 'live', fetchedAt: result.detail.observation?.capturedAt });
    setDetail(result.detail);
    setMembers(null);
  };
  const chooseList = (list: ListRef) => {
    // Bump generation immediately so any in-flight response for the previous list is ignored.
    timelineRequestId.current += 1;
    browseCacheRef.current = null;
    setSelectedListId(list.listId);
    setDetail(null);
    setMembers(null);
    setPosts(null);
    setPostsHasMore(false);
    setPostsOffset(0);
    setPostsMeta(null);
    setSelectedPost(null);
    setLoadingMore(false);
    setWorking(false);
    setNote('正在切换列表…');
  };
  useEffect(() => {
    if (!index || !selectedListId) return;
    const requestId = ++timelineRequestId.current;
    const listId = selectedListId;
    const stillCurrent = () => requestId === timelineRequestId.current && selectedListIdRef.current === listId;
    void (async () => {
      try {
        const browse = await loadBrowseTimeline(index.accountKey, listId);
        if (!stillCurrent()) return;
        if (browse) {
          setNote(browse.stale
            ? `缓存较旧 · 更新于 ${new Date(browse.fetchedAt).toLocaleString('zh-CN')}（未自动刷新）`
            : `已加载浏览缓存 · 更新于 ${new Date(browse.fetchedAt).toLocaleString('zh-CN')}`);
          return;
        }
        const binding = bindings.find((item) => item.accountKey.toLowerCase() === index.accountKey.toLowerCase() && item.listId === listId);
        if (binding) {
          const page = await loadCollectedTimeline(index.accountKey, listId, 0, false);
          if (!stillCurrent()) return;
          if (page.items.length) {
            setNote(`已加载已采集动态 ${page.items.length} 条${page.hasMore ? '，可继续加载' : ''}。`);
            return;
          }
        }
        if (!stillCurrent()) return;
        // No local preview: fetch live once so the feed is not stuck empty.
        setWorking(true);
        setNote('正在读取动态…');
        try {
          const result = await window.wmb.readXListTimeline({ listId, limit: LIVE_PAGE });
          if (!stillCurrent()) return;
          applyLiveTimeline(result, false);
          setNote(result.posts.length ? `刚刚读取 ${result.posts.length} 条当前动态，并写入浏览缓存。` : `这个 List 当前没有可读动态（可能为空、失效或权限不足）。`);
        } catch (error) {
          if (!stillCurrent()) return;
          const message = error instanceof Error ? error.message : String(error);
          // Stale request cancelled by a newer list switch — ignore.
          if (/已切换到更新的 X 操作|旧请求已取消|superseded/i.test(message)) return;
          setNote(message);
        } finally {
          if (stillCurrent()) setWorking(false);
        }
      } catch (error) {
        if (!stillCurrent()) return;
        const message = error instanceof Error ? error.message : String(error);
        if (/已切换到更新的 X 操作|旧请求已取消|superseded/i.test(message)) return;
        setNote(message);
      }
    })();
    return () => {
      // Invalidate this effect instance; a newer selectedListId owns the page.
      if (timelineRequestId.current === requestId) timelineRequestId.current += 1;
    };
  }, [index?.accountKey, selectedListId, bindings.map((item) => `${item.listId}:${item.enabled}:${item.revision}`).join('|')]);
  const readDetail = async () => {
    if (!selected) return;
    setWorking(true); setNote('');
    try { const result = await window.wmb.readXListDetail(selected.listId); setDetail(result.detail); setNote('已读取当前 List 详情。'); }
    catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  };
  const readMembers = async () => {
    if (!selected) return;
    setWorking(true); setNote('');
    try { const result = await window.wmb.readXListMembers(selected.listId); setDetail(result.detail); setMembers(result.members); setPosts(null); setPostsMeta(null); setNote(`已读取当前可见的 ${result.members.length} 位成员。`); }
    catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  };
  const readTimeline = async (forceLive = false) => {
    if (!selected || !index) return;
    const requestId = ++timelineRequestId.current;
    const listId = selected.listId;
    const stillCurrent = () => requestId === timelineRequestId.current && selectedListIdRef.current === listId;
    setWorking(true); setNote(forceLive ? '正在刷新动态…' : '');
    try {
      if (!forceLive) {
        const browse = await loadBrowseTimeline(index.accountKey, listId);
        if (!stillCurrent()) return;
        if (browse?.payload.posts.length) {
          setNote(browse.stale
            ? `缓存较旧 · 更新于 ${new Date(browse.fetchedAt).toLocaleString('zh-CN')}。可点刷新动态。`
            : `已加载浏览缓存 ${browse.payload.posts.length} 条 · 更新于 ${new Date(browse.fetchedAt).toLocaleString('zh-CN')}`);
          return;
        }
        if (selectedBinding) {
          const page = await loadCollectedTimeline(index.accountKey, listId, 0, false);
          if (!stillCurrent()) return;
          if (page.items.length) {
            setNote(`已加载已采集动态 ${page.items.length} 条${page.hasMore ? '，可继续加载或刷新动态' : ''}。`);
            return;
          }
        }
      }
      const result = await window.wmb.readXListTimeline({ listId, limit: LIVE_PAGE });
      if (!stillCurrent()) return;
      applyLiveTimeline(result, false);
      setNote(result.posts.length ? `刚刚读取 ${result.posts.length} 条当前动态，并写入浏览缓存。` : `这个 List 当前没有可读动态（可能为空、失效或权限不足）。`);
    } catch (error) {
      if (!stillCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/已切换到更新的 X 操作|旧请求已取消|superseded/i.test(message)) return;
      setNote(message);
    } finally {
      if (stillCurrent()) setWorking(false);
    }
  };
  const loadMoreTimeline = async () => {
    if (!selected || !index || working || loadingMore || !postsHasMore) return;
    const listId = selected.listId;
    const stillCurrent = () => selectedListIdRef.current === listId;
    setLoadingMore(true);
    setNote('正在加载更多…');
    // Hard UI watchdog: never leave the footer spinner stuck even if main hangs.
    const watchdog = window.setTimeout(() => {
      if (selectedListIdRef.current === listId) {
        setLoadingMore(false);
        setNote((current) => current === '正在加载更多…' ? '加载更多超时，请再试一次。' : current);
      }
    }, 18_000);
    try {
      if (postsMeta?.origin === 'collect' && selectedBinding) {
        const page = await loadCollectedTimeline(index.accountKey, listId, postsOffset, true);
        if (!stillCurrent()) return;
        if (!page.items.length) setPostsHasMore(false);
        setNote(page.items.length ? `已继续加载 ${page.items.length} 条已采集动态。` : '没有更多已采集动态。');
        return;
      }

      // 1) Local page from seeded browse/live memory. This must never timeout.
      const local = browseCacheRef.current;
      if (local && local.accountKey === index.accountKey && local.listId === listId) {
        const shown = new Set((posts ?? []).map((item) => item.url.replace(/[?#].*$/, '')));
        const localNext = local.posts
          .filter((item) => !shown.has(item.url.replace(/[?#].*$/, '')))
          .slice(0, LIVE_PAGE);
        if (localNext.length > 0) {
          setPosts((current) => {
            const base = current ?? [];
            const seen = new Set(base.map((item) => item.url.replace(/[?#].*$/, '')));
            return [...base, ...localNext.filter((item) => !seen.has(item.url.replace(/[?#].*$/, '')))];
          });
          setPostsOffset((current) => current + localNext.length);
          const remainingLocal = local.posts.some((item) => {
            const key = item.url.replace(/[?#].*$/, '');
            return !shown.has(key) && !localNext.some((post) => post.url.replace(/[?#].*$/, '') === key);
          });
          setPostsHasMore(remainingLocal || true);
          setNote(remainingLocal
            ? `已追加 ${localNext.length} 条缓存，可继续下拉。`
            : `已追加 ${localNext.length} 条缓存。继续下拉将尝试读取更新。`);
          return;
        }
      }

      // 2) Live continuation only after local cache is exhausted.
      const knownUrls = (posts ?? []).map((item) => item.url).filter(Boolean);
      const result = await window.wmb.readXListTimeline({
        listId,
        limit: LIVE_PAGE,
        knownUrls
      });
      if (!stillCurrent()) return;
      const existing = new Set((posts ?? []).map((item) => item.url.replace(/[?#].*$/, '')));
      const uniqueNew = result.posts.filter((item) => !existing.has(item.url.replace(/[?#].*$/, '')));
      if (uniqueNew.length > 0) {
        applyLiveTimeline({ ...result, posts: uniqueNew }, true);
        setPostsHasMore(Boolean(result.hasMore));
        setNote(result.hasMore ? `已追加 ${uniqueNew.length} 条，可继续下拉。` : `已追加 ${uniqueNew.length} 条。`);
        return;
      }
      // Empty page is not proof of end-of-feed when scraper is flaky. Keep retry enabled.
      setPostsHasMore(true);
      setNote('这轮没抓到新动态，再下拉或点一次加载更多重试。');
    } catch (error) {
      if (!stillCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/已切换到更新的 X 操作|旧请求已取消|superseded/i.test(message)) return;
      setNote(/超时/.test(message) ? '加载更多超时，请再试一次。' : message);
      setPostsHasMore(true);
    } finally {
      window.clearTimeout(watchdog);
      setLoadingMore(false);
    }
  };
  const openPost = async (post: TimelinePost) => {
    // optimistic shell first: show known post body immediately, fill full text/comments after.
    setSelectedPost({
      ...post,
      images: post.images ?? [],
      imageThumbs: post.imageThumbs ?? post.images ?? [],
      metrics: normalizeMetrics(post.metrics),
      replies: [],
      hasMoreReplies: true
    });
    setLoadingPost(true);
    setNote('正在加载完整帖子…');
    try {
      // Prefer fresh detail so truncated timeline text and missing metrics get replaced.
      const result = await window.wmb.readXListPost({ statusUrl: post.url, replyLimit: 30, bypassCache: true });
      const detailText = (result.post.text || '').trim();
      const shellText = (post.text || '').trim();
      setSelectedPost({
        ...result.post,
        text: detailText.length >= shellText.length ? detailText : shellText,
        origin: result.cached ? 'browse' : 'live',
        imageThumbs: result.post.imageThumbs ?? result.post.images ?? [],
        images: result.post.images ?? [],
        videoUrl: result.post.videoUrl ?? post.videoUrl ?? null,
        videoPoster: result.post.videoPoster ?? post.videoPoster ?? null,
        postKind: result.post.postKind ?? post.postKind ?? 'tweet',
        repostedBy: result.post.repostedBy ?? post.repostedBy ?? null,
        quotedPost: result.post.quotedPost ?? post.quotedPost ?? null,
        metrics: normalizeMetrics(result.post.metrics ?? post.metrics),
        replies: (result.post.replies ?? []).map((item) => ({
          ...item,
          imageThumbs: item.imageThumbs ?? item.images ?? [],
          images: item.images ?? [],
          metrics: normalizeMetrics(item.metrics)
        }))
      });
      setNote(result.cached ? '已加载帖子缓存。' : '已加载完整帖子。');
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingPost(false);
    }
  };
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = feedRef.current;
    if (!node) return;
    const onScroll = () => {
      if (!postsHasMore || working || loadingMore) return;
      if (node.scrollTop + node.clientHeight < node.scrollHeight - 240) return;
      void loadMoreTimeline();
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [postsHasMore, working, loadingMore, postsMeta?.origin, postsOffset, selectedListId, posts?.length]);
  const collectTimeline = async () => {
    if (!selectedBinding?.enabled || !index) return;
    setWorking(true); setNote('');
    try {
      const result = await window.wmb.collectXListTimeline({ accountKey: selectedBinding.accountKey, listId: selectedBinding.listId, limit: 50 });
      if (!result.ok) setNote(result.error.message);
      else {
        await loadLocal(index.accountKey);
        const browse = await loadBrowseTimeline(index.accountKey, selectedBinding.listId);
        if (browse?.payload.posts.length) {
          setNote(`已写入 ${result.data.sourceIds.length} 条可追溯资料，并更新浏览缓存 ${browse.payload.posts.length} 条。`);
        } else {
          const page = await loadCollectedTimeline(index.accountKey, selectedBinding.listId, 0, false);
          setNote(`已写入 ${result.data.sourceIds.length} 条可追溯资料，当前可见 ${page.items.length} 条。`);
        }
      }
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  };
  return <section className="x-lists-view">
    {!index ? <section className="empty-state library-empty">
      <h2>尚未读取 X List</h2>
      <p>{note || '使用 WMB 共享的 X 登录态读取列表；只有登录失效时才需前台接管。'}</p>
      <button className="refresh-button" disabled={loading} onClick={() => void loadIndex()}>{loading ? '读取中…' : '读取 X Lists'}</button>
    </section> : <>
      <div className="discover-sources" aria-label="List 分组">
        <button className={`chip${kindFilter === 'all' ? ' on' : ''}`} onClick={() => setKindFilter('all')}>已显示<span className="chip-count">{managedLists.length}</span></button>
        {groups.map((group) => <button key={group.kind} className={`chip${kindFilter === group.kind ? ' on' : ''}`} onClick={() => setKindFilter(group.kind)}>{groupLabels[group.kind]}<span className="chip-count">{group.lists.length}</span></button>)}
      </div>
      <div className="page-toolbar ranking-toolbar x-list-toolbar">
        <div className="filter-row" aria-label="X Lists">
          {visibleLists.map((list) => {
            const binding = bindings.find((item) => item.accountKey.toLowerCase() === index.accountKey.toLowerCase() && item.listId === list.listId);
            return <button
              key={list.listId}
              className={`filter${selected?.listId === list.listId ? ' active' : ''}${binding?.enabled ? ' context-selected' : ''}`}
              onClick={() => chooseList(list)}
              title={binding?.enabled ? '已接入发现' : list.ownerHandle ?? list.listId}
            >{binding?.enabled ? '✓ ' : ''}{listLabel(list)}</button>;
          })}
          {visibleLists.length === 0 && <span className="x-list-empty-inline">当前分组没有 List</span>}
        </div>
        <div className="ranking-actions">
          <button className="refresh-button" disabled={loading || working} title={loading ? '正在刷新列表' : '刷新列表'} aria-label={loading ? '正在刷新列表' : '刷新列表'} onClick={() => void loadIndex()}><span className={loading ? 'ranking-refresh-spinning' : ''} aria-hidden="true">↻</span></button>
        </div>
      </div>
      
      {selected ? <div className="x-lists-main">
        <div className="x-list-feed-head">
          <div className="x-list-feed-actions">
            <button disabled={working} onClick={() => void readTimeline(true)}>刷新动态</button>
            <button disabled={working} onClick={() => void readMembers()}>成员</button>
            <button disabled={working} onClick={() => void readDetail()}>详情</button>
            {selectedBinding?.enabled && <button disabled={working} onClick={() => void collectTimeline()}>采集一批</button>}
          </div>
        </div>
        
        {members && <section className="x-list-member-strip" aria-label="成员"><div className="x-list-member-grid">{members.map((member) => <span key={member.handle}><b>{member.displayName}</b><small>{member.handle}</small></span>)}</div></section>}
        {selectedPost ? null : working && !posts ? <section className="ranking-loading">正在读取动态…</section>
          : !posts ? <section className="empty-state library-empty"><h2>还没有动态</h2><p>点「刷新动态」读取当前 List。</p><button disabled={working} onClick={() => void readTimeline(true)}>刷新动态</button></section>
          : posts.length === 0 ? <section className="empty-state library-empty"><h2>当前没有可读动态</h2><p>本次读取没有返回帖子，可以重新读取。</p><button disabled={working} onClick={() => void readTimeline(true)}>重新读取</button></section>
          : <div className="x-timeline-feed" aria-label="List 动态" ref={feedRef}>
            {posts.map((post) => (
              <TimelineCard key={post.url} post={post} onOpen={(item) => void openPost(item)} />
            ))}
            {postsHasMore && <div className="x-timeline-more"><button disabled={working || loadingMore} onClick={() => void loadMoreTimeline()}>{loadingMore ? '加载中…' : '加载更多'}</button></div>}
            {!postsHasMore && posts.length > 0 && <div className="x-timeline-end">已经到底了</div>}
          </div>}
        {selectedPost && <section className="x-post-detail" aria-label="帖子详情">
          <header className="x-post-detail-head">
            <button type="button" onClick={() => setSelectedPost(null)}>← 返回动态</button>
            <button type="button" onClick={() => void window.wmb.openExternal(selectedPost.url)}>在 X 打开</button>
          </header>
          <TimelineCard post={selectedPost} className="main" fullText emphasizeMetrics />
          <div className="x-post-replies-head">评论 {selectedPost.replies.length}{selectedPost.hasMoreReplies ? '+' : ''}</div>
          {loadingPost ? <section className="ranking-loading">正在读取评论…</section> : selectedPost.replies.length === 0 ? <p className="x-post-empty-replies">暂无评论</p> : <div className="x-post-replies">
            {selectedPost.replies.map((reply) => (
              <TimelineCard key={reply.url} post={reply} className="reply" onOpen={(item) => void openPost(item)} />
            ))}
          </div>}
        </section>}
      </div> : <section className="empty-state library-empty"><h2>选择一个 List</h2></section>}
    </>}
  </section>;
}
