import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getReusableNeedsUserAgentTask, type AgentIntent, type AgentTask } from './agent-tasks.ts';
import { dispatchNeedsUserAgentTask, dispatchStartAgentTask, type AgentTaskMutationDependency } from './agent-task-commands.ts';
import { resolvePiConfig } from './pi-config.ts';
type ResolvedPiConfig = {
  baseUrl: string;
  model: string;
  api: 'openai-responses' | 'openai-completions';
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  nativeSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  apiKey: string;
};

export async function resolveAgentPiPrerequisite(dependency: AgentTaskMutationDependency, input: {
  intent: AgentIntent; businessDate: string; contextRefs: Record<string, unknown>; piSessionId?: string | null; piConfigPath?: string;
}): Promise<{ config: ResolvedPiConfig; waiting: null } | { config: null; waiting: { task: AgentTask; reused: boolean } }> {
  try { return { config: resolvePiConfig(input.piConfigPath), waiting: null }; }
  catch (error) {
    const database: DatabaseSync = 'database' in dependency ? dependency.database : dependency;
    const existing = getReusableNeedsUserAgentTask(database, input.intent, input.businessDate, input.contextRefs, 'PI_CONFIG_REQUIRED');
    if (existing) return { config: null, waiting: { task: existing, reused: true } };
    const actor = { type: 'scheduler' as const, id: input.intent.replaceAll('_', '-'), label: input.intent.replaceAll('_', '-') };
    const startRequestId = `${input.intent}:${input.businessDate}:prerequisite:start:${randomUUID()}`;
    const started = await dispatchStartAgentTask(dependency, input, { actor, requestId: startRequestId });
    const waiting = await dispatchNeedsUserAgentTask(dependency, started.task.id, 'PI_CONFIG_REQUIRED', error instanceof Error ? error.message : String(error), {
      actor, requestId: `${started.task.id}:prerequisite:needs-user`, taskId: started.task.id,
      causation: { requestId: startRequestId }
    });
    return { config: null, waiting: { task: waiting, reused: started.reused } };
  }
}
