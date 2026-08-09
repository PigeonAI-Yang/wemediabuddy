/** Shared Pi worker lease limits (CAP-027). */
export const MAX_WORKER_LEASES = 8;
/** Reserve one slot for desk manager. */
export const MAX_EMPLOYEE_LEASES = MAX_WORKER_LEASES - 1;
export const DEFAULT_MAX_WORKERS = 2;
