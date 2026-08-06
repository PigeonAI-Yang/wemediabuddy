import type { ContentProjectDetail } from '../main/content';
import type { TodayPlanItem, TodaySource } from '../main/workbench';
import type { XListBinding, XListOperation, XListOperationKind } from '../main/x-lists';
import type { CommandResult } from '../main/result';
import type { CommandReceiptV1 } from '../main/command-dispatcher';
import type { WorkspaceProposal, WorkspaceProposalBinding } from '../main/workspace-proposals';
import type { IntelligenceChannelsSummary, IntelligenceModule, SourceScanReceipt, WebsiteTrialRead } from '../main/intelligence-channels';
import type { WebsiteCandidate } from '../main/website-channel';
import type { XListResolution } from '../main/x-list-channel';
import type { ChannelProposalInput, IntelligenceChannelProposal, IntelligenceChannelProposalBinding } from '../main/intelligence-channel-proposals';
import type { XPostMetricSnapshot, XPostTrend } from '../main/x-post-metrics';
import type { XObservationSession } from '../main/x-observation-jobs';
import type { PiSkillInput, PiSkillSummary } from '../main/pi-skill-library';
import type { PiCommand } from '../main/pi-commands';
import type { BrowserProfile } from '../main/browser-config';
import type { WorkspaceBrowserBinding } from '../main/workspace-browser-binding';
import type { OwnerBrowserState } from '../main/browser-profile-owner';
import type { PublicationBrowserOperationV1 as PublicationBrowserOperation, PublicationSnapshotV1 as PublicationSnapshot } from '../main/publication-operations';
import type { WmbSettingsSnapshot } from './wmb-settings-types';

type OwnerBrowserCommand = { workspaceId: string; expectedBindingRevision: number; expectedRegistryRevision: number };

type XListCommand<T> = CommandResult<T>;

