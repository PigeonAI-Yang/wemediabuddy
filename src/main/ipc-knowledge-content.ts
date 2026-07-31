import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { DataRoot } from './data-root';
import { migrateDatabase } from './db/migrations';
import { getToday } from './workbench';
import { getGitHubRankings } from './github-rankings';
import { readRankingCache, writeRankingCache } from './ranking-cache';
import { createKnowledgeDomain, getKnowledgeContext, getKnowledgeDomain, getKnowledgeTopicDossier, listKnowledgeDomains, listKnowledgeSources, listKnowledgeTopics, listRediscovery, updateKnowledgeDomain, updateKnowledgeSource, type ManagementStatus, type VerificationStatus } from './knowledge';
import { addKnowledgeCanvasNode, createContentProjectFromBriefIdempotent, createCreativeBriefIdempotent, createKnowledgeCanvas, createKnowledgeRelation, decideKnowledgeSuggestionIdempotent, getContentProjectContextPackages, getCreativeBriefForContext, getCreativeBriefForPackage, getCreativeBriefLineage, getKnowledgeCanvas, getKnowledgeContextPackage, listKnowledgeCanvases, listKnowledgeContextPackages, moveKnowledgeCanvasNodes, previewKnowledgeContextPackage, removeKnowledgeCanvasNode, updateCreativeBriefIdempotent, updateKnowledgeCanvas, updateKnowledgeRelation } from './knowledge-canvas';
import { copyContentVersionToNewProject, createContentProjectWithVersion, createProjectFromPlanItem, deleteContentProject, getContentProject, getStudio, listContentProjects, saveCoreVersion, updateContentProject, type ContentProjectOrder, type ContentProjectPlatform, type ContentProjectStatus } from './content';
import { upsertSource } from './sources';
import { success } from './result';

type Dependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  migrate: (root: DataRoot, options?: { recoverAgentTasks?: boolean }) => DataRoot;
};

