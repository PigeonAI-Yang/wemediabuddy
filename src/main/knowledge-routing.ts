/**
 * WMB-5359：Source 入库后的有界 Entity / Topic 路由。
 *
 * 这个模块只负责冻结 Source、调用注入的模型、严格解析 route manifest，
 * 再把模型候选与真实的 Entity / Topic catalog 做确定性消歧；它不直接写库。
 * 关系、Entity alias 和 job 必须由 knowledge-compile-trigger 在同一事务内提交。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EntityType, KnowledgeScope } from './knowledge-flywheel.ts';
import { freezeKnowledgeSource, verifyCandidateLocator } from './knowledge-candidates.ts';
import type { SourceRecord } from './sources.ts';

export const KNOWLEDGE_ROUTE_MANIFEST_KEY = 'wmb_knowledge_route' as const;
export const KNOWLEDGE_ROUTE_CATALOG_LIMIT = 50;

const ENTITY_TYPES: Readonly<Record<string, true>> = Object.freeze({
  person: true, organization: true, product: true, platform: true, policy: true,
  institution: true, place: true, publication_channel: true, other: true
});
const TOPIC_KINDS: Readonly<Record<string, true>> = Object.freeze({ theme: true, event: true });
const TOPIC_RELATIONS: Readonly<Record<string, true>> = Object.freeze({
  primary: true, supporting: true, background: true, contradicting: true
});
const IDENTITY_STRENGTHS: Readonly<Record<string, true>> = Object.freeze({
  strong: true, confirmed_alias: true, possible: true
});
const ROOT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  reason: true, entityCandidates: true, topicCandidates: true,
  selectedEntityKey: true, selectedTopicKey: true, evidenceGaps: true
});
const ENTITY_KEYS: Readonly<Record<string, true>> = Object.freeze({
  entityType: true, canonicalKey: true, canonicalName: true, aliases: true,
  externalIdentity: true, identityStrength: true, locator: true, excerpt: true
});
const TOPIC_KEYS: Readonly<Record<string, true>> = Object.freeze({
  topicId: true, canonicalKey: true, title: true, kind: true, summary: true,
  relation: true, locator: true, excerpt: true
});
const GAP_KEYS: Readonly<Record<string, true>> = Object.freeze({
  code: true, statement: true, locator: true, excerpt: true
});

export type KnowledgeRouteEntityCandidate = Readonly<{
  entityType: EntityType;
  canonicalKey: string;
  canonicalName: string;
  aliases: readonly string[];
  externalIdentity: Readonly<Record<string, unknown>>;
  identityStrength: 'strong' | 'confirmed_alias' | 'possible';
  locator: string;
  excerpt: string;
}>;

export type KnowledgeRouteTopicCandidate = Readonly<{
  topicId: string | null;
  canonicalKey: string;
  title: string;
  kind: 'theme' | 'event';
  summary: string;
  relation: 'primary' | 'supporting' | 'background' | 'contradicting';
  locator: string;
  excerpt: string;
}>;

export type KnowledgeRouteEvidenceGap = Readonly<{
  code: string;
  statement: string;
  locator: string;
  excerpt: string;
}>;

export type KnowledgeRouteManifest = Readonly<{
  reason: string;
  entityCandidates: readonly KnowledgeRouteEntityCandidate[];
  topicCandidates: readonly KnowledgeRouteTopicCandidate[];
  selectedEntityKey: string | null;
  selectedTopicKey: string | null;
  evidenceGaps: readonly KnowledgeRouteEvidenceGap[];
}>;

export type KnowledgeRouteManifestResult =
  | Readonly<{ ok: true; manifest: KnowledgeRouteManifest }>
  | Readonly<{ ok: false; error: Readonly<{ code: string; message: string; details?: Readonly<Record<string, unknown>> }> }>;

type RouteEntityCatalogRow = Readonly<{
  id: string;
  entityType: EntityType;
  canonicalKey: string;
  canonicalName: string;
  aliases: readonly string[];
  externalIdentity: Readonly<Record<string, unknown>>;
  revision: number;
}>;

type RouteTopicCatalogRow = Readonly<{
  id: string;
  canonicalKey: string;
  title: string;
  kind: 'theme' | 'event';
  summary: string | null;
  status: string;
  revision: number;
}>;

export type KnowledgeRouteEntityResolution = Readonly<{
  action: 'match' | 'create';
  entityId: string | null;
  matchedCanonicalName: string | null;
  beforeRevision: number | null;
  entityType: EntityType;
  canonicalKey: string;
  canonicalName: string;
  aliasesToAdd: readonly string[];
  externalIdentity: Readonly<Record<string, unknown>>;
}>;

export type KnowledgeRouteResult = Readonly<{
  status: 'resolved' | 'unresolved' | 'failed' | 'stale';
  reasonCode: string;
  reason: string;
  source: SourceRecord | null;
  sourceBody: string;
  bodyKind: 'body_cache' | 'summary' | 'none';
  topicId: string | null;
  topicRelation: 'primary' | 'supporting' | 'background' | 'contradicting';
  entity: KnowledgeRouteEntityResolution | null;
  evidenceGaps: readonly KnowledgeRouteEvidenceGap[];
  manifest: KnowledgeRouteManifest | null;
  prompt: string | null;
  matchedSourceAliases: readonly string[];
}>;

function failure(code: string, message: string, details?: Readonly<Record<string, unknown>>): KnowledgeRouteManifestResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message, ...(details ? { details: Object.freeze(details) } : {}) }) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

function checkKeys(value: Record<string, unknown>, allowed: Readonly<Record<string, true>>, path: string): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed[key]) return `${path}.${key}`;
  }
  return null;
}

function stringArray(value: unknown, path: string): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const text = stringValue(item);
    if (!text) return null;
    if (!result.some((existing) => normalize(existing) === normalize(text))) result.push(text);
    if (index > 40) return null;
  }
  return Object.freeze(result);
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isPlainObject(value) ? Object.freeze({ ...value }) : null;
}

function readEntity(value: unknown, path: string): KnowledgeRouteEntityCandidate | null {
  if (!isPlainObject(value) || checkKeys(value, ENTITY_KEYS, path)) return null;
  const entityType = stringValue(value.entityType);
  const canonicalKey = stringValue(value.canonicalKey);
  const canonicalName = stringValue(value.canonicalName);
  const identityStrength = stringValue(value.identityStrength);
  const locator = stringValue(value.locator);
  const excerpt = stringValue(value.excerpt);
  const aliases = stringArray(value.aliases ?? [], `${path}.aliases`);
  const externalIdentity = objectRecord(value.externalIdentity ?? {});
  if (!entityType || !ENTITY_TYPES[entityType] || !canonicalKey || !canonicalName
    || !identityStrength || !IDENTITY_STRENGTHS[identityStrength]
    || !locator || !excerpt || !aliases || !externalIdentity) return null;
  return Object.freeze({
    entityType: entityType as EntityType,
    canonicalKey,
    canonicalName,
    aliases,
    externalIdentity,
    identityStrength: identityStrength as KnowledgeRouteEntityCandidate['identityStrength'],
    locator,
    excerpt
  });
}

function readTopic(value: unknown, path: string): KnowledgeRouteTopicCandidate | null {
  if (!isPlainObject(value) || checkKeys(value, TOPIC_KEYS, path)) return null;
  const topicIdRaw = value.topicId === null || value.topicId === undefined ? null : stringValue(value.topicId);
  const canonicalKey = stringValue(value.canonicalKey);
  const title = stringValue(value.title);
  const kind = stringValue(value.kind);
  const summary = value.summary === undefined || value.summary === null ? '' : stringValue(value.summary);
  const relation = stringValue(value.relation);
  const locator = stringValue(value.locator);
  const excerpt = stringValue(value.excerpt);
  if ((value.topicId !== null && value.topicId !== undefined && !topicIdRaw)
    || !canonicalKey || !title || !kind || !TOPIC_KINDS[kind]
    || summary === null || !relation || !TOPIC_RELATIONS[relation]
    || !locator || !excerpt) return null;
  return Object.freeze({
    topicId: topicIdRaw,
    canonicalKey,
    title,
    kind: kind as KnowledgeRouteTopicCandidate['kind'],
    summary,
    relation: relation as KnowledgeRouteTopicCandidate['relation'],
    locator,
    excerpt
  });
}

function readGap(value: unknown, path: string): KnowledgeRouteEvidenceGap | null {
  if (!isPlainObject(value) || checkKeys(value, GAP_KEYS, path)) return null;
  const code = stringValue(value.code);
  const statement = stringValue(value.statement);
  const locator = stringValue(value.locator);
  const excerpt = value.excerpt === undefined || value.excerpt === null ? '' : stringValue(value.excerpt);
  if (!code || !statement || !locator || excerpt === null) return null;
  return Object.freeze({ code, statement, locator, excerpt });
}

function parseRouteValue(value: unknown): KnowledgeRouteManifestResult {
  if (!isPlainObject(value)) return failure('ROUTE_MANIFEST_INVALID', 'route manifest 必须是对象。');
  const rootError = checkKeys(value, ROOT_KEYS, '$.wmb_knowledge_route');
  if (rootError) return failure('ROUTE_MANIFEST_INVALID', `route manifest 存在未知字段：${rootError}。`);
  const reason = stringValue(value.reason);
  if (!reason || !Array.isArray(value.entityCandidates) || !Array.isArray(value.topicCandidates)
    || !Array.isArray(value.evidenceGaps)) {
    return failure('ROUTE_MANIFEST_INVALID', 'route manifest 缺少必填字段或字段类型错误。');
  }
  if (value.entityCandidates.length > 20 || value.topicCandidates.length > 20 || value.evidenceGaps.length > 20) {
    return failure('ROUTE_MANIFEST_INVALID', 'route manifest 候选数量超过有界上限。');
  }
  const selectedEntityKey = value.selectedEntityKey === null ? null : stringValue(value.selectedEntityKey);
  const selectedTopicKey = value.selectedTopicKey === null ? null : stringValue(value.selectedTopicKey);
  if ((value.selectedEntityKey !== null && !selectedEntityKey)
    || (value.selectedTopicKey !== null && !selectedTopicKey)) {
    return failure('ROUTE_MANIFEST_INVALID', 'selectedEntityKey/selectedTopicKey 必须为非空字符串或 null。');
  }
  const entities: KnowledgeRouteEntityCandidate[] = [];
  for (const [index, item] of value.entityCandidates.entries()) {
    const entity = readEntity(item, `$.entityCandidates[${index}]`);
    if (!entity) return failure('ROUTE_MANIFEST_INVALID', `Entity 候选 ${index} 结构非法。`);
    const key = normalize(entity.canonicalKey);
    if (entities.some((existing) => normalize(existing.canonicalKey) === key)) {
      return failure('ROUTE_MANIFEST_INVALID', `Entity 候选 canonicalKey 重复：${entity.canonicalKey}。`);
    }
    entities.push(entity);
  }
  const topics: KnowledgeRouteTopicCandidate[] = [];
  for (const [index, item] of value.topicCandidates.entries()) {
    const topic = readTopic(item, `$.topicCandidates[${index}]`);
    if (!topic) return failure('ROUTE_MANIFEST_INVALID', `Topic 候选 ${index} 结构非法。`);
    const key = normalize(topic.canonicalKey);
    if (topics.some((existing) => normalize(existing.canonicalKey) === key)) {
      return failure('ROUTE_MANIFEST_INVALID', `Topic 候选 canonicalKey 重复：${topic.canonicalKey}。`);
    }
    topics.push(topic);
  }
  const gaps: KnowledgeRouteEvidenceGap[] = [];
  for (const [index, item] of value.evidenceGaps.entries()) {
    const gap = readGap(item, `$.evidenceGaps[${index}]`);
    if (!gap) return failure('ROUTE_MANIFEST_INVALID', `Evidence Gap ${index} 结构非法。`);
    gaps.push(gap);
  }
  if (selectedEntityKey && !entities.some((item) => normalize(item.canonicalKey) === normalize(selectedEntityKey))) {
    return failure('ROUTE_MANIFEST_INVALID', 'selectedEntityKey 未对应 entityCandidates。');
  }
  if (selectedTopicKey && !topics.some((item) => normalize(item.canonicalKey) === normalize(selectedTopicKey))) {
    return failure('ROUTE_MANIFEST_INVALID', 'selectedTopicKey 未对应 topicCandidates。');
  }
  return Object.freeze({ ok: true, manifest: Object.freeze({
    reason,
    entityCandidates: Object.freeze(entities),
    topicCandidates: Object.freeze(topics),
    selectedEntityKey,
    selectedTopicKey,
    evidenceGaps: Object.freeze(gaps)
  }) });
}

/** 严格提取恰好一个 route manifest；模型多余文字不被当作路由依据。 */
export function extractKnowledgeRouteManifest(text: string): KnowledgeRouteManifestResult {
  const fences = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) return failure('ROUTE_MANIFEST_NOT_FOUND', '模型未输出 route 的 ```json 围栏块。');
  let parsed = 0;
  const values: unknown[] = [];
  for (const fence of fences) {
    try {
      const value = JSON.parse(fence[1]!);
      parsed += 1;
      if (isPlainObject(value) && KNOWLEDGE_ROUTE_MANIFEST_KEY in value) values.push(value[KNOWLEDGE_ROUTE_MANIFEST_KEY]);
    } catch {
      // 其它围栏可能不是 route；只有全部 JSON 都坏时才报告 JSON 错误。
    }
  }
  if (!parsed) return failure('ROUTE_MANIFEST_JSON_INVALID', 'route 围栏块不是合法 JSON。');
  if (values.length !== 1) {
    return failure('ROUTE_MANIFEST_AMBIGUOUS', `route manifest 必须恰好一个，实际为 ${values.length} 个。`, { count: values.length });
  }
  return parseRouteValue(values[0]);
}

