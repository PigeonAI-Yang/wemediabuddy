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
  chatPi: (message: string) => ipcRenderer.invoke('pi:chat', message) as Promise<{ text: string; stopped: boolean }>,
  stopPi: () => ipcRenderer.invoke('pi:stop') as Promise<{ stopped: boolean }>,
  getPiConversation: () => ipcRenderer.invoke('pi:conversation-get') as Promise<{
    sessionFile: string;
    sessionId: string | null;
    messages: Array<{ role: 'user' | 'assistant'; text: string; status?: 'streaming' | 'stopped' | 'failed' }>;
    updatedAt: string;
  }>,
  onPiEvent: (listener: (event: { type: string; text?: string; error?: string }) => void) => {
    const handler = (_event: unknown, payload: { type: string; text?: string; error?: string }) => listener(payload);
    ipcRenderer.on('pi:event', handler);
    return () => { ipcRenderer.removeListener('pi:event', handler); };
  },
  startAgentTask: (input: { intent: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate: string; contextRefs?: Record<string, unknown> }) => ipcRenderer.invoke('agent:start', input),
  getAgentTask: (input?: { id?: string; intent?: 'daily_intelligence' | 'studio_draft' | 'results_review'; businessDate?: string }) => ipcRenderer.invoke('agent:get', input ?? {}),
  agentRequestId: (input: { taskId: string; logicalStep: string }) => ipcRenderer.invoke('agent:request-id', input),
  updateAgentTaskPhase: (input: { id: string; phase: string; piSessionId?: string | null }) => ipcRenderer.invoke('agent:update-phase', input),
  completeAgentTask: (id: string) => ipcRenderer.invoke('agent:complete', id),
  failAgentTask: (input: { id: string; errorCode: string; errorMessage: string }) => ipcRenderer.invoke('agent:fail', input),
  cancelAgentTask: (id: string) => ipcRenderer.invoke('agent:cancel', id),
  startBrowser: () => ipcRenderer.invoke('browser:start'),
  getToday: (planDate: string) => ipcRenderer.invoke('today:get', planDate),
  createProjectFromPlanItem: (planItemId: string) => ipcRenderer.invoke('today:create-project', planItemId),
  getStudio: () => ipcRenderer.invoke('studio:get'),
  getPublications: () => ipcRenderer.invoke('publish:list'),
  collectXMetrics: (publicationId: string) => ipcRenderer.invoke('metrics:collect-x', publicationId),
  prepareXPublication: (platformVersionId: string) => ipcRenderer.invoke('publish:prepare-x', platformVersionId),
  prepareWechatArticlePublication: (platformVersionId: string) => ipcRenderer.invoke('publish:prepare-wechat-article', platformVersionId),
  readBackWechatPublication: (publicationId: string, expectedRevision: number, articleUrl: string) => ipcRenderer.invoke('publish:readback-wechat', publicationId, expectedRevision, articleUrl),
  reconcileNotPublished: (publicationId: string, expectedRevision: number) => ipcRenderer.invoke('publish:reconcile-not-published', publicationId, expectedRevision)
});
