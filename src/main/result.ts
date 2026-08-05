export type ErrorCode = 'REVISION_CONFLICT' | 'INVALID_STATE' | 'ACCOUNT_MISMATCH' | 'CONFIRMATION_REQUIRED' | 'CONFIRMATION_STALE' | 'EXECUTION_GRANT_REQUIRED' | 'EXECUTION_GRANT_SCOPE_MISMATCH' | 'BROWSER_NEEDS_USER' | 'PUBLICATION_UNKNOWN' | 'X_LIST_UNKNOWN' | 'METRIC_UNAVAILABLE' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'WORKSPACE_BUSY' | 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_ID_MISMATCH' | 'WORKSPACE_SWITCH_FAILED' | 'PROFILE_STALE' | 'OFFICIAL_PACK_UNAVAILABLE' | 'PI_RUNTIME_PROBE_FAILED' | 'HAS_PLATFORM_VERSIONS' | 'HAS_CONTEXT_USES' | 'HAS_CANVAS_REFS';

export type CommandResult<T> = { ok: true; data: T; error: null } | { ok: false; data: null; error: { code: ErrorCode; message: string; details: Record<string, unknown> } };

export const success = <T>(data: T): CommandResult<T> => ({ ok: true, data, error: null });
export const failure = <T = never>(code: ErrorCode, message: string, details: Record<string, unknown> = {}): CommandResult<T> => ({ ok: false, data: null, error: { code, message, details } });
