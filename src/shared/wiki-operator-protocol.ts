/**
 * WMB-5240：Wiki 自然语言操作 —— 严格结构化动作协议（shared canonical SSOT）。
 *
 * 能力：维护整个 Wiki、单条/批量 Ingest、固定版本 Query + 可复用答案写回、全局 Lint、
 * 统一搜索、维护报告读取，全部经 Pi 末条回复中严格 ```json {"wmb_wiki_action": …} ``` 围栏清单
 * 声明（协议键，非工具名；与 wmb_query_writeback 同款机器校验，一个轮次至多一个协议围栏）。
 *
 * 定位：main（settle 执行面）、renderer（面板原因展示）、tests 共用单源；纯 JSON 校验、
 * 无 DB、无 Node 依赖、零副作用。执行面（authority gate/dispatcher/逐项结果/幂等）在
 * src/main/pi-wiki-actions.ts（executor），本模块只做形状/边界机器校验。
 *
 * 安全属性（acceptance）：
 * - 自由文本永不触发任何 Wiki 动作：只有严格围栏清单进入执行面，解析失败 → 零写零执行；
 * - 未知 action / 未知字段 / 类型错误 / 越界 → fail-closed（返回 null + 可读拒绝原因）；
 * - 动作 → 底层命令的映射封闭在 executor（枚举 → 恰一个已登记命令），本协议不含命令字符串，
 *   不存在自由文本命令透传；
 * - 固定版本必填：query 至少声明一个非空冻结版本引用列表（wikiVersionRefs / noteVersionRefs /
 *   evidenceRefs，`type:objectId:versionRef` 语法，每类 ≤ WIKI_QUERY_VERSIONS_MAX）；
 *   存在性/归属/漂移校验在 fixed-version-query 执行面（FIXED_VERSION_REF_INVALID /
 *   FIXED_VERSION_NOT_FOUND / FIXED_VERSION_DRIFT）；
 * - 批量有界：ingest items 1..WIKI_INGEST_BATCH_MAX；search/log limit 有界；maintain config 有界；
 * - 写动作（maintain start/pause/resume、ingest、lint run=true）必须携带
 *   taskId/grantId/workerLeaseId（解析期第一道；executor 仍须以真实 grant 深度复核，
 *   缺/过期 → TASK_GRANT_* 零写——解析期非空只是必要不充分）；
 * - 最终发布人工：本协议不暴露任何发布/平台变更/红线条目动作。
 */

import { WIKI_SEARCH_OBJECT_TYPES, type WikiSearchObjectType } from './knowledge-search.ts';
import type { KnowledgeLogEventType, KnowledgeLogObjectType } from './knowledge-global-log.ts';

/** 围栏清单键（协议键；不是 wmb_* 工具，SKILL.md 内不得以反引号书写以免工具 parity 误判）。 */
export const WIKI_ACTION_MANIFEST_KEY = 'wmb_wiki_action' as const;

/** ingest 批量上限（T-BR-1：sources.upsert_batch 入参 items 无 maxItems，协议层强制 1..50）。 */
export const WIKI_INGEST_BATCH_MAX = 50;
/** search limit 上限（WMB-5238 分页有界 1..100）。 */
export const WIKI_SEARCH_LIMIT_MAX = 100;
/** log limit 上限（WMB-5238 日志 limit ≤ 100）。 */
export const WIKI_LOG_LIMIT_MAX = 100;
/** query 每类冻结版本 id 上限（T-BR-2：防逐 id SELECT / 大 IN 无界）。 */
export const WIKI_QUERY_VERSIONS_MAX = 64;
/** maintain config 边界（对齐 src/main/knowledge-maintenance.ts MAX_* 常量）。 */
export const WIKI_MAINTENANCE_BATCH_LIMIT_MAX = 50;
export const WIKI_MAINTENANCE_MAX_TOPICS_MAX = 20;
export const WIKI_MAINTENANCE_STALL_LIMIT_MAX = 20;
/** requestId 长度上限（防无界注入）。 */
export const WIKI_ACTION_REQUEST_ID_MAX = 128;
/** log cursor 长度上限（不透明字符串透传）。 */
export const WIKI_LOG_CURSOR_MAX = 256;

export type WikiActionKind =
  | 'maintain'
  | 'ingest'
  | 'query'
  | 'lint'
  | 'search'
  | 'log'
  | 'report';

export const WIKI_ACTION_KINDS: readonly WikiActionKind[] = Object.freeze([
  'maintain', 'ingest', 'query', 'lint', 'search', 'log', 'report'
] as const);

