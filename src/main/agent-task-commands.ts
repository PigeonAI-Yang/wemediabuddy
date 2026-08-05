import type { DatabaseSync } from 'node:sqlite';
import type { CommandActorV1 } from './command-dispatcher.ts';
import {
  cancelAgentTask,
  completeAgentTask,
  failAgentTask,
  finishDailyIntelligenceFromReceipts,
  needsUserAgentTask,
  partialAgentTask,
  recoverInterruptedAgentTasks,
  reportAgentTaskProgress,
  requestAgentTaskControl,
  startAgentTask,
  updateAgentTaskPhase,
  type AgentTask,
  type AgentTaskControl,
  type AgentTaskProgress,
  type AgentIntent
} from './agent-tasks.ts';
import { dispatchBusinessCommand, receiptAsCommandResult, requireCommandResultData } from './business-command.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

export type AgentTaskMutationDependency = ActiveWorkspaceRuntime | DatabaseSync;
export type AgentTaskCommandContext = {
  actor: CommandActorV1;
  requestId: string;
  taskId?: string;
  workerLeaseId?: string;
  causation?: Readonly<Record<string, unknown>>;
};

function isRuntime(dependency: AgentTaskMutationDependency): dependency is ActiveWorkspaceRuntime {
  return 'dispatchCommand' in dependency && 'identity' in dependency && 'database' in dependency;
}

async function dispatchTask<TInput, TData>(
  dependency: AgentTaskMutationDependency,
  context: AgentTaskCommandContext,
  command: string,
  input: TInput,
  entityId: string | undefined,
  execute: (database: DatabaseSync, input: TInput) => TData
): Promise<TData> {
  if (!isRuntime(dependency)) return execute(dependency, input);
  const receipt = await dispatchBusinessCommand<TInput, TData>(dependency, {
    command,
    requestId: context.requestId,
    actor: context.actor,
    input,
    boundIdentity: dependency.identity,
    taskId: context.taskId,
    workerLeaseId: context.workerLeaseId,
    causation: context.causation,
    entityType: 'agent_task',
    execute: (database, normalizedInput) => ({ data: execute(database, normalizedInput), entityId })
  });
  return requireCommandResultData(receiptAsCommandResult<TData>(receipt));
}

export async function dispatchStartAgentTask(
  dependency: AgentTaskMutationDependency,
  input: { intent: AgentIntent; businessDate: string; contextRefs?: Record<string, unknown>; piSessionId?: string | null },
  context: AgentTaskCommandContext
): Promise<{ task: AgentTask; reused: boolean }> {
  return dispatchTask(dependency, context, 'agent_tasks.start', input, undefined, (database, normalizedInput) => {
    const result = startAgentTask(database, normalizedInput);
    return { task: requireCommandResultData(result), reused: result.reused === true };
  });
}

export function dispatchUpdateAgentTaskPhase(
  dependency: AgentTaskMutationDependency, id: string, phase: string,
  extras: { piSessionId?: string | null; contextRefs?: Record<string, unknown> }, context: AgentTaskCommandContext
): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.update_phase', { id, phase, extras }, id,
    (database, input) => requireCommandResultData(updateAgentTaskPhase(database, input.id, input.phase, input.extras)));
}

export function dispatchReportAgentTaskProgress(
  dependency: AgentTaskMutationDependency, id: string,
  input: { phase?: string; progress?: AgentTaskProgress; checkpoint?: Record<string, unknown>; message?: string; level?: 'info' | 'warning' },
  context: AgentTaskCommandContext
): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.report_progress', { id, input }, id,
    (database, normalized) => requireCommandResultData(reportAgentTaskProgress(database, normalized.id, normalized.input)));
}

export function dispatchRequestAgentTaskControl(
  dependency: AgentTaskMutationDependency, id: string, action: AgentTaskControl, context: AgentTaskCommandContext
): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.request_control', { id, action }, id,
    (database, input) => requireCommandResultData(requestAgentTaskControl(database, input.id, input.action)));
}

export function dispatchCancelAgentTask(dependency: AgentTaskMutationDependency, id: string, context: AgentTaskCommandContext): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.cancel', { id }, id,
    (database, input) => requireCommandResultData(cancelAgentTask(database, input.id)));
}

export function dispatchFailAgentTask(
  dependency: AgentTaskMutationDependency, id: string, errorCode: string, errorMessage: string, context: AgentTaskCommandContext
): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.fail', { id, errorCode, errorMessage }, id,
    (database, input) => requireCommandResultData(failAgentTask(database, input.id, input.errorCode, input.errorMessage)));
}

export function dispatchNeedsUserAgentTask(
  dependency: AgentTaskMutationDependency, id: string, errorCode: string, errorMessage: string, context: AgentTaskCommandContext
): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.needs_user', { id, errorCode, errorMessage }, id,
    (database, input) => requireCommandResultData(needsUserAgentTask(database, input.id, input.errorCode, input.errorMessage)));
}

export function dispatchPartialAgentTask(dependency: AgentTaskMutationDependency, id: string, context: AgentTaskCommandContext): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.partial', { id }, id,
    (database, input) => requireCommandResultData(partialAgentTask(database, input.id)));
}

export function dispatchFinishDailyIntelligence(
  dependency: AgentTaskMutationDependency, id: string,
  input: { forcePartial?: boolean; errorCode?: string; errorMessage?: string }, context: AgentTaskCommandContext
): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.finish_daily', { id, input }, id,
    (database, normalized) => requireCommandResultData(finishDailyIntelligenceFromReceipts(database, normalized.id, normalized.input)));
}

export function dispatchCompleteAgentTask(dependency: AgentTaskMutationDependency, id: string, context: AgentTaskCommandContext): Promise<AgentTask> {
  return dispatchTask(dependency, context, 'agent_tasks.complete', { id }, id,
    (database, input) => requireCommandResultData(completeAgentTask(database, input.id)));
}


export async function dispatchRecoverInterruptedAgentTasks(runtime: ActiveWorkspaceRuntime): Promise<number> {
  const receipt = await dispatchBusinessCommand<{ runtimeEpoch: string }, number>(runtime, {
    command: 'agent_tasks.recover_interrupted',
    requestId: `${runtime.identity.runtimeEpoch}:agent-recover`,
    actor: { type: 'scheduler', id: 'agent-recovery', label: 'agent-recovery' },
    input: { runtimeEpoch: runtime.identity.runtimeEpoch },
    boundIdentity: runtime.identity,
    entityType: 'agent_task',
    execute: (database) => ({ data: recoverInterruptedAgentTasks(database), sideEffectState: 'committed' })
  });
  return requireCommandResultData(receiptAsCommandResult<number>(receipt));
}