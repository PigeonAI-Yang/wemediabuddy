import { contextBridge, ipcRenderer } from 'electron';
import type { StudioAnnotation, StudioAnnotationResolveReason, StudioCommandResult, StudioDocumentScope, StudioReconcileMode } from '../shared/studio-annotations.ts';
import type { RoleModelPolicies } from '../shared/pi-config.ts';
import type { PiImageBatchChatInput, PiImageBatchRecord, PiImageBatchStatus } from '../shared/pi-image-batch.ts';
import type { ContentMediaBindingDraft, CropRegion, PlatformClipPayload, PlatformCropPayload, PlatformMediaBindingDraft } from '../shared/media-bindings.ts';
import {
  INVESTIGATION_IPC,
  type InvestigationDecideDirectionInput,
  type InvestigationDecideOutlineInput,
  type InvestigationDirection,
  type InvestigationOutline,
  type InvestigationReviewResearchInput
} from '../shared/project-investigation.ts';
import { ILLUSTRATION_IPC, type IllustrationItemRetryInput, type IllustrationRegenerateInput, type IllustrationStartInput, type IllustrationUndoInput } from '../shared/illustration-workflow.ts';
import {
  KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS,
  KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL,
  type KnowledgeAnnotationReadFilter,
  type KnowledgeAnnotationRecord,
  type KnowledgeChangeSetApplyInput,
  type KnowledgeChangeSetApplyResult,
  type KnowledgeChangeSetReadFilter,
  type KnowledgeChangeSetRecord,
  type KnowledgeEntityReadFilter,
  type KnowledgeEntityRecord,
  type KnowledgeEvidenceLinkRecord,
  type KnowledgeEvidenceReadFilter,
  type KnowledgeFreeNoteReadFilter,
  type KnowledgeFreeNoteRecord,
  type KnowledgeFlywheelListResult,
  type KnowledgeHealthIssueReadFilter,
  type KnowledgeHealthIssueRecord,
  type KnowledgeNoteReadFilter,
  type KnowledgeNoteRecord,
  type KnowledgeNoteVersionIdRead,
  type KnowledgeNoteVersionReadFilter,
  type KnowledgeNoteVersionRecord,
  type KnowledgeObjectIdRead,
  type KnowledgeQueryArtifactReadFilter,
  type KnowledgeQueryArtifactRecord,
  type KnowledgeQueryWritebackSummaryRecord,
  type KnowledgeReceiptReadFilter,
  type KnowledgeRelationReadFilter,
  type KnowledgeRelationRecord,
  type KnowledgeRelationRegistryEntry,
  type KnowledgeRelationRegistryReadFilter,
  type KnowledgeRequestIdRead,
  type KnowledgeUpdateReceiptRecord,
  type KnowledgeUsagePackageReadFilter,
  type KnowledgeUsagePackageRecord,
  type KnowledgeUsageRecordReadFilter,
  type KnowledgeUsageRecordRecord,
  type KnowledgeWikiPageReadFilter,
  type KnowledgeWikiPageRecord,
  type KnowledgeWikiPageVersionReadFilter,
  type KnowledgeWikiPageVersionRecord
} from '../shared/knowledge-flywheel.ts';
import {
  KNOWLEDGE_CANVAS_DETAIL_IPC_CHANNEL,
  KNOWLEDGE_CANVAS_PROJECTION_IPC_CHANNEL,
  KNOWLEDGE_CANVAS_SELECTION_MANIFEST_IPC_CHANNEL,
  type KnowledgeCanvasNodeDetail,
  type KnowledgeCanvasNodeDetailInput,
  type KnowledgeCanvasProjection,
  type KnowledgeCanvasProjectionInput,
  type KnowledgeCanvasSelectionManifest,
  type KnowledgeCanvasSelectionManifestInput
} from '../shared/knowledge-canvas.ts';
// WMB-5243：全局 Wiki 知识网络只读投影（无 canvasId；稳定节点 ID；正式对象只读投影）。
import {
  KNOWLEDGE_NETWORK_NODE_DETAIL_IPC_CHANNEL,
  KNOWLEDGE_NETWORK_PROJECTION_IPC_CHANNEL,
  type KnowledgeNetworkNodeDetail,
  type KnowledgeNetworkNodeDetailInput,
  type KnowledgeNetworkProjection,
  type KnowledgeNetworkProjectionInput
} from '../shared/knowledge-network.ts';
import {
  KNOWLEDGE_DEEP_LINK_IPC_CHANNEL,
  KNOWLEDGE_SOURCE_KNOWLEDGE_DETAIL_IPC_CHANNEL,
  KNOWLEDGE_TOPIC_WIKI_DETAIL_IPC_CHANNEL,
  type KnowledgeDeepLinkInput,
  type KnowledgeDeepLinkPayload,
  type SourceKnowledgeDetail,
  type SourceKnowledgeDetailInput,
  type TopicWikiDetail,
  type TopicWikiDetailInput
} from '../shared/knowledge-topic-library.ts';
import {
  KNOWLEDGE_MAINTENANCE_IPC_CHANNELS,
  type KnowledgeMaintenanceRun,
  type KnowledgeMaintenanceStartInput,
  type KnowledgeMaintenanceStartResult,
  type KnowledgeMaintenanceStatusView
} from '../shared/knowledge-maintenance.ts';
// WMB-5238：统一全文搜索 / 索引摘要 / 有界 hot cache 只读（类型见 src/shared/knowledge-search.ts）。
import {
  WIKI_SEARCH_READ_IPC_CHANNELS,
  type WikiHotCacheStatus,
  type WikiIndexSummary,
  type WikiSearchFilter,
  type WikiSearchPage
} from '../shared/knowledge-search.ts';
// WMB-5238：全局知识时间日志只读（类型见 src/shared/knowledge-global-log.ts）。
import {
  KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS,
  type KnowledgeLogEntry,
  type KnowledgeLogPage,
  type KnowledgeLogReadFilter
} from '../shared/knowledge-global-log.ts';
// WMB-5244：Source 媒体读模型投影 + 用户重试/全局暂停（通道常量与类型见 src/shared/source-media.ts）。
import {
  SOURCE_MEDIA_ARCHIVE_PAUSE_IPC_CHANNEL,
  SOURCE_MEDIA_OPEN_ORIGINAL_IPC_CHANNEL,
  SOURCE_MEDIA_OVERVIEW_IPC_CHANNEL,
  SOURCE_MEDIA_RETRY_IPC_CHANNEL,
  type SourceMediaArchivePauseInput,
  type SourceMediaOpenOriginalInput,
  type SourceMediaOverview,
  type SourceMediaOverviewInput,
  type SourceMediaRetryInput
} from '../shared/source-media.ts';
// WMB-5246：创作媒体建议（生成/决定/读模型；通道常量与类型见 src/shared/media-recommendations.ts）。
import {
  MEDIA_RECOMMENDATIONS_DECIDE_IPC_CHANNEL,
  MEDIA_RECOMMENDATIONS_GENERATE_IPC_CHANNEL,
  MEDIA_RECOMMENDATIONS_LIST_IPC_CHANNEL,
  type MediaRecommendation,
  type MediaRecommendationsReadModel
} from '../shared/media-recommendations.ts';
// WMB-5269：正文归档失败统一异常中心（列表读模型 + 新周期重试；通道常量与类型见 src/shared/source-body-archive.ts）。
import {
  SOURCES_LIST_BODY_CAPTURE_FAILURES_IPC_CHANNEL,
  SOURCES_RETRY_BODY_CAPTURE_FAILURES_IPC_CHANNEL,
  type SourceBodyCaptureFailureListInput,
  type SourceBodyCaptureFailureListResult,
  type SourceBodyCaptureRetryInput,
  type SourceBodyCaptureRetryResult
} from '../shared/source-body-archive.ts';
type OwnerBrowserCommand = { workspaceId: string; expectedBindingRevision: number; expectedRegistryRevision: number };

