export type DataChangedScope = 'today' | 'publications' | 'library' | 'sources' | 'agent' | 'studio';

export type DataChangedEvent = {
  scopes: DataChangedScope[];
  reason?: string;
  at: string;
};

type DataChangedPublisher = (event: DataChangedEvent) => void;

type DataChangedBusState = {
  publisher: DataChangedPublisher | null;
  pendingScopes: Set<DataChangedScope>;
  pendingReasons: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

const GLOBAL_KEY = '__wmb_data_changed_bus__';

function bus(): DataChangedBusState {
  const globalRef = globalThis as typeof globalThis & { [GLOBAL_KEY]?: DataChangedBusState };
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = {
      publisher: null,
      pendingScopes: new Set<DataChangedScope>(),
      pendingReasons: new Set<string>(),
      flushTimer: null
    };
  }
  return globalRef[GLOBAL_KEY]!;
}

export function setDataChangedPublisher(next: DataChangedPublisher | null): void {
  bus().publisher = next;
}

function flushDataChanged(): void {
  const state = bus();
  state.flushTimer = null;
  if (!state.pendingScopes.size) return;
  const event: DataChangedEvent = {
    scopes: [...state.pendingScopes],
    reason: state.pendingReasons.size ? [...state.pendingReasons].slice(0, 6).join(',') : undefined,
    at: new Date().toISOString()
  };
  state.pendingScopes.clear();
  state.pendingReasons.clear();
  state.publisher?.(event);
}

export function broadcastDataChanged(input: { scopes: DataChangedScope[]; reason?: string }): void {
  const state = bus();
  for (const scope of input.scopes) {
    if (scope) state.pendingScopes.add(scope);
  }
  if (input.reason) state.pendingReasons.add(input.reason);
  if (!state.pendingScopes.size) return;
  if (state.flushTimer) return;
  // Coalesce bursty writes (daily ingest / batch upsert) into one renderer refresh.
  state.flushTimer = setTimeout(flushDataChanged, 50);
}
