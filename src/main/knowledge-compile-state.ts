// WMB-5233：主题 Wiki 编译三态判定（read-model 可复用判定）。
// 诚实空壳语义：区分「尚未编译」「legacy 迁移初始页（零采纳知识）」「真实已编译」。
// 约束：
// - 不新增 schema/表、不扩展 HealthIssue 枚举、不改 DB CHECK；只在读取时从既有字段
//   （版本 flags / body.migration / compileReason / adoptedNoteVersionIds）派生；
// - 不依赖 compile_status 伪造健康：legacy 空壳即使 compile_status='current' 也判为
//   legacy_shell，禁止以 current/全绿误导；
// - Topic/Library/Canvas 三处投影复用同一判定，保证同一对象身份一致。
import type { DatabaseSync } from 'node:sqlite';
import { getWikiPage, listWikiPages } from './knowledge-flywheel.ts';
import type { KnowledgeCompileState } from '../shared/knowledge-compile-state.ts';
import type {
  KnowledgeWikiPageRecord,
  KnowledgeWikiPageVersionRecord
} from '../shared/knowledge-flywheel.ts';

/** 判定来源的派生输入（body 由主进程解析，渲染端零解析）。 */
export type CompileStateSource = Readonly<{
  page: KnowledgeWikiPageRecord | null;
  current: KnowledgeWikiPageVersionRecord | null;
  /** 当前版本正文（编译器 shape；legacy init 写 body.migration/derivedFromLegacy）。 */
  body?: Readonly<Record<string, unknown>> | null;
}>;

function isLegacyShellVersion(current: KnowledgeWikiPageVersionRecord, body: unknown): boolean {
  const flags = Array.isArray(current.flags) ? current.flags.map(String) : [];
  const hasMigrationFlag = flags.includes('migration') || flags.includes('derived-from-legacy');
  const prose = [
    String(current.compileReason ?? ''),
    String(current.changeSummary ?? ''),
    String(current.readableDiff ?? '')
  ].join(' ');
  const hasMigrationProse = /migration|derived-from-legacy|历史初始化/i.test(prose);
  const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const bodyMigration = Boolean(
    bodyRecord && (bodyRecord.migration === true || bodyRecord.derivedFromLegacy === true)
  );
  const adoptedCount = Array.isArray(current.adoptedNoteVersionIds)
    ? current.adoptedNoteVersionIds.filter(Boolean).length
    : 0;
  // 空壳定义：migration/derived 版本且零采纳知识（无任何正式知识可展示）。
  return (hasMigrationFlag || hasMigrationProse || bodyMigration) && adoptedCount === 0;
}

/**
 * 纯函数三态判定（可复用；输入来自任意 read 投影）。
 * - 无 active 页面或无当前版本 → uncompiled；
 * - migration/derived 版本且零采纳知识 → legacy_shell；
 * - 其余（有正式编译版本或已采纳知识）→ compiled。
 */
export function classifyWikiCompileState(source: CompileStateSource): KnowledgeCompileState {
  const { page, current } = source;
  if (!page || !current) return 'uncompiled';
  if (isLegacyShellVersion(current, source.body)) return 'legacy_shell';
  return 'compiled';
}

/**
 * DB 读回单 Topic 编译态：复用既有 active Topic Wiki 页 + 当前版本（无新表/无新查询路径）。
 * 返回 `{ state, page, current }`，投影方按需取 page/current 组装自身字段。
 */
