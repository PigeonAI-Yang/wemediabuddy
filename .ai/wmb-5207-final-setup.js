const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const rootPath = path.resolve('.ai/wmb-5207-final-root');
const userData = path.resolve('.ai/wmb-5207-final-user');
const workspaceId = 'wmb-5207-final';
fs.rmSync(rootPath, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(rootPath, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
const timestamp = new Date().toISOString();
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 1, state: { currentStep: 'complete', workspace: { workspaceId, rootPath, createdAt: timestamp }, ai: null, platforms: {}, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp } }, null, 2));
fs.writeFileSync(path.join(userData, 'pi-api-config.json'), JSON.stringify({ version: 1, state: { activeId: 'acceptance-profile', profiles: [{ id: 'acceptance-profile', name: 'Acceptance only', baseUrl: 'http://127.0.0.1:9', model: 'acceptance-model', api: 'openai-responses', encryptedApiKey: 'dW51c2VkLWFjY2VwdGFuY2Uta2V5' }], fallbackOrder: [] } }, null, 2));
fs.writeFileSync(path.join(userData, 'workspace-registry.json'), JSON.stringify({ version: 1, activeWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, displayName: 'WMB-5207 最终验收', rootPath, createdAt: new Date().toISOString() }], switchJournal: null }, null, 2));
console.log(JSON.stringify({ rootPath, userData }, null, 2));
