import type { RoleId } from './agent-capabilities.ts';

export type { RoleId } from './agent-capabilities.ts';

/** Strength levels available for a role candidate or its Provider preset. */
export type RoleModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A role fallback candidate is an explicit provider preset + model pair. */
export type RoleModelCandidate = {
  profileId: string;
  model: string;
  thinking?: RoleModelThinkingLevel;
};

export type RoleModelPolicy = {
  candidates: readonly RoleModelCandidate[];
};

export type RoleModelPolicies = Readonly<Record<RoleId, RoleModelPolicy>>;
