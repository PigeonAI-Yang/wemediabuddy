/** Toggle single-focus selection: click same id clears; other id replaces. */
export function toggleSingleFocus<T extends { id: string }>(current: T | null, next: T): T | null {
  if (current && current.id === next.id) return null;
  return next;
}

export function toggleSingleFocusByKey<T>(
  current: T | null,
  next: T,
  keyOf: (value: T) => string
): T | null {
  if (current && keyOf(current) === keyOf(next)) return null;
  return next;
}
