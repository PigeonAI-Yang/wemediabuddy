export function parseVisibleXListIds(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))] : null;
  } catch { return null; }
}

export function setListVisibility(current: string[], listId: string, visible: boolean): string[] {
  const next = new Set(current);
  if (visible) next.add(listId); else next.delete(listId);
  return [...next];
}
