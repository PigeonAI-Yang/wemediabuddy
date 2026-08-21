import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceStorageKey } from './workspace-storage';
import { TopicMaintenanceLedger } from './topic-maintenance-ledger.tsx';
import {
  useKnowledgeLog,
  useWikiIndexSummary,
  useWikiSearch,
} from './wiki-discovery';
import { isTopicLogSupplementary, topicIndexStatusLabel } from './topic-search-log';
import type {
  KnowledgeHealthIssueRecord,
  KnowledgeUpdateReceiptRecord,
  KnowledgeUsageRecordRecord,
  KnowledgeWikiPageVersionRecord,
} from '../shared/knowledge-flywheel';
import type { KnowledgeCompileState } from '../shared/knowledge-compile-state';
import type {
  TopicWikiDetail,
  TopicWikiKeyConclusion,
  TopicEvidenceEntry,
} from '../shared/knowledge-topic-library';
import {
  asNumber,
  asRecord,
  asString,
  errorMessage,
  formatRelativeTime,
  formatWhen,
  itemKey,
  listTopicMeta,
  normalizeDossierPage,
  normalizeKnowledgeContext,
  normalizeTopicListPage,
  normalizeTopicWikiDetail,
  patchSourceItem,
  prettyJsonish,
  relationLabel,
  topicStatusClass,
  topicStatusLabel,
} from './library-topics-helpers';
import type {
  ContextOpportunity,
  DossierCategory,
  DossierCounts,
  DossierItem,
  DossierTopic,
  ManagementStatus,
  TopicListItem,
  TopicStatusFilter,
  VerificationStatus,
  WorkspaceSegment,
} from './library-topics-helpers';
import {
  COMPILE_STATE_LABELS,
  DEEP_LIMIT,
  DOSSIER_CATEGORY_ORDER,
  DOSSIER_LABELS,
  EMPTY_COUNTS,
  LIST_LIMIT,
  OPEN_TOPIC_EVENT,
  QUERY_DEBOUNCE_MS,
  SEGMENT_LIMIT,
  STATUS_FILTERS,
  WIDE_RAIL_MQ,
  WIKI_DETAIL_LIMITS,
  WIKI_SECTION_ORDER,
  WIKI_SECTION_TAB,
} from './library-topics-constants';
import type { WikiSectionId, WikiTabId } from './library-topics-constants';
import {
  DeepItemCard,
  KeyConclusionCard,
  MethodFindingsSection,
  SourceCard,
  TopicActivityBody,
  TopicSearchBody,
  WikiEvidenceCard,
  WikiHealthCard,
  WikiReceiptCard,
  WikiUsageCard,
  WikiVersionCard,
} from './library-topics-parts';
import { WikiPageView } from './library-topics-wiki';
import type { LibraryTopicPiContext } from './library-topics-helpers';
export type { LibraryTopicPiContext } from './library-topics-helpers';

