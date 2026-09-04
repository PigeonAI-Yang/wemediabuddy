import type { DatabaseSync } from 'node:sqlite';

export type CreationExperimentObservationSample = Readonly<{
  articleSaved: boolean;
  durationMs: number | null;
  misuse: boolean;
  selectionMargin: number | null;
}>;

export type CreationExperimentObservationDecision = Readonly<{
  status: 'observe' | 'eligible_for_product_design';
  experimentCount: number;
  baselineCount: number;
  experimentArticleRate: number;
  baselineArticleRate: number;
  articleRateLift: number;
  misuseRate: number;
  medianSelectionMargin: number | null;
  medianLatencyOverhead: number | null;
  reasons: readonly string[];
}>;

export const CREATION_EXPERIMENT_PROMOTION_THRESHOLDS = Object.freeze({
  minExperimentCount: 10,
  minBaselineCount: 10,
  minArticleRateLift: 0.1,
  maxMisuseRate: 0.05,
  minMedianSelectionMargin: 5,
  maxMedianLatencyOverhead: 0.2
});

const round = (value: number): number => Math.round(value * 1000) / 1000;
const rate = (items: readonly CreationExperimentObservationSample[], predicate: (item: CreationExperimentObservationSample) => boolean): number =>
  items.length ? round(items.filter(predicate).length / items.length) : 0;
const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function evaluateCreationExperimentCohorts(input: {
  experiment: readonly CreationExperimentObservationSample[];
  baseline: readonly CreationExperimentObservationSample[];
}): CreationExperimentObservationDecision {
  const experimentArticleRate = rate(input.experiment, (item) => item.articleSaved);
  const baselineArticleRate = rate(input.baseline, (item) => item.articleSaved);
  const articleRateLift = round(experimentArticleRate - baselineArticleRate);
  const misuseRate = rate(input.experiment, (item) => item.misuse);
  const medianSelectionMargin = median(input.experiment.flatMap((item) => item.selectionMargin === null ? [] : [item.selectionMargin]));
  const experimentLatency = median(input.experiment.flatMap((item) => item.durationMs === null ? [] : [item.durationMs]));
  const baselineLatency = median(input.baseline.flatMap((item) => item.durationMs === null ? [] : [item.durationMs]));
  const medianLatencyOverhead = experimentLatency !== null && baselineLatency !== null && baselineLatency > 0
    ? round((experimentLatency - baselineLatency) / baselineLatency)
    : null;
  const thresholds = CREATION_EXPERIMENT_PROMOTION_THRESHOLDS;
  const reasons: string[] = [];
  if (input.experiment.length < thresholds.minExperimentCount) reasons.push(`实验样本不足 ${thresholds.minExperimentCount}`);
  if (input.baseline.length < thresholds.minBaselineCount) reasons.push(`基线样本不足 ${thresholds.minBaselineCount}`);
  if (articleRateLift < thresholds.minArticleRateLift) reasons.push(`正文落库率提升低于 ${thresholds.minArticleRateLift}`);
  if (misuseRate > thresholds.maxMisuseRate) reasons.push(`误用率高于 ${thresholds.maxMisuseRate}`);
  if (medianSelectionMargin === null || medianSelectionMargin < thresholds.minMedianSelectionMargin) reasons.push(`语义胜出中位领先分低于 ${thresholds.minMedianSelectionMargin}`);
  if (medianLatencyOverhead === null) reasons.push('缺少可比时延成本');
  else if (medianLatencyOverhead > thresholds.maxMedianLatencyOverhead) reasons.push(`中位额外时延高于 ${thresholds.maxMedianLatencyOverhead}`);
  return Object.freeze({
    status: reasons.length ? 'observe' : 'eligible_for_product_design',
    experimentCount: input.experiment.length,
    baselineCount: input.baseline.length,
    experimentArticleRate,
    baselineArticleRate,
    articleRateLift,
    misuseRate,
    medianSelectionMargin: medianSelectionMargin === null ? null : round(medianSelectionMargin),
    medianLatencyOverhead,
    reasons: Object.freeze(reasons)
  });
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
function parseJson(value: unknown): Record<string, unknown> {
  try { return parseObject(JSON.parse(String(value ?? '{}'))); }
  catch { return {}; }
}
function durationMs(createdAt: unknown, finishedAt: unknown): number | null {
  if (!createdAt || !finishedAt) return null;
  const duration = Date.parse(String(finishedAt)) - Date.parse(String(createdAt));
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}
function selectionMargin(experiment: Record<string, unknown>): number | null {
  const selectedId = typeof experiment.selectedVariantId === 'string' ? experiment.selectedVariantId : '';
  const variants = Array.isArray(experiment.variants) ? experiment.variants.map(parseObject) : [];
  const scores = variants.map((variant) => ({ id: String(variant.id ?? ''), score: Number(variant.weightedScore) }))
    .filter((variant) => variant.id && Number.isFinite(variant.score));
  const selected = scores.find((variant) => variant.id === selectedId);
  if (!selected || scores.length < 2) return null;
  const runnerUp = Math.max(...scores.filter((variant) => variant.id !== selectedId).map((variant) => variant.score));
  return round(selected.score - runnerUp);
}

export function readCreationExperimentObservation(database: DatabaseSync): CreationExperimentObservationDecision {
  const rows = database.prepare(`SELECT id, status, error_code AS errorCode, context_refs_json AS contextRefsJson,
    checkpoint_json AS checkpointJson, created_at AS createdAt, finished_at AS finishedAt
    FROM agent_tasks WHERE intent = 'studio_draft' ORDER BY created_at, id`).all() as Array<Record<string, unknown>>;
  const experiment: CreationExperimentObservationSample[] = [];
  const baseline: CreationExperimentObservationSample[] = [];
  for (const row of rows) {
    const context = parseJson(row.contextRefsJson);
    if (context.writerTask !== 'core_draft' || typeof context.projectId !== 'string') continue;
    const checkpoint = parseJson(row.checkpointJson);
    const hasExperiment = context.creationExperiment === true;
    const experimentValue = parseObject(checkpoint.creationExperiment);
    const finishedAt = row.finishedAt ? String(row.finishedAt) : null;
    const articleSaved = Boolean(finishedAt && database.prepare(`SELECT 1 FROM content_versions
      WHERE project_id = ? AND author = 'ai' AND created_at >= ? AND created_at <= ? LIMIT 1`)
      .get(context.projectId, String(row.createdAt), finishedAt));
    const sample = Object.freeze({
      articleSaved,
      durationMs: durationMs(row.createdAt, row.finishedAt),
      misuse: hasExperiment && (row.status !== 'succeeded' || selectionMargin(experimentValue) === null || String(row.errorCode ?? '').startsWith('CREATION_EXPERIMENT_')),
      selectionMargin: hasExperiment ? selectionMargin(experimentValue) : null
    });
    (hasExperiment ? experiment : baseline).push(sample);
  }
  return evaluateCreationExperimentCohorts({ experiment, baseline });
}