contextBridge.exposeInMainWorld('wmb', {
  getDataRoot: () => ipcRenderer.invoke('data-root:get'),
  chooseDataRoot: () => ipcRenderer.invoke('data-root:choose'),
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  switchWorkspace: (workspaceId: string) => ipcRenderer.invoke('workspaces:switch', workspaceId),
  createUkWorkspace: () => ipcRenderer.invoke('workspaces:create-uk'),
  listWorkspaceProposals: () => ipcRenderer.invoke('workspaces:proposals-list'),
  selectWorkspaceProposalRoot: (binding: unknown) => ipcRenderer.invoke('workspaces:proposal-select-root', binding),
  confirmWorkspaceProposal: (binding: unknown) => ipcRenderer.invoke('workspaces:proposal-confirm', binding),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getOnboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  getZhihuScoring: () => ipcRenderer.invoke('zhihu-scoring:get'),
  setZhihuScoring: (input: { autoThreshold?: number; boundaryThreshold?: number; targetCount?: number }) => ipcRenderer.invoke('zhihu-scoring:set', input),
  recordOnboardingStep: (step: 'welcome' | 'workspace' | 'ai' | 'platforms') => ipcRenderer.invoke('onboarding:record-step', step),
  createDefaultWorkspace: () => ipcRenderer.invoke('onboarding:create-default-workspace'),
  chooseOnboardingWorkspace: () => ipcRenderer.invoke('onboarding:choose-workspace'),
  testOnboardingAi: (input: { baseUrl: string; api: 'openai-responses' | 'openai-completions'; apiKey: string; model: string }) => ipcRenderer.invoke('onboarding:test-ai', input),
  saveOnboardingAi: (input: { name: string; baseUrl: string; api: 'openai-responses' | 'openai-completions'; apiKey: string; model: string }, testResult: unknown) => ipcRenderer.invoke('onboarding:save-ai', input, testResult),
  setOnboardingPlatform: (platformId: string, status: 'completed' | 'skipped') => ipcRenderer.invoke('onboarding:set-platform', platformId, status),
  completeOnboarding: () => ipcRenderer.invoke('onboarding:complete'),
  getAppUpdateState: () => ipcRenderer.invoke('app-update:get-state'),
  checkAppUpdate: () => ipcRenderer.invoke('app-update:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('app-update:download'),
  installAppUpdateNow: () => ipcRenderer.invoke('app-update:install-now'),
  installAppUpdateOnQuit: () => ipcRenderer.invoke('app-update:install-on-quit'),
  remindAppUpdateLater: () => ipcRenderer.invoke('app-update:remind-later'),
  markRendererReady: () => ipcRenderer.invoke('app:renderer-ready'),
  onAppUpdateState: (listener: (state: unknown) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state); ipcRenderer.on('app-update:state', handler); return () => ipcRenderer.removeListener('app-update:state', handler); },
  openLogs: () => ipcRenderer.invoke('settings:open-logs'),
  openExternal: (url: string) => ipcRenderer.invoke('link:open', url),
  getGitHubRankings: (refresh = false) => ipcRenderer.invoke('rankings:github-ai', refresh),
  getCachedRankings: () => ipcRenderer.invoke('rankings:get-cached'),
  listZhihuHotObservations: (limit = 50) => ipcRenderer.invoke('zhihu-hot:list-observations', limit),
  readZhihuHotCategory: (category: string = 'discussion', limit = 50) => ipcRenderer.invoke('zhihu-hot:read-category', { category, limit }),
  refreshZhihuHotCategory: (category: string = 'discussion', limit = 50) => ipcRenderer.invoke('zhihu-hot:refresh-category', { category, limit }),
  getIntelligenceChannels: () => ipcRenderer.invoke('intelligence-channels:get'),
  resolveWebsiteCandidates: (input: { inputText: string }) => ipcRenderer.invoke('intelligence-channels:resolve-website', input),
  trialReadWebsite: (input: { url: string }) => ipcRenderer.invoke('intelligence-channels:trial-website', input),
  resolveXListCandidates: (input: { inputText: string }) => ipcRenderer.invoke('intelligence-channels:resolve-x-list', input),
  scanIntelligenceChannel: (input: unknown) => ipcRenderer.invoke('intelligence-channels:scan-now', input),
  prepareIntelligenceChannelProposal: (input: unknown) => ipcRenderer.invoke('intelligence-channels:proposals-prepare', input),
  listIntelligenceChannelProposals: () => ipcRenderer.invoke('intelligence-channels:proposals-list'),
  confirmIntelligenceChannelProposal: (binding: unknown) => ipcRenderer.invoke('intelligence-channels:proposal-confirm', binding),
  readXListIndex: () => ipcRenderer.invoke('x-lists:read-index'),
  getCachedXListIndex: () => ipcRenderer.invoke('x-lists:get-cached-index'),
  readXListDetail: (listId: string) => ipcRenderer.invoke('x-lists:read-detail', listId),
  readXListMembers: (listId: string) => ipcRenderer.invoke('x-lists:read-members', listId),
  readXListTimeline: (input: { listId: string; limit?: number; knownUrls?: string[] }) => ipcRenderer.invoke('x-lists:read-timeline', input),
  readXListPost: (input: { statusUrl: string; replyLimit?: number; bypassCache?: boolean }) => ipcRenderer.invoke('x-lists:read-post', input),
  getCachedXListTimeline: (input: { accountKey: string; listId: string }) => ipcRenderer.invoke('x-lists:get-cached-timeline', input),
  listCachedXListTimeline: (input: { accountKey: string; listId: string; limit?: number; offset?: number }) => ipcRenderer.invoke('x-lists:list-cached-timeline', input),
  clearXListTimelineCache: (input: { accountKey?: string } = {}) => ipcRenderer.invoke('x-lists:clear-timeline-cache', input),
  getXListTimelineCacheStats: () => ipcRenderer.invoke('x-lists:timeline-cache-stats'),
  listXPostMetricSnapshots: (input: { sourceId: string; limit?: number }) => ipcRenderer.invoke('x-lists:list-post-metric-snapshots', input),
  getXPostTrend: (input: { sourceId: string }) => ipcRenderer.invoke('x-lists:get-post-trend', input),
  listXPostTrends: (input: { bindingId: string; limit?: number }) => ipcRenderer.invoke('x-lists:list-post-trends', input),
  startXObservation: (input: { requestId: string; bindingIds: string[] }) => ipcRenderer.invoke('x-lists:start-observation', input),
  getXObservation: (input: { sessionId: string }) => ipcRenderer.invoke('x-lists:get-observation', input),
  stopXObservation: (input: { sessionId: string }) => ipcRenderer.invoke('x-lists:stop-observation', input),
  listXListBindings: (accountKey?: string) => ipcRenderer.invoke('x-lists:list-bindings', accountKey),
  listXListOperations: (input: { accountKey?: string; limit?: number } = {}) => ipcRenderer.invoke('x-lists:list-operations', input),
  getXListOperation: (operationId: string) => ipcRenderer.invoke('x-lists:get-operation', operationId),
  prepareXListOperation: (input: unknown) => ipcRenderer.invoke('x-lists:prepare', input),
  armXListOperation: (input: { operationId: string; expectedRevision: number }) => ipcRenderer.invoke('x-lists:arm', input),
  confirmXListOperation: (input: { operationId: string; expectedRevision: number; typedListName?: string }) => ipcRenderer.invoke('x-lists:confirm', input),
  stopXListOperation: (input: { operationId: string; expectedRevision: number }) => ipcRenderer.invoke('x-lists:stop', input),
  bindXList: (input: { listId: string; expectedRevision?: number }) => ipcRenderer.invoke('x-lists:bind', input),
  setXListBindingEnabled: (input: { accountKey: string; listId: string; expectedRevision: number; enabled: boolean }) => ipcRenderer.invoke('x-lists:set-binding-enabled', input),
  collectXListTimeline: (input: { accountKey: string; listId: string; limit?: number }) => ipcRenderer.invoke('x-lists:collect-timeline', input),
  listKnowledgeSources: (input = {}) => ipcRenderer.invoke('knowledge:list-sources', input),
  updateKnowledgeSource: (input: unknown) => ipcRenderer.invoke('knowledge:update-source', input),
  deleteKnowledgeSource: (input: { id: string; expectedRevision: number; confirmReferencedDelete?: boolean }) => ipcRenderer.invoke('knowledge:delete-source', input),
  // WMB-5247：情报媒体治理（owner UI 显式动作；无 Agent grant）。
  mediaOverrideRestricted: (input: { bindingId: string; reason: string }) => ipcRenderer.invoke('media:rights-override', input),
  mediaRunGc: (input: { dryRun?: boolean; retentionDays?: number }) => ipcRenderer.invoke('media:gc-run', input),
  mediaRunStagingCleanup: (input?: { dryRun?: boolean; maxStaleMs?: number }) => ipcRenderer.invoke('media:staging-cleanup', input),
  mediaSourceDeleteGate: (input: { sourceId: string }) => ipcRenderer.invoke('media:delete-gate', input),
  laneRestoreSource: (input: { sourceId: string; expectedRevision: number; reason?: string }) => ipcRenderer.invoke('knowledge:lane-restore', input),
  listWatchingSources: (input: { limit?: number } = {}) => ipcRenderer.invoke('knowledge:list-watching', input),
  markSourcesWatching: (input: { sourceIds: string[] }) => ipcRenderer.invoke('knowledge:mark-watching', input),
  getSourceBodyCache: (sourceId: string) => ipcRenderer.invoke('sources:get-body-cache', sourceId),
  listSourceBodyCaches: (sourceIds: string[] = []) => ipcRenderer.invoke('sources:list-body-cache', sourceIds),
  fetchSourceBody: (input: { sourceId: string; force?: boolean; maxChars?: number }) => ipcRenderer.invoke('sources:fetch-body', input),
  getWireHealthLedger: (input: { businessDate?: string } = {}) => ipcRenderer.invoke('sources:wire-health', input),
  // WMB-5269：正文归档失败统一异常中心（列表读模型 + 新周期重试；通道/类型见 src/shared/source-body-archive.ts）。
  listSourceBodyCaptureFailures: (input?: SourceBodyCaptureFailureListInput) => ipcRenderer.invoke(SOURCES_LIST_BODY_CAPTURE_FAILURES_IPC_CHANNEL, input) as Promise<SourceBodyCaptureFailureListResult>,
  retrySourceBodyCaptureFailures: (input: SourceBodyCaptureRetryInput) => ipcRenderer.invoke(SOURCES_RETRY_BODY_CAPTURE_FAILURES_IPC_CHANNEL, input) as Promise<SourceBodyCaptureRetryResult>,
  // WMB-5244：Source 媒体当前 revision 读模型 + 用户动作（类型/通道见 src/shared/source-media.ts）。
  getSourceMediaOverview: (input: SourceMediaOverviewInput) => ipcRenderer.invoke(SOURCE_MEDIA_OVERVIEW_IPC_CHANNEL, input) as Promise<SourceMediaOverview>,
  retrySourceMedia: (input: SourceMediaRetryInput) => ipcRenderer.invoke(SOURCE_MEDIA_RETRY_IPC_CHANNEL, input),
  setMediaArchivePaused: (input: SourceMediaArchivePauseInput) => ipcRenderer.invoke(SOURCE_MEDIA_ARCHIVE_PAUSE_IPC_CHANNEL, input),
  openSourceMediaOriginal: (input: SourceMediaOpenOriginalInput) => ipcRenderer.invoke(SOURCE_MEDIA_OPEN_ORIGINAL_IPC_CHANNEL, input),
  // WMB-5246：创作媒体建议（生成/决定/读模型；接受仍是独立 Studio 保存边界）。
  listMediaRecommendations: (input: { contentVersionId: string; projectId?: string }) => ipcRenderer.invoke(MEDIA_RECOMMENDATIONS_LIST_IPC_CHANNEL, input) as Promise<MediaRecommendationsReadModel>,
  generateMediaRecommendations: (input: { contentVersionId: string; projectId: string; sourceRevisionKeys: string[]; allowGeneratedCover?: boolean; requestId?: string }) => ipcRenderer.invoke(MEDIA_RECOMMENDATIONS_GENERATE_IPC_CHANNEL, input),
  decideMediaRecommendation: (input: { id: string; expectedRevision: number; decision: 'accept' | 'reject'; confirmedByOwner?: boolean }) => ipcRenderer.invoke(MEDIA_RECOMMENDATIONS_DECIDE_IPC_CHANNEL, input) as Promise<{ ok: boolean; data?: MediaRecommendation; error?: unknown }>,
  listIllustrationRuns: (projectId: string) => ipcRenderer.invoke(ILLUSTRATION_IPC.list, projectId),
  getIllustrationRun: (runId: string) => ipcRenderer.invoke(ILLUSTRATION_IPC.get, runId),
  startIllustration: (input: IllustrationStartInput) => ipcRenderer.invoke(ILLUSTRATION_IPC.start, input),
  retryIllustrationItem: (input: IllustrationItemRetryInput) => ipcRenderer.invoke(ILLUSTRATION_IPC.retry, input),
  regenerateIllustrationItem: (input: IllustrationRegenerateInput) => ipcRenderer.invoke(ILLUSTRATION_IPC.regenerate, input),
  undoIllustrationItem: (input: IllustrationUndoInput) => ipcRenderer.invoke(ILLUSTRATION_IPC.undo, input),
  getIllustrationImageConfig: () => ipcRenderer.invoke(ILLUSTRATION_IPC.imageConfigGet),
  saveIllustrationImageConfig: (input: { profileId: string; model: string }) => ipcRenderer.invoke(ILLUSTRATION_IPC.imageConfigSave, input),
  getXhsStatus: () => ipcRenderer.invoke('xhs:status'),
  ensureXhs: () => ipcRenderer.invoke('xhs:ensure'),
  startXhsLogin: () => ipcRenderer.invoke('xhs:start-login'),
  listKnowledgeTopics: (input = {}) => ipcRenderer.invoke('knowledge:list-topics', input),
  listTopicMaintenanceProposals: (input = {}) => ipcRenderer.invoke('knowledge:topic-maintenance-proposals', input),
  approveTopicMaintenanceProposal: (input: unknown) => ipcRenderer.invoke('knowledge:topic-maintenance-approve', input),
  rejectTopicMaintenanceProposal: (input: unknown) => ipcRenderer.invoke('knowledge:topic-maintenance-reject', input),
  resumeTopicMaintenanceReproposal: (input: unknown) => ipcRenderer.invoke('knowledge:topic-maintenance-reproposal-resume', input),
  getKnowledgeContext: (input: unknown) => ipcRenderer.invoke('knowledge:get-context', input),
  getKnowledgeTopicDossier: (input: unknown) => ipcRenderer.invoke('knowledge:get-topic-dossier', input),
  getRediscovery: () => ipcRenderer.invoke('knowledge:rediscovery'),
  // WMB-5212：Topic Wiki 详情 / Source 知识详情 / 准确深链（只读投影；类型见 src/shared/knowledge-topic-library.ts）。
  getTopicWikiDetail: (input: TopicWikiDetailInput) => ipcRenderer.invoke(KNOWLEDGE_TOPIC_WIKI_DETAIL_IPC_CHANNEL, input) as Promise<TopicWikiDetail>,
  getSourceKnowledgeDetail: (input: SourceKnowledgeDetailInput) => ipcRenderer.invoke(KNOWLEDGE_SOURCE_KNOWLEDGE_DETAIL_IPC_CHANNEL, input) as Promise<SourceKnowledgeDetail>,
  resolveKnowledgeDeepLink: (input: KnowledgeDeepLinkInput) => ipcRenderer.invoke(KNOWLEDGE_DEEP_LINK_IPC_CHANNEL, input) as Promise<KnowledgeDeepLinkPayload>,
  listKnowledgeCanvases: () => ipcRenderer.invoke('knowledge-canvas:list'),
  createKnowledgeCanvas: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:create', input),
  getKnowledgeCanvas: (id: string) => ipcRenderer.invoke('knowledge-canvas:get', id),
  updateKnowledgeCanvas: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:update', input),
  addKnowledgeCanvasNode: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:add-node', input),
  moveKnowledgeCanvasNodes: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:move-nodes', input),
  removeKnowledgeCanvasNode: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:remove-node', input),
  createKnowledgeRelation: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:create-relation', input),
  updateKnowledgeRelation: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:update-relation', input),
  decideKnowledgeSuggestion: (input: unknown) => ipcRenderer.invoke('knowledge-canvas:decide-suggestion', input),
  // WMB-5213：三模式投影 / 节点详情深链 / selected-only 清单（只读；类型见 src/shared/knowledge-canvas.ts）。
  getKnowledgeCanvasProjection: (input: KnowledgeCanvasProjectionInput) => ipcRenderer.invoke(KNOWLEDGE_CANVAS_PROJECTION_IPC_CHANNEL, input) as Promise<KnowledgeCanvasProjection>,
  getCanvasNodeDetail: (input: KnowledgeCanvasNodeDetailInput) => ipcRenderer.invoke(KNOWLEDGE_CANVAS_DETAIL_IPC_CHANNEL, input) as Promise<KnowledgeCanvasNodeDetail>,
  // WMB-5243：全局 Wiki 知识网络只读投影 / 节点知识本体详情（类型见 src/shared/knowledge-network.ts）。
  getKnowledgeNetworkProjection: (input: KnowledgeNetworkProjectionInput) => ipcRenderer.invoke(KNOWLEDGE_NETWORK_PROJECTION_IPC_CHANNEL, input) as Promise<KnowledgeNetworkProjection>,
  getKnowledgeNetworkNodeDetail: (input: KnowledgeNetworkNodeDetailInput) => ipcRenderer.invoke(KNOWLEDGE_NETWORK_NODE_DETAIL_IPC_CHANNEL, input) as Promise<KnowledgeNetworkNodeDetail>,
  validateKnowledgeSelectionManifest: (input: KnowledgeCanvasSelectionManifestInput) => ipcRenderer.invoke(KNOWLEDGE_CANVAS_SELECTION_MANIFEST_IPC_CHANNEL, input) as Promise<KnowledgeCanvasSelectionManifest>,
  previewKnowledgeContextPackage: (input: unknown) => ipcRenderer.invoke('knowledge-context:preview-package', input),
  listKnowledgeContextPackages: (input?: unknown) => ipcRenderer.invoke('knowledge-context:list-packages', input),
  getKnowledgeContextPackage: (id: string) => ipcRenderer.invoke('knowledge-context:get-package', id),
  getContentProjectContextPackages: (projectId: string) => ipcRenderer.invoke('knowledge-context:project-packages', projectId),
  getCreativeBrief: (packageId:string) => ipcRenderer.invoke('knowledge-context:get-brief',packageId),
  getCreativeBriefForContext: (input:unknown) => ipcRenderer.invoke('knowledge-context:get-brief-for-context',input),
  createCreativeBrief: (input:unknown) => ipcRenderer.invoke('knowledge-context:create-brief',input),
  updateCreativeBrief: (input:unknown) => ipcRenderer.invoke('knowledge-context:update-brief',input),
  createProjectFromBrief: (input:unknown) => ipcRenderer.invoke('knowledge-context:create-project-from-brief',input),
  getCreativeBriefLineage: (briefId:string) => ipcRenderer.invoke('knowledge-context:get-brief-lineage',briefId),
  // WMB-5210 M1 知识飞轮边界（通道/类型见 src/shared/knowledge-flywheel.ts）。
  // 入参纯 JSON 透传，不做猜测性校验/默认值；非法/缺失参数由 main boundary 拒绝。
  // list* 返回分页信封 {items,total,limit,offset,hasMore}；get* 返回单对象或 null。
  submitKnowledgeChangeSet: (input: KnowledgeChangeSetApplyInput) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_WRITE_IPC_CHANNEL, input) as Promise<KnowledgeChangeSetApplyResult>,
  listKnowledgeEntities: (input?: KnowledgeEntityReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listEntities, input) as Promise<KnowledgeFlywheelListResult<KnowledgeEntityRecord>>,
  getKnowledgeEntity: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getEntity, input) as Promise<KnowledgeEntityRecord | null>,
  listKnowledgeNotes: (input?: KnowledgeNoteReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listNotes, input) as Promise<KnowledgeFlywheelListResult<KnowledgeNoteRecord>>,
  getKnowledgeNote: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getNote, input) as Promise<KnowledgeNoteRecord | null>,
  getKnowledgeNoteVersion: (input: KnowledgeNoteVersionIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getNoteVersion, input) as Promise<KnowledgeNoteVersionRecord | null>,
  listKnowledgeNoteVersions: (input?: KnowledgeNoteVersionReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listNoteVersions, input) as Promise<KnowledgeFlywheelListResult<KnowledgeNoteVersionRecord>>,
  listWikiPages: (input?: KnowledgeWikiPageReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listPages, input) as Promise<KnowledgeFlywheelListResult<KnowledgeWikiPageRecord>>,
  getWikiPage: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getPage, input) as Promise<KnowledgeWikiPageRecord | null>,
  getWikiPageVersion: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getPageVersion, input) as Promise<KnowledgeWikiPageVersionRecord | null>,
  listWikiPageVersions: (input?: KnowledgeWikiPageVersionReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listPageVersions, input) as Promise<KnowledgeFlywheelListResult<KnowledgeWikiPageVersionRecord>>,
  listKnowledgeRelations: (input?: KnowledgeRelationReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listRelations, input) as Promise<KnowledgeFlywheelListResult<KnowledgeRelationRecord>>,
  getKnowledgeRelation: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getRelation, input) as Promise<KnowledgeRelationRecord | null>,
  listEvidenceLinks: (input?: KnowledgeEvidenceReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listEvidence, input) as Promise<KnowledgeFlywheelListResult<KnowledgeEvidenceLinkRecord>>,
  listKnowledgeAnnotations: (input?: KnowledgeAnnotationReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listAnnotations, input) as Promise<KnowledgeFlywheelListResult<KnowledgeAnnotationRecord>>,
  getKnowledgeAnnotation: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getAnnotation, input) as Promise<KnowledgeAnnotationRecord | null>,
  listFreeNotes: (input?: KnowledgeFreeNoteReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listFreeNotes, input) as Promise<KnowledgeFlywheelListResult<KnowledgeFreeNoteRecord>>,
  getFreeNote: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getFreeNote, input) as Promise<KnowledgeFreeNoteRecord | null>,
  getChangeSet: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getChangeSet, input) as Promise<KnowledgeChangeSetRecord | null>,
  listChangeSets: (input?: KnowledgeChangeSetReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listChangeSets, input) as Promise<KnowledgeFlywheelListResult<KnowledgeChangeSetRecord>>,
  getUpdateReceipt: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getReceipt, input) as Promise<KnowledgeUpdateReceiptRecord | null>,
  getUpdateReceiptByRequest: (input: KnowledgeRequestIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getReceiptByRequest, input) as Promise<KnowledgeUpdateReceiptRecord | null>,
  listUpdateReceipts: (input?: KnowledgeReceiptReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listReceipts, input) as Promise<KnowledgeFlywheelListResult<KnowledgeUpdateReceiptRecord>>,
  getQueryArtifact: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getQueryArtifact, input) as Promise<KnowledgeQueryArtifactRecord | null>,
  getQueryArtifactByRequest: (input: KnowledgeRequestIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getQueryArtifactByRequest, input) as Promise<KnowledgeQueryArtifactRecord | null>,
  getQueryWritebackSummary: (input: KnowledgeRequestIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getQueryWritebackSummary, input) as Promise<KnowledgeQueryWritebackSummaryRecord | null>,
  listQueryArtifacts: (input?: KnowledgeQueryArtifactReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listQueryArtifacts, input) as Promise<KnowledgeFlywheelListResult<KnowledgeQueryArtifactRecord>>,
  getHealthIssue: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getHealthIssue, input) as Promise<KnowledgeHealthIssueRecord | null>,
  listHealthIssues: (input?: KnowledgeHealthIssueReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listHealthIssues, input) as Promise<KnowledgeFlywheelListResult<KnowledgeHealthIssueRecord>>,
  listRelationRegistry: (input?: KnowledgeRelationRegistryReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listRelationRegistry, input) as Promise<KnowledgeFlywheelListResult<KnowledgeRelationRegistryEntry>>,
  // WMB-5215 M6 创作知识调用血缘（不可变 Usage Package/Record 只读面）
  getKnowledgeUsagePackage: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getUsagePackage, input) as Promise<KnowledgeUsagePackageRecord | null>,
  getKnowledgeUsagePackageByRequest: (input: KnowledgeRequestIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getUsagePackageByRequest, input) as Promise<KnowledgeUsagePackageRecord | null>,
  listKnowledgeUsagePackages: (input?: KnowledgeUsagePackageReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listUsagePackages, input) as Promise<KnowledgeFlywheelListResult<KnowledgeUsagePackageRecord>>,
  getKnowledgeUsageRecord: (input: KnowledgeObjectIdRead) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.getUsageRecord, input) as Promise<KnowledgeUsageRecordRecord | null>,
  listKnowledgeUsageRecords: (input?: KnowledgeUsageRecordReadFilter) => ipcRenderer.invoke(KNOWLEDGE_FLYWHEEL_READ_IPC_CHANNELS.listUsageRecords, input) as Promise<KnowledgeFlywheelListResult<KnowledgeUsageRecordRecord>>,
  // END WMB-5210 M1
  // WMB-5236：全库维护 run（start/status/pause/resume；类型见 src/shared/knowledge-maintenance.ts）。
  // start 幂等（活动 run 重复 start 返回同一 run）；status 含持久报告读模型。
  startKnowledgeMaintenance: (input?: KnowledgeMaintenanceStartInput) => ipcRenderer.invoke(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.start, input) as Promise<KnowledgeMaintenanceStartResult>,
  getKnowledgeMaintenanceStatus: () => ipcRenderer.invoke(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.status) as Promise<KnowledgeMaintenanceStatusView>,
  pauseKnowledgeMaintenance: () => ipcRenderer.invoke(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.pause) as Promise<KnowledgeMaintenanceRun | null>,
  resumeKnowledgeMaintenance: () => ipcRenderer.invoke(KNOWLEDGE_MAINTENANCE_IPC_CHANNELS.resume) as Promise<KnowledgeMaintenanceRun>,
  // WMB-5238：统一全文搜索 / 索引摘要 / 有界 hot cache（只读；类型见 src/shared/knowledge-search.ts）。
  // 入参纯 JSON 透传；空查询 → 空结果 total 0；非法游标/未知类型由 main boundary 拒绝。
  searchWikiIndex: (input: WikiSearchFilter) => ipcRenderer.invoke(WIKI_SEARCH_READ_IPC_CHANNELS.search, input) as Promise<WikiSearchPage>,
  getWikiIndexSummary: () => ipcRenderer.invoke(WIKI_SEARCH_READ_IPC_CHANNELS.summary) as Promise<WikiIndexSummary>,
  getWikiHotCache: () => ipcRenderer.invoke(WIKI_SEARCH_READ_IPC_CHANNELS.hotCache) as Promise<WikiHotCacheStatus>,
  // WMB-5238：全局知识时间日志（只读派生读模型；类型见 src/shared/knowledge-global-log.ts）。
  // list 分页信封带 keyset 游标（before/after）；get 按 `${eventType}:${objectId}` 单条读取。
  listKnowledgeLogEntries: (input?: KnowledgeLogReadFilter) => ipcRenderer.invoke(KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.list, input) as Promise<KnowledgeLogPage>,
  getKnowledgeLogEntry: (id: string) => ipcRenderer.invoke(KNOWLEDGE_GLOBAL_LOG_READ_IPC_CHANNELS.get, id) as Promise<KnowledgeLogEntry | null>,
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('window:control', action),
  listBrowserProfiles: () => ipcRenderer.invoke('browser-profiles:list'),
  getWorkspaceBrowserBinding: () => ipcRenderer.invoke('workspace-browser:get-binding'),
  createBrowserProfile: (input: OwnerBrowserCommand & { label?: string }) => ipcRenderer.invoke('browser-profiles:create', input),
  rebindBrowserProfile: (input: OwnerBrowserCommand & { profileId: string }) => ipcRenderer.invoke('workspace-browser:rebind', input),
  verifyBrowserAccount: (input: OwnerBrowserCommand & { platform: 'x' | 'wechat' | 'zhihu' }) => ipcRenderer.invoke('workspace-browser:verify', input),
  migrateLegacyBrowserProfile: (input: OwnerBrowserCommand & { platform: 'x' | 'wechat' | 'zhihu' }) => ipcRenderer.invoke('workspace-browser:migrate-legacy', input),
  savePiConfig: (input: { id?: string; name: string; baseUrl: string; model: string; api: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; authMode?: 'bearer' | 'x-api-key' | 'none'; credentialSource?: { kind: 'environment'; variable: string } | { kind: 'command'; executable: string; args: string[] } | { kind: 'none' }; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; text?: boolean; vision?: boolean; nativeSearch?: boolean; imageGeneration?: boolean; jsonOutput?: boolean; streaming?: boolean; contextWindow?: number | null; maxTokens?: number | null; apiKey?: string }) => ipcRenderer.invoke('pi-config:save', input),
  activatePiConfig: (id: string) => ipcRenderer.invoke('pi-config:activate', id),
  deletePiConfig: (id: string) => ipcRenderer.invoke('pi-config:delete', id),
  saveRoleModelPolicies: (input: { roleModelPolicies: RoleModelPolicies; expectedRevision?: number }) => ipcRenderer.invoke('pi-config:save-role-policies', input),
  listPiModels: (input: { id?: string; baseUrl: string; api: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; authMode?: 'bearer' | 'x-api-key' | 'none'; credentialSource?: { kind: 'environment'; variable: string } | { kind: 'command'; executable: string; args: string[] } | { kind: 'none' }; apiKey?: string }) => ipcRenderer.invoke('pi-config:list-models', input) as Promise<Array<{ id: string; contextWindow?: number; maxTokens?: number }>>,
  discoverPiProviders: () => ipcRenderer.invoke('pi-config:discover'),
  probePiProvider: (input: { id?: string; baseUrl: string; api: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; authMode?: 'bearer' | 'x-api-key' | 'none'; credentialSource?: { kind: 'environment'; variable: string } | { kind: 'command'; executable: string; args: string[] } | { kind: 'none' }; apiKey?: string }) => ipcRenderer.invoke('pi-config:probe', input),
  listPiSkills: () => ipcRenderer.invoke('pi-skills:list'),
  savePiSkill: (input: { originalName?: string; name: string; description: string; instructions: string }) => ipcRenderer.invoke('pi-skills:save', input),
  deletePiSkill: (name: string) => ipcRenderer.invoke('pi-skills:delete', name),
  listPiCommands: () => ipcRenderer.invoke('pi:commands'),
  getPiAuthorityStatus: () => ipcRenderer.invoke('pi:authority-status'),
  getPiRuntime: () => ipcRenderer.invoke('pi-runtime:get'),
  updatePiRuntime: (sourceRuntimeRoot: string) => ipcRenderer.invoke('pi-runtime:update', sourceRuntimeRoot),
  rollbackPiRuntime: () => ipcRenderer.invoke('pi-runtime:rollback'),
  chatPi: (input: string | PiImageBatchChatInput | { message: string; orchestration: { originLabel: string; title: string; goal: string; acceptance: string }; delivery?: 'steer' | 'followUp' }, delivery?: 'steer' | 'followUp') => ipcRenderer.invoke('pi:chat', typeof input === 'string' ? { message: input, delivery } : { ...input, delivery: input.delivery ?? delivery }) as Promise<{
    batchStatus?: PiImageBatchStatus;
    text: string;
    thinking?: string;
    stopped: boolean;
    queued: boolean;
    conversation: {
      id: string;
      title: string;
      sessionFile: string;
      sessionId: string | null;
      createdAt: string;
      messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
      updatedAt: string;
    } | null;
  }>,
  getPiImageBatch: (input: { projectId: string; batchId?: string; requestId?: string }) => ipcRenderer.invoke('pi:image-batch:get', input) as Promise<PiImageBatchRecord | null>,
  listPiImageBatches: (input: { projectId: string; limit?: number }) => ipcRenderer.invoke('pi:image-batch:list', input) as Promise<PiImageBatchRecord[]>,
  stopPi: () => ipcRenderer.invoke('pi:stop') as Promise<{ stopped: boolean }>,
  forkPiConversation: (entryId: string) => ipcRenderer.invoke('pi:fork', entryId) as Promise<{
    cancelled: boolean;
    text: string;
    conversation: {
      id: string;
      title: string;
      sessionFile: string;
      sessionId: string | null;
      createdAt: string;
      messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
      updatedAt: string;
    };
  }>,
  getPiConversation: () => ipcRenderer.invoke('pi:conversation-get') as Promise<{
    id: string;
    title: string;
    sessionFile: string;
    sessionId: string | null;
    createdAt: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
    updatedAt: string;
  }>,
  listPiConversations: () => ipcRenderer.invoke('pi:conversation-list') as Promise<Array<{ id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean; archivedAt: string | null }>>,
  archivePiConversation: (conversationId: string, archived: boolean) => ipcRenderer.invoke('pi:conversation-archive', conversationId, archived) as Promise<{
    id: string; title: string; sessionFile: string; sessionId: string | null; createdAt: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
    updatedAt: string;
  }>,
  switchPiConversation: (conversationId: string) => ipcRenderer.invoke('pi:conversation-switch', conversationId) as Promise<{
    id: string;
    title: string;
    sessionFile: string;
    sessionId: string | null;
    createdAt: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
    updatedAt: string;
  }>,
  newPiConversation: () => ipcRenderer.invoke('pi:conversation-new') as Promise<{
    id: string;
    title: string;
    sessionFile: string;
    sessionId: string | null;
    createdAt: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
    updatedAt: string;
  }>,
  onPiEvent: (listener: (event: { type: string; text?: string; thinking?: string; error?: string; streamKey?: string; toolName?: string; toolCallId?: string; toolArgs?: unknown; toolResult?: unknown; isError?: boolean; scope?: 'dock' | 'task'; source?: 'manager' | string; delivery?: 'steer' | 'followUp'; steering?: string[]; followUp?: string[]; action?: string; jobId?: string; roleId?: string; status?: string; waitReason?: string | null }) => void) => {
    const handler = (_event: unknown, payload: { type: string; text?: string; thinking?: string; error?: string; streamKey?: string; toolName?: string; toolCallId?: string; toolArgs?: unknown; toolResult?: unknown; isError?: boolean; scope?: 'dock' | 'task'; source?: 'manager' | string; delivery?: 'steer' | 'followUp'; steering?: string[]; followUp?: string[]; action?: string; jobId?: string; roleId?: string; status?: string; waitReason?: string | null }) => listener(payload);
    ipcRenderer.on('pi:event', handler);
    return () => { ipcRenderer.removeListener('pi:event', handler); };
  },
  onDataChanged: (listener: (event: { scopes: Array<'today' | 'publications' | 'library' | 'sources' | 'agent' | 'studio' | 'proposals' | 'knowledge' | 'topics' | 'canvas' | 'health' | 'receipt'>; reason?: string; at: string }) => void) => {
    const handler = (_event: unknown, payload: { scopes: Array<'today' | 'publications' | 'library' | 'sources' | 'agent' | 'studio' | 'proposals' | 'knowledge' | 'topics' | 'canvas' | 'health' | 'receipt'>; reason?: string; at: string }) => listener(payload);
    ipcRenderer.on('data:changed', handler);
    return () => { ipcRenderer.removeListener('data:changed', handler); };
  },
  collectXAccountMetrics: () => ipcRenderer.invoke('metrics:collect-account-x'),
  listAccountMetricSnapshots: (accountId?: string) => ipcRenderer.invoke('metrics:list-account-snapshots', accountId),
  startAgentTask: (input: { intent: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate: string; contextRefs?: Record<string, unknown> }) => ipcRenderer.invoke('agent:start', input),
  getAgentTask: (input?: { id?: string; intent?: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate?: string }) => ipcRenderer.invoke('agent:get', input ?? {}),
  agentRequestId: (input: { taskId: string; logicalStep: string }) => ipcRenderer.invoke('agent:request-id', input),
  updateAgentTaskPhase: (input: { id: string; phase: string; piSessionId?: string | null }) => ipcRenderer.invoke('agent:update-phase', input),
  issueExecutionGrant: (input: { requestId?: string; taskId?: string; taskGrantId?: string; command: 'intelligence_channels.proposal_apply' | 'x_lists.operation_execute'; inputHash: string; boundIdentity: Record<string, unknown>; targetActor: { type: 'owner_ui'; id: 'renderer' }; browserProfileId?: string; bindingRevision?: number; expectedAccount?: string; allowedTransition: string; requiredReadback: Record<string, unknown>; expiresAt: string }) => ipcRenderer.invoke('execution-grants:issue', input),
  revokeExecutionGrant: (input: { requestId?: string; executionGrantId: string; expectedRevision: number }) => ipcRenderer.invoke('execution-grants:revoke', input),
  getExecutionGrant: (executionGrantId: string) => ipcRenderer.invoke('execution-grants:get', executionGrantId),
  listExecutionGrants: (filters?: { taskId?: string | null; status?: 'active' | 'consumed' | 'revoked' | 'expired' | 'stale' }) => ipcRenderer.invoke('execution-grants:list', filters),
  completeAgentTask: (id: string) => ipcRenderer.invoke('agent:complete', id),
  failAgentTask: (input: { id: string; errorCode: string; errorMessage: string }) => ipcRenderer.invoke('agent:fail', input),
  cancelAgentTask: (id: string) => ipcRenderer.invoke('agent:cancel', id),
  controlDailyIntelligence: (input: { id: string; action: 'skip_source' | 'save_partial' | 'cancel' }) => ipcRenderer.invoke('agent:control-daily', input),
  startResultsReview: (input: { businessDate: string; publicationId: string }) => ipcRenderer.invoke('agent:start-results-review', input),
  startDailyIntelligence: (input: { businessDate: string; modules?: Array<'official_web' | 'x_lists' | 'zhihu_hot'>; legacyPipeline?: boolean }) => ipcRenderer.invoke('agent:start-daily-intelligence', input),
  getManagerTask: (input?: { businessDate?: string }) => ipcRenderer.invoke('agent:get-manager-task', input ?? {}),
  syncManagerTask: (input?: { businessDate?: string }) => ipcRenderer.invoke('agent:sync-manager-task', input ?? {}),
  startStudioDraft: (input: { businessDate: string; projectId: string }) => ipcRenderer.invoke('agent:start-studio-draft', input),
  getToday: (planDate: string) => ipcRenderer.invoke('today:get', planDate),
  getTodayOverviewMetrics: (planDate: string, asOf?: string) => ipcRenderer.invoke('today:overview-metrics', planDate, asOf),
  listResearchSuccessorsNeedsUser: () => ipcRenderer.invoke('today:research-successors'),
  decideResearchSuccessor: (input: { jobId: string; decision: 'narrow' | 'supplement' | 'accept' }) => ipcRenderer.invoke('agents:decide-research-successor', input),
  getAgentsRoster: (input?: { businessDate?: string }) => ipcRenderer.invoke('agents:roster-status', input ?? {}),
  getCrewInstanceProjection: () => ipcRenderer.invoke('agents:crew-projection'),
  getAgentTaskTranscript: (jobId: string) => ipcRenderer.invoke('agents:task-transcript', jobId) as Promise<Array<{
    role: 'user' | 'assistant';
    text: string;
    thinking?: string;
    segments?: Array<{ kind: 'thinking' | 'text' | 'tool'; text: string; toolName?: string; toolCallId?: string; input?: string; output?: string; isError?: boolean }>;
    entryId?: string;
    kind?: 'system_event' | 'orchestration';
    createdAt?: string;
  }> | null>,
  listAgentAvatars: () => ipcRenderer.invoke('agents:list-avatars'),
  setAgentAvatar: (input: { roleId: string; base64: string; mimeType?: string; width?: number; height?: number }) => ipcRenderer.invoke('agents:set-avatar', input),
  clearAgentAvatar: (input: { roleId: string }) => ipcRenderer.invoke('agents:clear-avatar', input),
  jobsSpawn: (input: {
    roleId: 'reporter' | 'planner' | 'writer' | 'librarian';
    brief: string;
    businessDate?: string | null;
    channelIds?: readonly string[] | null;
    sourceFeedIds?: readonly string[] | null;
    projectId?: string | null;
    writerTask?: 'core_draft' | 'xiaohongshu_platform_version' | 'video_script' | null;
    sourceIds?: readonly string[] | null;
    scope?: 'workspace' | null;
  }) => ipcRenderer.invoke('jobs:spawn', input),
  jobsList: () => ipcRenderer.invoke('jobs:list'),
  jobsGet: (jobId: string) => ipcRenderer.invoke('jobs:get', jobId),
  jobsAwait: (input: { jobId: string; timeoutMs?: number }) => ipcRenderer.invoke('jobs:await', input),
  jobsCancel: (jobId: string) => ipcRenderer.invoke('jobs:cancel', jobId),
  jobsMessage: (input: { jobId: string; body: string }) => ipcRenderer.invoke('jobs:message', input),
  jobsMessages: (jobId: string) => ipcRenderer.invoke('jobs:messages', jobId),
  jobsPoolStatus: () => ipcRenderer.invoke('jobs:pool-status'),
  jobsSetMaxWorkers: (maxWorkers: number) => ipcRenderer.invoke('jobs:set-max-workers', maxWorkers),
  getAgentsCapabilitySummary: () => ipcRenderer.invoke('agents:capability-summary'),
  listAgentsOverlays: () => ipcRenderer.invoke('agents:list-overlays'),
  setAgentsOverlay: (input: { roleId: string; capabilityId: string; enabled: boolean }) => ipcRenderer.invoke('agents:set-overlay', input),
  getProposalLedger: (input: { planDate: string; tab?: 'today' | 'shelved' | 'adopted' | 'dismissed' | 'expired'; limit?: number; offset?: number }) => ipcRenderer.invoke('proposals:get', input),
  getProposalLedgerSummary: (planDate: string) => ipcRenderer.invoke('proposals:summary', planDate),
  getProposalDetail: (planItemId: string) => ipcRenderer.invoke('proposals:detail', planItemId),
  refreshFermenting: (planDate: string) => ipcRenderer.invoke('today:refresh-fermenting', planDate),
  listFermenting: (planDate: string) => ipcRenderer.invoke('today:list-fermenting', planDate),
  setCarryState: (input: { id: string; expectedRevision: number; state: 'active' | 'watching' | 'done' | 'dismissed' | 'expired'; reason?: string }) => ipcRenderer.invoke('today:set-carry-state', input),
  dismissPlanItem: (input: { planItemId: string; reason?: string }) => ipcRenderer.invoke('today:dismiss-plan-item', input),
  restoreProposal: (input: { planItemId: string; reason?: string }) => ipcRenderer.invoke('proposals:restore', input),
  requestPlanItem: (input: { planItemId: string; requestId?: string }) => ipcRenderer.invoke('plan-item:request-planning', input),
  approvePlanItem: (input: { planItemId: string; expectedRevision: number; reason?: string; requestId?: string }) => ipcRenderer.invoke('plan-item:approve', input),
  rejectPlanItem: (input: { planItemId: string; expectedRevision: number; reason: string; requestId?: string }) => ipcRenderer.invoke('plan-item:reject', input),
  reworkPlanItem: (input: { planItemId: string; expectedRevision: number; reason?: string; requestId?: string }) => ipcRenderer.invoke('plan-item:rework', input),
  advancePlanItem: (input: { planItemId: string; requestId?: string }) => ipcRenderer.invoke('plan-item:advance', input),
  getStudio: () => ipcRenderer.invoke('studio:get'),
  listStudioProjects: (input: { query?: string; status?: 'idea' | 'drafting' | 'review' | 'ready' | 'completed'; archived?: boolean; order?: 'recent' | 'oldest' | 'versions'; platform?: 'x' | 'xiaohongshu' | 'wechat' | 'zhihu'; limit?: number; offset?: number }) => ipcRenderer.invoke('studio:list', input),
  getStudioSummary: () => ipcRenderer.invoke('studio:summary'),
  getStudioProject: (projectId: string) => ipcRenderer.invoke('studio:get-detail', projectId),
  createStudioProject: (input: { title: string; body: string }) => ipcRenderer.invoke('studio:create-project', input),
  updateStudioProject: (input: { projectId: string; expectedRevision: number; status?: 'idea' | 'drafting' | 'review' | 'ready' | 'completed'; archived?: boolean; topicId?:string|null }) => ipcRenderer.invoke('studio:update-project', input),
  deleteStudioProject: (input: { projectId: string; expectedRevision: number }) => ipcRenderer.invoke('studio:delete-project', input),
  saveDiscoveredSource: (input: { requestId: string; title: string; originalUrl?: string; summary?: string; author?: string; categories?: string[] }) => ipcRenderer.invoke('sources:save-discovered', input),
  copyStudioVersionToProject: (input: { sourceProjectId: string; contentVersionId: string; title: string }) => ipcRenderer.invoke('studio:copy-version', input),
  saveStudioCore: (input: { projectId: string; title: string; body: string; expectedRevision: number; mediaBindings?: ContentMediaBindingDraft[] }) => ipcRenderer.invoke('studio:save-core', input),
  saveStudioPlatform: (input: { projectId: string; contentVersionId: string; platform: 'x' | 'xiaohongshu' | 'wechat' | 'zhihu'; format: string; title?: string; body: string; assetIds?: string[]; mediaBindings?: PlatformMediaBindingDraft[]; cropPayloads?: PlatformCropPayload[]; clipPayloads?: PlatformClipPayload[]; expectedRevision?: number; versionId?: string }) => ipcRenderer.invoke('studio:save-platform', input),
  listStudioAnnotations: (input: StudioDocumentScope & { includeResolved?: boolean }) => ipcRenderer.invoke('studio-annotations:list', input) as Promise<StudioAnnotation[]>,
  createStudioAnnotation: (input: StudioDocumentScope & { body: string; startOffset: number; endOffset: number; note?: string | null }) => ipcRenderer.invoke('studio-annotations:create', input) as Promise<StudioCommandResult<StudioAnnotation>>,
  updateStudioAnnotation: (input: { id: string; expectedRevision: number; note: string | null }) => ipcRenderer.invoke('studio-annotations:update', input) as Promise<StudioCommandResult<StudioAnnotation>>,
  resolveStudioAnnotation: (input: { id: string; expectedRevision: number; reason: StudioAnnotationResolveReason }) => ipcRenderer.invoke('studio-annotations:resolve', input) as Promise<StudioCommandResult<StudioAnnotation>>,
  reopenStudioAnnotation: (input: { id: string; expectedRevision: number; body: string }) => ipcRenderer.invoke('studio-annotations:reopen', input) as Promise<StudioCommandResult<StudioAnnotation>>,
  reconcileStudioAnnotations: (input: StudioDocumentScope & { previousBody: string; nextBody: string; mode: StudioReconcileMode }) => ipcRenderer.invoke('studio-annotations:reconcile', input) as Promise<StudioCommandResult<StudioAnnotation[]>>,
  listStudioAssets: (projectId: string) => ipcRenderer.invoke('studio:list-assets', projectId),
  importStudioImage: (input: {
    projectId: string;
    sourcePath?: string;
    fileName?: string;
    mimeType?: string;
    bytesBase64?: string;
    alt?: string;
  }) => ipcRenderer.invoke('studio:import-image', input),
  deriveStudioAsset: (input: { sourceAssetId: string; cropRegion: CropRegion; pngBase64: string }) => ipcRenderer.invoke('studio:derive-asset', input),
  deriveStudioAnnotation: (input: { sourceAssetId: string; annotationSpec: unknown; pngBase64: string }) => ipcRenderer.invoke('studio:derive-annotation', input),
  deriveStudioClip: (input: { sourceAssetId: string; startMs: number; endMs: number }) => ipcRenderer.invoke('studio:derive-clip', input),
  // WMB-5290：项目专项调查（两次 Owner 审批 + 派记者/写手编排；变更返回完整读模型 CommandResult）。
  investigationGet: (projectId: string) => ipcRenderer.invoke(INVESTIGATION_IPC.get, projectId),
  investigationInitialize: (projectId: string) => ipcRenderer.invoke(INVESTIGATION_IPC.initialize, projectId),
  investigationSaveOutline: (input: { projectId: string; expectedRevision: number; outline: InvestigationOutline }) => ipcRenderer.invoke(INVESTIGATION_IPC.saveOutline, input),
  investigationDecideOutline: (input: InvestigationDecideOutlineInput) => ipcRenderer.invoke(INVESTIGATION_IPC.decideOutline, input),
  investigationReviewResearch: (input: InvestigationReviewResearchInput) => ipcRenderer.invoke(INVESTIGATION_IPC.reviewResearch, input),
  investigationSaveDirection: (input: { projectId: string; expectedRevision: number; direction: InvestigationDirection }) => ipcRenderer.invoke(INVESTIGATION_IPC.saveDirection, input),
  investigationDecideDirection: (input: InvestigationDecideDirectionInput) => ipcRenderer.invoke(INVESTIGATION_IPC.decideDirection, input),
  investigationStartWriter: (input: { projectId: string; expectedRevision: number }) => ipcRenderer.invoke(INVESTIGATION_IPC.startWriter, input),
  investigationRetryReporter: (input: { projectId: string; expectedRevision: number }) => ipcRenderer.invoke(INVESTIGATION_IPC.retryReporter, input),
  getPublications: () => ipcRenderer.invoke('publish:list'),
  collectXMetrics: (publicationId: string) => ipcRenderer.invoke('metrics:collect-x', publicationId),
  schedulePublicationMetrics: (publicationId: string) => ipcRenderer.invoke('metrics:schedule', publicationId),
  listMetricJobs: (publicationId?: string) => ipcRenderer.invoke('metrics:list-jobs', publicationId),
  listPublicationMetricSnapshots: (publicationId?: string) => ipcRenderer.invoke('metrics:list-snapshots', publicationId),
  processDueMetrics: () => ipcRenderer.invoke('metrics:process-due'),
  listReviews: (publicationId?: string) => ipcRenderer.invoke('reviews:list', publicationId),
  getReview: (id: string) => ipcRenderer.invoke('reviews:get', id),
  saveReview: (input: {
    id?: string;
    publicationId: string;
    metricSnapshotIds: string[];
    keep?: string[];
    stop?: string[];
    change?: string[];
    summary?: string;
    status?: 'draft' | 'final';
    expectedRevision?: number;
    findings?: Array<{ id?: string; title: string; body: string }>;
  }) => ipcRenderer.invoke('reviews:save', input),
  listReviewBacklinks: (input?: { reviewIds?: string[]; findingIds?: string[] }) => ipcRenderer.invoke('reviews:backlinks', input),
  createPublicationSnapshot: (platformVersionId: string, requestId?: string) => ipcRenderer.invoke('publish:snapshot-create', { platformVersionId, requestId }),
  authorizePublicationEditor: (input: { publicationId: string; expectedRevision: number; requestId?: string }) => ipcRenderer.invoke('publish:editor-prepare', input),
  getPublicationSnapshot: (publicationId: string) => ipcRenderer.invoke('publish:snapshot-get', publicationId),
  getPublicationBrowserOperation: (operationId: string) => ipcRenderer.invoke('publish:operation-get', operationId),
  prepareXPublication: (platformVersionId: string) => ipcRenderer.invoke('publish:snapshot-create', { platformVersionId }),
  prepareWechatArticlePublication: (platformVersionId: string) => ipcRenderer.invoke('publish:snapshot-create', { platformVersionId }),
  prepareZhihuArticlePublication: (platformVersionId: string) => ipcRenderer.invoke('publish:snapshot-create', { platformVersionId }),
  readBackWechatPublication: (publicationId: string, expectedRevision: number, articleUrl: string) => ipcRenderer.invoke('publish:readback-wechat', publicationId, expectedRevision, articleUrl),
  reconcileNotPublished: (publicationId: string, expectedRevision: number) => ipcRenderer.invoke('publish:reconcile-not-published', publicationId, expectedRevision),
  returnPublicationToEdit: (publicationId: string, expectedRevision: number) => ipcRenderer.invoke('publish:return-to-edit', publicationId, expectedRevision),
  ensureDailyCycle: (businessDate: string, requestId?: string) => ipcRenderer.invoke('daily-cycle:ensure', { businessDate, requestId }),
  pauseDailyCycle: (businessDate: string, expectedRevision: number, requestId?: string) => ipcRenderer.invoke('daily-cycle:pause', { businessDate, expectedRevision, requestId }),
  resumeDailyCycle: (businessDate: string, expectedRevision: number, requestId?: string) => ipcRenderer.invoke('daily-cycle:resume', { businessDate, expectedRevision, requestId }),
  getDailyCycle: (businessDate: string) => ipcRenderer.invoke('daily-cycle:get', businessDate),
  transitionDailyTarget: (input: { targetId: string; expectedRevision: number; toStatus: string; blockedReasonCode?: string | null; requestId?: string }) => ipcRenderer.invoke('daily-target:transition', input),
  skipDailyTarget: (input: { targetId: string; expectedRevision: number; reasonCode?: string | null; requestId?: string }) => ipcRenderer.invoke('daily-target:skip', input),
  replaceDailyTarget: (input: { targetId: string; expectedRevision: number; replacementSourceItemId: string; requestId?: string }) => ipcRenderer.invoke('daily-target:replace', input),
  carryDailyTarget: (input: { targetId: string; expectedRevision: number; nextBusinessDate: string; requestId?: string }) => ipcRenderer.invoke('daily-target:carry', input),
  ensureTargetArticle: (targetId: string, requestId?: string) => ipcRenderer.invoke('daily-target:ensure-article', { targetId, requestId }),
  saveTargetArticle: (input: { targetId: string; body: string; title?: string; expectedRevision: number; author?: string; requestId?: string }) => ipcRenderer.invoke('daily-target:save-article', input),
  finalizeTargetArticle: (input: { targetId: string; expectedRevision: number; requestId?: string }) => ipcRenderer.invoke('daily-target:finalize-article', input),
  getTargetArticle: (targetId: string) => ipcRenderer.invoke('daily-target:get-article', targetId),
  ensureDraftIteration: (input: { businessDate: string; projectId: string; predecessorContentVersionId: string; predecessorTargetId?: string | null; requestId?: string }) => ipcRenderer.invoke('daily-iteration:draft-ensure', input),
  ensurePublishedIteration: (input: { businessDate: string; projectId: string; predecessorPublicationId: string; predecessorContentVersionId: string; requestId?: string }) => ipcRenderer.invoke('daily-iteration:published-ensure', input),
  createIterationVersion: (input: { projectId: string; predecessorContentVersionId: string; body?: string; requestId?: string }) => ipcRenderer.invoke('daily-iteration:version-create', input),
  getYesterdayIteration: (businessDate: string) => ipcRenderer.invoke('daily-iteration:projection', businessDate),
  ensureContentDerivative: (projectId: string, requestId?: string) => ipcRenderer.invoke('content-derivative:ensure', { projectId, requestId }),
  saveDerivativeVersion: (input: { projectId: string; sourceContentVersionId: string; title: string; body: string; formatDecisionJson?: string; author?: string; requestId?: string }) => ipcRenderer.invoke('content-derivative:save-version', input),
  finalizeDerivativeVersion: (input: { projectId: string; expectedLatestVersionNumber?: number | null; requestId?: string }) => ipcRenderer.invoke('content-derivative:finalize-version', input),
  getStudioDualProjection: (projectId: string) => ipcRenderer.invoke('studio:dual-projection', projectId),
  getStudioDerivative: (projectId: string) => ipcRenderer.invoke('studio:derivative-projection', projectId),
  getDailyOrchestrationSchedule: () => ipcRenderer.invoke('daily-orchestration:get-schedule'),
  setDailyOrchestrationSchedule: (input: { time?: string; autoEnabled?: boolean }) => ipcRenderer.invoke('daily-orchestration:set-schedule', input),
  orchestrateDailyContent: (businessDate: string, source?: string) => ipcRenderer.invoke('daily-orchestration:orchestrate', { businessDate, source }),
});