export function buildKnowledgeRoutePrompt(input: {
  source: SourceRecord;
  body: string;
  bodyKind: 'body_cache' | 'summary' | 'none';
  scope: KnowledgeScope;
  entities: readonly RouteEntityCatalogRow[];
  topics: readonly RouteTopicCatalogRow[];
}): string {
  return [
    '执行 WeMediaBuddy 生产知识路由任务（WMB-5359）。',
    '',
    '# 任务',
    '基于冻结 Source 与有界 catalog，判断本 Source 应归属哪个已有 Topic，并识别是否与已有 Entity 的正式名称/已确认别名相同。',
    '只输出一个 ```json 围栏块，声明 wmb_knowledge_route；围栏外不要输出其它文字。',
    '只有强身份或正文明确确认的 alias 才能选择已有 Entity；只有名称相似不得合并。无法唯一判断时 selected* 必须为 null。',
    '证据缺口必须保留在 evidenceGaps，不得把来源的一句话自动写成 supported 事实。',
    `scope=${input.scope}`,
    '',
    '# 冻结 Source',
    `sourceId=${input.source.id}`,
    `revision=${input.source.revision}`,
    `title=${input.source.title}`,
    `author=${input.source.author ?? ''}`,
    `publishedAt=${input.source.publishedAt ?? ''}`,
    `summary=${input.source.summary ?? ''}`,
    `正文（${input.bodyKind}）：`,
    '```',
    input.body,
    '```',
    '',
    '# 有界 Entity catalog（仅可从这里判断既有身份）',
    JSON.stringify(input.entities, null, 2),
    '',
    '# 有界 Topic catalog（topicId 必须来自这里）',
    JSON.stringify(input.topics, null, 2),
    '',
    '# 严格 manifest 结构',
    '```json',
    '{',
    '  "wmb_knowledge_route": {',
    '    "reason": "路由原因（必填）",',
    '    "entityCandidates": [{ "entityType": "product", "canonicalKey": "...", "canonicalName": "...", "aliases": [], "externalIdentity": {}, "identityStrength": "strong|confirmed_alias|possible", "locator": "L1", "excerpt": "正文原句" }],',
    '    "topicCandidates": [{ "topicId": "catalog 中的 id 或 null", "canonicalKey": "...", "title": "...", "kind": "theme|event", "summary": "...", "relation": "primary|supporting|background|contradicting", "locator": "L1", "excerpt": "正文原句" }],',
    '    "selectedEntityKey": "candidate canonicalKey 或 null",',
    '    "selectedTopicKey": "candidate canonicalKey 或 null",',
    '    "evidenceGaps": [{ "code": "稳定原因码", "statement": "待核实主张", "locator": "L1", "excerpt": "正文原句" }]',
    '  }',
    '}',
    '```',
    'locator 必须是 L<行> 或 L<起>-<止>，且能定位冻结正文；多候选或证据不足时不要猜测。'
  ].join('\n');
}

