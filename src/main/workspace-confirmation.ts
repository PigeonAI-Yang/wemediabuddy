import path from 'node:path';
import { migrateDatabase } from './db/migrations.ts';
import type { DataRoot } from './data-root.ts';
import { activateWorkspaceProfile, readWorkspaceProfile } from './workspace-profiles.ts';
import { WorkspaceProposalStore, type WorkspaceProposalBinding } from './workspace-proposals.ts';
import { createProposedWorkspace, readRootWorkspaceId } from './workspaces.ts';

export function createWorkspaceConfirmation(input: {
  userDataPath: () => string;
  defaultBrowserProfileId: () => string;
  chooseDirectory: () => Promise<string | null>;
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  relaunchCurrentWorkspace: <T>(apply: () => Promise<T>) => Promise<T>;
  proposals: WorkspaceProposalStore;
}) {
  const selectedRoots = new Map<string, string>();
  async function selectRoot(binding: WorkspaceProposalBinding) {
    const proposal = input.proposals.validateConfirmation(binding, { workspaceId: null, currentProfile: null });
    if (proposal.target !== 'new') throw Object.assign(new Error('现有工作空间不需要选择新目录。'), { code: 'VALIDATION_ERROR' });
    const rootPath = await input.chooseDirectory();
    if (!rootPath) return null;
    selectedRoots.set(proposal.id, rootPath);
    return { proposalId: proposal.id, rootPath };
  }
  async function confirm(binding: WorkspaceProposalBinding) {
    const pending = input.proposals.get(binding.proposalId);
    if (!pending) throw Object.assign(new Error('工作空间提案已失效。'), { code: 'PROFILE_STALE' });
    if (pending.target === 'new') {
      const proposal = input.proposals.validateConfirmation(binding, { workspaceId: null, currentProfile: null });
      const rootPath = selectedRoots.get(proposal.id);
      if (!rootPath) throw Object.assign(new Error('请先选择并核对新工作空间目录。'), { code: 'CONFIRMATION_REQUIRED' });
      const workspace = await createProposedWorkspace({ registryPath: path.join(input.userDataPath(), 'workspace-registry.json'), rootPath, profile: proposal.profile, defaultProfileId: input.defaultBrowserProfileId() });
      input.proposals.consume(proposal.id);
      selectedRoots.delete(proposal.id);
      return { workspace, profile: proposal.profile };
    }
    return input.relaunchCurrentWorkspace(async () => {
      const root = await input.loadSelectedDataRoot();
      if (!root) throw Object.assign(new Error('当前工作空间不可用。'), { code: 'WORKSPACE_NOT_FOUND' });
      const database = migrateDatabase(path.join(root.path, 'wmb.db'));
      try {
        const workspaceId = await readRootWorkspaceId(root.path);
        const currentProfile = readWorkspaceProfile(database);
        const proposal = input.proposals.validateConfirmation(binding, { workspaceId, currentProfile });
        const profile = activateWorkspaceProfile(database, proposal.profile, proposal.baseProfileRevision!);
        input.proposals.consume(proposal.id);
        return { workspace: { id: workspaceId, displayName: profile.displayName, rootPath: root.path }, profile };
      } finally { database.close(); }
    });
  }
  return { list: () => input.proposals.list().map((item) => ({ ...item, selectedRootPath: selectedRoots.get(item.proposal.id) ?? null })), selectRoot, confirm };
}
