import type { DatabaseSync } from 'node:sqlite';
import type { TopicMaintenanceChange } from './topic-maintenance.ts';

type Row = Record<string, unknown>;

export type MergeMembership = Readonly<{
  sourceLinks: readonly string[];
  planItems: readonly string[];
  contentProjects: readonly string[];
  workCarryItems: readonly string[];
  knowledgeCanvases: readonly string[];
  knowledgeCanvasNodes: readonly string[];
  knowledgeDomainTopics: readonly string[];
  knowledgeDomains: readonly string[];
}>;

export type TopicConflictCheck =
  | Readonly<{ kind: 'topic_revision'; topicId: string; expectedRevision: number }>
  | Readonly<{ kind: 'canonical_absent'; canonicalKey: string; exceptTopicId: string | null }>
  | Readonly<{ kind: 'merge_membership'; mergedTopicId: string; expected: MergeMembership }>
  | Readonly<{ kind: 'merge_target_keys'; mergedTopicId: string; retainedTopicId: string; expectedCanvasNodes: readonly string[]; expectedCarryRows: readonly string[] }>
  | Readonly<{
      kind: 'reassign_links'; sourceId: string; fromTopicId: string; toTopicId: string;
      relations: readonly string[]; expectedFrom: readonly string[]; expectedTarget: readonly string[];
    }>;

export type TopicConflictContractV2 = Readonly<{
  version: 2;
  checks: readonly TopicConflictCheck[];
}>;

export type TopicConflictEvidence = Readonly<{
  kind: TopicConflictCheck['kind'] | 'legacy_snapshot';
  identity: string;
  expected: unknown;
  actual: unknown;
}>;

const canonicalKey = (value: string) => value.trim().toLocaleLowerCase();
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const rowStrings = (rows: Row[], fields: readonly string[]) => sorted(rows.map((row) => fields.map((field) => String(row[field] ?? '')).join('|')));
const rows = (database: DatabaseSync, sql: string, ...params: unknown[]) => database.prepare(sql).all(...params as any[]) as Row[];

function topicRevision(database: DatabaseSync, topicId: string): number | null {
  const row = database.prepare('SELECT revision FROM topics WHERE id=?').get(topicId) as { revision: number } | undefined;
  return row ? Number(row.revision) : null;
}

function mergeMembership(database: DatabaseSync, topicId: string): MergeMembership {
  const domainTopics = rows(database, 'SELECT domain_id,sort_order FROM knowledge_domain_topics WHERE topic_id=?', topicId);
  const domainIds = sorted(domainTopics.map((row) => String(row.domain_id)));
  const domains = domainIds.length
    ? rows(database, `SELECT id,revision FROM knowledge_domains WHERE id IN (${domainIds.map(() => '?').join(',')})`, ...domainIds)
    : [];
  return Object.freeze({
    sourceLinks: rowStrings(rows(database, 'SELECT source_id,relation FROM topic_source_links WHERE topic_id=?', topicId), ['source_id', 'relation']),
    planItems: rowStrings(rows(database, 'SELECT id,revision FROM plan_items WHERE topic_id=?', topicId), ['id', 'revision']),
    contentProjects: rowStrings(rows(database, 'SELECT id,revision FROM content_projects WHERE topic_id=?', topicId), ['id', 'revision']),
    workCarryItems: rowStrings(rows(database, "SELECT id,revision,topic_id,object_type,object_id,fingerprint,story_key FROM work_carry_items WHERE topic_id=? OR (object_type='topic' AND object_id=?)", topicId, topicId), ['id', 'revision', 'topic_id', 'object_type', 'object_id', 'fingerprint', 'story_key']),
    knowledgeCanvases: rowStrings(rows(database, 'SELECT id,revision FROM knowledge_canvases WHERE topic_id=?', topicId), ['id', 'revision']),
    knowledgeCanvasNodes: rowStrings(rows(database, "SELECT id,revision,canvas_id FROM knowledge_canvas_nodes WHERE object_type='topic' AND object_id=?", topicId), ['id', 'revision', 'canvas_id']),
    knowledgeDomainTopics: rowStrings(domainTopics, ['domain_id', 'sort_order']),
    knowledgeDomains: rowStrings(domains, ['id', 'revision'])
  });
}