export type WikiMaintainSubaction = 'start' | 'status' | 'pause' | 'resume' | 'report';

export const WIKI_MAINTAIN_SUBACCTIONS: readonly WikiMaintainSubaction[] = Object.freeze([
  'start', 'status', 'pause', 'resume', 'report'
] as const);

/** 写动作集合（静态字面量查找表）：解析时必须携带 taskId/grantId/workerLeaseId（缺失 → 拒绝零写）。 */
export const WIKI_WRITE_ACTION_KINDS: Readonly<Record<string, true>> = Object.freeze({
  maintain: true,
  ingest: true,
  lint: true
} as const);

// ============================================================
// 载荷类型（与 executor 契约逐字段对齐；全部 camelCase 纯 JSON）
// ============================================================

/** maintain config：只在 subaction=start 合法；每项可选且有界。 */
export type WikiMaintainConfig = Readonly<{
  batchLimit?: number;
  maxTopicsPerSource?: number;
  stallLimit?: number;
}>;

/** ingest 条目（对齐 sources.upsert_batch 可选字段；feedId 明确禁止）。 */
export type WikiIngestItem = Readonly<{
  title: string;
  originalUrl: string;
  author?: string;
  publishedAt?: string;
  summary?: string;
  categories?: readonly string[];
  keywords?: readonly string[];
  valueJudgment?: string;
  ipRelevance?: string;
  creationAngles?: string;
  recommendedPlatforms?: readonly string[];
  recommendedFormats?: readonly string[];
  timeliness?: string;
  priority?: number;
  evidence?: string;
  expectedRevision?: number;
}>;

/** log 过滤子集（对齐 WMB-5238 KnowledgeLogReadFilter；eventType/objectType 枚举受限）。 */
export type WikiLogFilter = Readonly<{
  eventType?: KnowledgeLogEventType;
  topicId?: string;
  objectType?: KnowledgeLogObjectType;
  objectId?: string;
  scope?: string;
  limit?: number;
  before?: string;
  after?: string;
}>;

/** 协议动作载荷（discriminated by action）。 */
export type WikiActionPayload =
  | Readonly<{ action: 'maintain'; subaction: WikiMaintainSubaction; config?: WikiMaintainConfig }>
  | Readonly<{ action: 'ingest'; items: readonly WikiIngestItem[] }>
  | Readonly<{
      action: 'query';
      question?: string;
      /** 固定版本引用字符串：`wiki_page:<pageId>:<versionId>`（owner：src/main/fixed-version-query.ts）。 */
      wikiVersionRefs?: readonly string[];
      /** 固定版本引用字符串：`knowledge_note:<noteId>:<versionId>`。 */
      noteVersionRefs?: readonly string[];
      /** 固定版本引用字符串：`evidence:<id>`（evidence 无版本表，objectId 即版本）。 */
      evidenceRefs?: readonly string[];
    }>
  | Readonly<{ action: 'lint'; run?: boolean }>
  | Readonly<{ action: 'search'; query: string; limit?: number; objectTypes?: readonly WikiSearchObjectType[] }>
  | Readonly<{ action: 'log'; filter?: WikiLogFilter; limit?: number; cursor?: string }>
  | Readonly<{ action: 'report' }>;

/** 完整清单：公共字段（requestId 必填；authority 三件套写动作必填）+ 动作载荷。 */
export type WikiActionManifest = WikiActionPayload & Readonly<{
  requestId: string;
  taskId?: string;
  grantId?: string;
  workerLeaseId?: string;
}>;

// ============================================================
// 拒绝原因（fail-closed；reason 为用户语言中文，供 settle 面板展示，
// 不携带动态值/路径/SQL/堆栈/密钥，满足 T-EL-1）
// ============================================================

export const WIKI_ACTION_REJECT_CODES = Object.freeze([
  'WIKI_ACTION_MISSING',            // 回复无 ```json 围栏 / 围栏内无 wmb_wiki_action 键
  'WIKI_ACTION_INVALID',            // 围栏 JSON 非法或结构非法
  'WIKI_ACTION_UNKNOWN_ACTION',     // action 不在 WIKI_ACTION_KINDS
  'WIKI_ACTION_EXTRA_FIELD',        // 出现协议未列出的字段（fail-closed）
  'WIKI_ACTION_MISSING_FIELD',      // 必填字段缺失
  'WIKI_ACTION_BATCH_OVER_LIMIT',   // ingest 超过批量上限
  'WIKI_ACTION_QUERY_VERSION_REQUIRED', // query 未声明任何冻结版本（固定版本必填）
  'WIKI_ACTION_AUTHORITY_REQUIRED', // 写动作缺少 taskId/grantId/workerLeaseId
  'WIKI_ACTION_BOUND_VIOLATION',    // limit/config/版本 id 数量越界
  'WIKI_ACTION_INVALID_VALUE'       // 枚举/URL/类型非法（如 originalUrl 非 http(s)）
] as const);

