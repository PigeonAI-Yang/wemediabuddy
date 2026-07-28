import type { TodayPlanItem, TodaySource } from '../main/workbench';

declare global {
  interface Window {
    wmb: {
      getDataRoot(): Promise<{ path: string; isNew: boolean } | null>;
      chooseDataRoot(): Promise<{ path: string; isNew: boolean } | null>;
      getSettings(): Promise<{
        paths: Record<string, string>;
        usage: Record<string, number>;
        counts: Record<string, number>;
        health: Record<string, unknown>;
        mcp: { status: string; url: string | null };
        browser: { status: string; pid?: number; cdpUrl?: string; profilePath?: string };
        browserOptions: Array<{ id: string; label: string; executablePath: string; userDataDir: string; profileDirectory: string }>;
        selectedBrowser: { id: string; label: string; executablePath: string; userDataDir: string; profileDirectory: string } | null;
        pi: {
          activeId: string | null;
          profiles: Array<{ id: string; name: string; baseUrl: string; model: string; configured: boolean; active: boolean }>;
          baseUrl: string;
          model: string;
          configured: boolean;
        };
        piRuntime: { version: string; root: string; source: 'bundled' | 'override'; previousVersion: string | null; stagingVersion: string | null };
      } | null>;
      openLogs(): Promise<void>;
      openExternal(url: string): Promise<void>;
      windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<boolean>;
      getPiRuntime(): Promise<{ version: string; root: string; source: 'bundled' | 'override'; previousVersion: string | null; stagingVersion: string | null }>;
      updatePiRuntime(sourceRuntimeRoot: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      rollbackPiRuntime(): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      configureBrowser(id: string): Promise<{ id: string }>;
      savePiConfig(input: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string }): Promise<unknown>;
      activatePiConfig(id: string): Promise<unknown>;
      deletePiConfig(id: string): Promise<unknown>;
      listPiModels(input: { id?: string; baseUrl: string; apiKey?: string }): Promise<string[]>;
      chatPi(message: string): Promise<{ text: string; stopped: boolean }>;
      stopPi(): Promise<{ stopped: boolean }>;
      getPiConversation(): Promise<{
        id: string;
        title: string;
        sessionFile: string;
        sessionId: string | null;
        createdAt: string;
        messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
        updatedAt: string;
      }>;
      listPiConversations(): Promise<Array<{ id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean }>>;
      switchPiConversation(conversationId: string): Promise<{
        id: string;
        title: string;
        sessionFile: string;
        sessionId: string | null;
        createdAt: string;
        messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
        updatedAt: string;
      }>;
      newPiConversation(): Promise<{
        id: string;
        title: string;
        sessionFile: string;
        sessionId: string | null;
        createdAt: string;
        messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
        updatedAt: string;
      }>;
      onPiEvent(listener: (event: { type: string; text?: string; error?: string }) => void): () => void;
      startAgentTask(input: { intent: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate: string; contextRefs?: Record<string, unknown> }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      getAgentTask(input?: { id?: string; intent?: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate?: string }): Promise<unknown>;
      agentRequestId(input: { taskId: string; logicalStep: string }): Promise<string>;
      updateAgentTaskPhase(input: { id: string; phase: string; piSessionId?: string | null }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      completeAgentTask(id: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      failAgentTask(input: { id: string; errorCode: string; errorMessage: string }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      cancelAgentTask(id: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      startDailyIntelligence(businessDate: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      startStudioDraft(input: { businessDate: string; projectId: string }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      startResultsReview(input: { businessDate: string; publicationId: string }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      startBrowser(): Promise<{ pid: number; cdpUrl: string; profilePath: string }>;
      getToday(planDate: string): Promise<{ sources: TodaySource[]; plan: { id: string; summary: string; items: TodayPlanItem[] } | null; pendingActions: string[] } | null>;
      createProjectFromPlanItem(planItemId: string): Promise<{ id: string; revision: number; created: boolean }>;
      getStudio(): Promise<Array<{
        id: string;
        title: string;
        revisions: Array<{ id: string; number: number; body: string; createdAt: string; author: 'user' | 'ai' }>;
        platforms: Record<string, Array<{ id: string; title: string | null; body: string; revision: number; assets: string[] }>>;
      }> | null>;
      saveStudioCore(input: { projectId: string; title: string; body: string }): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
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
        };
        payload: { title: string | null; body: string; assets: Array<{ id: string; sha256: string; relativePath: string; mimeType: string }> } | null;
        attempts: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; reconciliations: Array<Record<string, unknown>>;
      }>>;
      collectXMetrics(publicationId: string): Promise<{ sourceUrl: string; capturedAt: string; normalized: Record<string, { status: string; value?: number; rawLabel?: string }>; raw: Record<string, { status: string; value?: number; rawLabel?: string }> }>;
      schedulePublicationMetrics(publicationId: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      listMetricJobs(publicationId?: string): Promise<Array<Record<string, unknown>>>;
      listPublicationMetricSnapshots(publicationId: string): Promise<Array<{
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
