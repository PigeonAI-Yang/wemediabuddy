export function parseMetricValue(label: string): number | null {
  const match = label.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万千亿KMB]?)/i);
  if (!match) return null;
  const scale = ({ 万: 10_000, 千: 1_000, 亿: 100_000_000, k: 1_000, m: 1_000_000, b: 1_000_000_000 } as Record<string, number>)[match[2].toLowerCase()] ?? 1;
  return Number(match[1]) * scale;
}

export const xMetricFields = ['replies', 'reposts', 'likes', 'bookmarks', 'views'] as const;
export type XMetricField = typeof xMetricFields[number];
export type XMetricSource = 'graphql' | 'dom';
export type XMetricEvidence =
  | { status: 'value'; value: number; rawLabel: string; rawValue: string | number | null; source: XMetricSource }
  | { status: 'unsupported'; rawLabel: string; rawValue: string | number | null; source: XMetricSource }
  | { status: 'unavailable'; rawLabel: string; rawValue: string | number | null; source: XMetricSource }
  | { status: 'parse_failed'; rawLabel: string; rawValue: string | number | null; source: XMetricSource };
export type XMetricEvidenceMap = Record<XMetricField, XMetricEvidence>;
export type XMetricValues = Record<XMetricField, number | null>;

export function xMetricEvidence(raw: unknown, source: XMetricSource, label?: string): XMetricEvidence {
  const rawLabel = label ?? (raw == null ? '' : String(raw).trim());
  const rawValue = typeof raw === 'number' || typeof raw === 'string' ? raw : null;
  if (raw === undefined || raw === null || String(raw).trim() === '') return { status: 'unavailable', rawLabel, rawValue, source };
  const text = String(raw).trim();
  const valid = source === 'graphql'
    ? (typeof raw === 'number' && Number.isInteger(raw)) || /^\d+$/.test(text)
    : /^\d+(?:\.\d+)?\s*[万千亿KMB]?$/i.test(text.replace(/,/g, ''))
      || /views?|likes?|reposts?|retweets?|replies?|bookmarks?|回复|转帖|转推|转发|喜欢|赞|书签|收藏|查看|播放/i.test(text);
  const value = valid ? parseMetricValue(text) : null;
  return value === null || !Number.isFinite(value) || value < 0
    ? { status: 'parse_failed', rawLabel, rawValue, source }
    : { status: 'value', value: Math.round(value), rawLabel, rawValue, source };
}

export function xMetricEvidenceMap(
  raw: Partial<Record<XMetricField, unknown>>,
  source: XMetricSource,
  labels: Partial<Record<XMetricField, string>> = {}
): XMetricEvidenceMap {
  return Object.fromEntries(xMetricFields.map((field) => [field, xMetricEvidence(raw[field], source, labels[field])])) as XMetricEvidenceMap;
}

export function xMetricValues(evidence: XMetricEvidenceMap): XMetricValues {
  return Object.fromEntries(xMetricFields.map((field) => [field, evidence[field].status === 'value' ? evidence[field].value : null])) as XMetricValues;
}
