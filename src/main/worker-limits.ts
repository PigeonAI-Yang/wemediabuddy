/** Shared Pi worker lease limits (CAP-027). */
export const MAX_WORKER_LEASES = 8;
/** Reserve one slot for desk manager. */
export const MAX_EMPLOYEE_LEASES = MAX_WORKER_LEASES - 1;
/** Reporter jobs must retain at least five concurrent employee slots. */
export const MIN_REPORTER_CONCURRENCY = 5;
/** Default shared employee-pool capacity; explicit positive values below the reporter floor resolve upward. */
export const DEFAULT_MAX_WORKERS = MIN_REPORTER_CONCURRENCY;
