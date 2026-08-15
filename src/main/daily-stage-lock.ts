/** Per-businessDate execution lock for scan/judge so scheduler/manager/button don't double-run. */

export type DailyStageLockKind = 'scan' | 'judge' | 'full';

type LockEntry = {
  kind: DailyStageLockKind;
  owner: string;
  at: number;
};

const locks = new Map<string, LockEntry>();

function key(businessDate: string, kind: DailyStageLockKind): string {
  // full competes with both scan and judge via explicit checks
  return `${businessDate}::${kind === 'full' ? 'full' : kind}`;
}

export function tryAcquireDailyStageLock(input: {
  businessDate: string;
  kind: DailyStageLockKind;
  owner: string;
}): { ok: true } | { ok: false; heldBy: LockEntry } {
  const businessDate = input.businessDate.trim();
  if (!businessDate) return { ok: true };

  const conflicts: DailyStageLockKind[] =
    input.kind === 'full' ? ['scan', 'judge', 'full']
      : input.kind === 'scan' ? ['scan', 'full']
        : ['judge', 'full'];

  for (const kind of conflicts) {
    const held = locks.get(key(businessDate, kind));
    if (held && held.owner !== input.owner) {
      return { ok: false, heldBy: held };
    }
  }

  locks.set(key(businessDate, input.kind === 'full' ? 'full' : input.kind), {
    kind: input.kind,
    owner: input.owner,
    at: Date.now()
  });
  return { ok: true };
}

export function releaseDailyStageLock(input: {
  businessDate: string;
  kind: DailyStageLockKind;
  owner: string;
}): void {
  const businessDate = input.businessDate.trim();
  if (!businessDate) return;
  const k = key(businessDate, input.kind === 'full' ? 'full' : input.kind);
  const held = locks.get(k);
  if (held && held.owner === input.owner) locks.delete(k);
}

export function getDailyStageLock(businessDate: string, kind: DailyStageLockKind): LockEntry | null {
  return locks.get(key(businessDate.trim(), kind === 'full' ? 'full' : kind)) ?? null;
}