export function LibraryTopicsView(props: {
  workspaceId: string | null;
  initialTopicId?: string | null;
  onTopicContextChange?: (ctx: LibraryTopicPiContext) => void;
  onOpenStudio?: (projectId: string) => void;
  onGoStudio?: () => void;
  onOpenCanvas?: (canvasId?: string) => void;
  onOpenPi?: () => void;
  piConfigured?: boolean;
  aiSourcePresentation?: boolean;
}): React.JSX.Element {
  const {
    workspaceId,
    initialTopicId = null,
    onTopicContextChange,
    onOpenStudio,
    onGoStudio,
    onOpenCanvas,
    onOpenPi,
    piConfigured = false,
    aiSourcePresentation = false,
  } = props;

  const [topics, setTopics] = useState<TopicListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listHasMore, setListHasMore] = useState(false);
  const [listTotal, setListTotal] = useState(0);
  const [listReloadToken, setListReloadToken] = useState(0);
  const [topicQuery, setTopicQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TopicStatusFilter>('all'); const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [focusedTopicId, setFocusedTopicId] = useState<string | null>(null);
  const [segment, setSegment] = useState<WorkspaceSegment>('judgments');
  const [segmentReloadToken, setSegmentReloadToken] = useState(0);
  const [deepMode, setDeepMode] = useState(false);
  const [deepCategory, setDeepCategory] = useState<DossierCategory | ''>('');
  const [deepReloadToken, setDeepReloadToken] = useState(0);
  // WMB-5212 M3：Topic Wiki 详情（Wiki-first 默认；dossier 兜底仍可达）。
  const [wikiDetail, setWikiDetail] = useState<TopicWikiDetail | null>(null);
  const [wikiError, setWikiError] = useState<string | null>(null);
  const [wikiReloadToken, setWikiReloadToken] = useState(0);
  const [wikiTab, setWikiTab] = useState<WikiTabId>('overview');
  // WMB-5239：主题原位「搜索本主题资料 / 相关动态」（topicId 限定当前主题范围；无主题时不发 IPC）。
  const [topicSearchQuery, setTopicSearchQuery] = useState('');
  const topicScopeId = selectedTopicId ?? undefined;
  const topicScopeEnabled = Boolean(selectedTopicId);
  const topicSearch = useWikiSearch({ query: topicSearchQuery, topicId: topicScopeId, enabled: topicScopeEnabled, limit: 12 });
  const topicActivity = useKnowledgeLog({ topicId: topicScopeId, enabled: topicScopeEnabled, limit: 30 });
  const { summary: indexSummary, error: indexError } = useWikiIndexSummary({ enabled: topicScopeEnabled });
  const indexHint = indexError ? '检索状态暂不可用' : topicIndexStatusLabel(indexSummary);
  const topicActivityEntries = useMemo(
    () => topicActivity.entries.filter((entry) => isTopicLogSupplementary(entry)),
    [topicActivity.entries],
  );
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const wikiLoadSeq = useRef(0);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [canvasMessage, setCanvasMessage] = useState<string | null>(null);
  const [sourceActionError, setSourceActionError] = useState<string | null>(null);
  const [sourceUpdatingId, setSourceUpdatingId] = useState<string | null>(null);
  const [wideLayout, setWideLayout] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(WIDE_RAIL_MQ).matches;
  });

  const [headerTopic, setHeaderTopic] = useState<DossierTopic | null>(null);
  const [counts, setCounts] = useState<DossierCounts>(EMPTY_COUNTS);

  const [judgments, setJudgments] = useState<DossierItem[]>([]);
  const [methodFindings, setMethodFindings] = useState<DossierItem[]>([]);
  const [sources, setSources] = useState<DossierItem[]>([]);
  const [counterEvidence, setCounterEvidence] = useState<DossierItem[]>([]);
  const [sourcesPreview, setSourcesPreview] = useState<DossierItem[]>([]);
  const [contentHistory, setContentHistory] = useState<DossierItem[]>([]);
  const [metrics, setMetrics] = useState<DossierItem[]>([]);
  const [reviews, setReviews] = useState<DossierItem[]>([]);
  const [opportunities, setOpportunities] = useState<ContextOpportunity[]>([]);
  const [expandedReviews, setExpandedReviews] = useState<Record<string, boolean>>({});

  const [segmentLoading, setSegmentLoading] = useState(false);
  const [segmentError, setSegmentError] = useState<string | null>(null);

  const [deepItems, setDeepItems] = useState<DossierItem[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepLoadingMore, setDeepLoadingMore] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);
  const [deepHasMore, setDeepHasMore] = useState(false);
  const [deepTotal, setDeepTotal] = useState(0);

  const selectedTopicIdRef = useRef<string | null>(selectedTopicId);
  const topicsRef = useRef<TopicListItem[]>([]);
  const onTopicContextChangeRef = useRef(onTopicContextChange);
  const segmentLoadSeq = useRef(0);
  const listLoadSeq = useRef(0);
  const deepLoadSeq = useRef(0);
  const lastEmittedKeyRef = useRef<string | null>(null);
  const listPaneRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const preferIdOnListLoadRef = useRef<string | null>(null);

  useEffect(() => {
    selectedTopicIdRef.current = selectedTopicId;
  }, [selectedTopicId]);

  useEffect(() => {
    topicsRef.current = topics;
  }, [topics]);

  useEffect(() => {
    onTopicContextChangeRef.current = onTopicContextChange;
  }, [onTopicContextChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(topicQuery.trim()), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [topicQuery]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(WIDE_RAIL_MQ);
    const onChange = () => setWideLayout(media.matches);
    onChange();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  const emitContext = useCallback((topicId: string | null, title?: string | null) => {
    const nextKey = topicId && title ? `${topicId}::${title}` : 'null';
    if (lastEmittedKeyRef.current === nextKey) return;
    lastEmittedKeyRef.current = nextKey;
    if (!topicId || !title) {
      onTopicContextChangeRef.current?.(null);
      return;
    }
    onTopicContextChangeRef.current?.({ id: topicId, title });
  }, []);

  const clearWorkspace = useCallback(() => {
    setHeaderTopic(null);
    setCounts(EMPTY_COUNTS);
    setJudgments([]);
    setMethodFindings([]);
    setSources([]);
    setCounterEvidence([]);
    setSourcesPreview([]);
    setContentHistory([]);
    setMetrics([]);
    setReviews([]);
    setOpportunities([]);
    setSegmentError(null);
    setSourceActionError(null);
    setDeepItems([]);
    setDeepError(null);
    setDeepHasMore(false);
    setDeepTotal(0);
    setExpandedReviews({});
    setCanvasMessage(null);
    setWikiDetail(null);
    setWikiError(null);
    setWikiTab('overview');
    setRestoringVersionId(null);
    setRestoreMessage(null);
  }, []);

  const selectTopic = useCallback((topicId: string | null, title?: string | null) => {
    setSelectedTopicId(topicId);
    selectedTopicIdRef.current = topicId;
    if (workspaceId) { const key = workspaceStorageKey(workspaceId, 'libraryTopicId'); if (topicId) localStorage.setItem(key, topicId); else localStorage.removeItem(key); }
    setDeepMode(false);
    setDeepCategory('');
    setExpandedReviews({});
    setSourceActionError(null);
    setCanvasMessage(null);
    if (!topicId) {
      clearWorkspace();
      emitContext(null);
      return;
    }
    const knownTitle = title
      ?? topicsRef.current.find((item) => item.id === topicId)?.title
      ?? null;
    if (knownTitle) emitContext(topicId, knownTitle);
  }, [clearWorkspace, emitContext, workspaceId]);

  const loadTopicList = useCallback(async (options?: {
    preferId?: string | null;
    offset?: number;
    append?: boolean;
  }) => {
    const offset = options?.offset ?? 0;
    const append = Boolean(options?.append);
    const seq = ++listLoadSeq.current;
    if (append) setListLoadingMore(true);
    else {
      setListLoading(true);
      setListError(null);
    }
    try {
      const raw = await window.wmb.listKnowledgeTopics({
        query: debouncedQuery || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: LIST_LIMIT,
        offset,
      });
      if (seq !== listLoadSeq.current) return;
      const page = normalizeTopicListPage(raw);
      const nextItems = append
        ? (() => {
          const seen = new Set(topicsRef.current.map((item) => item.id));
          const merged = [...topicsRef.current];
          for (const item of page.items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            merged.push(item);
          }
          return merged;
        })()
        : page.items;

      setTopics(nextItems);
      topicsRef.current = nextItems;
      setListTotal(page.total);
      setListHasMore(page.hasMore);
      if (append) return;

      const preferredCandidate = options?.preferId
        ?? preferIdOnListLoadRef.current
        ?? null;
      preferIdOnListLoadRef.current = null;
      const preferred = preferredCandidate && nextItems.some((item) => item.id === preferredCandidate)
        ? preferredCandidate
        : null;

      if (preferred) {
        const row = nextItems.find((item) => item.id === preferred) ?? null;
        if (preferred !== selectedTopicIdRef.current) {
          selectTopic(preferred, row?.title ?? null);
        } else if (row?.title) {
          emitContext(preferred, row.title);
        }
      } else if (selectedTopicIdRef.current) {
        const stillVisible = nextItems.some((item) => item.id === selectedTopicIdRef.current);
        if (!stillVisible) selectTopic(null);
        else {
          const row = nextItems.find((item) => item.id === selectedTopicIdRef.current) ?? null;
          if (row?.title) emitContext(row.id, row.title);
        }
      }
    } catch (error) {
      if (seq !== listLoadSeq.current) return;
      if (!append) {
        setTopics([]);
        topicsRef.current = [];
        setListTotal(0);
        setListHasMore(false);
        setListError(errorMessage(error));
        selectTopic(null);
      } else {
        setListError(errorMessage(error));
      }
    } finally {
      if (seq === listLoadSeq.current) {
        setListLoading(false);
        setListLoadingMore(false);
      }
    }
  }, [debouncedQuery, emitContext, selectTopic, statusFilter]);

  useEffect(() => {
    void loadTopicList({ preferId: selectedTopicIdRef.current ?? undefined });
  }, [debouncedQuery, statusFilter, listReloadToken, loadTopicList]);

  useEffect(() => {
    const topicId = asString(initialTopicId);
    if (!topicId) return;
    preferIdOnListLoadRef.current = topicId;
    setSegment('judgments');
    setDeepMode(false);
    selectTopic(topicId);
    void loadTopicList({ preferId: topicId });
    // Mount-time deep link only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTopicId || deepMode) {
      if (!selectedTopicId) {
        setSegmentLoading(false);
        setSegmentError(null);
      }
      return;
    }

    const topicId = selectedTopicId;
    const activeSegment = segment;
    const seq = ++segmentLoadSeq.current;
    let cancelled = false;

    const run = async () => {
      setSegmentLoading(true);
      setSegmentError(null);
      try {
        if (activeSegment === 'judgments') {
          const requests: Array<Promise<unknown>> = [
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'judgments', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'method_findings', limit: 20, offset: 0 }),
            // Preload content projects so 「去创作」 works from the default tab.
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'content_history', limit: 20, offset: 0 }),
            // WMB-5226：概览「已有资料」预览始终需要真实来源（不依赖宽布局）。
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'sources', limit: 12, offset: 0 }),
          ];
          const [judgmentsPageRaw, methodsPageRaw, contentPageRaw, sourcesPreviewRaw] = await Promise.all(requests);
          if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
          const judgmentsPage = normalizeDossierPage(judgmentsPageRaw);
          const methodsPage = normalizeDossierPage(methodsPageRaw);
          const contentPage = normalizeDossierPage(contentPageRaw);
          const previewPage = normalizeDossierPage(sourcesPreviewRaw);
          if (!judgmentsPage) throw new Error('主题档案读取失败');
          setHeaderTopic(judgmentsPage.topic);
          setCounts(judgmentsPage.counts);
          setJudgments(judgmentsPage.items);
          setMethodFindings(methodsPage?.items ?? []);
          setContentHistory(contentPage?.items ?? []);
          setSourcesPreview(previewPage?.items ?? []);
          emitContext(judgmentsPage.topic.id, judgmentsPage.topic.title);
        } else if (activeSegment === 'sources') {
          const [sourcesPageRaw, counterPageRaw] = await Promise.all([
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'sources', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'counter_evidence', limit: SEGMENT_LIMIT, offset: 0 }),
          ]);
          if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
          const sourcesPage = normalizeDossierPage(sourcesPageRaw);
          const counterPage = normalizeDossierPage(counterPageRaw);
          const page = sourcesPage ?? counterPage;
          if (!page) throw new Error('主题资料读取失败');
          setHeaderTopic(page.topic);
          setCounts(page.counts);
          setSources(sourcesPage?.items ?? []);
          setCounterEvidence(counterPage?.items ?? []);
          setSourcesPreview(sourcesPage?.items.slice(0, 12) ?? []);
          emitContext(page.topic.id, page.topic.title);
        } else {
          const [contextRaw, contentRaw, metricsRaw, reviewsRaw] = await Promise.all([
            window.wmb.getKnowledgeContext({ topicId, limit: 50 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'content_history', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'metrics', limit: SEGMENT_LIMIT, offset: 0 }),
            window.wmb.getKnowledgeTopicDossier({ topicId, category: 'reviews', limit: SEGMENT_LIMIT, offset: 0 }),
          ]);
          if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
          const context = normalizeKnowledgeContext(contextRaw);
          const contentPage = normalizeDossierPage(contentRaw);
          const metricsPage = normalizeDossierPage(metricsRaw);
          const reviewsPage = normalizeDossierPage(reviewsRaw);
          const page = contentPage ?? metricsPage ?? reviewsPage;
          if (page) {
            setHeaderTopic(page.topic);
            setCounts(page.counts);
            emitContext(page.topic.id, page.topic.title);
          } else {
            const listItem = topicsRef.current.find((item) => item.id === topicId) ?? null;
            if (listItem) {
              setHeaderTopic({
                id: listItem.id,
                title: listItem.title,
                summary: listItem.summary,
                status: listItem.status,
                firstSeenAt: listItem.firstSeenAt,
                lastSeenAt: listItem.lastSeenAt,
              });
              emitContext(listItem.id, listItem.title);
            }
          }
          setOpportunities(context.opportunities);
          setContentHistory(contentPage?.items ?? []);
          setMetrics(metricsPage?.items ?? []);
          setReviews(reviewsPage?.items ?? []);
        }
      } catch (error) {
        if (cancelled || seq !== segmentLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        setSegmentError(errorMessage(error));
      } finally {
        if (!cancelled && seq === segmentLoadSeq.current) setSegmentLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedTopicId, segment, segmentReloadToken, emitContext, deepMode, wideLayout]);

  useEffect(() => {
    if (!selectedTopicId || !deepMode) {
      if (!deepMode) {
        setDeepLoading(false);
        setDeepLoadingMore(false);
      }
      return;
    }

    const topicId = selectedTopicId;
    const category = deepCategory;
    const seq = ++deepLoadSeq.current;
    let cancelled = false;

    const run = async () => {
      setDeepLoading(true);
      setDeepError(null);
      try {
        const raw = await window.wmb.getKnowledgeTopicDossier({
          topicId,
          category: category || undefined,
          limit: DEEP_LIMIT,
          offset: 0,
        });
        if (cancelled || seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        const page = normalizeDossierPage(raw);
        if (!page) throw new Error('完整档案读取失败');
        setHeaderTopic(page.topic);
        setCounts(page.counts);
        setDeepItems(page.items);
        setDeepHasMore(page.hasMore);
        setDeepTotal(page.total);
        emitContext(page.topic.id, page.topic.title);
      } catch (error) {
        if (cancelled || seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        setDeepError(errorMessage(error));
        setDeepItems([]);
        setDeepHasMore(false);
        setDeepTotal(0);
      } finally {
        if (!cancelled && seq === deepLoadSeq.current) setDeepLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedTopicId, deepMode, deepCategory, deepReloadToken, emitContext]);

  // WMB-5212 M3：Topic Wiki 详情加载（Wiki-first 默认；dossier 仍可深查）。
  useEffect(() => {
    if (!selectedTopicId || deepMode) {
      if (!selectedTopicId) {
        setWikiError(null);
      }
      return;
    }

    const topicId = selectedTopicId;
    const seq = ++wikiLoadSeq.current;
    let cancelled = false;

    const run = async () => {
      setWikiError(null);
      try {
        const raw = await window.wmb.getTopicWikiDetail({ topicId, ...WIKI_DETAIL_LIMITS });
        if (cancelled || seq !== wikiLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        const detail = normalizeTopicWikiDetail(raw);
        if (!detail || detail.topicId !== topicId) return;
        setWikiDetail(detail);
        if (detail.topic) {
          setHeaderTopic({
            id: detail.topic.id,
            title: detail.topic.title,
            summary: detail.topic.summary,
            status: detail.topic.status,
            firstSeenAt: detail.topic.firstSeenAt,
            lastSeenAt: detail.topic.lastSeenAt,
            revision: detail.topic.revision,
          });
          if (detail.dossierCounts) setCounts({ ...EMPTY_COUNTS, ...detail.dossierCounts });
          emitContext(detail.topic.id, detail.topic.title);
        }
      } catch (error) {
        if (cancelled || seq !== wikiLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
        setWikiError(errorMessage(error));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedTopicId, deepMode, wikiReloadToken, emitContext]);

  // WMB-5212：dataChanged 订阅（topics/knowledge/receipt scope）替代手动刷新主路径；
  // 刷新 Wiki 详情与列表但保留当前选择（设计 §2.5 / §9）。
  useEffect(() => {
    if (typeof window.wmb.onDataChanged !== 'function') return;
    const refresh = (event: { scopes: string[] }) => {
      const scopes = event.scopes ?? [];
      const touches = scopes.some((scope) => scope === 'topics' || scope === 'knowledge' || scope === 'receipt' || scope === 'library');
      if (!touches) return;
      // 主题/Wiki 数据变化：列表始终刷新（保留当前选择）；已开详情时同步刷新各投影。
      setListReloadToken((value) => value + 1);
      if (selectedTopicIdRef.current) {
        setWikiReloadToken((value) => value + 1);
        setSegmentReloadToken((value) => value + 1);
        setDeepReloadToken((value) => value + 1);
      }
    };
    const unsubscribe = window.wmb.onDataChanged(refresh);
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const onOpenTopic = (event: Event) => {
      const custom = event as CustomEvent<{ topicId?: string }>;
      const topicId = asString(custom.detail?.topicId);
      if (!topicId) return;
      setSegment('judgments');
      setDeepMode(false);
      const known = topicsRef.current.find((item) => item.id === topicId) ?? null;
      if (known) {
        selectTopic(known.id, known.title);
        return;
      }
      preferIdOnListLoadRef.current = topicId;
      selectTopic(topicId);
      void loadTopicList({ preferId: topicId });
    };
    window.addEventListener(OPEN_TOPIC_EVENT, onOpenTopic as EventListener);
    return () => window.removeEventListener(OPEN_TOPIC_EVENT, onOpenTopic as EventListener);
  }, [loadTopicList, selectTopic]);

  const selectedListItem = useMemo(
    () => topics.find((item) => item.id === selectedTopicId) ?? null,
    [topics, selectedTopicId],
  );
  const displayTopic = headerTopic ?? selectedListItem;

  const sourceTotal = (counts.sources ?? 0) + (counts.counter_evidence ?? 0);
  const opportunityTotal = selectedListItem?.opportunityCount ?? opportunities.length;
  const contentTotal = counts.content_history ?? selectedListItem?.contentCount ?? 0;
  const reviewTotal = counts.reviews ?? 0;
  const outcomeBadge = (opportunityTotal || 0) + contentTotal + (counts.metrics ?? 0) + reviewTotal;
  const showSourcesRail = !deepMode && segment === 'judgments' && wideLayout && Boolean(displayTopic);
  const recentLabel = formatRelativeTime(displayTopic?.lastSeenAt) ?? '—';

  const objectMetaLine = useMemo(() => {
    const parts = [
      `资料 ${sourceTotal}`,
      `机会 ${opportunityTotal || 0}`,
      `内容 ${contentTotal}`,
      `复盘 ${reviewTotal}`,
      `最近 ${recentLabel}`,
    ];
    return parts.join(' · ');
  }, [sourceTotal, opportunityTotal, contentTotal, reviewTotal, recentLabel]);

  // WMB-5242：最近整理时间 = 当前认识版本创建时间（唯一可读的整理时点）；尚未整理（无版本）时不显示时间。
  const organizeLabel = useMemo(() => {
    const time = wikiDetail?.wiki?.current?.createdAt ?? null;
    if (!time) return null;
    return formatRelativeTime(time) ?? formatWhen(time);
  }, [wikiDetail]);

  const moveFocus = useCallback((delta: number) => {
    if (!topics.length) return;
    const currentIndex = topics.findIndex((item) => item.id === focusedTopicId);
    const nextIndex = currentIndex < 0
      ? (delta > 0 ? 0 : topics.length - 1)
      : Math.max(0, Math.min(topics.length - 1, currentIndex + delta));
    const next = topics[nextIndex];
    if (!next) return;
    setFocusedTopicId(next.id);
  }, [focusedTopicId, topics]);

  // WMB-5212 M3：Wiki 默认详情状态推导 + 章节直达（供键盘/章节导航共用）。
  // failed/stale 编译状态横幅始终可见；hasCurrentKnowledge 只在有摘要、结论或争议时展示正文。
  const wikiPage = wikiDetail?.wiki?.page ?? null;
  const wikiCurrent = wikiDetail?.wiki?.current ?? null;
  const wikiBody = wikiDetail?.wiki?.body ?? null;
  const hasCurrentKnowledge = Boolean(
    wikiBody
    && ((wikiBody.summary && wikiBody.summary !== '暂无综合摘要。')
      || wikiBody.keyConclusions?.length
      || wikiBody.retainedDisputes?.length)
  );
  const showWikiPage = Boolean(wikiDetail?.wiki);
  const wikiRisks = wikiDetail?.risks ?? null;
  const wikiCompileStatus = wikiDetail?.wiki?.compileStatus ?? null;
  // WMB-5233：诚实三态（后端读投影派生；无 wiki → uncompiled）。
  const compileState = (wikiDetail?.wiki?.compileState ?? 'uncompiled') as KnowledgeCompileState;

  const scrollToWikiSection = useCallback((section: WikiSectionId) => {
    // 跨页签章节：先切到所属页签，等渲染完成后再滚动定位（DOM 章节始终保留）。
    setWikiTab(WIKI_SECTION_TAB[section]);
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.requestAnimationFrame(() => {
      const target = document.getElementById(`topic-wiki-${section}`);
      if (target) {
        target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        target.focus({ preventScroll: true });
      }
    });
  }, []);

  const onGridKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveFocus(1);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      moveFocus(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const current = topics.find((item) => item.id === (focusedTopicId ?? selectedTopicIdRef.current));
      if (current) {
        setSegment('judgments');
        selectTopic(current.id, current.title);
      }
    }
  }, [focusedTopicId, moveFocus, selectTopic, topics]);

  const onWorkspaceKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    // Wiki 默认详情：数字键 1–7 直达章节（当前认识→版本）。
    const wikiKey = Number(event.key);
    const wikiIndex = Number.isInteger(wikiKey) && wikiKey >= 1 && wikiKey <= WIKI_SECTION_ORDER.length ? wikiKey - 1 : -1;
    if (wikiIndex >= 0 && showWikiPage && !deepMode) {
      event.preventDefault();
      scrollToWikiSection(WIKI_SECTION_ORDER[wikiIndex]);
      return;
    }
    if (event.key === '1') {
      event.preventDefault();
      setDeepMode(false);
      setSegment('judgments');
      return;
    }
    if (event.key === '2') {
      event.preventDefault();
      setDeepMode(false);
      setSegment('sources');
      return;
    }
    if (event.key === '3') {
      event.preventDefault();
      setDeepMode(false);
      setSegment('outcomes');
    }
  }, [deepMode, showWikiPage, scrollToWikiSection]);

  const loadMoreTopics = useCallback(() => {
    if (listLoading || listLoadingMore || !listHasMore) return;
    void loadTopicList({ offset: topics.length, append: true });
  }, [listHasMore, listLoading, listLoadingMore, loadTopicList, topics.length]);

  const loadMoreDeep = useCallback(async () => {
    if (!selectedTopicId || !deepMode || deepLoading || deepLoadingMore || !deepHasMore) return;
    const topicId = selectedTopicId;
    const seq = ++deepLoadSeq.current;
    setDeepLoadingMore(true);
    setDeepError(null);
    try {
      const raw = await window.wmb.getKnowledgeTopicDossier({
        topicId,
        category: deepCategory || undefined,
        limit: DEEP_LIMIT,
        offset: deepItems.length,
      });
      if (seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
      const page = normalizeDossierPage(raw);
      if (!page) throw new Error('完整档案读取失败');
      setHeaderTopic(page.topic);
      setCounts(page.counts);
      setDeepItems((current) => {
        const seen = new Set(current.map(itemKey));
        const merged = [...current];
        for (const item of page.items) {
          const key = itemKey(item);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
        return merged;
      });
      setDeepHasMore(page.hasMore);
      setDeepTotal(page.total);
    } catch (error) {
      if (seq !== deepLoadSeq.current || selectedTopicIdRef.current !== topicId) return;
      setDeepError(errorMessage(error));
    } finally {
      if (seq === deepLoadSeq.current) setDeepLoadingMore(false);
    }
  }, [deepCategory, deepHasMore, deepItems.length, deepLoading, deepLoadingMore, deepMode, selectedTopicId]);

  const updateSourceMeta = useCallback(async (
    item: DossierItem,
    patch: { verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus },
  ) => {
    const revision = asNumber(item.metadata?.revision);
    if (revision == null) return;
    setSourceUpdatingId(item.objectId);
    setSourceActionError(null);
    try {
      const result = await window.wmb.updateKnowledgeSource({
        id: item.objectId,
        expectedRevision: revision,
        verificationStatus: patch.verificationStatus,
        managementStatus: patch.managementStatus,
      });
      const nextRevision = asNumber(result?.revision) ?? revision + 1;
      const apply = (rows: DossierItem[]) => rows.map((row) => (
        row.objectId === item.objectId
          ? patchSourceItem(row, {
            revision: nextRevision,
            verificationStatus: patch.verificationStatus,
            managementStatus: patch.managementStatus,
          })
          : row
      ));
      setSources(apply);
      setCounterEvidence(apply);
      setSourcesPreview(apply);
      setDeepItems(apply);
    } catch (error) {
      setSourceActionError(errorMessage(error));
    } finally {
      setSourceUpdatingId(null);
    }
  }, []);

  const openCanvasForTopic = useCallback(async () => {
    if (!displayTopic || canvasBusy) return;
    setCanvasBusy(true);
    setCanvasMessage(null);
    try {
      const listRaw = await window.wmb.listKnowledgeCanvases();
      const list = Array.isArray(listRaw) ? listRaw : [];
      let canvasId: string | null = null;
      for (const entry of list) {
        const row = asRecord(entry);
        if (!row) continue;
        if (asString(row.topicId) === displayTopic.id) {
          canvasId = asString(row.id);
          break;
        }
      }
      if (!canvasId) {
        const createdRaw = await window.wmb.createKnowledgeCanvas({
          title: `${displayTopic.title} 工作台`,
          topicId: displayTopic.id,
        });
        canvasId = asString(asRecord(createdRaw)?.id);
      }
      if (!canvasId) throw new Error('画布创建失败');
      setCanvasMessage('已准备主题画布');
      onOpenCanvas?.(canvasId);
    } catch (error) {
      setCanvasMessage(errorMessage(error));
    } finally {
      setCanvasBusy(false);
    }
  }, [canvasBusy, displayTopic, onOpenCanvas]);

  const goCreate = useCallback(() => {
    if (!displayTopic) return;
    let projectId: string | null = null;
    for (const item of contentHistory) {
      if (item.objectType === 'content_project' && item.objectId) {
        projectId = item.objectId;
        break;
      }
    }
    if (projectId) {
      onOpenStudio?.(projectId);
      return;
    }
    if (workspaceId) localStorage.setItem(workspaceStorageKey(workspaceId, 'studioTopicId'), displayTopic.id);
    if (onGoStudio) {
      onGoStudio();
      return;
    }
    onOpenStudio?.('');
  }, [contentHistory, displayTopic, onGoStudio, onOpenStudio]);

  const backToGrid = useCallback(() => {
    setFocusedTopicId(selectedTopicIdRef.current);
    selectTopic(null);
  }, [selectTopic]);

  const askPiBrief = useCallback(() => {
    if (!displayTopic) return;
    emitContext(displayTopic.id, displayTopic.title);
    onOpenPi?.();
    const prompt = [
      `请基于当前主题「${displayTopic.title}」的档案（判断、关键资料与回流），产出 1–3 条可执行选题方案。`,
      '每条含：标题方向、why now、时效、角度、目标读者、建议平台/体裁、还缺什么证据。',
      '不要空泛综述，优先可马上开写的切口。'
    ].join('');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('wmb-pi-generate', { detail: { prompt, orchestration: { originLabel: '资料库', title: '请 Pi 出选题', goal: '基于主题档案产出可执行选题方案', acceptance: '1–3 条可执行选题方案' } } }));
    }, 0);
  }, [displayTopic, emitContext, onOpenPi]);

  // WMB-5212：Wiki 版本恢复 = 既有 ChangeSet 写路径追加新版本（契约 §15.2；设计 §2.7 明确会生成新版本）。
  const restoreWikiVersion = useCallback(async (version: KnowledgeWikiPageVersionRecord) => {
    const page = wikiDetail?.wiki?.page;
    if (!page || !selectedTopicId || restoringVersionId) return;
    if (!window.confirm(`恢复会生成一个以 V${version.versionNumber} 内容为基础的新版本（不覆盖历史）。确定恢复？`)) return;
    setRestoringVersionId(version.id);
    setRestoreMessage(null);
    try {
      const result = await window.wmb.submitKnowledgeChangeSet({
        requestId: `wiki-restore:${page.id}:${version.id}:${Date.now()}`,
        reason: `恢复主题 Wiki 到 V${version.versionNumber}（用户操作）`,
        triggerSource: 'user',
        resolutionMode: 'manual_correction',
        createdBy: 'user',
        input: {
          wikiPages: [{
            id: page.id,
            scope: page.scope,
            pageType: 'topic',
            canonicalKey: page.canonicalKey,
            title: version.title || page.title,
            subjectType: 'topic',
            subjectId: selectedTopicId,
            beforeRevision: page.revision,
            version: {
              restoreFromVersionId: version.id,
              changeSummary: `恢复至 V${version.versionNumber}`,
              compileReason: 'user-restore',
              body: {},
            },
          }],
        },
      });
      if (!result.ok) throw new Error(result.error?.message ?? '恢复失败');
      setRestoreMessage(`已生成新版本（基于 V${version.versionNumber}）。`);
      setWikiReloadToken((value) => value + 1);
      setSegmentReloadToken((value) => value + 1);
      setDeepReloadToken((value) => value + 1);
      setListReloadToken((value) => value + 1);
    } catch (error) {
      setRestoreMessage(`恢复失败：${errorMessage(error)}`);
    } finally {
      setRestoringVersionId(null);
    }
  }, [restoringVersionId, selectedTopicId, wikiDetail]);


  const renderSourceCard = (item: DossierItem, forceContradicting = false) => (
    <SourceCard item={item} forceContradicting={forceContradicting} sourceUpdatingId={sourceUpdatingId} onUpdateSourceMeta={updateSourceMeta} aiSourcePresentation={aiSourcePresentation} />
  );
  const renderMethodFindings = () => <MethodFindingsSection items={methodFindings} />;
  const renderDeepItem = (item: DossierItem) => (
    <DeepItemCard
      item={item}
      sourceUpdatingId={sourceUpdatingId}
      onUpdateSourceMeta={updateSourceMeta}
      aiSourcePresentation={aiSourcePresentation}
      expandedReviews={expandedReviews}
      setExpandedReviews={setExpandedReviews}
      onOpenStudio={onOpenStudio}
    />
  );
  const renderKeyConclusion = (item: TopicWikiKeyConclusion, index: number) => <KeyConclusionCard item={item} index={index} />;
  const renderWikiEvidence = (entry: TopicEvidenceEntry) => <WikiEvidenceCard entry={entry} />;
  const renderWikiReceipt = (receipt: KnowledgeUpdateReceiptRecord) => <WikiReceiptCard receipt={receipt} />;
  const renderWikiUsage = (record: KnowledgeUsageRecordRecord) => <WikiUsageCard record={record} />;
  const renderWikiHealth = (issue: KnowledgeHealthIssueRecord) => <WikiHealthCard issue={issue} />;
  const renderWikiVersion = (version: KnowledgeWikiPageVersionRecord, isCurrent: boolean) => (
    <WikiVersionCard version={version} isCurrent={isCurrent} restoringVersionId={restoringVersionId} onRestore={restoreWikiVersion} />
  );
  const renderTopicSearchBody = () => <TopicSearchBody topicSearch={topicSearch as any} topicSearchQuery={topicSearchQuery} />;
  const renderTopicActivityBody = () => <TopicActivityBody topicActivity={topicActivity as any} topicActivityEntries={topicActivityEntries as any} />;
  const renderWikiPage = () => (
    <WikiPageView
      wikiDetail={wikiDetail}
      counts={counts}
      sourcesPreview={sourcesPreview}
      wikiTab={wikiTab}
      setWikiTab={setWikiTab}
      wikiCompileStatus={wikiCompileStatus}
      compileState={compileState}
      wikiRisks={wikiRisks}
      hasCurrentKnowledge={hasCurrentKnowledge}
      wikiBody={wikiBody}
      restoringVersionId={restoringVersionId}
      restoreMessage={restoreMessage}
      onRestore={restoreWikiVersion}
      wikiPage={wikiPage}
      aiSourcePresentation={aiSourcePresentation}
      indexHint={indexHint}
      topicSearchQuery={topicSearchQuery}
      setTopicSearchQuery={setTopicSearchQuery}
      topicSearch={topicSearch as any}
      topicActivity={topicActivity as any}
      topicActivityEntries={topicActivityEntries as any}
      setDeepMode={setDeepMode}
      setDeepCategory={setDeepCategory as any}
    />
  );
  const homeView = (
    <div className="topic-home" aria-label="主题首页">
      <div className="topic-home-toolbar library-topic-list-toolbar">
        <input
          type="search"
          value={topicQuery}
          placeholder="搜索主题"
          aria-label="搜索主题"
          onChange={(event) => setTopicQuery(event.target.value)}
        />
        <div className="topic-status-filters studio-filter-row" role="group" aria-label="主题状态筛选">
          {STATUS_FILTERS.map((filter) => <button
            key={filter.id}
            type="button"
            className={statusFilter === filter.id ? 'active' : ''}
            aria-pressed={statusFilter === filter.id}
            onClick={() => setStatusFilter(filter.id)}
          >{filter.label}</button>)}
        </div>
        <button type="button" className="topic-maintenance-entry" onClick={() => setMaintenanceOpen(true)}>整理台账</button>
      </div>
      <div
        className="topic-card-grid"
        aria-label="主题卡片"
        ref={listPaneRef as React.RefObject<HTMLDivElement>}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
      >
        {listLoading ? <p className="library-panel-empty library-topic-list-state">正在加载主题…</p> : null}
        {listError ? <div className="library-topic-error library-topic-list-state" role="alert">
          <strong>主题列表失败</strong>
          <p>{listError}</p>
          <button type="button" onClick={() => void loadTopicList()}>重试</button>
        </div> : null}
        {!listLoading && !listError && !topics.length ? <section className="empty-state library-empty topic-home-empty">
          <h2>尚未形成主题</h2>
          <p>{debouncedQuery || statusFilter !== 'all' ? '没有匹配当前筛选的主题。' : '下一轮情报会把资料归入稳定主题。'}</p>
        </section> : null}
        {topics.map((item) => {
          const summary = asString(item.summary);
          const focused = item.id === focusedTopicId;
          return <button
            key={item.id}
            type="button"
            className={`topic-object-card${focused ? ' focused' : ''}`}
            onClick={() => {
              setFocusedTopicId(item.id);
              setSegment('judgments');
              selectTopic(item.id, item.title);
            }}
            onFocus={() => setFocusedTopicId(item.id)}
          >
            <div className="topic-object-card-top">
              <strong>{item.title}</strong>
            </div>
            {/* WMB-5242：当前综合 —— 标题后优先呈现（知识目录语义）。 */}
            {summary ? <p className="topic-object-card-summary topic-object-card-current">{summary}</p> : null}
            <div className="topic-object-card-footer">
              <div className="topic-object-card-meta">{listTopicMeta(item)}</div>
              <span className="topic-object-card-footer-badges">
                {/* WMB-5242：整理状态（已整理 / 初始资料 / 尚未整理）；仅已有数据可推导时展示。 */}
                {item.compileState ? <span className={`topic-compile-state ${item.compileState}`}>
                  {COMPILE_STATE_LABELS[item.compileState] ?? item.compileState}
                </span> : null}
                <span className={`pill-status ${topicStatusClass(item.status)}`}>
                  <span className="dot" />
                  {topicStatusLabel(item.status)}
                </span>
              </span>
            </div>
          </button>;
        })}
      </div>
      {listHasMore ? <div className="library-topic-list-more topic-home-more">
        <button type="button" disabled={listLoadingMore} onClick={loadMoreTopics}>
          {listLoadingMore ? '加载中…' : `加载更多（${topics.length}/${listTotal || topics.length}）`}
        </button>
      </div> : null}
    </div>
  );

  const maintenanceView = (<div className="topic-maintenance-page" aria-label="主题整理台账页面"><header className="topic-maintenance-page-head"><button type="button" className="topic-back-button" onClick={() => setMaintenanceOpen(false)}>← 主题</button><div><h2>整理台账</h2><p>批准当前建议，查看资料员重新整理进度和历史记录。</p></div></header><TopicMaintenanceLedger /></div>);

  if (!selectedTopicId) {
    return <div className="topic-layout topic-layout-home">{maintenanceOpen ? maintenanceView : homeView}</div>;
  }

  return <div className="topic-layout topic-layout-detail">
    <section
      className={`topic-work-pane library-topic-workspace topic-detail-pane${showSourcesRail ? ' with-rail' : ''}`}
      aria-label="主题详情"
      ref={workspaceRef}
      tabIndex={0}
      onKeyDown={onWorkspaceKeyDown}
    >
      {!displayTopic ? <div className="empty-state library-empty">
        <button type="button" className="topic-back-button" onClick={backToGrid}>← 主题</button>
        <h2>{listLoading || segmentLoading ? '正在准备主题' : '主题读取中'}</h2>
        <p>如果长时间无响应，返回主题卡重试。</p>
      </div> : <>
        <header className="topic-object-head">
          <div className="topic-object-head-bar">
            <button type="button" className="topic-back-button" onClick={backToGrid}>← 主题</button>
            <div className="library-topic-head-actions topic-object-head-actions">
              <details className="topic-more">
                <summary>更多</summary>
                <div className="topic-more-menu">
                  {deepMode ? (
                    <button type="button" onClick={() => { setDeepMode(false); setDeepCategory(''); }}>退出档案</button>
                  ) : (
                    <button type="button" onClick={() => { setDeepMode(true); setDeepCategory(''); }}>完整档案</button>
                  )}
                  <button type="button" onClick={goCreate}>去创作</button>
                  {onOpenCanvas ? <button
                    type="button"
                    disabled={canvasBusy}
                    onClick={() => void openCanvasForTopic()}
                  >{canvasBusy ? '处理中…' : '放画布'}</button> : null}
                </div>
              </details>
              <button
                type="button"
                className="primary-button"
                disabled={!piConfigured}
                title={!piConfigured ? '请先配置 Pi' : '基于当前主题让 Pi 出选题方案'}
                onClick={askPiBrief}
              >让 Pi 出选题方案</button>
            </div>
          </div>
          <div className="library-topic-title-row">
            <h2>{displayTopic.title}</h2>
            <span className={`pill-status ${topicStatusClass(displayTopic.status)}`}>
              <span className="dot" />
              {topicStatusLabel(displayTopic.status)}
            </span>
          </div>
          <p className="topic-object-meta">{objectMetaLine}</p>
          {showWikiPage ? <p className="topic-object-meta">{`资料员持续维护${organizeLabel ? ` · 最近整理 ${organizeLabel}` : ''}`}</p> : null}
          {canvasMessage ? <p className="library-topic-action-note">{canvasMessage}</p> : null}
          {!piConfigured ? <p className="library-topic-action-note">Pi 尚未配置时，无法直接生成选题方案。</p> : null}
        </header>

        {deepMode ? <>
          <nav className="library-topic-deep-tabs" aria-label="完整档案分类">
            <button
              type="button"
              className={!deepCategory ? 'active' : ''}
              onClick={() => setDeepCategory('')}
            >全部 <span>{Object.values(counts).reduce((sum, value) => sum + value, 0)}</span></button>
            {DOSSIER_CATEGORY_ORDER.map((category) => <button
              key={category}
              type="button"
              className={deepCategory === category ? 'active' : ''}
              onClick={() => setDeepCategory(category)}
            >{DOSSIER_LABELS[category]} <span>{counts[category] ?? 0}</span></button>)}
          </nav>
          <div className="library-topic-segment-body topic-work-body" data-segment="deep">
            {deepLoading ? <p className="library-panel-empty">正在加载完整档案…</p>
              : deepError ? <div className="library-topic-error" role="alert">
                <strong>完整档案加载失败</strong>
                <p>{deepError}</p>
                <button type="button" onClick={() => setDeepReloadToken((value) => value + 1)}>重试</button>
              </div>
              : !deepItems.length ? <p className="library-panel-empty">这个分类还没有资产。资料 {sourceTotal} · 内容 {contentTotal} · 复盘 {reviewTotal}。</p>
                : <>
                  <div className="library-topic-section-head">
                    <h3>{deepCategory ? DOSSIER_LABELS[deepCategory] : '全部档案'}</h3>
                    <span>{deepItems.length}/{deepTotal || deepItems.length}</span>
                  </div>
                  {sourceActionError ? <p className="library-topic-action-note danger">{sourceActionError}</p> : null}
                  <div className="library-topic-cards">
                    {deepItems.map((item) => renderDeepItem(item))}
                  </div>
                  {deepHasMore ? <div className="library-topic-list-more">
                    <button type="button" disabled={deepLoadingMore} onClick={() => void loadMoreDeep()}>
                      {deepLoadingMore ? '加载中…' : '加载更多'}
                    </button>
                  </div> : null}
                </>}
          </div>
        </> : !wikiDetail && wikiError ? <div className="library-topic-error" role="alert">
            <strong>主题加载失败</strong>
            <p>{wikiError}</p>
            <button type="button" onClick={() => setWikiReloadToken((value) => value + 1)}>重试</button>
          </div>
          : !wikiDetail ? <p className="library-panel-empty">正在加载主题…</p>
          : showWikiPage ? renderWikiPage() : <>
          <p className="library-topic-action-note">本主题还没有整理出当前认识：继续保存资料后，资料员会在这里持续汇总。以下为现有档案。</p>
          <nav className="topic-work-tabs" aria-label="主题工作分段">
            <button type="button" className={segment === 'judgments' ? 'active' : ''} onClick={() => setSegment('judgments')}>
              判断 <span>{counts.judgments}</span>
            </button>
            <button type="button" className={segment === 'sources' ? 'active' : ''} onClick={() => setSegment('sources')}>
              证据 <span>{sourceTotal}</span>
            </button>
            <button type="button" className={segment === 'outcomes' ? 'active' : ''} onClick={() => setSegment('outcomes')}>
              回流 <span>{outcomeBadge}</span>
            </button>
          </nav>

          <div className="library-topic-main-row">
            <div className="library-topic-segment-body topic-work-body" data-segment={segment}>
              {segment === 'judgments' ? (
                segmentLoading ? <p className="library-panel-empty">正在加载判断…</p>
                  : segmentError ? <div className="library-topic-error" role="alert">
                    <strong>判断加载失败</strong>
                    <p>{segmentError}</p>
                    <button type="button" onClick={() => setSegmentReloadToken((value) => value + 1)}>重试</button>
                  </div>
                  : judgments.length ? <div className="library-topic-cards">
                    {judgments.map((item) => <article key={itemKey(item)} className="library-topic-card">
                      <header>
                        <strong>{item.title || '判断'}</strong>
                        <time>{formatWhen(item.occurredAt)}</time>
                      </header>
                      <p>{item.body || '暂无正文'}</p>
                      {(item.metadata?.whyNow || item.metadata?.timeliness) ? <div className="library-topic-card-meta">
                        {item.metadata.whyNow ? <span>为何现在：{item.metadata.whyNow}</span> : null}
                        {item.metadata.timeliness ? <span>时效：{item.metadata.timeliness}</span> : null}
                      </div> : null}
                    </article>)}
                    {renderMethodFindings()}
                  </div> : <div className="library-topic-empty-block">
                    <p className="library-panel-empty">尚未沉淀判断（来自计划观点）。可先看证据或等今日机会回流。</p>
                    {renderMethodFindings()}
                  </div>
              ) : null}

              {segment === 'sources' ? (
                segmentLoading ? <p className="library-panel-empty">正在加载证据…</p>
                  : segmentError ? <div className="library-topic-error" role="alert">
                    <strong>证据加载失败</strong>
                    <p>{segmentError}</p>
                    <button type="button" onClick={() => setSegmentReloadToken((value) => value + 1)}>重试</button>
                  </div>
                  : (!sources.length && !counterEvidence.length) ? <p className="library-panel-empty">这个主题还没有关联证据。计数以档案为准：资料 {counts.sources} · 反证 {counts.counter_evidence}。</p>
                    : <div className="library-topic-sources">
                      <div className="library-topic-section-head">
                        <h3>支撑证据</h3>
                        <span>真计数 {counts.sources} · 反证 {counts.counter_evidence}</span>
                      </div>
                      {sourceActionError ? <p className="library-topic-action-note danger">{sourceActionError}</p> : null}
                      {sources.length ? <div className="library-topic-cards">
                        {sources.map((item) => renderSourceCard(item))}
                      </div> : <p className="library-panel-empty">暂无主证据条目。</p>}
                      {counterEvidence.length ? <section className="library-topic-counter" aria-label="反证资料">
                        <div className="library-topic-section-head">
                          <h3>反证</h3>
                          <span>{counterEvidence.length} 条</span>
                        </div>
                        <div className="library-topic-cards">
                          {counterEvidence.map((item) => renderSourceCard(item, true))}
                        </div>
                      </section> : null}
                    </div>
              ) : null}

              {segment === 'outcomes' ? (
                segmentLoading ? <p className="library-panel-empty">正在加载回流…</p>
                  : segmentError ? <div className="library-topic-error" role="alert">
                    <strong>回流加载失败</strong>
                    <p>{segmentError}</p>
                    <button type="button" onClick={() => setSegmentReloadToken((value) => value + 1)}>重试</button>
                  </div>
                  : (!(opportunities.length || contentHistory.length || metrics.length || reviews.length)) ? <p className="library-panel-empty">还没有关联机会、内容或复盘教训回流到这个主题。</p>
                    : <div className="library-topic-outcomes">
                      <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>关联机会</h3>
                          <span>{opportunities.length} 条</span>
                        </div>
                        {opportunities.length ? <div className="library-topic-cards">
                          {opportunities.map((item) => <article key={item.id} className="library-topic-card">
                            <header>
                              <strong>{item.title}</strong>
                              <time>{item.planDate || '计划日未知'}</time>
                            </header>
                            <p>优先级 {item.priority ?? '—'}</p>
                          </article>)}
                        </div> : <p className="library-panel-empty">暂无关联机会。</p>}
                      </section>

                      <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>关联内容</h3>
                          <span>档案计数 {counts.content_history}</span>
                        </div>
                        {contentHistory.length ? <div className="library-topic-cards">
                          {contentHistory.map((item) => <article key={itemKey(item)} className="library-topic-card">
                            <header>
                              <strong>{item.title}</strong>
                              <time>{formatWhen(item.occurredAt)}</time>
                            </header>
                            <p>{item.body || '暂无正文摘要'}</p>
                            <div className="library-topic-card-meta">
                              <span>状态 {item.metadata?.status || '未知'}{item.metadata?.archived ? ' · 已归档' : ''}</span>
                            </div>
                            {item.objectType === 'content_project' && onOpenStudio ? <div className="library-panel-actions">
                              <button type="button" className="text-button" onClick={() => onOpenStudio(item.objectId)}>打开创作</button>
                            </div> : null}
                          </article>)}
                        </div> : <p className="library-panel-empty">暂无关联内容。</p>}
                      </section>

                      {metrics.length ? <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>指标快照</h3>
                          <span>档案计数 {counts.metrics}</span>
                        </div>
                        <div className="library-topic-cards">
                          {metrics.map((item) => {
                            const body = prettyJsonish(item.body) || item.body || '暂无指标明细';
                            return <article key={itemKey(item)} className="library-topic-card">
                              <header>
                                <strong>{item.title}</strong>
                                <time>{formatWhen(item.occurredAt)}</time>
                              </header>
                              <p className="library-topic-metric-body">{body}</p>
                              {item.metadata?.sourceUrl ? <div className="library-panel-actions">
                                <button type="button" className="text-button" onClick={() => void window.wmb.openExternal(String(item.metadata?.sourceUrl))}>来源 ↗</button>
                              </div> : null}
                            </article>;
                          })}
                        </div>
                      </section> : null}

                      <section className="library-topic-outcome-block">
                        <div className="library-topic-section-head">
                          <h3>复盘教训</h3>
                          <span>档案计数 {counts.reviews}</span>
                        </div>
                        {reviews.length ? <div className="library-topic-cards">
                          {reviews.map((item) => {
                            const key = itemKey(item);
                            const expanded = expandedReviews[key] ?? true;
                            const keep = prettyJsonish(item.metadata?.keep ?? null);
                            const stop = prettyJsonish(item.metadata?.stop ?? null);
                            const change = prettyJsonish(item.metadata?.change ?? null);
                            return <article key={key} className="library-topic-card">
                              <header>
                                <strong>{item.title || '复盘'}</strong>
                                <div className="library-topic-card-badges">
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => setExpandedReviews((current) => ({ ...current, [key]: !expanded }))}
                                  >{expanded ? '收起' : '展开'}</button>
                                  <time>{formatWhen(item.occurredAt)}</time>
                                </div>
                              </header>
                              <p>{item.body || '无摘要'}</p>
                              {expanded && (keep || stop || change) ? <div className="library-topic-ksc">
                                {keep ? <div><b>Keep</b><span>{keep}</span></div> : null}
                                {stop ? <div><b>Stop</b><span>{stop}</span></div> : null}
                                {change ? <div><b>Change</b><span>{change}</span></div> : null}
                              </div> : null}
                            </article>;
                          })}
                        </div> : <p className="library-panel-empty">暂无复盘教训（Keep / Stop / Change）。</p>}
                      </section>
                    </div>
              ) : null}
            </div>

            {showSourcesRail ? <aside className="library-topic-rail topic-rail" aria-label="证据侧栏">
              <div className="library-topic-section-head">
                <h3>证据</h3>
                <span>{counts.sources}</span>
              </div>
              {sourcesPreview.length ? <ul className="library-topic-rail-list">
                {sourcesPreview.map((item) => <li key={itemKey(item)}>
                  <button type="button" onClick={() => setSegment('sources')}>
                    <strong>{item.title}</strong>
                    <span>{relationLabel(item.metadata?.relation)}</span>
                  </button>
                </li>)}
              </ul> : <p className="library-panel-empty">{segmentLoading ? '加载证据…' : '暂无证据标题'}</p>}
              <button type="button" className="text-button library-topic-rail-open" onClick={() => setSegment('sources')}>查看全部证据</button>
            </aside> : null}
          </div>
        </>}
      </>}
    </section>
  </div>;
}
