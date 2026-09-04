export function sourceContentEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = left?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? '';
  const normalizedRight = right?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? '';
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const [shorter, longer] = normalizedLeft.length <= normalizedRight.length
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft];
  return shorter.length >= 80
    && longer.startsWith(shorter)
    && shorter.length / longer.length >= 0.65;
}