function parseJsonObject(raw: string | null | undefined): Readonly<Record<string, unknown>> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(raw: string | null | undefined): readonly string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return stringArray(value, '$') ?? [];
  } catch {
    return [];
  }
}

function entityCatalog(database: DatabaseSync, scope: KnowledgeScope): RouteEntityCatalogRow[] {
  const rows = database.prepare(`SELECT id, entity_type AS entityType, canonical_key AS canonicalKey,
      canonical_name AS canonicalName, aliases_json AS aliasesJson, external_identity_json AS externalIdentityJson, revision
    FROM knowledge_entities WHERE scope=? AND lifecycle='active'
    ORDER BY updated_at DESC, id DESC LIMIT ?`).all(scope, KNOWLEDGE_ROUTE_CATALOG_LIMIT) as Array<Record<string, unknown>>;
  return rows.map((row) => Object.freeze({
    id: String(row.id), entityType: row.entityType as EntityType, canonicalKey: String(row.canonicalKey),
    canonicalName: String(row.canonicalName), aliases: parseJsonStringArray(String(row.aliasesJson ?? '[]')),
    externalIdentity: parseJsonObject(String(row.externalIdentityJson ?? '{}')), revision: Number(row.revision)
  }));
}

function topicCatalog(database: DatabaseSync): RouteTopicCatalogRow[] {
  const rows = database.prepare(`SELECT id, canonical_key AS canonicalKey, title, kind, summary, status, revision
    FROM topics WHERE status IN ('active','watching') ORDER BY last_seen_at DESC, id DESC LIMIT ?`)
    .all(KNOWLEDGE_ROUTE_CATALOG_LIMIT) as Array<Record<string, unknown>>;
  return rows.map((row) => Object.freeze({
    id: String(row.id), canonicalKey: String(row.canonicalKey), title: String(row.title),
    kind: (String(row.kind) === 'event' ? 'event' : 'theme') as 'theme' | 'event',
    summary: row.summary == null ? null : String(row.summary), status: String(row.status), revision: Number(row.revision)
  }));
}

