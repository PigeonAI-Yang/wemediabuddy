import type { PiFocusObject } from './app-types';
import { useEffect, useRef, useState } from 'react';
import type {
  KnowledgeHealthIssueRecord,
  KnowledgeHealthIssueStatus,
  KnowledgeHealthIssueType,
  KnowledgeHealthSeverity,
  KnowledgeUpdateReceiptRecord,
} from '../shared/knowledge-flywheel';
import { SourceMark } from './source-mark';
import { domainOf, formatSourcePublishedAt } from './today-view-parts';
import { issueTypeLabel, severityLabel } from './knowledge-canvas-projection';
import {
  annotationIntentLabel,
  asSourceKnowledgeContext,
  asSourceKnowledgeDetail,
  bodyStatusLabel,
  conclusionStatusLabel,
  digestForSource,
  evidenceNatureLabel,
  evidenceRelationLabel,
  healthSeverityCls,
  healthStatusLabel,
  migrateLibrarySection,
  receiptCountsSummary,
  receiptTriggerLabel,
  shouldRefreshLibrary,
  sourceListBadges,
  sourceQualityProfile,
  type LibrarySection,
  type LibrarySourceItem,
  type RediscoveryItem,
  type SourceDigest,
  type SourceKnowledgeContext,
  type SourceKnowledgeDetail,
} from './library-view-parts';

// 资料列表按新鲜度分组，沿用服务端排序，只加分组头不打乱顺序。
const RECENCY_GROUPS = ['今天', '昨天', '近 7 天', '更早'] as const;
const recencyGroupOf = (source: LibrarySourceItem): (typeof RECENCY_GROUPS)[number] => {
  const time = Date.parse(source.publishedAt ?? source.collectedAt ?? '');
  if (!Number.isFinite(time)) return '更早';
  const days = (Date.now() - time) / 86_400_000;
  return days < 1 ? '今天' : days < 2 ? '昨天' : days < 7 ? '近 7 天' : '更早';
};

const SECTIONS: ReadonlyArray<{ id: LibrarySection; label: string; hint: string }> = Object.freeze([
  { id: 'saved', label: '资料', hint: '有效资料库与摄取管理' },
  { id: 'pending', label: '待处理', hint: '高价值未创作、持续观察与待核验超时' },
  { id: 'health', label: '知识健康', hint: '知识健康问题' },
  { id: 'removed', label: '移出', hint: '已移出资料' }
]);

const HEALTH_SEVERITY_FILTERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['', '全部'], ['critical', '严重'], ['high', '高'], ['medium', '中'], ['low', '低'], ['info', '提示']
]);
const HEALTH_STATUS_FILTERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['', '全部'], ['open', '未处理'], ['repairing', '修复中'], ['resolved', '已解决'], ['accepted_risk', '接受风险'], ['false_positive', '误报']
]);
const HEALTH_TYPE_FILTERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['', '全部'], ['stale_claim', '陈旧断言'], ['stale_wiki_page', '陈旧 Wiki'], ['unresolved_contradiction', '未解决矛盾'],
  ['unsupported_claim', '无依据断言'], ['duplicate_knowledge', '重复知识'], ['orphan_knowledge', '孤立知识'],
  ['missing_wiki_page', '缺 Wiki 页'], ['broken_reference', '失效引用'], ['unreturned_review', '未回流复盘']
]);

const PENDING_POOLS: ReadonlyArray<readonly [string, string, string]> = Object.freeze([
  ['unused', '高价值但尚未创作', '建议打开资料，核对后进入选题或创作。'],
  ['watching', '持续观察', '资料处于观察中，建议核验后决定是否投入创作。'],
  ['pending', '待核验超过 7 天', '待核验超过 7 天，建议打开资料确认核验状态。']
]);

const formatDateTime = (value: string | null | undefined): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 回执数组元素（自动处理/失败/争议）的可读文本：字符串原样，对象取 reason/message/title 或序列化。 */
const readableEntry = (entry: unknown): string => {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    const picked = record.reason ?? record.message ?? record.title ?? record.note ?? record.changeType;
    if (typeof picked === 'string' && picked.trim()) return picked;
    try {
      return JSON.stringify(entry);
    } catch {
      return String(entry);
    }
  }
  return String(entry);
};