declare global {
  interface Window {
    wmb: {
      getDataRoot(): Promise<{ path: string; isNew: boolean } | null>;
      chooseDataRoot(): Promise<{ path: string; isNew: boolean } | null>;
      listWorkspaces(): Promise<{ activeWorkspaceId: string | null; workspaces: Array<{ id: string; displayName: string; rootPath: string }> }>;
      switchWorkspace(workspaceId: string): Promise<{ relaunching: boolean }>;
      createUkWorkspace(): Promise<{ id: string; displayName: string; rootPath: string } | null>;
      listWorkspaceProposals(): Promise<Array<{ proposal: WorkspaceProposal; binding: WorkspaceProposalBinding; selectedRootPath: string | null }>>;
      selectWorkspaceProposalRoot(binding: WorkspaceProposalBinding): Promise<{ proposalId: string; rootPath: string } | null>;
      confirmWorkspaceProposal(binding: WorkspaceProposalBinding): Promise<unknown>;
      getSettings(): Promise<WmbSettingsSnapshot | null>;
      openLogs(): Promise<void>;
      openExternal(url: string): Promise<void>;
      getGitHubRankings(refresh?: boolean): Promise<{
        fetchedAt: string;
        boards: Array<{
          id: string; label: string; kind: 'rankings'; sourceId: string; sourceLabel: string; sourceUrl: string; status: 'ready' | 'unavailable'; error?: string;
          items: Array<{ rank: number; name: string; url: string; description: string; language: string; stars: string; gained: string }>;
        }>;
      }>;
      getCachedRankings(): Promise<{
        fetchedAt: string;
        boards: Array<{
          id: string; label: string; kind: 'rankings'; sourceId: string; sourceLabel: string; sourceUrl: string; status: 'ready' | 'unavailable'; error?: string;
          items: Array<{ rank: number; name: string; url: string; description: string; language: string; stars: string; gained: string }>;
        }>;
      } | null>;
      getIntelligenceChannels(): Promise<{ summary: IntelligenceChannelsSummary; receipts: SourceScanReceipt[] }>;
      resolveWebsiteCandidates(input: { inputText: string }): Promise<WebsiteCandidate[]>;
      trialReadWebsite(input: { url: string }): Promise<WebsiteTrialRead>;
      resolveXListCandidates(input: { inputText: string }): Promise<XListCommand<XListResolution>>;
      scanIntelligenceChannel(input: { module: IntelligenceModule; sourceId: string; expectedRevision: number }): Promise<unknown>;
      prepareIntelligenceChannelProposal(input: ChannelProposalInput): Promise<IntelligenceChannelProposal>;
      listIntelligenceChannelProposals(): Promise<Array<{ proposal: IntelligenceChannelProposal; binding: IntelligenceChannelProposalBinding }>>;
      confirmIntelligenceChannelProposal(binding: IntelligenceChannelProposalBinding): Promise<{ version: 'CommandReceiptV1'; ok: boolean; data: { applied: number } | null; error: { code: string; message: string } | null; executionGrantId?: string }>;
      readXListIndex(): Promise<{ accountKey: string; lists: Array<{ listId: string; canonicalUrl: string; name: string; ownerHandle: string | null; kind: 'owned' | 'following' | 'member' | 'unknown' }>; observation: { capturedAt: string; pageUrl: string; fingerprint: string; visibleText: string } }>;
      getCachedXListIndex(): Promise<{ accountKey: string; lists: Array<{ listId: string; canonicalUrl: string; name: string; ownerHandle: string | null; kind: 'owned' | 'following' | 'member' | 'unknown' }>; observation: { capturedAt: string; pageUrl: string; fingerprint: string; visibleText: string } } | null>;
      readXListDetail(listId: string): Promise<{ accountKey: string; detail: { listId: string; canonicalUrl: string; name: string; ownerHandle: string | null; kind: 'owned' | 'following' | 'member' | 'unknown'; description: string; isPrivate: boolean; memberCount: number | null; observation: { capturedAt: string; pageUrl: string; fingerprint: string; visibleText: string } } }>;
      readXListMembers(listId: string): Promise<{ accountKey: string; detail: { listId: string; canonicalUrl: string; name: string; ownerHandle: string | null; kind: 'owned' | 'following' | 'member' | 'unknown'; description: string; isPrivate: boolean; memberCount: number | null; observation: { capturedAt: string; pageUrl: string; fingerprint: string; visibleText: string } }; members: Array<{ handle: string; displayName: string; profileUrl: string }> }>;
      readXListTimeline(input: { listId: string; limit?: number; knownUrls?: string[] }): Promise<{ accountKey: string; detail: { listId: string; canonicalUrl: string; name: string; ownerHandle: string | null; kind: 'owned' | 'following' | 'member' | 'unknown'; description: string; isPrivate: boolean; memberCount: number | null; observation: { capturedAt: string; pageUrl: string; fingerprint: string; visibleText: string } }; posts: Array<{ url: string; authorHandle: string | null; displayName: string | null; avatarUrl: string | null; text: string; postedAt: string | null; images: string[]; imageThumbs: string[]; hasVideo: boolean; videoPoster: string | null; videoUrl?: string | null; postKind?: 'tweet' | 'repost' | 'quote'; repostedBy?: { handle: string | null; displayName?: string | null; avatarUrl?: string | null } | null; quotedPost?: { url: string; authorHandle: string | null; displayName?: string | null; avatarUrl?: string | null; text: string; postedAt: string | null; images?: string[]; imageThumbs?: string[]; hasVideo?: boolean; videoPoster?: string | null; videoUrl?: string | null; metrics?: { replies?: number | null; reposts?: number | null; likes?: number | null; bookmarks?: number | null; views?: number | null } } | null; metrics?: { replies: number | null; reposts: number | null; likes: number | null; bookmarks: number | null; views: number | null } }>; hasMore: boolean; livePostCount?: number; refreshDisposition?: 'updated' | 'retained_cache' | 'merged_cache' }>;
      readXListPost(input: { statusUrl: string; replyLimit?: number; bypassCache?: boolean }): Promise<{ accountKey: string; post: { url: string; authorHandle: string | null; displayName: string | null; avatarUrl: string | null; text: string; postedAt: string | null; images: string[]; imageThumbs: string[]; hasVideo: boolean; videoPoster: string | null; videoUrl?: string | null; postKind?: 'tweet' | 'repost' | 'quote'; repostedBy?: { handle: string | null; displayName?: string | null; avatarUrl?: string | null } | null; quotedPost?: { url: string; authorHandle: string | null; displayName?: string | null; avatarUrl?: string | null; text: string; postedAt: string | null; images?: string[]; imageThumbs?: string[]; hasVideo?: boolean; videoPoster?: string | null; videoUrl?: string | null; metrics?: { replies?: number | null; reposts?: number | null; likes?: number | null; bookmarks?: number | null; views?: number | null } } | null; metrics?: { replies: number | null; reposts: number | null; likes: number | null; bookmarks: number | null; views: number | null }; replies: Array<{ url: string; authorHandle: string | null; displayName: string | null; avatarUrl: string | null; text: string; postedAt: string | null; images: string[]; imageThumbs: string[]; hasVideo: boolean; videoPoster: string | null; videoUrl?: string | null; postKind?: 'tweet' | 'repost' | 'quote'; repostedBy?: { handle: string | null; displayName?: string | null; avatarUrl?: string | null } | null; quotedPost?: { url: string; authorHandle: string | null; displayName?: string | null; avatarUrl?: string | null; text: string; postedAt: string | null; images?: string[]; imageThumbs?: string[]; hasVideo?: boolean; videoPoster?: string | null; videoUrl?: string | null; metrics?: { replies?: number | null; reposts?: number | null; likes?: number | null; bookmarks?: number | null; views?: number | null } } | null; metrics?: { replies: number | null; reposts: number | null; likes: number | null; bookmarks: number | null; views: number | null } }>; hasMoreReplies: boolean }; cached?: boolean; fetchedAt?: string; stale?: boolean }>;
      getCachedXListTimeline(input: { accountKey: string; listId: string }): Promise<{ accountKey: string; listId: string; payload: { accountKey: string; listId: string; detail?: { name?: string; canonicalUrl?: string } | null; posts: Array<{ url: string; authorHandle: string | null; displayName?: string | null; avatarUrl?: string | null; text: string; postedAt: string | null; images?: string[]; imageThumbs?: string[]; hasVideo?: boolean; videoPoster?: string | null; videoUrl?: string | null; postKind?: 'tweet' | 'repost' | 'quote'; repostedBy?: { handle: string | null; displayName?: string | null; avatarUrl?: string | null } | null; quotedPost?: { url: string; authorHandle: string | null; displayName?: string | null; avatarUrl?: string | null; text: string; postedAt: string | null; images?: string[]; imageThumbs?: string[]; hasVideo?: boolean; videoPoster?: string | null; videoUrl?: string | null; metrics?: { replies?: number | null; reposts?: number | null; likes?: number | null; bookmarks?: number | null; views?: number | null } } | null; metrics?: { replies?: number | null; reposts?: number | null; likes?: number | null; bookmarks?: number | null; views?: number | null } }> }; postsCount: number; payloadBytes: number; fetchedAt: string; lastAccessedAt: string; source: 'live' | 'collect'; schemaVersion: number; fingerprint: string; stale: boolean } | null>;
      listCachedXListTimeline(input: { accountKey: string; listId: string; limit?: number; offset?: number }): Promise<{ items: Array<{ id: string; originalUrl: string | null; title: string; author: string | null; publishedAt: string | null; collectedAt: string; summary: string | null }>; limit: number; offset: number; hasMore: boolean; binding: { id: string; accountKey: string; listId: string; sourceFeedId: string; enabled: boolean } | null }>;
      clearXListTimelineCache(input?: { accountKey?: string }): Promise<{ deleted: number }>;
      getXListTimelineCacheStats(): Promise<{ rows: number; bytes: number; accounts: number }>;
      listXPostMetricSnapshots(input: { sourceId: string; limit?: number }): Promise<XPostMetricSnapshot[]>;
      getXPostTrend(input: { sourceId: string }): Promise<XPostTrend>;
      listXPostTrends(input: { bindingId: string; limit?: number }): Promise<XPostTrend[]>;
      startXObservation(input: { requestId: string; bindingIds: string[] }): Promise<XListCommand<XObservationSession>>;
      getXObservation(input: { sessionId: string }): Promise<XObservationSession | null>;
      stopXObservation(input: { sessionId: string }): Promise<XObservationSession | null>;
      listXListBindings(accountKey?: string): Promise<Array<{ id: string; accountKey: string; listId: string; canonicalUrl: string; ownerHandle: string; name: string; kind: 'owned' | 'following' | 'member'; sourceFeedId: string; enabled: boolean; lastObservedAt: string | null; lastObservation: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number }>>;
      listXListOperations(input?: { accountKey?: string; limit?: number }): Promise<Array<XListOperation>>;
      getXListOperation(operationId: string): Promise<XListOperation | null>;
      prepareXListOperation(input: { requestId: string; accountKey: string; kind: XListOperationKind; listId?: string; name?: string; description?: string; isPrivate?: boolean; handles?: string[] }): Promise<XListCommand<{ operation: XListOperation; replayed: boolean }>>;
      armXListOperation(input: { operationId: string; expectedRevision: number }): Promise<XListCommand<XListOperation>>;
      confirmXListOperation(input: { operationId: string; expectedRevision: number; typedListName?: string }): Promise<CommandReceiptV1<XListOperation>>;
      stopXListOperation(input: { operationId: string; expectedRevision: number }): Promise<XListCommand<XListOperation>>;
      bindXList(input: { listId: string; expectedRevision?: number }): Promise<XListCommand<{ id: string; accountKey: string; listId: string; canonicalUrl: string; ownerHandle: string; name: string; kind: 'owned' | 'following' | 'member'; sourceFeedId: string; enabled: boolean; lastObservedAt: string | null; lastObservation: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number }>>;
      setXListBindingEnabled(input: { accountKey: string; listId: string; expectedRevision: number; enabled: boolean }): Promise<XListCommand<{ id: string; accountKey: string; listId: string; canonicalUrl: string; ownerHandle: string; name: string; kind: 'owned' | 'following' | 'member'; sourceFeedId: string; enabled: boolean; lastObservedAt: string | null; lastObservation: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number }>>;
      collectXListTimeline(input: { accountKey: string; listId: string; limit?: number }): Promise<XListCommand<{ binding: { id: string; accountKey: string; listId: string; canonicalUrl: string; ownerHandle: string; name: string; kind: 'owned' | 'following' | 'member'; sourceFeedId: string; enabled: boolean; lastObservedAt: string | null; lastObservation: Record<string, unknown>; createdAt: string; updatedAt: string; revision: number }; sourceIds: string[] }>>;
      listKnowledgeSources(input?: { query?: string; verificationStatus?: string; managementStatus?: string; includeArchived?: boolean; limit?: number; offset?: number }): Promise<{ items: any[]; total: number; limit: number; offset: number; hasMore: boolean } | null>;
      updateKnowledgeSource(input: { id: string; expectedRevision: number; verificationStatus?: string; managementStatus?: string; title?: string; summary?: string | null; author?: string | null }): Promise<{ id: string; revision: number }>;
      deleteKnowledgeSource(input: { id: string; expectedRevision: number }): Promise<{ id: string; deleted: true }>;
      listWatchingSources(input?: { limit?: number }): Promise<Array<{
        id: string;
        title: string;
        originalUrl?: string | null;
        summary?: string | null;
        publishedAt?: string | null;
        collectedAt?: string | null;
        verificationStatus?: string;
        managementStatus?: string;
        revision?: number;
        topics?: string;
        opportunityCount?: number;
        projectCount?: number;
        publicationCount?: number;
        priority?: number | null;
      }>>;
      markSourcesWatching(input: { sourceIds: string[] }): Promise<{ updated: number; ids: string[] }>;
      getSourceBodyCache(sourceId: string): Promise<{
        sourceId: string;
        url: string;
        status: 'ready' | 'failed' | 'empty';
        contentType: string | null;
        extractedText: string;
        extractedChars: number;
        errorMessage: string | null;
        fetchedAt: string;
        updatedAt: string;
      } | null>;
      listSourceBodyCaches(sourceIds?: string[]): Promise<Array<{
        sourceId: string;
        url: string;
        status: 'ready' | 'failed' | 'empty';
        contentType: string | null;
        extractedText: string;
        extractedChars: number;
        errorMessage: string | null;
        fetchedAt: string;
        updatedAt: string;
      }>>;
      fetchSourceBody(input: { sourceId: string; force?: boolean; maxChars?: number }): Promise<{
        sourceId: string;
        url: string;
        status: 'ready' | 'failed' | 'empty';
        contentType: string | null;
        extractedText: string;
        extractedChars: number;
        errorMessage: string | null;
        fetchedAt: string;
        updatedAt: string;
      }>;
      getXhsStatus(): Promise<{
        status: 'not_started' | 'starting' | 'ready' | 'needs_user' | 'process_failed' | 'tool_mismatch';
        url: string | null;
        port: number | null;
        pid: number | null;
        runtimeDir: string | null;
        tools: string[];
        requiredToolsPresent: boolean;
        lastError: string | null;
      }>;
      ensureXhs(): Promise<any>;
      startXhsLogin(): Promise<{ ok: boolean; pid?: number; error?: string }>;
      getWireHealthLedger(input?: { businessDate?: string }): Promise<{
        taskId: string | null;
        businessDate: string | null;
        status: string | null;
        phase: string | null;
        updatedAt: string | null;
        entries: Array<{ key: string; kind: 'registry' | 'x_list' | 'other'; ok: boolean; at: string; error?: string; saved: number }>;
        summary: { total: number; ok: number; failed: number; saved: number };
      }>;
      listKnowledgeTopics(input?: { query?: string; status?: string; limit?: number; offset?: number }): Promise<{ items: Array<{ id: string; title: string; canonicalKey: string; kind: string; summary: string | null; status: string; firstSeenAt: string | null; lastSeenAt: string | null; revision: number; sourceCount: number; opportunityCount: number; contentCount: number; publicationCount: number }>; total: number; limit: number; offset: number; hasMore: boolean }>;
      listKnowledgeDomains(input?: {query?:string;status?:string;order?:'manual'|'recent'|'size';limit?:number;offset?:number}):Promise<{items:any[];total:number;limit:number;offset:number;hasMore:boolean}>;
      getKnowledgeDomain(id:string,input?:{limit?:number;offset?:number}):Promise<any>;
      createKnowledgeDomain(input:{title:string;description?:string;status?:'active'|'watching'|'dormant';topicIds?:string[]}):Promise<any>;
      updateKnowledgeDomain(input:{id:string;expectedRevision:number;title?:string;description?:string;status?:'active'|'watching'|'dormant';topicIds?:string[];archived?:boolean}):Promise<any>;
      getKnowledgeContext(input: { topicId?: string; sourceId?: string; query?: string; limit?: number }): Promise<any>;
      getKnowledgeTopicDossier(input: { topicId: string; category?: string; limit?: number; offset?: number }): Promise<any>;
      getRediscovery(): Promise<{ unused: any[]; watching: any[]; pending: any[] }>;
      listKnowledgeCanvases(): Promise<any[]>;
      createKnowledgeCanvas(input: { title: string; topicId?: string }): Promise<any>;
      getKnowledgeCanvas(id: string): Promise<any>;
      updateKnowledgeCanvas(input: { id:string;expectedRevision:number;title?:string;viewportX?:number;viewportY?:number;zoom?:number }): Promise<any>;
      addKnowledgeCanvasNode(input: { canvasId: string; objectType: string; objectId?: string; noteTitle?: string; noteText?: string; x: number; y: number }): Promise<any>;
      moveKnowledgeCanvasNodes(input: { canvasId: string; nodes: Array<{ id: string; x: number; y: number; expectedRevision: number }> }): Promise<any>;
      removeKnowledgeCanvasNode(input: { canvasId: string; nodeId: string; expectedRevision: number }): Promise<any>;
      createKnowledgeRelation(input: { canvasId: string; fromNodeId: string; toNodeId: string; relationType: string; label?: string }): Promise<any>;
      updateKnowledgeRelation(input: { id: string; expectedRevision: number; fromNodeId?:string; toNodeId?:string; relationType?: string; label?: string|null; hidden?: boolean; archived?: boolean }): Promise<any>;
      decideKnowledgeSuggestion(input:{requestId:string;id:string;expectedRevision:number;decision:'confirm'|'reject'}):Promise<any>;
      previewKnowledgeContextPackage(input:{canvasId:string;nodeIds:string[];excludedNodeIds?:string[];excludedRelationIds?:string[]}):Promise<any>;
      listKnowledgeContextPackages(input?:{query?:string;archived?:boolean;limit?:number;offset?:number}):Promise<any>;
      getKnowledgeContextPackage(id: string): Promise<any>;
      getContentProjectContextPackages(projectId: string): Promise<any[]>;
      getCreativeBrief(packageId:string):Promise<any|null>;
      getCreativeBriefForContext(input:{canvasId:string;nodeIds:string[]}):Promise<any|null>;
      createCreativeBrief(input:{requestId:string;canvasId:string;nodeIds:string[];selectionMode:'current_page'|'selected';title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[]}):Promise<any>;
      updateCreativeBrief(input:{requestId:string;id:string;expectedRevision:number;title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[];status?:'draft'|'confirmed'}):Promise<any>;
      createProjectFromBrief(input:{requestId:string;briefId:string;expectedRevision:number}):Promise<any>;
      getCreativeBriefLineage(briefId:string):Promise<any>;
      windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<boolean>;
      getPiRuntime(): Promise<{ version: string; root: string; source: 'bundled' | 'override'; previousVersion: string | null; stagingVersion: string | null }>;
      updatePiRuntime(sourceRuntimeRoot: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      rollbackPiRuntime(): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      listBrowserProfiles(): Promise<OwnerBrowserState>;
      getWorkspaceBrowserBinding(): Promise<OwnerBrowserState>;
      createBrowserProfile(input: OwnerBrowserCommand & { label?: string }): Promise<unknown>;
      rebindBrowserProfile(input: OwnerBrowserCommand & { profileId: string }): Promise<unknown>;
      verifyBrowserAccount(input: OwnerBrowserCommand & { platform: 'x' | 'wechat' }): Promise<unknown>;
      migrateLegacyBrowserProfile(input: OwnerBrowserCommand & { platform: 'x' | 'wechat' }): Promise<unknown>;
      savePiConfig(input: { id?: string; name: string; baseUrl: string; model: string; api: 'openai-responses' | 'openai-completions'; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; contextWindow?: number | null; maxTokens?: number | null; apiKey?: string }): Promise<unknown>;
      activatePiConfig(id: string): Promise<unknown>;
      deletePiConfig(id: string): Promise<unknown>;
      listPiModels(input: { id?: string; baseUrl: string; api: 'openai-responses' | 'openai-completions'; apiKey?: string }): Promise<Array<{ id: string; contextWindow?: number; maxTokens?: number }>>;
      listPiSkills(): Promise<PiSkillSummary[]>;
      savePiSkill(input: PiSkillInput): Promise<PiSkillSummary>;
      deletePiSkill(name: string): Promise<{ name: string }>;
      listPiCommands(): Promise<PiCommand[]>;
      chatPi(message: string, delivery?: 'steer' | 'followUp'): Promise<{
        text: string;
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
      }>;
      stopPi(): Promise<{ stopped: boolean }>;
      forkPiConversation(entryId: string): Promise<{
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
      }>;
      getPiConversation(): Promise<{
        id: string;
        title: string;
        sessionFile: string;
        sessionId: string | null;
        createdAt: string;
        messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
        updatedAt: string;
      }>;
      listPiConversations(): Promise<Array<{ id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean; archivedAt: string | null }>>;
      archivePiConversation(conversationId: string, archived: boolean): Promise<{
        id: string; title: string; sessionFile: string; sessionId: string | null; createdAt: string;
        messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
        updatedAt: string;
      }>;
      switchPiConversation(conversationId: string): Promise<{
        id: string;
        title: string;
        sessionFile: string;
        sessionId: string | null;
        createdAt: string;
        messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
        updatedAt: string;
      }>;
      newPiConversation(): Promise<{
        id: string;
        title: string;
        sessionFile: string;
        sessionId: string | null;
        createdAt: string;
        messages: Array<{ role: 'user' | 'assistant'; text: string; thinking?: string; entryId?: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
        updatedAt: string;
      }>;
      onPiEvent(listener: (event: { type: string; text?: string; thinking?: string; error?: string; streamKey?: string; toolName?: string; toolCallId?: string; toolArgs?: unknown; toolResult?: unknown; isError?: boolean; scope?: 'dock' | 'task'; delivery?: 'steer' | 'followUp'; steering?: string[]; followUp?: string[] }) => void): () => void;
      onDataChanged(listener: (event: { scopes: Array<'today' | 'publications' | 'library' | 'sources' | 'agent' | 'studio'>; reason?: string; at: string }) => void): () => void;
      startAgentTask(input: { intent: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate: string; contextRefs?: Record<string, unknown> }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      getAgentTask(input?: { id?: string; intent?: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate?: string }): Promise<unknown>;
      agentRequestId(input: { taskId: string; logicalStep: string }): Promise<string>;
      updateAgentTaskPhase(input: { id: string; phase: string; piSessionId?: string | null }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      issueExecutionGrant(input: { requestId?: string; taskId?: string; taskGrantId?: string; command: 'intelligence_channels.proposal_apply' | 'x_lists.operation_execute' | 'publication.editor_prepare_execute'; inputHash: string; boundIdentity: Record<string, unknown>; targetActor: { type: 'owner_ui'; id: 'renderer' }; browserProfileId?: string; bindingRevision?: number; expectedAccount?: string; allowedTransition: string; requiredReadback: Record<string, unknown>; expiresAt: string }): Promise<{ version: 'CommandReceiptV1'; ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      completeAgentTask(id: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      failAgentTask(input: { id: string; errorCode: string; errorMessage: string }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      cancelAgentTask(id: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      controlDailyIntelligence(input: { id: string; action: 'skip_source' | 'save_partial' | 'cancel' }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      startDailyIntelligence(input: { businessDate: string }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      startStudioDraft(input: { businessDate: string; projectId: string }): Promise<{ ok: boolean; data: { task: { id: string; status: string; errorMessage: string | null }; reused: boolean } | null; error: { code: string; message: string } | null }>;
      startResultsReview(input: { businessDate: string; publicationId: string }): Promise<{ ok: boolean; data: { task: { id: string; status: string; errorMessage: string | null }; reused: boolean } | null; error: { code: string; message: string } | null }>;
      getToday(planDate: string): Promise<{
        sources: TodaySource[];
        sourcesTotal: number;
        sourcesDate: string | null;
        plan: { id: string; planDate: string; summary: string; items: TodayPlanItem[] } | null;
        latestPlan: { id: string; planDate: string; summary: string; items: TodayPlanItem[] } | null;
        pool: Array<{
          planItemId: string;
          planDate: string;
          title: string;
          priority: number;
          timeliness: string | null;
          timelinessClass: 'breaking' | 'hot' | 'evergreen';
          expiresAt: string | null;
          topicId: string | null;
          sourceIds: string[];
          whyNow: string;
          angle: string;
          pointOfView: string;
          targetAudience: string;
          platforms: string[];
          formats: string[];
          titleGuidance: string;
          openingGuidance: string;
          structureGuidance: string;
          effortEstimate: string;
          availableMaterials: string[];
          missingMaterials: string[];
          trendEvidence: TodayPlanItem['trendEvidence'];
          createdAt: string;
          isNew: boolean;
          carry: { id: string; state: string; revision: number } | null;
          demotion: { publishedAt: string; platform: string } | null;
        }>;
        pendingActions: string[];
        fermenting: {
          items: Array<{
            id: string;
            objectType: 'plan_item' | 'source' | 'topic';
            objectId: string;
            fingerprint: string;
            title: string;
            state: 'active' | 'watching' | 'done' | 'dismissed' | 'expired';
            priority: number | null;
            topicId: string | null;
            sourceIds: string[];
            originPlanDate: string | null;
            firstSeenAt: string;
            lastSeenAt: string;
            expiresAt: string;
            decayScore: number;
            reason: string | null;
            aftershocks: Array<{ sourceId: string; title: string; collectedAt: string }>;
            fermentedDays: number;
            createdAt: string;
            updatedAt: string;
            revision: number;
          }>;
          watchingItems: Array<{
            id: string;
            objectType: 'plan_item' | 'source' | 'topic';
            objectId: string;
            fingerprint: string;
            title: string;
            state: 'active' | 'watching' | 'done' | 'dismissed' | 'expired';
            priority: number | null;
            topicId: string | null;
            sourceIds: string[];
            originPlanDate: string | null;
            firstSeenAt: string;
            lastSeenAt: string;
            expiresAt: string;
            decayScore: number;
            reason: string | null;
            aftershocks: Array<{ sourceId: string; title: string; collectedAt: string }>;
            fermentedDays: number;
            createdAt: string;
            updatedAt: string;
            revision: number;
          }>;
          topics: Array<{ topicId: string; title: string; activeCount: number; watchingCount: number; latestTitle: string | null; fermentedDays: number }>;
          pinnedSources: Array<{ id: string; title: string; collectedAt: string; priority: number | null; summary: string | null; canonicalUrl: string | null; fermentedDays: number; reason: string }>;
        };
      } | null>;
      refreshFermenting(planDate: string): Promise<any>;
      listFermenting(planDate: string): Promise<any>;
      setCarryState(input: { id: string; expectedRevision: number; state: 'active' | 'watching' | 'done' | 'dismissed' | 'expired'; reason?: string }): Promise<any>;
      dismissPlanItem(input: { planItemId: string; reason?: string }): Promise<any>;
      createProjectFromPlanItem(planItemId: string): Promise<{ id: string; revision: number; created: boolean }>;
      getStudio(): Promise<Array<{
        id: string;
        title: string;
        revision: number;
        revisions: Array<{ id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai' }>;
        platforms: Record<string, Array<{ id: string; title: string | null; body: string; revision: number; assets: string[] }>>;
      }> | null>;
      listStudioProjects(input: {
        query?: string;
        status?: 'idea' | 'drafting' | 'review' | 'ready' | 'completed';
        archived?: boolean;
        topicId?: string | null;
        order?: 'recent' | 'oldest' | 'versions';
        platform?: 'x' | 'xiaohongshu' | 'wechat';
        limit?: number;
        offset?: number;
      }): Promise<{
        items: Array<{
          id: string; title: string; status: 'idea' | 'drafting' | 'review' | 'ready' | 'completed';
          archivedAt: string | null; revision: number; createdAt: string; updatedAt: string; versionCount: number;
          latestVersion: { id: string; number: number; createdAt: string; author: 'user' | 'ai' } | null;
          platforms: { x: number; xiaohongshu: number; wechat: number };
        }>;
        limit: number; offset: number; hasMore: boolean;
      } | null>;
      getStudioSummary(): Promise<{
        total: number;
        byStatus: Record<'idea' | 'drafting' | 'review' | 'ready' | 'completed', number>;
        archived: number;
        updatedWithin7Days: number;
      } | null>;
      getStudioProject(projectId: string): Promise<ContentProjectDetail | null>;
      createStudioProject(input: { title: string; body: string }): Promise<ContentProjectDetail>;
      updateStudioProject(input: {
        projectId: string;
        expectedRevision: number;
        status?: 'idea' | 'drafting' | 'review' | 'ready' | 'completed';
        archived?: boolean;
      }): Promise<{ ok: boolean; data: ContentProjectDetail | null; error: { code: string; message: string; details?: { current?: ContentProjectDetail } } | null }>;
      deleteStudioProject(input: { projectId: string; expectedRevision: number }): Promise<{ ok: boolean; data?: { id: string }; error: { code: string; message: string } | null }>;
      saveDiscoveredSource(input: { requestId: string; title: string; originalUrl?: string; summary?: string; author?: string; categories?: string[] }): Promise<{ version: 'CommandReceiptV1'; receiptId: string; ok: boolean; data: { items: Array<{ id: string; created: boolean; revision: number }> } | null; error: { code: string; message: string } | null }>;
      copyStudioVersionToProject(input: {
        sourceProjectId: string; contentVersionId: string; title: string;
      }): Promise<{ ok: boolean; data: ContentProjectDetail | null; error: { code: string; message: string } | null }>;
      saveStudioCore(input: { projectId: string; title: string; body: string; expectedRevision: number }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      listStudioAssets(projectId: string): Promise<Array<{
        id: string;
        relativePath: string;
        mimeType: string;
        byteCount: number;
        sha256: string;
        origin: string;
        width: number | null;
        height: number | null;
        durationMs: number | null;
        createdAt: string;
      }>>;
      importStudioImage(input: {
        projectId: string;
        sourcePath?: string;
        fileName?: string;
        mimeType?: string;
        bytesBase64?: string;
        alt?: string;
      }): Promise<
        | { ok: true; asset: { id: string; relativePath: string; mimeType: string; byteCount: number; sha256: string; origin: string; width: number | null; height: number | null; durationMs: number | null; createdAt: string }; markdown: string; reused: boolean }
        | { ok: false; cancelled: true }
      >;
      getPublications(): Promise<Array<{
        publication: {
          id: string;
          platformVersionId: string;
          platform: 'x' | 'xiaohongshu' | 'wechat';
          accountKey: string;
          status: string;
          revision: number;
          externalUrl: string | null;
          externalId: string | null;
          publishedAt: string | null;
          projectId: string;
          format: string | null;
        };
        payload: { title: string | null; body: string; assets: Array<{ id: string; sha256: string; relativePath: string; mimeType: string }>; editorEvidenceUrl?: string } | null;
        snapshot?: PublicationSnapshot;
        operation?: PublicationBrowserOperation;
        attempts: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; reconciliations: Array<Record<string, unknown>>;
      }>>;
      createPublicationSnapshot(platformVersionId: string, requestId?: string): Promise<CommandResult<unknown>>;
      authorizePublicationEditor(input: { publicationId: string; expectedRevision: number; requestId?: string }): Promise<CommandResult<unknown>>;
      getPublicationSnapshot(publicationId: string): Promise<PublicationSnapshot | null>;
      getPublicationBrowserOperation(operationId: string): Promise<PublicationBrowserOperation | null>;
      collectXMetrics(publicationId: string): Promise<{ sourceUrl: string; capturedAt: string; normalized: Record<string, { status: string; value?: number; rawLabel?: string }>; raw: Record<string, { status: string; value?: number; rawLabel?: string }> }>;
      schedulePublicationMetrics(publicationId: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      listMetricJobs(publicationId?: string): Promise<Array<Record<string, unknown>>>;
      listPublicationMetricSnapshots(publicationId?: string): Promise<Array<{
        id: string; publicationId: string; scheduledFor: string; capturedAt: string; sourceUrl: string;
        normalized: Record<string, { status: string; value?: number; rawLabel?: string }>;
        raw: Record<string, { status: string; value?: number; rawLabel?: string }>;
        createdAt: string;
      }>>;
      processDueMetrics(): Promise<{ processed: number; snapshots: unknown[] }>;
      collectXAccountMetrics(): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      listAccountMetricSnapshots(accountId?: string): Promise<Array<{
        id: string; accountId: string; platform: string; capturedAt: string; sourceUrl: string;
        normalized: Record<string, { status?: string; value?: number; rawLabel?: string }>;
        raw: Record<string, { status?: string; value?: number; rawLabel?: string }>;
        createdAt: string;
      }>>;
      listReviews(publicationId?: string): Promise<Array<{
        id: string; publicationId: string; contentVersionId: string; metricSnapshotIds: string[];
        status: 'draft' | 'final'; keep: string[]; stop: string[]; change: string[]; summary: string | null;
        createdAt: string; updatedAt: string; finalizedAt: string | null; revision: number;
        findings: Array<{ id: string; reviewId: string; title: string; body: string; createdAt: string; updatedAt: string; revision: number }>;
      }>>;
      getReview(id: string): Promise<{
        id: string; publicationId: string; contentVersionId: string; metricSnapshotIds: string[];
        status: 'draft' | 'final'; keep: string[]; stop: string[]; change: string[]; summary: string | null;
        createdAt: string; updatedAt: string; finalizedAt: string | null; revision: number;
        findings: Array<{ id: string; reviewId: string; title: string; body: string; createdAt: string; updatedAt: string; revision: number }>;
      } | null>;
      saveReview(input: {
        id?: string; publicationId: string; metricSnapshotIds: string[]; keep?: string[]; stop?: string[]; change?: string[];
        summary?: string; status?: 'draft' | 'final'; expectedRevision?: number;
        findings?: Array<{ id?: string; title: string; body: string }>;
      }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      listReviewBacklinks(input?: { reviewIds?: string[]; findingIds?: string[] }): Promise<Array<{
        planId: string; planDate: string; planItemId: string; planItemTitle: string; reviewIds: string[]; methodFindingIds: string[];
      }>>;
      prepareXPublication(platformVersionId: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      prepareWechatArticlePublication(platformVersionId: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      readBackWechatPublication(publicationId: string, expectedRevision: number, articleUrl: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      reconcileNotPublished(publicationId: string, expectedRevision: number): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
    };
  }
}

export {};
