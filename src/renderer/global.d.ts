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
        pi: { baseUrl: string; model: string; configured: boolean };
      } | null>;
      openLogs(): Promise<void>;
      openExternal(url: string): Promise<void>;
      windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<boolean>;
      configureBrowser(id: string): Promise<{ id: string }>;
      savePiConfig(input: { baseUrl: string; model: string; apiKey?: string }): Promise<{ baseUrl: string; model: string; configured: boolean }>;
      chatPi(message: string): Promise<{ text: string; stopped: boolean }>;
      stopPi(): Promise<{ stopped: boolean }>;
      getPiConversation(): Promise<{
        sessionFile: string;
        sessionId: string | null;
        messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed' }>;
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
      startBrowser(): Promise<{ pid: number; cdpUrl: string; profilePath: string }>;
      getToday(planDate: string): Promise<{ sources: TodaySource[]; plan: { id: string; summary: string; items: TodayPlanItem[] } | null; pendingActions: string[] } | null>;
      createProjectFromPlanItem(planItemId: string): Promise<{ id: string; revision: number; created: boolean }>;
      getStudio(): Promise<Array<{ id: string; title: string; revisions: Array<{ id: string; number: number; body: string }>; platforms: Record<string, Array<{ id: string; title: string | null; body: string; revision: number; assets: string[] }>> }> | null>;
      getPublications(): Promise<Array<{
        publication: { id: string; platformVersionId: string; platform: 'x' | 'xiaohongshu' | 'wechat'; accountKey: string; status: string; revision: number };
        payload: { title: string | null; body: string; assets: Array<{ id: string; sha256: string; relativePath: string; mimeType: string }> } | null;
        attempts: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; reconciliations: Array<Record<string, unknown>>;
      }>>;
      collectXMetrics(publicationId: string): Promise<{ sourceUrl: string; capturedAt: string; normalized: Record<string, { status: string; value?: number; rawLabel?: string }>; raw: Record<string, { status: string; value?: number; rawLabel?: string }> }>;
      prepareXPublication(platformVersionId: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      prepareWechatArticlePublication(platformVersionId: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      readBackWechatPublication(publicationId: string, expectedRevision: number, articleUrl: string): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
      reconcileNotPublished(publicationId: string, expectedRevision: number): Promise<{ ok: boolean; data: unknown; error: { code: string; message: string } | null }>;
    };
  }
}

export {};