export function LibraryView(props: {
  onOpenTopic?: (topicId: string) => void;
  onOpenStudio?: (projectId: string) => void;
  onOpenCanvas?: (canvasId?: string) => void;
  focusSourceId?: string | null;
  onFocusSourceConsumed?: () => void;
  onFocusChange?: (focus: PiFocusObject | null) => void;
  aiSourcePresentation: boolean;
  sectionStorageKey: string;
}): React.JSX.Element {
  const { onOpenTopic, focusSourceId, onFocusSourceConsumed, onFocusChange, aiSourcePresentation, sectionStorageKey } = props;
  const storedSection = migrateLibrarySection(localStorage.getItem(sectionStorageKey));
  const [section, setSection] = useState<LibrarySection>(storedSection ?? 'saved');
  const [knowledge, setKnowledge] = useState<Awaited<ReturnType<typeof window.wmb.listKnowledgeSources>> | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [verificationFilter, setVerificationFilter] = useState('');
  const [managementFilter, setManagementFilter] = useState('');
  const [knowledgeOffset, setKnowledgeOffset] = useState(0);
  const [sourceContext, setSourceContext] = useState<SourceKnowledgeContext | null>(null);
  const [selectedKnowledge, setSelectedKnowledge] = useState<LibrarySourceItem | null>(null);
  const [sourceDetail, setSourceDetail] = useState<SourceKnowledgeDetail | null>(null);
  const [sourceDetailLoading, setSourceDetailLoading] = useState(false);
  const [libraryBody, setLibraryBody] = useState<Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>>>(null);
  const [libraryBodyLoading, setLibraryBodyLoading] = useState(false);
  const [libraryBodyError, setLibraryBodyError] = useState('');
  const [rediscovery, setRediscovery] = useState<{ unused: RediscoveryItem[]; watching: RediscoveryItem[]; pending: RediscoveryItem[] }>({ unused: [], watching: [], pending: [] });
  const [watchingBoard, setWatchingBoard] = useState<LibrarySourceItem[]>([]);
  const [editingSource, setEditingSource] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [sourceActionError, setSourceActionError] = useState('');
  const [sourceActionBusy, setSourceActionBusy] = useState(false);
  const [pendingSourceAction, setPendingSourceAction] = useState<null | 'archive' | 'delete'>(null);
  const [removedList, setRemovedList] = useState<LibrarySourceItem[]>([]);
  const [removedTotal, setRemovedTotal] = useState(0);
  const [removedError, setRemovedError] = useState('');
  const [removedBusyId, setRemovedBusyId] = useState<string | null>(null);
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null);
  // WMB-5212：行内联知识面（正文缓存状态 / 已消化摘要 / 未处理健康问题数）
  const [bodyStatusBySource, setBodyStatusBySource] = useState<ReadonlyMap<string, string>>(new Map());
  const [digestsBySource, setDigestsBySource] = useState<ReadonlyMap<string, SourceDigest>>(new Map());
  const [openHealthBySource, setOpenHealthBySource] = useState<ReadonlyMap<string, number>>(new Map());
  // WMB-5212：知识健康页
  const [healthIssues, setHealthIssues] = useState<KnowledgeHealthIssueRecord[]>([]);
  const [healthTotal, setHealthTotal] = useState(0);
  const [healthSeverityFilter, setHealthSeverityFilter] = useState('');
  const [healthStatusFilter, setHealthStatusFilter] = useState('');
  const [healthTypeFilter, setHealthTypeFilter] = useState('');
  const [healthOffset, setHealthOffset] = useState(0);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [affectedIndex, setAffectedIndex] = useState<ReadonlyMap<string, { title: string; type: string }>>(new Map());
  const [refreshAnnouncement, setRefreshAnnouncement] = useState('');
  const focusRequestId = useRef(0);
  const detailRefreshId = useRef(0);

  const publishFocus = (source: LibrarySourceItem | null, body: Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>> | null = null) => {
    if (!onFocusChange) return;
    if (!source) {
      onFocusChange(null);
      return;
    }
    const excerpt = body?.status === 'ready' && body.extractedText?.trim()
      ? body.extractedText.slice(0, 6000)
      : null;
    onFocusChange({
      type: 'source',
      id: source.id,
      title: source.title,
      summary: source.summary ?? null,
      url: source.originalUrl ?? null,
      bodyStatus: body?.status ?? 'none',
      bodyExcerpt: excerpt,
      bodyChars: body?.extractedChars ?? excerpt?.length ?? 0,
      meta: {
        author: source.author ?? null,
        publishedAt: source.publishedAt ?? null,
        collectedAt: source.collectedAt ?? null,
        verificationStatus: source.verificationStatus ?? null,
        managementStatus: source.managementStatus ?? null,
        topics: source.topics ?? ''
      }
    });
  };

  const openSection = (next: LibrarySection) => {
    setSection(next);
    localStorage.setItem(sectionStorageKey, next);
  };

  const onTabsKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = SECTIONS.findIndex((item) => item.id === section);
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === 'ArrowRight') nextIndex = (index + 1) % SECTIONS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = SECTIONS.length - 1;
    openSection(SECTIONS[nextIndex].id);
  };

  const loadSourceDetail = async (sourceId: string, requestId: number) => {
    setSourceDetailLoading(true);
    try {
      const detail = await window.wmb.getSourceKnowledgeDetail({
        sourceId,
        evidenceLimit: 20,
        receiptLimit: 20,
        healthLimit: 20,
        annotationLimit: 20
      });
      if (requestId !== detailRefreshId.current) return;
      setSourceDetail(asSourceKnowledgeDetail(detail));
    } catch {
      if (requestId !== detailRefreshId.current) return;
      setSourceDetail(null);
    } finally {
      if (requestId === detailRefreshId.current) setSourceDetailLoading(false);
    }
  };

  const openSourceDrawer = async (source: LibrarySourceItem) => {
    const requestId = ++focusRequestId.current;
    setSelectedKnowledge(source);
    setLibraryBody(null);
    setLibraryBodyError('');
    setSourceDetail(null);
    setSourceDetailLoading(true);
    setLibraryBodyLoading(true);
    publishFocus(source, null);
    try {
      const [context, body, detail] = await Promise.all([
        window.wmb.getKnowledgeContext({ sourceId: source.id }),
        window.wmb.getSourceBodyCache(source.id),
        window.wmb.getSourceKnowledgeDetail({ sourceId: source.id, evidenceLimit: 20, receiptLimit: 20, healthLimit: 20, annotationLimit: 20 })
      ]);
      if (requestId !== focusRequestId.current) return;
      setSourceContext(asSourceKnowledgeContext(context));
      setLibraryBody(body);
      setSourceDetail(asSourceKnowledgeDetail(detail));
      publishFocus(source, body);
    } catch (error) {
      if (requestId !== focusRequestId.current) return;
      setLibraryBodyError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === focusRequestId.current) {
        setLibraryBodyLoading(false);
        setSourceDetailLoading(false);
      }
    }
  };
  const fetchLibraryBody = async (force = false) => {
    if (!selectedKnowledge) return;
    const source = selectedKnowledge;
    const requestId = ++focusRequestId.current;
    setLibraryBodyLoading(true);
    setLibraryBodyError('');
    try {
      const body = await window.wmb.fetchSourceBody({ sourceId: source.id, force, maxChars: 20000 });
      if (requestId !== focusRequestId.current) return;
      setLibraryBody(body);
      publishFocus(source, body);
    } catch (error) {
      if (requestId !== focusRequestId.current) return;
      setLibraryBodyError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === focusRequestId.current) setLibraryBodyLoading(false);
    }
  };
  const loadWatchingBoard = async () => {
    const rows = await window.wmb.listWatchingSources({ limit: 30 });
    setWatchingBoard((rows ?? []) as LibrarySourceItem[]);
  };

  // 「已移出」视图：archived 条目 + 最新判定流水（AI 判定不相关原因 / 主编归档），上限 100 条按时间倒序。
  const loadRemoved = async () => {
    const page = await window.wmb.listKnowledgeSources({ managementStatus: 'archived', limit: 100, offset: 0 });
    setRemovedList(((page?.items ?? []) as LibrarySourceItem[]));
    setRemovedTotal(page?.total ?? 0);
  };
  const restoreRemovedSource = async (source: LibrarySourceItem) => {
    if (source.revision == null) return;
    setRemovedBusyId(source.id);
    setRemovedError('');
    try {
      await window.wmb.laneRestoreSource({ sourceId: source.id, expectedRevision: source.revision });
      setRestoreConfirmId(null);
      void loadRemoved();
    } catch (error) {
      setRemovedError(error instanceof Error ? error.message : String(error));
      void loadRemoved(); // 陈旧 revision 冲突后刷新列表，可重试
    } finally {
      setRemovedBusyId(null);
    }
  };

  const loadKnowledge = async () => {
    const page = await window.wmb.listKnowledgeSources({
      query: knowledgeQuery,
      verificationStatus: verificationFilter || undefined,
      managementStatus: managementFilter || undefined,
      limit: 50,
      offset: knowledgeOffset
    });
    setKnowledge(page);
  };

  // 行内联知识面：正文缓存状态 + 摄取回执摘要 + 未处理健康问题数（有界批量读取）。
  const loadRowMeta = async () => {
    const items = knowledge?.items ?? [];
    const ids = items.map((item) => item.id);
    if (!ids.length) {
      setBodyStatusBySource(new Map());
      setDigestsBySource(new Map());
      setOpenHealthBySource(new Map());
      return;
    }
    const [bodies, receipts, issues] = await Promise.all([
      window.wmb.listSourceBodyCaches(ids).catch(() => []),
      window.wmb.listUpdateReceipts({ limit: 200 }).catch(() => null),
      window.wmb.listHealthIssues({ status: 'open', limit: 200 }).catch(() => null)
    ]);
    const bodyMap = new Map<string, string>();
    for (const body of bodies ?? []) {
      if (body && typeof body.sourceId === 'string' && body.status) bodyMap.set(body.sourceId, String(body.status));
    }
    setBodyStatusBySource(bodyMap);
    const digestMap = new Map<string, SourceDigest>();
    for (const id of ids) digestMap.set(id, digestForSource(receipts?.items ?? [], id));
    setDigestsBySource(digestMap);
    const healthMap = new Map<string, number>();
    for (const issue of issues?.items ?? []) {
      if (!issue.affectedObjectId) continue;
      healthMap.set(issue.affectedObjectId, (healthMap.get(issue.affectedObjectId) ?? 0) + 1);
    }
    setOpenHealthBySource(healthMap);
  };

  const loadRediscovery = async () => {
    const value = await window.wmb.getRediscovery();
    setRediscovery({
      unused: (value?.unused ?? []) as RediscoveryItem[],
      watching: (value?.watching ?? []) as RediscoveryItem[],
      pending: (value?.pending ?? []) as RediscoveryItem[]
    });
  };

  const loadHealthIssues = async () => {
    setHealthLoading(true);
    setHealthError('');
    try {
      const page = await window.wmb.listHealthIssues({
        status: (healthStatusFilter || undefined) as KnowledgeHealthIssueStatus | undefined,
        severity: (healthSeverityFilter || undefined) as KnowledgeHealthSeverity | undefined,
        issueType: (healthTypeFilter || undefined) as KnowledgeHealthIssueType | undefined,
        limit: 50,
        offset: healthOffset
      });
      setHealthIssues((page?.items ?? []) as KnowledgeHealthIssueRecord[]);
      setHealthTotal(page?.total ?? 0);
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : String(error));
    } finally {
      setHealthLoading(false);
    }
  };

  // 受影响对象标题索引（知识健康页内联标签；深链仍走 resolveKnowledgeDeepLink）。
  const loadAffectedIndex = async () => {
    const [sources, wikiPages, notes] = await Promise.all([
      window.wmb.listKnowledgeSources({ limit: 100 }).catch(() => null),
      window.wmb.listWikiPages({ limit: 100 }).catch(() => null),
      window.wmb.listKnowledgeNotes({ limit: 100 }).catch(() => null)
    ]);
    const index = new Map<string, { title: string; type: string }>();
    for (const source of (sources?.items ?? []) as LibrarySourceItem[]) {
      index.set(source.id, { title: source.title, type: 'source' });
    }
    for (const page of wikiPages?.items ?? []) {
      index.set(page.id, { title: page.title, type: 'wiki_page' });
    }
    for (const note of notes?.items ?? []) {
      index.set(note.id, { title: note.title, type: 'knowledge_note' });
    }
    setAffectedIndex(index);
  };

  const affectedLabel = (issue: KnowledgeHealthIssueRecord): string => {
    if (!issue.affectedObjectId) return '全局';
    const hit = affectedIndex.get(issue.affectedObjectId);
    if (hit) return hit.title;
    const prefix = issue.affectedObjectType === 'source' ? '资料'
      : issue.affectedObjectType === 'wiki_page' ? 'Wiki'
      : issue.affectedObjectType === 'knowledge_note' ? '知识'
      : '对象';
    return `${prefix} ${issue.affectedObjectId.slice(0, 8)}`;
  };

  const openHealthAffected = async (issue: KnowledgeHealthIssueRecord) => {
    if (!issue.affectedObjectType || !issue.affectedObjectId) return;
    const link = await window.wmb.resolveKnowledgeDeepLink({ objectType: issue.affectedObjectType, objectId: issue.affectedObjectId }).catch(() => null);
    if (link?.targetType === 'source' && link.targetId) {
      void openSourceDrawer({ id: link.targetId, title: link.title ?? '定位中的资料' });
    } else if (link?.targetType === 'topic_wiki' && link.targetId) {
      onOpenTopic?.(link.targetId);
    }
  };

  const openPendingTopic = async (item: RediscoveryItem) => {
    const context = await window.wmb.getKnowledgeContext({ sourceId: item.id, limit: 5 }).catch(() => null);
    const topics = asSourceKnowledgeContext(context)?.topics ?? [];
    if (topics[0]) {
      onOpenTopic?.(topics[0].id);
    } else {
      void openSourceDrawer({ id: item.id, title: item.title });
    }
  };

  useEffect(() => {
    if (section === 'saved') {
      void loadKnowledge();
      void loadWatchingBoard();
    }
  }, [section, knowledgeQuery, verificationFilter, managementFilter, knowledgeOffset]);
  useEffect(() => {
    if (section !== 'saved') return;
    void loadRowMeta();
  }, [section, knowledge]);

  useEffect(() => {
    if (section === 'saved') {
      return window.wmb.onDataChanged((event) => {
        if (!shouldRefreshLibrary(event.scopes)) return;
        void loadKnowledge();
        void loadWatchingBoard();
        setRefreshAnnouncement('资料库已自动更新');
      });
    }
  }, [section, knowledgeQuery, verificationFilter, managementFilter, knowledgeOffset]);
  useEffect(() => {
    if (!focusSourceId || section !== 'saved' || !knowledge?.items?.length) return;
    const hit = knowledge.items.find((item) => item.id === focusSourceId);
    if (hit) {
      void openSourceDrawer(hit);
      onFocusSourceConsumed?.();
      return;
    }
    void openSourceDrawer({ id: focusSourceId, title: '定位中的资料' });
    onFocusSourceConsumed?.();
  }, [focusSourceId, section, knowledge?.items?.map((item) => item.id).join('|')]);

  useEffect(() => {
    if (section === 'pending') {
      void loadRediscovery();
    }
    if (section === 'health') {
      void loadHealthIssues();
      void loadAffectedIndex();
    }
    if (section === 'removed') {
      void loadRemoved();
    }
  }, [section]);
  useEffect(() => {
    if (section !== 'pending') return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshLibrary(event.scopes)) return;
      void loadRediscovery();
      setRefreshAnnouncement('待处理已自动更新');
    });
  }, [section]);
  useEffect(() => {
    if (section !== 'health') return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshLibrary(event.scopes)) return;
      void loadHealthIssues();
      setRefreshAnnouncement('知识健康已自动更新');
    });
  }, [section, healthSeverityFilter, healthStatusFilter, healthTypeFilter, healthOffset]);
  useEffect(() => {
    if (section !== 'removed') return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshLibrary(event.scopes)) return;
      void loadRemoved();
    });
  }, [section]);

  // 详情打开期间 receipt/knowledge 变化 → 就地刷新回执与证据（Wiki 无手动刷新更新）。
  useEffect(() => {
    if (!selectedKnowledge) return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshLibrary(event.scopes)) return;
      const requestId = ++detailRefreshId.current;
      void loadSourceDetail(selectedKnowledge.id, requestId);
      setRefreshAnnouncement('知识状态已自动更新');
    });
  }, [selectedKnowledge?.id]);

  const closeSourceDetail = () => {
    focusRequestId.current += 1;
    setSourceContext(null);
    setSelectedKnowledge(null);
    setSourceDetail(null);
    setSourceDetailLoading(false);
    setLibraryBody(null);
    setLibraryBodyError('');
    setEditingSource(false);
    setSourceActionError('');
    setPendingSourceAction(null);
    publishFocus(null);
  };
  const beginEditSource = () => {
    if (!selectedKnowledge) return;
    setEditTitle(selectedKnowledge.title || '');
    setEditSummary(selectedKnowledge.summary || '');
    setEditAuthor(selectedKnowledge.author || '');
    setSourceActionError('');
    setEditingSource(true);
  };
  const saveSourceEdits = async () => {
    if (!selectedKnowledge || selectedKnowledge.revision == null) return;
    const title = editTitle.trim();
    if (!title) {
      setSourceActionError('标题不能为空');
      return;
    }
    setSourceActionBusy(true);
    setSourceActionError('');
    try {
      const result = await window.wmb.updateKnowledgeSource({
        id: selectedKnowledge.id,
        expectedRevision: selectedKnowledge.revision,
        title,
        summary: editSummary.trim() || null,
        author: editAuthor.trim() || null
      });
      const next = {
        ...selectedKnowledge,
        title,
        summary: editSummary.trim() || null,
        author: editAuthor.trim() || null,
        revision: result.revision
      };
      setSelectedKnowledge(next);
      setEditingSource(false);
      publishFocus(next, libraryBody);
      void loadKnowledge();
      void loadWatchingBoard();
    } catch (error) {
      setSourceActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSourceActionBusy(false);
    }
  };
  const archiveSelectedSource = async () => {
    if (!selectedKnowledge || selectedKnowledge.revision == null) return;
    setSourceActionBusy(true);
    setSourceActionError('');
    try {
      await window.wmb.updateKnowledgeSource({
        id: selectedKnowledge.id,
        expectedRevision: selectedKnowledge.revision,
        managementStatus: 'archived'
      });
      closeSourceDetail();
      void loadKnowledge();
      void loadWatchingBoard();
    } catch (error) {
      setSourceActionError(error instanceof Error ? error.message : String(error));
      setPendingSourceAction(null);
    } finally {
      setSourceActionBusy(false);
    }
  };
  const deleteSelectedSource = async () => {
    if (!selectedKnowledge || selectedKnowledge.revision == null) return;
    setSourceActionBusy(true);
    setSourceActionError('');
    try {
      await window.wmb.deleteKnowledgeSource({
        id: selectedKnowledge.id,
        expectedRevision: selectedKnowledge.revision
      });
      closeSourceDetail();
      void loadKnowledge();
      void loadWatchingBoard();
    } catch (error) {
      setSourceActionError(error instanceof Error ? error.message : String(error));
      setPendingSourceAction(null);
    } finally {
      setSourceActionBusy(false);
    }
  };

  if (selectedKnowledge) {
    const metaBits = [
      selectedKnowledge.managementStatus === 'watching' ? '观察中' : null,
      formatSourcePublishedAt(selectedKnowledge.publishedAt) ?? formatSourcePublishedAt(selectedKnowledge.collectedAt),
      selectedKnowledge.author || null,
      domainOf(selectedKnowledge.originalUrl ?? null)
    ].filter(Boolean);
    const detail = sourceDetail;
    const quality = sourceQualityProfile(selectedKnowledge, {
      bodyStatus: libraryBody?.status ?? bodyStatusBySource.get(selectedKnowledge.id) ?? 'none',
      digested: (detail?.receipts.items.length ?? 0) > 0,
      evidenceCount: detail?.evidence.items.length ?? 0,
      openHealthIssues: (detail?.healthIssues.items ?? []).filter((issue) => issue.status === 'open' || issue.status === 'repairing').length
    });
    const openHealth = (detail?.healthIssues.items ?? []).filter((issue) => issue.status === 'open' || issue.status === 'repairing');
    return <section className="page library-page library-source-detail-page">
      <header className="library-source-detail-head">
        <button className="text-button" onClick={closeSourceDetail}>← 返回资料库</button>
        <div className="library-source-detail-actions">
          {!editingSource ? <button className="secondary-button" disabled={sourceActionBusy} onClick={beginEditSource}>编辑</button> : null}
          <button className="secondary-button" disabled={libraryBodyLoading || sourceActionBusy} onClick={() => void fetchLibraryBody(false)}>{libraryBody?.status === 'ready' ? '刷新正文' : '抓取正文'}</button>
          {libraryBody?.status === 'ready' ? <button className="secondary-button" disabled={libraryBodyLoading || sourceActionBusy} onClick={() => void fetchLibraryBody(true)}>强制重抓</button> : null}
          {selectedKnowledge.originalUrl ? <button className="secondary-button" onClick={() => void window.wmb.openExternal(selectedKnowledge.originalUrl!)}>打开原文 ↗</button> : null}
          <button className="secondary-button" disabled={sourceActionBusy || selectedKnowledge.revision == null} onClick={() => { setSourceActionError(''); setPendingSourceAction('archive'); }}>归档</button>
          <button className="text-button danger-button" disabled={sourceActionBusy || selectedKnowledge.revision == null} onClick={() => { setSourceActionError(''); setPendingSourceAction('delete'); }}>删除</button>
        </div>
      </header>
      <article className="library-source-detail">
        {sourceActionError ? <p className="source-detail-error">{sourceActionError}</p> : null}
        {pendingSourceAction ? (
          <div className="library-source-confirm" role="group" aria-label={pendingSourceAction === 'delete' ? '确认删除' : '确认归档'}>
            <p>{pendingSourceAction === 'delete'
              ? `永久删除「${selectedKnowledge.title}」？不可恢复。`
              : `归档「${selectedKnowledge.title}」后，默认列表不再显示。`}</p>
            <div className="library-source-detail-actions">
              <button
                className={pendingSourceAction === 'delete' ? 'primary-button danger-button' : 'primary-button'}
                disabled={sourceActionBusy}
                onClick={() => { void (pendingSourceAction === 'delete' ? deleteSelectedSource() : archiveSelectedSource()); }}
              >{pendingSourceAction === 'delete' ? '确认删除' : '确认归档'}</button>
              <button className="secondary-button" disabled={sourceActionBusy} onClick={() => setPendingSourceAction(null)}>取消</button>
            </div>
          </div>
        ) : null}
        {editingSource ? (
          <div className="library-source-edit">
            <label>标题<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>
            <label>作者<input value={editAuthor} onChange={(event) => setEditAuthor(event.target.value)} /></label>
            <label>摘要<textarea value={editSummary} rows={6} onChange={(event) => setEditSummary(event.target.value)} /></label>
            <div className="library-source-detail-actions">
              <button className="primary-button" disabled={sourceActionBusy} onClick={() => void saveSourceEdits()}>保存</button>
              <button className="secondary-button" disabled={sourceActionBusy} onClick={() => { setEditingSource(false); setSourceActionError(''); }}>取消</button>
            </div>
          </div>
        ) : (
          <>
            <h1>{selectedKnowledge.title}</h1>
            {metaBits.length ? <p className="library-source-detail-meta">{metaBits.join(' · ')}</p> : null}
          </>
        )}
        <div className="knowledge-status-controls">
          <label>核验<select value={selectedKnowledge.verificationStatus ?? 'pending'} disabled={sourceActionBusy || selectedKnowledge.revision == null} onChange={async (event) => {
            if (selectedKnowledge.revision == null) return;
            const result = await window.wmb.updateKnowledgeSource({ id: selectedKnowledge.id, expectedRevision: selectedKnowledge.revision, verificationStatus: event.target.value });
            setSelectedKnowledge({ ...selectedKnowledge, verificationStatus: event.target.value, revision: result.revision });
            void loadKnowledge();
          }}><option value="pending">待核验</option><option value="verified">已核验</option><option value="disputed">有争议</option><option value="rejected">已排除</option></select></label>
          <label>管理<select value={selectedKnowledge.managementStatus ?? 'active'} disabled={sourceActionBusy || selectedKnowledge.revision == null} onChange={async (event) => {
            if (selectedKnowledge.revision == null) return;
            const result = await window.wmb.updateKnowledgeSource({ id: selectedKnowledge.id, expectedRevision: selectedKnowledge.revision, managementStatus: event.target.value });
            setSelectedKnowledge({ ...selectedKnowledge, managementStatus: event.target.value, revision: result.revision });
            void loadKnowledge();
            void loadWatchingBoard();
          }}><option value="active">活跃</option><option value="watching">观察中</option><option value="expired">已过期</option><option value="archived">已归档</option></select></label>
        </div>
        {!editingSource ? <section>
          <h2>摘要</h2>
          <p>{selectedKnowledge.summary || '暂无摘要'}</p>
        </section> : null}
        {!editingSource ? <section className="library-source-quality">
          <h2>来源质量</h2>
          {sourceDetailLoading ? <p className="library-detail-loading">正在读取知识画像…</p> : (
            <div className="library-quality-grid" role="list" aria-label="来源质量画像">
              <span className="quality-cell"><b className={`pill-status ${quality.verification.cls}`}><span className="dot"/>{quality.verification.text}</b><small>核验</small></span>
              <span className="quality-cell"><b className={`pill-status ${quality.management.cls}`}><span className="dot"/>{quality.management.text}</b><small>管理</small></span>
              {quality.priority != null ? <span className="quality-cell"><b>{quality.priority}</b><small>优先级</small></span> : null}
              <span className="quality-cell"><b>{bodyStatusLabel(quality.bodyStatus)}</b><small>正文</small></span>
              <span className="quality-cell"><b>{quality.digested ? '已消化' : '未消化'}</b><small>知识消化</small></span>
              <span className="quality-cell"><b>{quality.evidenceCount}</b><small>证据贡献</small></span>
              <span className="quality-cell"><b className={openHealth.length ? 'health-count' : ''}>{quality.openHealthIssues}</b><small>未处理健康问题</small></span>
            </div>
          )}
        </section> : null}
        <section>
          <div className="source-detail-body-head">
            <h2>正文</h2>
            <span className="source-detail-body-status">{libraryBodyLoading ? '处理中…' : libraryBody?.status === 'ready' ? `已缓存 ${libraryBody.extractedChars} 字` : libraryBody?.status === 'failed' ? '抓取失败' : libraryBody?.status === 'empty' ? '无正文' : '尚未抓取'}</span>
          </div>
          {libraryBodyError ? <p className="source-detail-error">{libraryBodyError}</p> : null}
          {libraryBody?.errorMessage ? <p className="source-detail-error">{libraryBody.errorMessage}</p> : null}
          {libraryBody?.status === 'ready' && libraryBody.extractedText
            ? <div className="library-source-detail-body">{libraryBody.extractedText}</div>
            : <p className="empty-copy">暂无正文</p>}
        </section>
        <section className="library-source-receipts">
          <h2>摄取回执 · {(detail?.receipts.items ?? []).length}</h2>
          <details open={sourceDetailLoading ? undefined : (detail?.receipts.items.length ?? 0) > 0}>
            <summary>最近知识编译与摄取回执（可收起，持久可回看）</summary>
            {(detail?.receipts.items ?? []).map((receipt) => (
              <article className="library-receipt-item" key={receipt.id}>
                <div className="library-receipt-head">
                  <span className="tag receipt-trigger">{receiptTriggerLabel(receipt.triggerType)}</span>
                  <span className="library-receipt-time">{formatDateTime(receipt.createdAt)}</span>
                  {receipt.requestId ? <span className="library-receipt-request">#{receipt.requestId.slice(0, 12)}</span> : null}
                </div>
                <p className="library-receipt-summary">{receipt.summary}</p>
                <p className="library-receipt-counts">{receiptCountsSummary(receipt.counts)}</p>
                {(receipt.autoResolutions ?? []).length ? <p className="library-receipt-resolutions"><strong>自动处理</strong>{(receipt.autoResolutions ?? []).map(readableEntry).join('；')}</p> : null}
                {(receipt.retainedDisputes ?? []).length ? <p className="library-receipt-disputes"><strong>保留争议</strong>{(receipt.retainedDisputes ?? []).map(readableEntry).join('；')}</p> : null}
                {(receipt.failures ?? []).length ? <p className="library-receipt-failures"><strong>未处理</strong>{(receipt.failures ?? []).map(readableEntry).join('；')}</p> : null}
                {(receipt.affectedTopics ?? []).length ? <div className="library-receipt-topics"><span>影响主题</span>{(receipt.affectedTopics ?? []).map((topic) => {
                  const topicId = typeof topic === 'string' ? topic : topic && typeof topic === 'object' ? (topic as { id?: unknown }).id : undefined;
                  if (typeof topicId !== 'string') return null;
                  return <button key={topicId} className="secondary-button" onClick={() => onOpenTopic?.(topicId)}>打开主题 {topicId.slice(0, 8)}</button>;
                })}</div> : null}
              </article>
            ))}
            {!sourceDetailLoading && !(detail?.receipts.items ?? []).length ? <p className="empty-copy">尚无摄取回执。新资料保存并完成知识编译后会出现在这里。</p> : null}
          </details>
        </section>
        <section>
          <h2>证据贡献</h2>
          {sourceDetailLoading ? <p className="library-detail-loading">正在读取证据…</p> : (detail?.evidence.items ?? []).length ? (
            <div className="library-evidence-list">
              {(detail?.evidence.items ?? []).map((entry) => (
                <article className="library-evidence-item" key={entry.id}>
                  <div className="library-evidence-head">
                    <span className={`tag evidence-relation ${evidenceRelationLabel(entry.relation)}`}>{evidenceRelationLabel(entry.relation)}</span>
                    <span className="tag evidence-nature">{evidenceNatureLabel(entry.sourceNature)}</span>
                    <span className={`pill-status ${conclusionStatusCls(entry.noteConclusionStatus)}`}><span className="dot"/>{conclusionStatusLabel(entry.noteConclusionStatus)}</span>
                  </div>
                  <p className="library-evidence-statement">{entry.noteStatement}</p>
                  {entry.excerpt ? <blockquote className="library-evidence-excerpt">{entry.excerpt}</blockquote> : null}
                  {entry.locator ? <p className="library-evidence-locator">定位：{entry.locator}</p> : null}
                </article>
              ))}
            </div>
          ) : <p className="empty-copy">该资料尚未形成证据贡献。知识编译后，支持/反驳/限定的固定知识版本会出现在这里。</p>}
        </section>
        <section>
          <h2>关联</h2>
          <p className="library-source-detail-meta">主题 {sourceContext?.topics.length ?? 0} · 机会 {sourceContext?.opportunities.length ?? 0} · 项目 {sourceContext?.projects.length ?? 0} · 发布 {sourceContext?.publications.length ?? 0}</p>
          <div className="library-source-detail-links">
            {(detail?.topics.length ? detail.topics : (sourceContext?.topics ?? [])).map((item) => <button key={item.id} className="secondary-button" onClick={() => onOpenTopic?.(item.id)}>{item.title}</button>)}
          </div>
          {(sourceContext?.reviews ?? []).map((review) => <article className="library-source-detail-note" key={review.id}><strong>复盘</strong><p>{review.summary || '无摘要'}</p></article>)}
          {(sourceContext?.findings ?? []).map((finding) => <article className="library-source-detail-note" key={finding.id}><strong>{finding.title}</strong><p>{finding.body}</p></article>)}
        </section>
        <section>
          <h2>批注</h2>
          {sourceDetailLoading ? <p className="library-detail-loading">正在读取批注…</p> : (detail?.annotations.items ?? []).length ? (
            <div className="library-annotation-list">
              {(detail?.annotations.items ?? []).map((annotation) => (
                <article className="library-annotation-item" key={annotation.id}>
                  <div className="library-annotation-head">
                    <span className="tag annotation-intent">{annotationIntentLabel(annotation.intent)}</span>
                    <span className="library-annotation-time">{formatDateTime(annotation.createdAt)}</span>
                  </div>
                  <p className="library-annotation-body">{annotation.body}</p>
                </article>
              ))}
            </div>
          ) : <p className="empty-copy">暂无批注。对知识对象的纠正、限定与批注会随知识编译沉淀在这里。</p>}
        </section>
        <section>
          <h2>健康问题</h2>
          {sourceDetailLoading ? <p className="library-detail-loading">正在读取健康问题…</p> : openHealth.length ? (
            <div className="library-issue-list">
              {openHealth.map((issue) => (
                <article className="library-issue-item" key={issue.id}>
                  <div className="library-issue-head">
                    <span className={`issue-severity ${healthSeverityCls(issue.severity)}`}>{severityLabel(issue.severity)}</span>
                    <span className="tag issue-type">{issueTypeLabel(issue.issueType)}</span>
                    <span className={`pill-status ${issueStatusCls(issue.status)}`}><span className="dot"/>{healthStatusLabel(issue.status)}</span>
                  </div>
                  <p className="library-issue-suggestion">{issue.suggestedAction}</p>
                  {issue.resolutionNote ? <p className="library-issue-resolution">解决记录：{issue.resolutionNote}</p> : null}
                  <p className="library-issue-time">检测于 {formatDateTime(issue.detectedAt)}</p>
                </article>
              ))}
            </div>
          ) : <p className="empty-copy">该资料当前没有未处理健康问题。</p>}
        </section>
      </article>
    </section>;
  }

  return <section className="page library-page">
    <p className="sr-only" aria-live="polite">{refreshAnnouncement}</p>
    <nav className="proposal-tabs library-tabs" role="tablist" aria-label="资料库分页面" onKeyDown={onTabsKeyDown}>
      {SECTIONS.map((item) => (
        <button
          type="button"
          key={item.id}
          role="tab"
          aria-selected={section === item.id}
          aria-label={`${item.label}，${item.hint}`}
          className={`proposal-tab${section === item.id ? ' active' : ''}`}
          onClick={() => openSection(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>

    {section === 'saved' ? <>
      {watchingBoard.length > 0 && managementFilter !== 'watching' && <section className="library-watching-board" aria-label="观察中">
        <div className="library-watching-head">
          <h2>观察中 · {watchingBoard.length}</h2>
        </div>
        <div className="library-watching-list">
          {watchingBoard.map((source) => (
            <article
              className="library-watching-card"
              key={`watch-${source.id}`}
              role="button"
              tabIndex={0}
              onClick={() => { void openSourceDrawer(source); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  void openSourceDrawer(source);
                }
              }}
            >
              <div className="library-watching-title">{source.title}</div>
              <div className="library-watching-meta">
                <span>观察中</span>
                <span>{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt) ?? ''}</span>
              </div>
              {source.summary ? <p>{source.summary}</p> : null}
            </article>
          ))}
        </div>
      </section>}
      <div className="page-toolbar knowledge-toolbar">
        <input aria-label="搜索资料" placeholder="搜索标题、摘要或关键词" value={knowledgeQuery} onChange={(e) => { setKnowledgeQuery(e.target.value); setKnowledgeOffset(0); }}/>
        <span className="chip-label">核验</span>
        {([['', '全部'], ['verified', '已核验'], ['pending', '待核验'], ['disputed', '有争议'], ['rejected', '已排除']] as const).map(([value, label]) => <button key={value} className={`chip${verificationFilter === value ? ' on' : ''}`} aria-label={`核验状态 ${label}`} onClick={() => { setVerificationFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
        <span className="chip-label">管理</span>
        {([['', '全部'], ['active', '活跃'], ['watching', '观察中'], ['expired', '已过期'], ['archived', '已归档']] as const).map(([value, label]) => <button key={value} className={`chip${managementFilter === value ? ' on' : ''}`} aria-label={`管理状态 ${label}`} onClick={() => { setManagementFilter(value); setKnowledgeOffset(0); }}>{label}</button>)}
      </div>
      {knowledge?.items.length ? <div className="library-list">{RECENCY_GROUPS.map((groupLabel) => {
        const groupItems = knowledge.items.filter((source) => recencyGroupOf(source) === groupLabel);
        if (!groupItems.length) return null;
        return <div className="lib-group" key={groupLabel}>
          <div className="lib-group-head"><span>{groupLabel}</span><span>{groupItems.length} 条</span></div>
          {groupItems.map((source) => {
        const statePill = source.managementStatus === 'watching' ? { cls: 'blue', text: '观察中' }
          : source.managementStatus === 'archived' ? { cls: 'gray', text: '已归档' }
          : source.managementStatus === 'expired' ? { cls: 'gray', text: '已过期' }
          : source.verificationStatus === 'verified' ? { cls: 'green', text: '已验证' }
          : source.verificationStatus === 'disputed' ? { cls: 'amber', text: '有争议' }
          : source.verificationStatus === 'rejected' ? { cls: 'gray', text: '已排除' }
          : { cls: 'gray', text: '待验证' };
        const tags = String(source.topics || '').split(/[,，、]/).map((tag) => tag.trim()).filter((tag) => tag && tag !== '尚未归入主题').slice(0, 4);
        const domain = domainOf(source.originalUrl ?? null);
        const used = (source.opportunityCount ?? 0) + (source.projectCount ?? 0) + (source.publicationCount ?? 0) > 0;
        const digest = digestsBySource.get(source.id);
        const inlineBadges = sourceListBadges({
          bodyStatus: bodyStatusBySource.get(source.id),
          digested: digest?.latest != null,
          openHealthIssues: openHealthBySource.get(source.id)
        });
        return <article className="lib-row" key={source.id} role="button" tabIndex={0} onClick={() => { void openSourceDrawer(source); }} onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openSourceDrawer(source);
          }
        }}>
          <SourceMark canonicalUrl={source.originalUrl ?? null} aiSourcePresentation={aiSourcePresentation}/>
          <div className="lib-main">
            {domain ? <div className="lib-eyebrow">{domain}</div> : null}
            <div className="lib-title">{source.title}</div>
            <div className="lib-sum">{source.summary || '暂无摘要'}</div>
            <div className="lib-tags">{tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}{used
              ? <span className="tag lib-count">机会 {source.opportunityCount ?? 0} · 内容 {source.projectCount ?? 0} · 发布 {source.publicationCount ?? 0}</span>
              : <span className="tag lib-count lib-unused">尚未使用</span>}
              {inlineBadges.map((badge) => <span key={badge.text} className={`tag lib-inline ${badge.cls}`}>{badge.text}</span>)}
            </div>
            {digest?.latest ? <p className="lib-knowledge-change">{receiptTriggerLabel(digest.latest.triggerType)}：{digest.latest.summary}</p> : null}
          </div>
          <div className="lib-side">
            <span className={`pill-status ${statePill.cls}`}><span className="dot"/>{statePill.text}</span>
            <span className="lib-time">{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt)}</span>
            {source.originalUrl ? <button className="text-button" onClick={(event) => { event.stopPropagation(); const url = source.originalUrl; if (url) void window.wmb.openExternal(url); }}>原文 ↗</button> : null}
          </div>
        </article>;
          })}
        </div>;
      })}</div> : <section className="empty-state library-empty"><h2>没有匹配资料</h2><p>调整搜索或筛选条件后再看。</p></section>}
      <div className="knowledge-pager"><button disabled={knowledgeOffset === 0} onClick={() => setKnowledgeOffset(Math.max(0, knowledgeOffset - 50))}>上一页</button><span>{knowledgeOffset + 1}–{Math.min(knowledgeOffset + 50, knowledge?.total ?? 0)} / {knowledge?.total ?? 0}</span><button disabled={!knowledge?.hasMore} onClick={() => setKnowledgeOffset(knowledgeOffset + 50)}>下一页</button></div>
    </> : section === 'pending' ? <div className="pending-pools">{PENDING_POOLS.map(([key, title, hint]) => {
      const items = rediscovery[key as keyof typeof rediscovery] ?? [];
      return <section key={key} className="pending-pool" aria-label={title}>
        <div className="pending-pool-head"><h2>{title}<span>{items.length}</span></h2><p>{hint}</p></div>
        {items.length ? <div className="pending-pool-list">{items.map((item) => (
          <article className="pending-item" key={item.id}>
            <div className="pending-item-main">
              <strong>{item.title}</strong>
              <small className="pending-item-reason">{item.reason}</small>
              {item.latestReceipt ? <p className="pending-item-change">{receiptTriggerLabel(item.latestReceipt.triggerType)}：{item.latestReceipt.summary}</p> : null}
              <div className="pending-item-actions">
                <button className="secondary-button" onClick={() => { void openSourceDrawer(item); }}>打开资料</button>
                <button className="secondary-button" onClick={() => { void openPendingTopic(item); }}>打开主题</button>
              </div>
            </div>
          </article>
        ))}</div> : <p className="empty-copy">当前没有此类待处理资料。</p>}
      </section>;
    })}</div> : section === 'health' ? <section className="health-section" aria-label="知识健康">
      <div className="page-toolbar knowledge-toolbar">
        <span className="chip-label">严重度</span>
        {HEALTH_SEVERITY_FILTERS.map(([value, label]) => <button key={value} className={`chip${healthSeverityFilter === value ? ' on' : ''}`} aria-label={`严重度 ${label}`} onClick={() => { setHealthSeverityFilter(value); setHealthOffset(0); }}>{label}</button>)}
        <span className="chip-label">状态</span>
        {HEALTH_STATUS_FILTERS.map(([value, label]) => <button key={value} className={`chip${healthStatusFilter === value ? ' on' : ''}`} aria-label={`健康状态 ${label}`} onClick={() => { setHealthStatusFilter(value); setHealthOffset(0); }}>{label}</button>)}
        <span className="chip-label">类型</span>
        {HEALTH_TYPE_FILTERS.map(([value, label]) => <button key={value} className={`chip${healthTypeFilter === value ? ' on' : ''}`} aria-label={`问题类型 ${label}`} onClick={() => { setHealthTypeFilter(value); setHealthOffset(0); }}>{label}</button>)}
        <span className="health-total">健康问题 · {healthTotal} 条</span>
      </div>
      {healthError ? <p className="source-detail-error">{healthError}</p> : null}
      {healthLoading ? <p className="library-detail-loading">正在读取健康问题…</p> : healthIssues.length ? <div className="library-issue-list health-list">{healthIssues.map((issue) => (
        <article className="library-issue-item" key={issue.id}>
          <div className="library-issue-head">
            <span className={`issue-severity ${healthSeverityCls(issue.severity)}`}>{severityLabel(issue.severity)}</span>
            <span className="tag issue-type">{issueTypeLabel(issue.issueType)}</span>
            <span className={`pill-status ${issueStatusCls(issue.status)}`}><span className="dot"/>{healthStatusLabel(issue.status)}</span>
          </div>
          <p className="library-issue-affected">影响对象：{affectedLabel(issue)}</p>
          <p className="library-issue-suggestion">{issue.suggestedAction}</p>
          {issue.resolutionNote ? <p className="library-issue-resolution">解决记录：{issue.resolutionNote}</p> : null}
          <div className="library-issue-actions">
            {issue.affectedObjectId ? <button className="secondary-button" onClick={() => { void openHealthAffected(issue); }}>打开受影响对象</button> : null}
            <span className="library-issue-time">检测于 {formatDateTime(issue.detectedAt)}</span>
          </div>
        </article>
      ))}</div> : <section className="empty-state library-empty"><h2>没有健康问题</h2><p>当前筛选下没有知识健康问题。</p></section>}
      <div className="knowledge-pager"><button disabled={healthOffset === 0} onClick={() => setHealthOffset(Math.max(0, healthOffset - 50))}>上一页</button><span>{healthOffset + 1}–{Math.min(healthOffset + 50, healthTotal)} / {healthTotal}</span><button disabled={healthOffset + 50 >= healthTotal} onClick={() => setHealthOffset(healthOffset + 50)}>下一页</button></div>
    </section> : <section className="removed-section" aria-label="已移出资料">
      <div className="page-toolbar knowledge-toolbar">
        <span className="removed-head">已移出 · {removedTotal} 条</span>
        <span className="removed-hint">被判定与本赛道无关（AI 判定不相关）或主编手动归档的资料，可查原因并恢复。</span>
      </div>
      {removedError ? <p className="source-detail-error">{removedError}</p> : null}
      {removedList.length ? <div className="library-list">{removedList.map((source) => {
        const laneBadge = source.laneJudgment?.decision === 'irrelevant' && (source.laneJudgment.judgedBy === 'agent' || source.laneJudgment.judgedBy === 'system')
          ? { cls: 'amber', text: `AI 判定不相关：${source.laneJudgment.reason || '未提供原因'}` }
          : { cls: 'gray', text: '主编归档' };
        const tags = String(source.topics || '').split(/[,，、]/).map((tag) => tag.trim()).filter((tag) => tag && tag !== '尚未归入主题').slice(0, 4);
        const domain = domainOf(source.originalUrl ?? null);
        return <div className="lib-row-wrap" key={source.id}>
          <article className="lib-row" onClick={() => { void openSourceDrawer(source); }}>
            <SourceMark canonicalUrl={source.originalUrl ?? null} aiSourcePresentation={aiSourcePresentation}/>
            <div className="lib-main">
              {domain ? <div className="lib-eyebrow">{domain}</div> : null}
              <div className="lib-title">{source.title}</div>
              <div className="lib-sum">{source.summary || '暂无摘要'}</div>
              <div className="lib-tags">
                <span className={`tag lane-badge ${laneBadge.cls}`}>{laneBadge.text}</span>
                {tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
              </div>
            </div>
            <div className="lib-side">
              <span className="lib-time">{formatSourcePublishedAt(source.publishedAt) ?? formatSourcePublishedAt(source.collectedAt)}</span>
              <button className="secondary-button" disabled={removedBusyId === source.id} onClick={(event) => { event.stopPropagation(); setRemovedError(''); setRestoreConfirmId(source.id); }}>恢复</button>
            </div>
          </article>
          {restoreConfirmId === source.id ? <div className="lane-restore-confirm" role="group" aria-label="确认恢复">
            <p>恢复后该资料回到有效资料库，7 天内不会再被自动判定</p>
            <div className="lane-restore-actions">
              <button className="primary-button" disabled={removedBusyId === source.id} onClick={(event) => { event.stopPropagation(); void restoreRemovedSource(source); }}>确认恢复</button>
              <button className="secondary-button" disabled={removedBusyId === source.id} onClick={(event) => { event.stopPropagation(); setRestoreConfirmId(null); }}>取消</button>
            </div>
          </div> : null}
        </div>;
      })}</div> : <section className="empty-state library-empty"><h2>没有已移出资料</h2><p>被判定与本赛道无关或手动归档的资料会出现在这里，可查原因并恢复。</p></section>}
    </section>}
  </section>;
}

function conclusionStatusCls(status: string | null | undefined): string {
  const value = String(status ?? '');
  if (value === 'disputed' || value === 'contradicted') return 'amber';
  if (value === 'superseded') return 'gray';
  if (value === 'supported' || value === 'inference') return 'green';
  return 'gray';
}

function issueStatusCls(status: string | null | undefined): string {
  const value = String(status ?? '');
  if (value === 'resolved' || value === 'false_positive') return 'green';
  if (value === 'repairing') return 'blue';
  if (value === 'accepted_risk') return 'amber';
  return 'amber';
}