function scalarIdentityEntries(identity: Readonly<Record<string, unknown>>): ReadonlyArray<readonly [string, string | number]> {
  return Object.entries(identity).filter((entry): entry is [string, string | number] =>
    typeof entry[1] === 'string' || typeof entry[1] === 'number');
}

function exactExternalIdentity(candidate: Readonly<Record<string, unknown>>, existing: Readonly<Record<string, unknown>>): boolean {
  const left = scalarIdentityEntries(candidate);
  const right = scalarIdentityEntries(existing);
  if (!left.length || left.length !== right.length) return false;
  return left.every(([key, value]) => existing[key] === value);
}

function namesOf(entity: RouteEntityCatalogRow): readonly string[] {
  return [entity.canonicalName, ...entity.aliases];
}

function resolveEntityCandidate(candidate: KnowledgeRouteEntityCandidate, catalog: readonly RouteEntityCatalogRow[]):
  | { ok: true; value: KnowledgeRouteEntityResolution; matchedAliases: readonly string[] }
  | { ok: false; code: string; reason: string } {
  if (candidate.identityStrength === 'possible') {
    return { ok: false, code: 'ENTITY_IDENTITY_INSUFFICIENT', reason: '只有名称相似，缺少强身份或已确认 alias 证据。' };
  }
  const candidateNames = [candidate.canonicalName, ...candidate.aliases].map(normalize).filter(Boolean);
  const matches = catalog.filter((entity) => {
    if (entity.entityType !== candidate.entityType) return false;
    const nameMatch = namesOf(entity).some((name) => candidateNames.includes(normalize(name)));
    const keyMatch = normalize(entity.canonicalKey) === normalize(candidate.canonicalKey);
    const candidateHasIdentity = scalarIdentityEntries(candidate.externalIdentity).length > 0;
    const existingHasIdentity = scalarIdentityEntries(entity.externalIdentity).length > 0;
    const identityMatch = exactExternalIdentity(candidate.externalIdentity, entity.externalIdentity);
    return identityMatch || ((nameMatch || keyMatch) && (!candidateHasIdentity || !existingHasIdentity));
  });
  if (matches.length > 1) return { ok: false, code: 'ENTITY_AMBIGUOUS', reason: '候选同时命中多个已有 Entity，必须人工消歧。' };
  if (matches.length === 1) {
    const existing = matches[0]!;
    const aliases = [...namesOf(existing), candidate.canonicalName, ...candidate.aliases]
      .filter(Boolean)
      .reduce<string[]>((all, value) => {
        if (!all.some((item) => normalize(item) === normalize(value))) all.push(value);
        return all;
      }, []);
    const externalIdentity = { ...existing.externalIdentity, ...candidate.externalIdentity };
    return { ok: true, matchedAliases: Object.freeze(aliases), value: Object.freeze({
      action: 'match', entityId: existing.id, matchedCanonicalName: existing.canonicalName,
      beforeRevision: existing.revision, entityType: candidate.entityType,
      canonicalKey: existing.canonicalKey, canonicalName: candidate.canonicalName,
      aliasesToAdd: Object.freeze(aliases), externalIdentity: Object.freeze(externalIdentity)
    }) };
  }
  return { ok: true, matchedAliases: Object.freeze([candidate.canonicalName, ...candidate.aliases]), value: Object.freeze({
    action: 'create', entityId: null, matchedCanonicalName: null, beforeRevision: null,
    entityType: candidate.entityType, canonicalKey: candidate.canonicalKey,
    canonicalName: candidate.canonicalName,
    aliasesToAdd: Object.freeze([...new Set([candidate.canonicalName, ...candidate.aliases])]),
    externalIdentity: Object.freeze({ ...candidate.externalIdentity })
  }) };
}

