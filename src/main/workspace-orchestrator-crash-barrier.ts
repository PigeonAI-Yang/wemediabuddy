export const ORCHESTRATOR_CRASH_INJECTED = 'ORCHESTRATOR_CRASH_INJECTED' as const;

export const CRASH_BARRIER_BUNDLES = Object.freeze([
  'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'
] as const);

export type CrashBarrierBundle = (typeof CRASH_BARRIER_BUNDLES)[number];

export const CRASH_BARRIER_PHASES = Object.freeze([
  'identity_registry',
  'business_rows',
  'checkpoint_index',
  'event_outbox'
] as const);

export type CrashBarrierPhase = (typeof CRASH_BARRIER_PHASES)[number];

export type CrashBarrierContext = Readonly<{
  bundle: CrashBarrierBundle;
  phase: CrashBarrierPhase;
  workspaceId?: string;
  requestId?: string;
  intentId?: string;
  rootRequestId?: string;
  stageRequestId?: string;
  operationRequestId?: string;
  effectRequestId?: string;
  [key: string]: unknown;
}>;

/**
 * A production hook is intentionally side-effect free by default. Returning
 * true asks the shared dispatcher to raise the stable injected-crash error;
 * throwing the same error from a custom hook is also supported.
 */
export type WorkspaceOrchestratorCrashBarrier = (context: CrashBarrierContext) => void | boolean;

export class WorkspaceOrchestratorCrashInjectedError extends Error {
  readonly code = ORCHESTRATOR_CRASH_INJECTED;
  readonly context: CrashBarrierContext;

  constructor(context: CrashBarrierContext) {
    super(ORCHESTRATOR_CRASH_INJECTED);
    this.name = 'WorkspaceOrchestratorCrashInjectedError';
    this.context = Object.freeze({ ...context });
  }
}

export function isWorkspaceOrchestratorCrashInjectedError(error: unknown): error is WorkspaceOrchestratorCrashInjectedError {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === ORCHESTRATOR_CRASH_INJECTED;
}

export function invokeWorkspaceOrchestratorCrashBarrier(
  barrier: WorkspaceOrchestratorCrashBarrier | undefined,
  context: CrashBarrierContext
): void {
  if (!barrier) return;
  if (barrier(context) === true) throw new WorkspaceOrchestratorCrashInjectedError(context);
}
