import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('wmb', {
  getDataRoot: () => ipcRenderer.invoke('data-root:get'),
  chooseDataRoot: () => ipcRenderer.invoke('data-root:choose'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  openLogs: () => ipcRenderer.invoke('settings:open-logs'),
  openExternal: (url: string) => ipcRenderer.invoke('link:open', url),
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('window:control', action),
  configureBrowser: (id: string) => ipcRenderer.invoke('browser:configure', id),
  savePiConfig: (input: { baseUrl: string; model: string; apiKey?: string }) => ipcRenderer.invoke('pi-config:save', input),
  getPiRuntime: () => ipcRenderer.invoke('pi-runtime:get'),
  updatePiRuntime: (sourceRuntimeRoot: string) => ipcRenderer.invoke('pi-runtime:update', sourceRuntimeRoot),
  rollbackPiRuntime: () => ipcRenderer.invoke('pi-runtime:rollback'),
  chatPi: (message: string) => ipcRenderer.invoke('pi:chat', message) as Promise<{ text: string; stopped: boolean }>,
  stopPi: () => ipcRenderer.invoke('pi:stop') as Promise<{ stopped: boolean }>,
  getPiConversation: () => ipcRenderer.invoke('pi:conversation-get') as Promise<{
    id: string;
    title: string;
    sessionFile: string;
    sessionId: string | null;
    createdAt: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
    updatedAt: string;
  }>,
  listPiConversations: () => ipcRenderer.invoke('pi:conversation-list') as Promise<Array<{ id: string; title: string; preview: string; createdAt: string; updatedAt: string; active: boolean }>>,
  switchPiConversation: (conversationId: string) => ipcRenderer.invoke('pi:conversation-switch', conversationId) as Promise<{
    id: string;
    title: string;
    sessionFile: string;
    sessionId: string | null;
    createdAt: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
    updatedAt: string;
  }>,
  newPiConversation: () => ipcRenderer.invoke('pi:conversation-new') as Promise<{
    id: string;
    title: string;
    sessionFile: string;
    sessionId: string | null;
    createdAt: string;
    messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed'; createdAt?: string }>;
    updatedAt: string;
  }>,
  onPiEvent: (listener: (event: { type: string; text?: string; error?: string }) => void) => {
    const handler = (_event: unknown, payload: { type: string; text?: string; error?: string }) => listener(payload);
    ipcRenderer.on('pi:event', handler);
    return () => { ipcRenderer.removeListener('pi:event', handler); };
  },
  collectXAccountMetrics: () => ipcRenderer.invoke('metrics:collect-account-x'),
  listAccountMetricSnapshots: (accountId?: string) => ipcRenderer.invoke('metrics:list-account-snapshots', accountId),
  startAgentTask: (input: { intent: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate: string; contextRefs?: Record<string, unknown> }) => ipcRenderer.invoke('agent:start', input),
  getAgentTask: (input?: { id?: string; intent?: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate?: string }) => ipcRenderer.invoke('agent:get', input ?? {}),
  agentRequestId: (input: { taskId: string; logicalStep: string }) => ipcRenderer.invoke('agent:request-id', input),
  updateAgentTaskPhase: (input: { id: string; phase: string; piSessionId?: string | null }) => ipcRenderer.invoke('agent:update-phase', input),
  completeAgentTask: (id: string) => ipcRenderer.invoke('agent:complete', id),
  failAgentTask: (input: { id: string; errorCode: string; errorMessage: string }) => ipcRenderer.invoke('agent:fail', input),
  cancelAgentTask: (id: string) => ipcRenderer.invoke('agent:cancel', id),
  startResultsReview: (input: { businessDate: string; publicationId: string }) => ipcRenderer.invoke('agent:start-results-review', input),
  startDailyIntelligence: (businessDate: string) => ipcRenderer.invoke('agent:start-daily-intelligence', businessDate),
  startStudioDraft: (input: { businessDate: string; projectId: string }) => ipcRenderer.invoke('agent:start-studio-draft', input),
  startBrowser: () => ipcRenderer.invoke('browser:start'),
  getToday: (planDate: string) => ipcRenderer.invoke('today:get', planDate),
  createProjectFromPlanItem: (planItemId: string) => ipcRenderer.invoke('today:create-project', planItemId),
  getStudio: () => ipcRenderer.invoke('studio:get'),
  saveStudioCore: (input: { projectId: string; title: string; body: string }) => ipcRenderer.invoke('studio:save-core', input),
  getPublications: () => ipcRenderer.invoke('publish:list'),
  collectXMetrics: (publicationId: string) => ipcRenderer.invoke('metrics:collect-x', publicationId),
  schedulePublicationMetrics: (publicationId: string) => ipcRenderer.invoke('metrics:schedule', publicationId),
  listMetricJobs: (publicationId?: string) => ipcRenderer.invoke('metrics:list-jobs', publicationId),
  listPublicationMetricSnapshots: (publicationId: string) => ipcRenderer.invoke('metrics:list-snapshots', publicationId),
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
  prepareXPublication: (platformVersionId: string) => ipcRenderer.invoke('publish:prepare-x', platformVersionId),
  prepareWechatArticlePublication: (platformVersionId: string) => ipcRenderer.invoke('publish:prepare-wechat-article', platformVersionId),
  readBackWechatPublication: (publicationId: string, expectedRevision: number, articleUrl: string) => ipcRenderer.invoke('publish:readback-wechat', publicationId, expectedRevision, articleUrl),
  reconcileNotPublished: (publicationId: string, expectedRevision: number) => ipcRenderer.invoke('publish:reconcile-not-published', publicationId, expectedRevision)
});
