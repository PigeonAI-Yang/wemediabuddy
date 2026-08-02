import type { DatabaseSync } from 'node:sqlite';
import { getReusableNeedsUserAgentTask, needsUserAgentTask, startAgentTask, type AgentIntent, type AgentTask } from './agent-tasks.ts';
import { resolvePiConfig } from './pi-config.ts';

export function resolveAgentPiPrerequisite(database: DatabaseSync, input: {
  intent: AgentIntent; businessDate: string; contextRefs: Record<string, unknown>; piSessionId?: string | null; piConfigPath?: string;
}): { config: ReturnType<typeof resolvePiConfig>; waiting: null } | { config: null; waiting: { task: AgentTask; reused: boolean } } {
  try { return { config: resolvePiConfig(input.piConfigPath), waiting: null }; }
  catch (error) {
    const existing = getReusableNeedsUserAgentTask(database, input.intent, input.businessDate, input.contextRefs, 'PI_CONFIG_REQUIRED');
    if (existing) return { config: null, waiting: { task: existing, reused: true } };
    const started = startAgentTask(database, input);
    if (!started.ok) throw new Error(started.error.message);
    const waiting = needsUserAgentTask(database, started.data.id, 'PI_CONFIG_REQUIRED', error instanceof Error ? error.message : String(error));
    if (!waiting.ok) throw new Error(waiting.error.message);
    return { config: null, waiting: { task: waiting.data, reused: started.reused === true } };
  }
}
