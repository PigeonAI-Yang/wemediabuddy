import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('wmb', {
  getDataRoot: () => ipcRenderer.invoke('data-root:get'),
  chooseDataRoot: () => ipcRenderer.invoke('data-root:choose'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  openLogs: () => ipcRenderer.invoke('settings:open-logs'),
  openExternal: (url: string) => ipcRenderer.invoke('link:open', url),
  getGitHubRankings: (refresh = false) => ipcRenderer.invoke('rankings:github-ai', refresh),
  listKnowledgeSources: (input = {}) => ipcRenderer.invoke('knowledge:list-sources', input),
  updateKnowledgeSource: (input: unknown) => ipcRenderer.invoke('knowledge:update-source', input),
  listKnowledgeTopics: (input = {}) => ipcRenderer.invoke('knowledge:list-topics', input),
  listKnowledgeDomains: (input = {}) => ipcRenderer.invoke('knowledge-domains:list', input),
  getKnowledgeDomain: (id:string,input={}) => ipcRenderer.invoke('knowledge-domains:get', id,input),
  createKnowledgeDomain: (input:unknown) => ipcRenderer.invoke('knowledge-domains:create',input),
  updateKnowledgeDomain: (input:unknown) => ipcRenderer.invoke('knowledge-domains:update',input),
  getKnowledgeContext: (input: unknown) => ipcRenderer.invoke('knowledge:get-context', input),
  getKnowledgeTopicDossier: (input: unknown) => ipcRenderer.invoke('knowledge:get-topic-dossier', input),
  getRediscovery: () => ipcRenderer.invoke('knowledge:rediscovery'),
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
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('window:control', action),
  configureBrowser: (id: string) => ipcRenderer.invoke('browser:configure', id),
  savePiConfig: (input: { id?: string; name: string; baseUrl: string; model: string; api: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; apiKey?: string }) => ipcRenderer.invoke('pi-config:save', input),
  activatePiConfig: (id: string) => ipcRenderer.invoke('pi-config:activate', id),
  deletePiConfig: (id: string) => ipcRenderer.invoke('pi-config:delete', id),
  listPiModels: (input: { id?: string; baseUrl: string; api: 'openai-responses' | 'openai-completions' | 'anthropic-messages'; apiKey?: string }) => ipcRenderer.invoke('pi-config:list-models', input) as Promise<string[]>,
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
  onPiEvent: (listener: (event: { type: string; text?: string; error?: string; toolName?: string }) => void) => {
    const handler = (_event: unknown, payload: { type: string; text?: string; error?: string; toolName?: string }) => listener(payload);
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
  controlDailyIntelligence: (input: { id: string; action: 'skip_source' | 'save_partial' | 'cancel' }) => ipcRenderer.invoke('agent:control-daily', input),
  startResultsReview: (input: { businessDate: string; publicationId: string }) => ipcRenderer.invoke('agent:start-results-review', input),
  startDailyIntelligence: (businessDate: string) => ipcRenderer.invoke('agent:start-daily-intelligence', businessDate),
  startStudioDraft: (input: { businessDate: string; projectId: string }) => ipcRenderer.invoke('agent:start-studio-draft', input),
  startBrowser: () => ipcRenderer.invoke('browser:start'),
  getToday: (planDate: string) => ipcRenderer.invoke('today:get', planDate),
  createProjectFromPlanItem: (planItemId: string) => ipcRenderer.invoke('today:create-project', planItemId),
  getStudio: () => ipcRenderer.invoke('studio:get'),
  listStudioProjects: (input: { query?: string; status?: 'idea' | 'drafting' | 'review' | 'ready' | 'completed'; archived?: boolean; order?: 'recent' | 'oldest' | 'versions'; platform?: 'x' | 'xiaohongshu' | 'wechat'; limit?: number; offset?: number }) => ipcRenderer.invoke('studio:list', input),
  getStudioProject: (projectId: string) => ipcRenderer.invoke('studio:get-detail', projectId),
  createStudioProject: (input: { title: string; body: string }) => ipcRenderer.invoke('studio:create-project', input),
  updateStudioProject: (input: { projectId: string; expectedRevision: number; status?: 'idea' | 'drafting' | 'review' | 'ready' | 'completed'; archived?: boolean; topicId?:string|null }) => ipcRenderer.invoke('studio:update-project', input),
  copyStudioVersionToProject: (input: { sourceProjectId: string; contentVersionId: string; title: string }) => ipcRenderer.invoke('studio:copy-version', input),
  saveStudioCore: (input: { projectId: string; title: string; body: string; expectedRevision: number }) => ipcRenderer.invoke('studio:save-core', input),
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