export type WikiActionRejectCode = (typeof WIKI_ACTION_REJECT_CODES)[number];

export type WikiActionReject = Readonly<{
  code: WikiActionRejectCode;
  /** 出错字段路径（协议键名或 items[N].key，无动态数据）。 */
  field?: string;
  /** 用户语言原因（静态中文文案；可含字段名与上限数字，不含路径/值）。 */
  reason: string;
}>;

export type WikiActionParseResult = Readonly<{
  manifest: WikiActionManifest | null;
  reject: WikiActionReject | null;
}>;

// ============================================================
// 纯校验辅助（全部 fail-closed；本包唯一 canonical guard）
// ============================================================

/** 本包唯一 canonical 对象守卫（共享类型守卫模块不存在时定义一次、导出复用）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asOptionalNonEmptyString(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

function reject(code: WikiActionRejectCode, reason: string, field?: string): WikiActionParseResult {
  return { manifest: null, reject: Object.freeze({ code, reason, ...(field ? { field } : {}) }) };
}

function ok(manifest: WikiActionManifest): WikiActionParseResult {
  return { manifest: Object.freeze(manifest), reject: null };
}

/** 检查 record 的键集合 ⊆ allowed；返回首个未列出的键（null = 全部合法）。 */
function extraKeyOf(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

/** 可选整数区间校验；非法返回 null。 */
function asIntInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

/** 字符串数组校验（每个元素非空字符串，长度 ≤ max）；非法返回 null。 */
function asStringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) return null;
    out.push(item.trim());
  }
  return out;
}

/** 字符串数组字段校验（数组字段的元素必须是字符串；值数组非法返回 null）。 */
function asStringArrayField(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) return null;
    out.push(item.trim());
  }
  return out;
}