export function getTopicCompileState(
  database: DatabaseSync,
  topicId: string
): CompileStateSource & { state: KnowledgeCompileState } {
  let page: KnowledgeWikiPageRecord | null = null;
  let current: KnowledgeWikiPageVersionRecord | null = null;
  try {
    const pageRows = listWikiPages(database, {
      subjectType: 'topic', subjectId: topicId, pageType: 'topic', lifecycle: 'active', limit: 1
    });
    if (pageRows.items.length > 0) {
      const detail = getWikiPage(database, pageRows.items[0].id);
      if (detail) {
        page = detail.page as unknown as KnowledgeWikiPageRecord;
        current = detail.version as unknown as KnowledgeWikiPageVersionRecord;
      }
    }
  } catch {
    // 精简 fixture 缺 v56 表 → 无正式编译（uncompiled），与既有深链容错语义一致。
  }
  const body = current?.body && typeof current.body === 'object'
    ? current.body as Readonly<Record<string, unknown>>
    : null;
  return { page, current, body, state: classifyWikiCompileState({ page, current, body }) };
}

/**
 * 批量读回 Topic 编译态（有界 topicIds；一次 join 查询，复用同一纯判定）。
 * 供主题列表（listKnowledgeTopics）等列表投影使用；store 不变式：每个 Topic 至多一个
 * active Topic Wiki 页（canonical_key 唯一 + lifecycle），本函数对重复行按 updated_at 取新。
 */
export function listTopicCompileStates(
  database: DatabaseSync,
  topicIds: readonly string[]
): ReadonlyMap<string, KnowledgeCompileState> {
  const ids = [...new Set(topicIds)].filter(Boolean);
  const result = new Map<string, KnowledgeCompileState>();
  if (!ids.length) return result;
  let rows: Array<Record<string, unknown>> = [];
  try {
    const placeholders = ids.map(() => '?').join(',');
    rows = database.prepare(
      `SELECT p.subject_id AS topicId, p.id AS pageId, v.flags_json AS flagsJson,
         v.adopted_note_version_ids_json AS adoptedJson, v.compile_reason AS compileReason,
         v.change_summary AS changeSummary, v.readable_diff AS readableDiff, v.body_json AS bodyJson,
         p.updated_at AS updatedAt
       FROM knowledge_wiki_pages p
       LEFT JOIN knowledge_wiki_page_versions v ON v.id = p.current_version_id
       WHERE p.subject_type = 'topic' AND p.lifecycle = 'active' AND p.subject_id IN (${placeholders})
       ORDER BY p.updated_at DESC, p.id DESC`
    ).all(...ids) as Array<Record<string, unknown>>;
  } catch {
    return result; // 精简 fixture 缺 v56 表 → 全部视为未编译
  }
  for (const row of rows) {
    const topicId = String(row.topicId ?? '');
    if (!topicId || result.has(topicId)) continue;
    if (!row.pageId || row.flagsJson === null) {
      result.set(topicId, 'uncompiled');
      continue;
    }
    let flags: unknown[] = [];
    let adopted: unknown[] = [];
    let body: unknown = null;
    try {
      flags = JSON.parse(String(row.flagsJson ?? '[]')) as unknown[];
      adopted = JSON.parse(String(row.adoptedJson ?? '[]')) as unknown[];
      body = row.bodyJson ? JSON.parse(String(row.bodyJson)) : null;
    } catch {
      // 非法 JSON 视为无版本 → 未编译（保守不谎报已编译）
      result.set(topicId, 'uncompiled');
      continue;
    }
    const currentLike = Object.freeze({
      id: '', pageId: String(row.pageId), versionNumber: 0, title: '',
      body,
      adoptedNoteVersionIds: adopted.map(String),
      businessObjectRefs: Object.freeze([]),
      flags: flags.map(String),
      changeSummary: String(row.changeSummary ?? ''),
      readableDiff: String(row.readableDiff ?? ''),
      compileReason: String(row.compileReason ?? ''),
      creatorNature: 'migration' as const,
      changeSetId: '',
      restoredFromVersionId: null,
      createdAt: ''
    }) as unknown as KnowledgeWikiPageVersionRecord;
    result.set(topicId, classifyWikiCompileState({
      page: { id: String(row.pageId) } as unknown as KnowledgeWikiPageRecord,
      current: currentLike,
      body: body && typeof body === 'object' ? body as Readonly<Record<string, unknown>> : null
    }));
  }
  return result;
}