function mergeTargetKeys(database: DatabaseSync, mergedTopicId: string, retainedTopicId: string) {
  const canvasIds = sorted(rows(database, "SELECT canvas_id FROM knowledge_canvas_nodes WHERE object_type='topic' AND object_id=?", mergedTopicId).map((row) => String(row.canvas_id)));
  const canvasNodes = canvasIds.length
    ? rowStrings(rows(database, `SELECT id,revision,canvas_id FROM knowledge_canvas_nodes WHERE object_type='topic' AND object_id=? AND canvas_id IN (${canvasIds.map(() => '?').join(',')})`, retainedTopicId, ...canvasIds), ['id', 'revision', 'canvas_id'])
    : [];
  const carryRows = rowStrings(rows(database, "SELECT id FROM work_carry_items WHERE object_type='topic' AND object_id=?", retainedTopicId), ['id']);
  return { canvasNodes, carryRows };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Builds the only approval conflict scope. Display snapshots never expand this contract. */
export function buildTopicConflictContract(database: DatabaseSync, changes: readonly TopicMaintenanceChange[]): TopicConflictContractV2 {
  const checks: TopicConflictCheck[] = [];
  const topicIds = new Set<string>();
  for (const change of changes) {
    if (change.kind === 'create') {
      checks.push({ kind: 'canonical_absent', canonicalKey: canonicalKey(change.after.canonicalKey ?? change.after.title), exceptTopicId: null });
    }
    if (change.kind === 'update') {
      topicIds.add(change.topicId);
      const current = database.prepare('SELECT canonical_key FROM topics WHERE id=?').get(change.topicId) as { canonical_key: string };
      const nextKey = canonicalKey(change.after.canonicalKey ?? change.after.title);
      if (nextKey !== current.canonical_key) checks.push({ kind: 'canonical_absent', canonicalKey: nextKey, exceptTopicId: change.topicId });
    }
    if (change.kind === 'archive') topicIds.add(change.topicId);
    if (change.kind === 'merge') {
      topicIds.add(change.retainedTopicId); topicIds.add(change.mergedTopicId);
      checks.push({ kind: 'merge_membership', mergedTopicId: change.mergedTopicId, expected: mergeMembership(database, change.mergedTopicId) });
      const target = mergeTargetKeys(database, change.mergedTopicId, change.retainedTopicId);
      checks.push({ kind: 'merge_target_keys', mergedTopicId: change.mergedTopicId, retainedTopicId: change.retainedTopicId, expectedCanvasNodes: target.canvasNodes, expectedCarryRows: target.carryRows });
    }
    if (change.kind === 'reassign') {
      topicIds.add(change.fromTopicId); topicIds.add(change.toTopicId);
      const filter = change.relation === undefined ? '' : ' AND relation=?';
      const params = change.relation === undefined ? [change.sourceId, change.fromTopicId] : [change.sourceId, change.fromTopicId, change.relation];
      const relations = sorted(rows(database, `SELECT relation FROM topic_source_links WHERE source_id=? AND topic_id=?${filter}`, ...params).map((row) => String(row.relation)));
      const target = relations.length
        ? sorted(rows(database, `SELECT relation FROM topic_source_links WHERE source_id=? AND topic_id=? AND relation IN (${relations.map(() => '?').join(',')})`, change.sourceId, change.toTopicId, ...relations).map((row) => String(row.relation)))
        : [];
      checks.push({ kind: 'reassign_links', sourceId: change.sourceId, fromTopicId: change.fromTopicId, toTopicId: change.toTopicId, relations, expectedFrom: relations, expectedTarget: target });
    }
  }
  for (const topicId of sorted(topicIds)) checks.unshift({ kind: 'topic_revision', topicId, expectedRevision: topicRevision(database, topicId)! });
  return Object.freeze({ version: 2, checks: Object.freeze(checks) });
}

/** Returns exact failed assertions; an empty result authorizes the frozen apply. */
export function evaluateTopicConflictContract(database: DatabaseSync, contract: TopicConflictContractV2): TopicConflictEvidence[] {
  const conflicts: TopicConflictEvidence[] = [];
  for (const check of contract.checks) {
    if (check.kind === 'topic_revision') {
      const actual = topicRevision(database, check.topicId);
      if (actual !== check.expectedRevision) conflicts.push({ kind: check.kind, identity: check.topicId, expected: check.expectedRevision, actual });
      continue;
    }
    if (check.kind === 'canonical_absent') {
      const found = database.prepare('SELECT id FROM topics WHERE canonical_key=? AND (? IS NULL OR id<>?) LIMIT 1').get(check.canonicalKey, check.exceptTopicId, check.exceptTopicId) as { id: string } | undefined;
      if (found) conflicts.push({ kind: check.kind, identity: check.canonicalKey, expected: null, actual: found.id });
      continue;
    }
    if (check.kind === 'merge_membership') {
      const actual = mergeMembership(database, check.mergedTopicId);
      if (!same(actual, check.expected)) conflicts.push({ kind: check.kind, identity: check.mergedTopicId, expected: check.expected, actual });
      continue;
    }
    if (check.kind === 'merge_target_keys') {
      const actual = mergeTargetKeys(database, check.mergedTopicId, check.retainedTopicId);
      const expected = { canvasNodes: check.expectedCanvasNodes, carryRows: check.expectedCarryRows };
      if (!same(actual, expected)) conflicts.push({ kind: check.kind, identity: `${check.mergedTopicId}->${check.retainedTopicId}`, expected, actual });
      continue;
    }
    const filter = check.relations.length ? ` AND relation IN (${check.relations.map(() => '?').join(',')})` : ' AND 0';
    const from = sorted(rows(database, `SELECT relation FROM topic_source_links WHERE source_id=? AND topic_id=?${filter}`, check.sourceId, check.fromTopicId, ...check.relations).map((row) => String(row.relation)));
    const target = sorted(rows(database, `SELECT relation FROM topic_source_links WHERE source_id=? AND topic_id=?${filter}`, check.sourceId, check.toTopicId, ...check.relations).map((row) => String(row.relation)));
    if (!same(from, check.expectedFrom) || !same(target, check.expectedTarget)) conflicts.push({ kind: check.kind, identity: `${check.sourceId}:${check.fromTopicId}->${check.toTopicId}`, expected: { from: check.expectedFrom, target: check.expectedTarget }, actual: { from, target } });
  }
  return conflicts;
}