/** originalUrl 协议级校验：仅 http(s) 且 authority 无 user:pass@ 主机凭据（T-URL-1 / T-URL-2；canonicalize 仍由后端执行）。 */
function isHttpUrl(value: string): boolean {
  const match = /^https?:\/\/([^/?#\s]*)/i.exec(value);
  if (!match) return false;
  const authority = match[1] ?? '';
  return authority.length > 0 && !authority.includes('@');
}

/**
 * 固定版本引用语法门（fail-closed；存在性/归属/漂移由 fixed-version-query 执行面校验）：
 * `wiki_page:<pageId>:<versionId>`（3 段）、`knowledge_note:<noteId>:<versionId>`（3 段）、`evidence:<id>`（2 段）。
 */
function isValidVersionRef(ref: string, typePrefix: string, partCount: number): boolean {
  if (/\s/.test(ref)) return false;
  const parts = ref.split(':');
  return parts.length === partCount && parts[0] === typePrefix && parts.every((part) => part.length > 0);
}

const INGEST_ITEM_KEYS = Object.freeze([
  'title', 'originalUrl', 'author', 'publishedAt', 'summary', 'categories', 'keywords',
  'valueJudgment', 'ipRelevance', 'creationAngles', 'recommendedPlatforms',
  'recommendedFormats', 'timeliness', 'priority', 'evidence', 'expectedRevision'
] as const);

type IngestItemResult = { item: WikiIngestItem } | { reject: WikiActionReject };

function normalizeIngestItem(raw: unknown, index: number): IngestItemResult {
  if (!isRecord(raw)) return { reject: { code: 'WIKI_ACTION_INVALID', reason: 'ingest items 结构非法。', field: `items[${index}]` } };
  const field = `items[${index}]`;
  const extra = extraKeyOf(raw, INGEST_ITEM_KEYS);
  if (extra !== null) {
    return { reject: { code: 'WIKI_ACTION_EXTRA_FIELD', reason: `ingest 条目 ${field} 含协议未列出的字段（${extra}），零写。`, field: `${field}.${extra}` } };
  }
  if (!isNonEmptyString(raw.title)) {
    return { reject: { code: 'WIKI_ACTION_MISSING_FIELD', reason: `ingest 条目 ${field} 缺少必填字段 title（非空字符串）。`, field: `${field}.title` } };
  }
  if (!isNonEmptyString(raw.originalUrl)) {
    return { reject: { code: 'WIKI_ACTION_MISSING_FIELD', reason: `ingest 条目 ${field} 缺少必填字段 originalUrl（非空字符串）。`, field: `${field}.originalUrl` } };
  }
  const originalUrl = raw.originalUrl.trim();
  if (!isHttpUrl(originalUrl)) {
    return { reject: { code: 'WIKI_ACTION_INVALID_VALUE', reason: `ingest 条目 ${field} 的 originalUrl 必须是 http(s) 链接且不得携带主机凭据。`, field: `${field}.originalUrl` } };
  }
  const item: WikiIngestItem = { title: raw.title.trim(), originalUrl };
  const stringKeys = ['author', 'publishedAt', 'summary', 'valueJudgment', 'ipRelevance', 'creationAngles', 'timeliness', 'evidence'] as const;
  for (const key of stringKeys) {
    if (raw[key] !== undefined) {
      if (!isNonEmptyString(raw[key])) {
        return { reject: { code: 'WIKI_ACTION_INVALID_VALUE', reason: `ingest 条目 ${field} 的 ${key} 必须是非空字符串。`, field: `${field}.${key}` } };
      }
      (item as Record<string, unknown>)[key] = (raw[key] as string).trim();
    }
  }
  const arrayKeys = ['categories', 'keywords', 'recommendedPlatforms', 'recommendedFormats'] as const;
  for (const key of arrayKeys) {
    if (raw[key] !== undefined) {
      const values = asStringArrayField(raw[key]);
      if (values === null) {
        return { reject: { code: 'WIKI_ACTION_INVALID_VALUE', reason: `ingest 条目 ${field} 的 ${key} 必须是字符串数组。`, field: `${field}.${key}` } };
      }
      (item as Record<string, unknown>)[key] = values;
    }
  }
  for (const key of ['priority', 'expectedRevision'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
        return { reject: { code: 'WIKI_ACTION_INVALID_VALUE', reason: `ingest 条目 ${field} 的 ${key} 必须是数字。`, field: `${field}.${key}` } };
      }
      (item as Record<string, unknown>)[key] = raw[key];
    }
  }
  return { item };
}

const LOG_FILTER_KEYS = Object.freeze(['eventType', 'topicId', 'objectType', 'objectId', 'scope', 'limit', 'before', 'after'] as const);

/** 静态枚举查找表（日志事件类型）。 */
const LOG_EVENT_TYPES: Readonly<Record<string, true>> = Object.freeze({
  change_set: true,
  receipt: true,
  compile: true,
  lint_detected: true,
  lint_resolved: true,
  maintenance_started: true,
  maintenance_completed: true,
  query: true,
  source: true
} as const);

/** 静态枚举查找表（日志对象类型）。 */
const LOG_OBJECT_TYPES: Readonly<Record<string, true>> = Object.freeze({
  change_set: true,
  receipt: true,
  wiki_page_version: true,
  health_issue: true,
  maintenance_run: true,
  query_artifact: true,
  source_revision: true
} as const);

type LogFilterResult = { filter: WikiLogFilter } | { reject: WikiActionReject };

function normalizeLogFilter(raw: unknown): LogFilterResult {
  if (!isRecord(raw)) return { reject: { code: 'WIKI_ACTION_INVALID', reason: 'log filter 结构非法。', field: 'filter' } };
  const extra = extraKeyOf(raw, LOG_FILTER_KEYS);
  if (extra !== null) {
    return { reject: { code: 'WIKI_ACTION_EXTRA_FIELD', reason: `log filter 含协议未列出的字段（${extra}），零写。`, field: `filter.${extra}` } };
  }
  // 可变中间类型：校验完成后整体赋值给只读 WikiLogFilter（构造期赋值需可变）。
  const filter: {
    eventType?: KnowledgeLogEventType;
    objectType?: KnowledgeLogObjectType;
    topicId?: string;
    objectId?: string;
    scope?: string;
    limit?: number;
    before?: string;
    after?: string;
  } = {};
  if (raw.eventType !== undefined) {
    if (!isNonEmptyString(raw.eventType) || !LOG_EVENT_TYPES[raw.eventType]) {
      return { reject: { code: 'WIKI_ACTION_INVALID_VALUE', reason: 'log filter.eventType 不在已知事件类型内。', field: 'filter.eventType' } };
    }
    filter.eventType = raw.eventType as KnowledgeLogEventType;
  }
  if (raw.objectType !== undefined) {
    if (!isNonEmptyString(raw.objectType) || !LOG_OBJECT_TYPES[raw.objectType]) {
      return { reject: { code: 'WIKI_ACTION_INVALID_VALUE', reason: 'log filter.objectType 不在已知对象类型内。', field: 'filter.objectType' } };
    }
    filter.objectType = raw.objectType as KnowledgeLogObjectType;
  }
  for (const key of ['topicId', 'objectId', 'scope', 'before', 'after'] as const) {
    if (raw[key] !== undefined) {
      const value = asOptionalNonEmptyString(raw[key]);
      if (value === null) {
        return { reject: { code: 'WIKI_ACTION_INVALID_VALUE', reason: `log filter.${key} 必须是非空字符串。`, field: `filter.${key}` } };
      }
      filter[key] = value;
    }
  }
  if (raw.limit !== undefined) {
    const limit = asIntInRange(raw.limit, 1, WIKI_LOG_LIMIT_MAX);
    if (limit === null) {
      return { reject: { code: 'WIKI_ACTION_BOUND_VIOLATION', reason: `log limit 必须为 1..${WIKI_LOG_LIMIT_MAX} 的整数。`, field: 'filter.limit' } };
    }
    filter.limit = limit;
  }
  return { filter };
}

// ============================================================
// 主校验入口（fail-closed：任何非法 → null manifest + 可读原因）
// ============================================================

const COMMON_KEYS = Object.freeze(['action', 'requestId', 'taskId', 'grantId', 'workerLeaseId'] as const);

export function normalizeWikiActionManifest(raw: unknown): WikiActionParseResult {
  if (!isRecord(raw)) return reject('WIKI_ACTION_INVALID', 'wmb_wiki_action 清单必须是 JSON 对象。');
  if (!isNonEmptyString(raw.action)) return reject('WIKI_ACTION_MISSING_FIELD', 'wmb_wiki_action 清单缺少必填字段 action。', 'action');
  const action = raw.action.trim() as WikiActionKind;
  if (!WIKI_ACTION_KINDS.includes(action)) return reject('WIKI_ACTION_UNKNOWN_ACTION', `未知 Wiki 动作（${action}），零写零执行。`, 'action');
  if (!isNonEmptyString(raw.requestId)) return reject('WIKI_ACTION_MISSING_FIELD', 'wmb_wiki_action 清单缺少必填字段 requestId（幂等键）。', 'requestId');
  if (raw.requestId.length > WIKI_ACTION_REQUEST_ID_MAX) return reject('WIKI_ACTION_BOUND_VIOLATION', `requestId 过长（上限 ${WIKI_ACTION_REQUEST_ID_MAX} 字符）。`, 'requestId');

  const authority: Record<string, string> = {};
  for (const key of ['taskId', 'grantId', 'workerLeaseId'] as const) {
    if (raw[key] !== undefined) {
      const value = asOptionalNonEmptyString(raw[key]);
      if (value === null) return reject('WIKI_ACTION_INVALID_VALUE', `字段 ${key} 必须是非空字符串。`, key);
      authority[key] = value;
    }
  }
  const isWrite = WIKI_WRITE_ACTION_KINDS[action] === true
    && (action !== 'lint' || raw.run === true)
    && (action !== 'maintain' || (raw.subaction !== 'status' && raw.subaction !== 'report'));
  // action 已校验为合法枚举：此处以宽松形状承载公共字段，ok() 出口做判别联合收窄（构造已完成校验）。
  const common: Record<string, unknown> = { action, requestId: raw.requestId.trim(), ...authority };

  switch (action) {
    case 'maintain': {
      const extra = extraKeyOf(raw, [...COMMON_KEYS, 'subaction', 'config']);
      if (extra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `maintain 含协议未列出的字段（${extra}），零写。`, extra);
      if (!isNonEmptyString(raw.subaction) || !WIKI_MAINTAIN_SUBACCTIONS.includes(raw.subaction as WikiMaintainSubaction)) {
        return reject('WIKI_ACTION_MISSING_FIELD', 'maintain 缺少必填字段 subaction（start/status/pause/resume/report）。', 'subaction');
      }
      const subaction = raw.subaction as WikiMaintainSubaction;
      if (subaction !== 'start' && raw.config !== undefined) {
        return reject('WIKI_ACTION_EXTRA_FIELD', 'config 只在 maintain subaction=start 时合法。', 'config');
      }
      let config: WikiMaintainConfig | undefined;
      if (raw.config !== undefined) {
        if (!isRecord(raw.config)) return reject('WIKI_ACTION_INVALID_VALUE', 'maintain config 必须是对象。', 'config');
        const configExtra = extraKeyOf(raw.config, ['batchLimit', 'maxTopicsPerSource', 'stallLimit']);
        if (configExtra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `maintain config 含协议未列出的字段（${configExtra}），零写。`, `config.${configExtra}`);
        const parsed: { batchLimit?: number; maxTopicsPerSource?: number; stallLimit?: number } = {};
        if (raw.config.batchLimit !== undefined) {
          const value = asIntInRange(raw.config.batchLimit, 1, WIKI_MAINTENANCE_BATCH_LIMIT_MAX);
          if (value === null) return reject('WIKI_ACTION_BOUND_VIOLATION', `config.batchLimit 必须为 1..${WIKI_MAINTENANCE_BATCH_LIMIT_MAX} 的整数。`, 'config.batchLimit');
          parsed.batchLimit = value;
        }
        if (raw.config.maxTopicsPerSource !== undefined) {
          const value = asIntInRange(raw.config.maxTopicsPerSource, 1, WIKI_MAINTENANCE_MAX_TOPICS_MAX);
          if (value === null) return reject('WIKI_ACTION_BOUND_VIOLATION', `config.maxTopicsPerSource 必须为 1..${WIKI_MAINTENANCE_MAX_TOPICS_MAX} 的整数。`, 'config.maxTopicsPerSource');
          parsed.maxTopicsPerSource = value;
        }
        if (raw.config.stallLimit !== undefined) {
          const value = asIntInRange(raw.config.stallLimit, 1, WIKI_MAINTENANCE_STALL_LIMIT_MAX);
          if (value === null) return reject('WIKI_ACTION_BOUND_VIOLATION', `config.stallLimit 必须为 1..${WIKI_MAINTENANCE_STALL_LIMIT_MAX} 的整数。`, 'config.stallLimit');
          parsed.stallLimit = value;
        }
        config = parsed;
      }
      if (isWrite && (!common.taskId || !common.grantId || !common.workerLeaseId)) {
        return reject('WIKI_ACTION_AUTHORITY_REQUIRED', 'maintain start/pause/resume 必须携带 taskId、grantId、workerLeaseId，缺失零写。', 'grantId');
      }
            // 构造完成且已通过全部 fail-closed 校验：收窄到判别联合（编译器无法自动证明组合后判别）。
      return ok({ ...common, subaction, ...(config ? { config } : {}) } as unknown as WikiActionManifest);
    }
    case 'ingest': {
      const extra = extraKeyOf(raw, [...COMMON_KEYS, 'items']);
      if (extra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `ingest 含协议未列出的字段（${extra}），零写。`, extra);
      if (!Array.isArray(raw.items)) return reject('WIKI_ACTION_MISSING_FIELD', 'ingest 缺少必填字段 items（数组）。', 'items');
      if (raw.items.length < 1) return reject('WIKI_ACTION_MISSING_FIELD', 'ingest items 不能为空数组。', 'items');
      if (raw.items.length > WIKI_INGEST_BATCH_MAX) {
        return reject('WIKI_ACTION_BATCH_OVER_LIMIT', `ingest 批量超过上限（${WIKI_INGEST_BATCH_MAX} 条），零写。`, 'items');
      }
      if (!common.taskId || !common.grantId || !common.workerLeaseId) {
        return reject('WIKI_ACTION_AUTHORITY_REQUIRED', 'ingest 是业务写入，必须携带 taskId、grantId、workerLeaseId，缺失零写。', 'grantId');
      }
      const items: WikiIngestItem[] = [];
      for (let index = 0; index < raw.items.length; index += 1) {
        const result = normalizeIngestItem(raw.items[index], index);
        if ('reject' in result) return { manifest: null, reject: result.reject };
        items.push(result.item);
      }
            return ok({ ...common, items } as unknown as WikiActionManifest);
    }
    case 'query': {
      const extra = extraKeyOf(raw, [...COMMON_KEYS, 'question', 'wikiVersionRefs', 'noteVersionRefs', 'evidenceRefs']);
      if (extra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `query 含协议未列出的字段（${extra}），零写。`, extra);
      if (raw.question !== undefined && asOptionalNonEmptyString(raw.question) === null) {
        return reject('WIKI_ACTION_INVALID_VALUE', 'query.question 必须是非空字符串。', 'question');
      }
      const lists: Array<[string, string[] | null, string, number]> = [
        ['wikiVersionRefs', asStringArray(raw.wikiVersionRefs, WIKI_QUERY_VERSIONS_MAX), 'wiki_page', 3],
        ['noteVersionRefs', asStringArray(raw.noteVersionRefs, WIKI_QUERY_VERSIONS_MAX), 'knowledge_note', 3],
        ['evidenceRefs', asStringArray(raw.evidenceRefs, WIKI_QUERY_VERSIONS_MAX), 'evidence', 2]
      ];
      for (const [key, value, typePrefix, partCount] of lists) {
        if (raw[key] !== undefined && value === null) {
          return reject('WIKI_ACTION_BOUND_VIOLATION', `${key} 必须是非空字符串数组且每类 ≤ ${WIKI_QUERY_VERSIONS_MAX} 个。`, key);
        }
        if (value !== null) {
          for (const ref of value) {
            if (!isValidVersionRef(ref, typePrefix, partCount)) {
              return reject('WIKI_ACTION_INVALID_VALUE', `${key} 含非法版本引用（必须为 ${typePrefix}:objectId:versionRef 语法）。`, key);
            }
          }
        }
      }
      const anyVersion = lists.some(([, value]) => value !== null && value.length > 0);
      if (!anyVersion) {
        return reject('WIKI_ACTION_QUERY_VERSION_REQUIRED', 'query 必须声明至少一个非空冻结版本引用列表（wikiVersionRefs / noteVersionRefs / evidenceRefs），固定版本必填，零写。', 'wikiVersionRefs');
      }
      const payload: Record<string, unknown> = { ...common };
      if (raw.question !== undefined) payload.question = (raw.question as string).trim();
      for (const [key, value] of lists) {
        if (value !== null && value.length > 0) payload[key] = value;
      }
      return ok(payload as unknown as WikiActionManifest);
    }
    case 'lint': {
      const extra = extraKeyOf(raw, [...COMMON_KEYS, 'run']);
      if (extra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `lint 含协议未列出的字段（${extra}），零写。`, extra);
      if (raw.run !== undefined && typeof raw.run !== 'boolean') return reject('WIKI_ACTION_INVALID_VALUE', 'lint.run 必须是布尔值。', 'run');
      if (raw.run === true && (!common.taskId || !common.grantId || !common.workerLeaseId)) {
        return reject('WIKI_ACTION_AUTHORITY_REQUIRED', 'lint run=true 触发全局 Lint 写入，必须携带 taskId、grantId、workerLeaseId，缺失零写。', 'grantId');
      }
            return ok({ ...common, ...(raw.run !== undefined ? { run: raw.run } : {}) } as unknown as WikiActionManifest);
    }
    case 'search': {
      const extra = extraKeyOf(raw, [...COMMON_KEYS, 'query', 'limit', 'objectTypes']);
      if (extra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `search 含协议未列出的字段（${extra}），零写。`, extra);
      const query = asOptionalNonEmptyString(raw.query);
      if (query === null) return reject('WIKI_ACTION_MISSING_FIELD', 'search 缺少必填字段 query（非空字符串）。', 'query');
      let limit: number | undefined;
      if (raw.limit !== undefined) {
        const parsedLimit = asIntInRange(raw.limit, 1, WIKI_SEARCH_LIMIT_MAX);
        if (parsedLimit === null) return reject('WIKI_ACTION_BOUND_VIOLATION', `search limit 必须为 1..${WIKI_SEARCH_LIMIT_MAX} 的整数。`, 'limit');
        limit = parsedLimit;
      }
      let objectTypes: WikiSearchObjectType[] | undefined;
      if (raw.objectTypes !== undefined) {
        if (!Array.isArray(raw.objectTypes)) return reject('WIKI_ACTION_INVALID_VALUE', 'search objectTypes 必须是数组。', 'objectTypes');
        const parsed: WikiSearchObjectType[] = [];
        for (const item of raw.objectTypes) {
          if (!isNonEmptyString(item) || !WIKI_SEARCH_OBJECT_TYPES.includes(item as WikiSearchObjectType)) {
            return reject('WIKI_ACTION_INVALID_VALUE', 'search objectTypes 含未知对象类型。', 'objectTypes');
          }
          parsed.push(item as WikiSearchObjectType);
        }
        objectTypes = parsed;
      }
            return ok({ ...common, query, ...(limit !== undefined ? { limit } : {}), ...(objectTypes ? { objectTypes } : {}) } as unknown as WikiActionManifest);
    }
    case 'log': {
      const extra = extraKeyOf(raw, [...COMMON_KEYS, 'filter', 'limit', 'cursor']);
      if (extra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `log 含协议未列出的字段（${extra}），零写。`, extra);
      let filter: WikiLogFilter | undefined;
      if (raw.filter !== undefined) {
        const result = normalizeLogFilter(raw.filter);
        if ('reject' in result) return { manifest: null, reject: result.reject };
        filter = result.filter;
      }
      let limit: number | undefined;
      if (raw.limit !== undefined) {
        const parsedLimit = asIntInRange(raw.limit, 1, WIKI_LOG_LIMIT_MAX);
        if (parsedLimit === null) return reject('WIKI_ACTION_BOUND_VIOLATION', `log limit 必须为 1..${WIKI_LOG_LIMIT_MAX} 的整数。`, 'limit');
        limit = parsedLimit;
      }
      let cursor: string | undefined;
      if (raw.cursor !== undefined) {
        const value = asOptionalNonEmptyString(raw.cursor);
        if (value === null || value.length > WIKI_LOG_CURSOR_MAX) return reject('WIKI_ACTION_BOUND_VIOLATION', `log cursor 必须是非空字符串且 ≤ ${WIKI_LOG_CURSOR_MAX} 字符。`, 'cursor');
        cursor = value;
      }
            return ok({ ...common, ...(filter ? { filter } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) } as unknown as WikiActionManifest);
    }
    case 'report': {
      const extra = extraKeyOf(raw, COMMON_KEYS);
      if (extra !== null) return reject('WIKI_ACTION_EXTRA_FIELD', `report 含协议未列出的字段（${extra}），零写。`, extra);
            return ok(common as unknown as WikiActionManifest);
    }
  }
}

// ============================================================
// 围栏提取 / 剥离（与 query-writeback.ts 同款语义：只认最后一个 ```json 围栏）
// ============================================================

/** 回复文本中是否存在 ```json 围栏（无论内容是否合法）。 */
export function hasWikiActionFence(text: string): boolean {
  return /```json\s*[\s\S]*?```/.test(text ?? '');
}

/**
 * 解析 Pi 回复文本中**最后一个** ```json 围栏块里的 `wmb_wiki_action` 清单。
 * 无围栏 / JSON 非法 / 键错 / 结构非法 → reject（调用方零写零执行，绝不从自由文本猜测）。
 */
export function extractWikiActionManifest(text: string): WikiActionParseResult {
  const fences = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) {
    return reject('WIKI_ACTION_MISSING', '本轮回复未携带 wmb_wiki_action 围栏清单，未执行任何 Wiki 动作。');
  }
  const last = fences[fences.length - 1]![1]!;
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    return reject('WIKI_ACTION_INVALID', '回复含 JSON 围栏但 JSON 非法，未执行任何 Wiki 动作。');
  }
  if (!isRecord(value)) return reject('WIKI_ACTION_INVALID', 'wmb_wiki_action 清单必须是 JSON 对象。');
  if (!(WIKI_ACTION_MANIFEST_KEY in value)) {
    return reject('WIKI_ACTION_MISSING', '回复含 JSON 围栏但无 wmb_wiki_action 清单（清单缺失），未执行任何 Wiki 动作。');
  }
  return normalizeWikiActionManifest(value[WIKI_ACTION_MANIFEST_KEY]);
}

/** 从回复文本中移除 wmb_wiki_action 围栏块（用户看到的正文不含协议块；无块则原样返回）。 */
export function stripWikiActionBlock(text: string): string {
  const fences = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!fences.length) return text;
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const fence = fences[index]!;
    try {
      const value: unknown = JSON.parse(fence[1]!);
      if (isRecord(value) && WIKI_ACTION_MANIFEST_KEY in value) {
        const start = fence.index!;
        const end = start + fence[0].length;
        const prefix = text.slice(0, start).replace(/\s+$/, '');
        const suffix = text.slice(end).replace(/^\s+/, '');
        return ((prefix ? `${prefix}\n` : '') + suffix).trim();
      }
    } catch {
      // 非 JSON 围栏：继续向前找
    }
  }
  return text;
}