export function registerKnowledgeContentIpc({ loadSelectedDataRoot, migrate }: Dependencies): void {
  ipcMain.handle('rankings:get-cached', async () => {
    const root = await loadSelectedDataRoot();
    if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db'));
    try { return readRankingCache(db); } finally { db.close(); }
  });
  ipcMain.handle('rankings:github-ai', async (_event, refresh = false) => {
    const value = await getGitHubRankings(refresh);
    const root = await loadSelectedDataRoot();
    if (!root) return value;
    const db = migrateDatabase(path.join(root.path, 'wmb.db'));
    try {
      const cached = readRankingCache(db);
      const freshReady = value.boards.some((board) => board.status === 'ready');
      if (!freshReady && cached?.boards.some((board) => board.status === 'ready')) return cached;
      if (freshReady) writeRankingCache(db, value);
      return value;
    } finally { db.close(); }
  });
  ipcMain.handle('knowledge:list-sources', async (_event, input = {}) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return listKnowledgeSources(db, input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge:update-source', async (_event, input: { id: string; expectedRevision: number; verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus }) => {
    const root = await loadSelectedDataRoot(); if (!root) throw new Error('请先选择数据根目录。');
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return updateKnowledgeSource(db, input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge:list-topics', async (_event, input = {}) => {
    const root = await loadSelectedDataRoot(); if (!root) return [];
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return listKnowledgeTopics(db, input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-domains:list',async(_event,input={})=>{
    const root=await loadSelectedDataRoot();if(!root)return {items:[],total:0,limit:50,offset:0,hasMore:false};
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return listKnowledgeDomains(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-domains:get',async(_event,id:string,input={})=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return getKnowledgeDomain(db,id,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-domains:create',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return createKnowledgeDomain(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-domains:update',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return updateKnowledgeDomain(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge:get-context', async (_event, input: { topicId?: string; sourceId?: string; query?: string; limit?: number }) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return getKnowledgeContext(db, input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge:get-topic-dossier',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return getKnowledgeTopicDossier(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge:rediscovery', async () => {
    const root = await loadSelectedDataRoot(); if (!root) return { unused: [], watching: [], pending: [] };
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return listRediscovery(db); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:list', async () => {
    const root = await loadSelectedDataRoot(); if (!root) return [];
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return listKnowledgeCanvases(db); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:create', async (_event, input: { title: string; topicId?: string }) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return createKnowledgeCanvas(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:get', async (_event, id: string) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return getKnowledgeCanvas(db,id); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:update', async (_event, input) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return updateKnowledgeCanvas(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:add-node', async (_event, input) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return addKnowledgeCanvasNode(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:move-nodes', async (_event, input) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return moveKnowledgeCanvasNodes(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:remove-node', async (_event, input) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return removeKnowledgeCanvasNode(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:create-relation', async (_event, input) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return createKnowledgeRelation(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:update-relation', async (_event, input) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return updateKnowledgeRelation(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-canvas:decide-suggestion', async (_event, input) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return decideKnowledgeSuggestionIdempotent(db,input); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-context:preview-package',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return previewKnowledgeContextPackage(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-context:list-packages',async(_event,input={})=>{
    const root=await loadSelectedDataRoot();if(!root)return {items:[],total:0,limit:50,offset:0,hasMore:false};
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return listKnowledgeContextPackages(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-context:get-package', async (_event, id: string) => {
    const root = await loadSelectedDataRoot(); if (!root) return null;
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return getKnowledgeContextPackage(db,id); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-context:project-packages', async (_event, projectId: string) => {
    const root = await loadSelectedDataRoot(); if (!root) return [];
    const db = migrateDatabase(path.join(root.path, 'wmb.db')); try { return getContentProjectContextPackages(db,projectId); } finally { db.close(); }
  });
  ipcMain.handle('knowledge-context:get-brief',async(_event,packageId:string)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return getCreativeBriefForPackage(db,packageId);}finally{db.close();}
  });
  ipcMain.handle('knowledge-context:get-brief-for-context',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return getCreativeBriefForContext(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-context:create-brief',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return createCreativeBriefIdempotent(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-context:update-brief',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return updateCreativeBriefIdempotent(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-context:create-project-from-brief',async(_event,input)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return createContentProjectFromBriefIdempotent(db,input);}finally{db.close();}
  });
  ipcMain.handle('knowledge-context:get-brief-lineage',async(_event,briefId:string)=>{
    const root=await loadSelectedDataRoot();if(!root)return null;
    const db=migrateDatabase(path.join(root.path,'wmb.db'));try{return getCreativeBriefLineage(db,briefId);}finally{db.close();}
  });
  ipcMain.handle('window:control', (event, action: 'minimize' | 'maximize' | 'close') => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') window.close();
    return window.isMaximized();
  });
  ipcMain.handle('today:get', async (_event, planDate: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return getToday(database, planDate); } finally { database.close(); }
  });
  ipcMain.handle('today:create-project', async (_event, planItemId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return createProjectFromPlanItem(database, planItemId); } finally { database.close(); }
  });
  ipcMain.handle('studio:get', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return getStudio(database); } finally { database.close(); }
  });
  ipcMain.handle('studio:list', async (_event, input: { query?: string; status?: ContentProjectStatus; archived?: boolean; order?: ContentProjectOrder; platform?: ContentProjectPlatform; limit?: number; offset?: number }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return listContentProjects(database, input); } finally { database.close(); }
  });
  ipcMain.handle('studio:get-detail', async (_event, projectId: string) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) return null;
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return getContentProject(database, projectId); } finally { database.close(); }
  });
  ipcMain.handle('studio:create-project', async (_event, input: { title: string; body: string }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const title = input.title.trim();
    if (!title) throw new Error('项目标题不能为空。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const created = createContentProjectWithVersion(database, { title, body: input.body || `# ${title}\n\n` });
      return getContentProject(database, created.id);
    } finally { database.close(); }
  });
  ipcMain.handle('studio:update-project', async (_event, input: { projectId: string; expectedRevision: number; status?: ContentProjectStatus; archived?: boolean; topicId?:string|null }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return updateContentProject(database, input); } finally { database.close(); }
  });
  ipcMain.handle('sources:save-discovered', async (_event, input: { title: string; originalUrl?: string; summary?: string; author?: string; categories?: string[] }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      const saved = upsertSource(database, { title: input.title, originalUrl: input.originalUrl, summary: input.summary, author: input.author, categories: input.categories });
      return success({ id: saved.id, created: saved.created });
    } finally { database.close(); }
  });
  ipcMain.handle('studio:delete-project', async (_event, input: { projectId: string; expectedRevision: number }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return deleteContentProject(database, input); } finally { database.close(); }
  });
  ipcMain.handle('studio:copy-version', async (_event, input: { sourceProjectId: string; contentVersionId: string; title: string }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try { return copyContentVersionToNewProject(database, input); } finally { database.close(); }
  });
  ipcMain.handle('studio:save-core', async (_event, input: { projectId: string; title: string; body: string; expectedRevision: number }) => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    if (!input?.projectId) throw new Error('请先选择内容项目。');
    const database = migrateDatabase(path.join(dataRoot.path, 'wmb.db'));
    try {
      return saveCoreVersion(database, {
        projectId: input.projectId,
        title: input.title,
        body: String(input.body ?? ''),
        expectedRevision: input.expectedRevision,
        author: 'user'
      });
    } finally { database.close(); }
  });
}
