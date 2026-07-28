export function parseMetricValue(label: string): number | null {
  const match = label.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万千KMB]?)/i);
  if (!match) return null;
  const scale = ({ 万: 10_000, 千: 1_000, k: 1_000, m: 1_000_000, b: 1_000_000_000 } as Record<string, number>)[match[2].toLowerCase()] ?? 1;
  return Number(match[1]) * scale;
}
