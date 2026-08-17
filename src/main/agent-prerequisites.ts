import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getActiveAgentTask, getReusableNeedsUserAgentTask, type AgentIntent, type AgentTask } from './agent-tasks.ts';
import { dispatchNeedsUserAgentTask, dispatchStartAgentTask, type AgentTaskMutationDependency } from './agent-task-commands.ts';
import {
  isModelPolicySnapshot,
  resolveRoleModelPolicySnapshot,
  resolveRolePiConfigChain,
  type ModelPolicySnapshot,
  type ResolvedPiConfig,
  type RoleId
} from './pi-config.ts';

export type AgentPiPrerequisite = {
  config: ResolvedPiConfig;
  policySnapshot: ModelPolicySnapshot;
  waiting: null;
};

export type AgentPiWaiting = {
  config: null;
  policySnapshot: ModelPolicySnapshot | null;
  waiting: { task: AgentTask; reused: boolean };
};

export function readTaskModelPolicySnapshot(task: Pick<AgentTask, 'contextRefs'>, roleId: RoleId): ModelPolicySnapshot | null {
  const value = task.contextRefs.modelPolicySnapshot;
  return isModelPolicySnapshot(value) && value.roleId === roleId ? value : null;
}

function policyErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return 'ROLE_MODEL_POLICY_REQUIRED';
  return /^ROLE_MODEL_/.test(error.code) ? error.code : 'ROLE_MODEL_POLICY_REQUIRED';
}

function policyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function roleModelNeedsUserFailure(error: unknown): { code: string; message: string } | null {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return null;
  if (![
    'ROLE_MODEL_POLICY_REQUIRED',
    'ROLE_MODEL_PROFILE_MISSING',
    'ROLE_MODEL_AUTH_FAILED',
    'ROLE_MODEL_CONFIG_INVALID',
    'ROLE_MODEL_CHAIN_EXHAUSTED'
  ].includes(error.code)) return null;
  return { code: error.code, message: policyErrorMessage(error) };
}
export async function resolveAgentPiPrerequisite(dependency: AgentTaskMutationDependency, input: {
  intent: AgentIntent;
  roleId: RoleId;
  businessDate: string;
  contextRefs: Record<string, unknown>;
  piSessionId?: string | null;
  piConfigPath?: string;
}): Promise<AgentPiPrerequisite | AgentPiWaiting> {
  const database: DatabaseSync = 'database' in dependency ? dependency.database : dependency;
  const active = getActiveAgentTask(database, input.intent, input.businessDate);
  const activeSnapshot = active ? readTaskModelPolicySnapshot(active, input.roleId) : null;
  let policySnapshot: ModelPolicySnapshot | null = activeSnapshot;
  let persistedContextRefs: Record<string, unknown> = { ...input.contextRefs, roleId: input.roleId };
  try {
    policySnapshot ??= resolveRoleModelPolicySnapshot(input.roleId, input.piConfigPath);
    persistedContextRefs = { ...persistedContextRefs, modelPolicySnapshot: policySnapshot };
    const chain = resolveRolePiConfigChain(input.roleId, policySnapshot, input.piConfigPath);
    const config = chain[0];
    if (!config) throw Object.assign(new Error('当前角色没有可用的模型策略。'), { code: 'ROLE_MODEL_POLICY_REQUIRED' });
    return { config, policySnapshot, waiting: null };
  } catch (error) {
    const code = policyErrorCode(error);
    const existing = getReusableNeedsUserAgentTask(database, input.intent, input.businessDate, persistedContextRefs, code);
    if (existing) return { config: null, policySnapshot, waiting: { task: existing, reused: true } };
    const actor = { type: 'scheduler' as const, id: input.intent.replaceAll('_', '-'), label: input.intent.replaceAll('_', '-') };
    const startRequestId = `${input.intent}:${input.businessDate}:prerequisite:start:${randomUUID()}`;
    const started = await dispatchStartAgentTask(dependency, {
      intent: input.intent,
      businessDate: input.businessDate,
      contextRefs: persistedContextRefs,
      piSessionId: input.piSessionId
    }, { actor, requestId: startRequestId });
    const waiting = await dispatchNeedsUserAgentTask(dependency, started.task.id, code, policyErrorMessage(error), {
      actor, requestId: `${started.task.id}:prerequisite:needs-user`, taskId: started.task.id,
      causation: { requestId: startRequestId }
    });
    return { config: null, policySnapshot, waiting: { task: waiting, reused: started.reused } };
  }
}