function selected<T extends { canonicalKey: string }>(items: readonly T[], key: string | null): T | null {
  return key ? items.find((item) => normalize(item.canonicalKey) === normalize(key)) ?? null : null;
}

function routeResult(input: Partial<KnowledgeRouteResult> & Pick<KnowledgeRouteResult, 'status' | 'reasonCode' | 'reason'>): KnowledgeRouteResult {
  return Object.freeze({
    source: null, sourceBody: '', bodyKind: 'none', topicId: null, entity: null,
    topicRelation: 'primary',
    evidenceGaps: Object.freeze([]), manifest: null, prompt: null,
    matchedSourceAliases: Object.freeze([]), ...input
  });
}

/**
 * 冻结 Source 并执行一次有界路由。返回值不写库；调用方可在 revision 二次确认后提交。
 */
export async function resolveKnowledgeRoute(database: DatabaseSync, input: {
  workspaceId: string;
  sourceId: string;
  revision: number;
  scope?: KnowledgeScope;
  modelCall: (prompt: string) => Promise<string>;
}): Promise<KnowledgeRouteResult> {
  const scope = input.scope ?? 'global';
  const frozen = freezeKnowledgeSource(database, input.sourceId);
  if (!frozen) return routeResult({ status: 'failed', reasonCode: 'SOURCE_NOT_FOUND', reason: 'Source 不存在。' });
  if (frozen.source.revision !== input.revision) {
    return routeResult({ status: 'stale', reasonCode: 'SOURCE_REVISION_STALE', reason: `Source revision 已从 ${input.revision} 更新到 ${frozen.source.revision}。`, source: frozen.source });
  }
  if (!frozen.body.trim()) {
    return routeResult({ status: 'unresolved', reasonCode: 'AWAITING_BODY', reason: 'Source 尚无可用正文或摘要，等待正文归档后重试。', source: frozen.source, bodyKind: frozen.bodyKind });
  }
  const entities = entityCatalog(database, scope);
  const topics = topicCatalog(database);
  const prompt = buildKnowledgeRoutePrompt({ source: frozen.source, body: frozen.body, bodyKind: frozen.bodyKind, scope, entities, topics });
  let text: string;
  try {
    text = await input.modelCall(prompt);
  } catch (error) {
    return routeResult({ status: 'failed', reasonCode: 'MODEL_CALL_FAILED', reason: `模型调用失败：${error instanceof Error ? error.message : String(error)}`, source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, prompt });
  }
  const extracted = extractKnowledgeRouteManifest(text);
  if (!extracted.ok) {
    return routeResult({ status: 'failed', reasonCode: extracted.error.code, reason: extracted.error.message, source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, prompt });
  }
  const manifest = extracted.manifest;
  const allEvidence = [...manifest.entityCandidates.map((candidate) => ({ locator: candidate.locator, excerpt: candidate.excerpt })),
    ...manifest.topicCandidates.map((candidate) => ({ locator: candidate.locator, excerpt: candidate.excerpt })),
    ...manifest.evidenceGaps.map((gap) => ({ locator: gap.locator, excerpt: gap.excerpt }))];
  for (const evidence of allEvidence) {
    const verdict = verifyCandidateLocator(frozen.body, evidence.locator, evidence.excerpt || undefined);
    if (!verdict.ok) {
      return routeResult({ status: 'failed', reasonCode: verdict.reasonCode, reason: `route 证据定位失败：${verdict.reason}`, source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, manifest, prompt });
    }
  }
  if (manifest.entityCandidates.length > 1 && !manifest.selectedEntityKey) {
    return routeResult({ status: 'unresolved', reasonCode: 'ENTITY_AMBIGUOUS', reason: '存在多个 Entity 候选但没有唯一选择，必须人工消歧。', source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, manifest, prompt, evidenceGaps: manifest.evidenceGaps });
  }
  const entityCandidate = selected(manifest.entityCandidates, manifest.selectedEntityKey);
  let entity: KnowledgeRouteEntityResolution | null = null;
  let matchedSourceAliases: readonly string[] = [];
  if (entityCandidate) {
    const resolved = resolveEntityCandidate(entityCandidate, entities);
    if (!resolved.ok) {
      return routeResult({ status: 'unresolved', reasonCode: resolved.code, reason: resolved.reason, source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, manifest, prompt, evidenceGaps: manifest.evidenceGaps });
    }
    entity = resolved.value;
    matchedSourceAliases = resolved.matchedAliases;
  }
  if (manifest.topicCandidates.length > 1 && !manifest.selectedTopicKey) {
    return routeResult({ status: 'unresolved', reasonCode: 'TOPIC_AMBIGUOUS', reason: '存在多个 Topic 候选但没有唯一选择，必须人工消歧。', source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, manifest, prompt, entity, evidenceGaps: manifest.evidenceGaps, matchedSourceAliases });
  }
  const topicCandidate = selected(manifest.topicCandidates, manifest.selectedTopicKey);
  if (!topicCandidate) {
    return routeResult({ status: 'unresolved', reasonCode: 'TOPIC_UNRESOLVED', reason: '没有可确认的 Topic 归属，保留为待消歧资料。', source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, manifest, prompt, entity, evidenceGaps: manifest.evidenceGaps, matchedSourceAliases });
  }
  const topic = topicCandidate.topicId
    ? topics.find((item) => item.id === topicCandidate.topicId)
    : topics.find((item) => normalize(item.canonicalKey) === normalize(topicCandidate.canonicalKey));
  if (!topic) {
    return routeResult({ status: 'unresolved', reasonCode: 'TOPIC_NOT_IN_CATALOG', reason: '模型选择的 Topic 不在冻结 catalog 中，必须人工确认。', source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, manifest, prompt, entity, evidenceGaps: manifest.evidenceGaps, matchedSourceAliases });
  }
  return routeResult({ status: 'resolved', reasonCode: 'ROUTED', reason: manifest.reason, source: frozen.source, sourceBody: frozen.body, bodyKind: frozen.bodyKind, topicId: topic.id, topicRelation: topicCandidate.relation, entity, evidenceGaps: manifest.evidenceGaps, manifest, prompt, matchedSourceAliases });
}
