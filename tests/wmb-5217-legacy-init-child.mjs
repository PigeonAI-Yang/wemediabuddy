/**
 * WMB-5217 M8 历史初始化契约验收（子进程，真实 SQLite）。
 * Design: docs/spark/2026-08-12-wmb-knowledge-flywheel-migration-delivery-acceptance-design.md §3–§4、§7。
 * 验收（对照 TASKS WMB-5217 Acceptance）：
 *  1) 真实旧 schema fixture：active/watching Topic 得到唯一 Topic Wiki（flags=migration+derived-from-legacy），
 *     dormant/archived 与已有 Wiki 的 Topic 跳过；一 Topic 一 Wiki；
 *  2) verified 高价值 Source / final Review / Method Finding 仅在证据明确时经真实 ChangeSet 创建
 *     Note（unverified/inference，绝不伪造 verified）；弱证据/低价值/反方/去重 → 零 Note 保持 Raw；
 *  3) 可读初始化回执（triggerType='migration'）+ orphan_knowledge 健康问题；保留原对象 ID/数量/贡献发布链；
 *  4) 幂等重跑/可中断恢复/定点重跑：同输入重放零写、state 表快路径、skipped_state_changed 不覆盖、
 *     单 Topic 失败不阻断；无 workspace 身份 → 全量跳过零写；
 *  5) v58 迁移本身：receipt trigger_type 扩展 'migration'，存量回施行原样保留；
 *  6) 迁移前后 legacy 表数量/ID/链路一致（topics/source_items/topic_source_links/content_projects、
 *     content_versions、platform_versions、publications、reviews、method_findings），dossier 读回不变。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, migrations } from '../src/main/db/migrations.ts';
import {
  applyKnowledgeChangeSet,
  getUpdateReceiptByRequest,
  listKnowledgeEvidenceLinks,
  listUpdateReceipts,
  listWikiPages
} from '../src/main/knowledge-flywheel.ts';
import { getKnowledgeTopicDossier } from '../src/main/knowledge.ts';
import {
  LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION,
  legacyInitRequestId,
  runLegacyKnowledgeInit
} from '../src/main/legacy-knowledge-init.ts';

const WORKSPACE = 'ws-legacy-init';
const T = '2026-08-01T00:00:00.000Z';

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

// ============ 0. 种子：真实旧 schema 业务链（无任何知识对象） ============
function seedWorkspace(database) {
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(WORKSPACE, T, T);
  database.prepare("INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, created_at, updated_at, revision) VALUES (?, 'x', '@acct-x', 'X', 'authenticated', ?, ?, 1)").run('acct-x', T, T);
  database.prepare("INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, created_at, updated_at, revision) VALUES (?, 'xiaohongshu', '@acct-xhs', 'XHS', 'authenticated', ?, ?, 1)").run('acct-xhs', T, T);
}

function seedTopic(database, { id, title, summary, status, canonicalKey }) {
  database.prepare(`INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 1, ?, 'theme', ?, ?, ?, ?)`)
    .run(id, title, T, T, canonicalKey ?? title.toLowerCase(), summary ?? null, status, T, T);
}

function seedSource(database, { id, title, summary, priority, verificationStatus, relation, topicId, managementStatus = 'active' }) {
  database.prepare(`INSERT INTO source_items (
      id, feed_id, original_url, canonical_url, content_fingerprint, title, author, published_at, collected_at, summary,
      categories_json, keywords_json, value_judgment, ip_relevance, creation_angles, recommended_platforms_json,
      recommended_formats_json, timeliness, priority, evidence, client_label, verification_status, management_status,
      created_at, updated_at, revision
    ) VALUES (?, NULL, ?, ?, NULL, ?, 'author', ?, ?, ?, '[]', '[]', '价值高', '', '', '[]', '[]', '当日', ?, 'evidence', 'test', ?, ?, ?, ?, 1)`)
    .run(id, `https://example.com/${id}`, `https://example.com/${id}`, title, T, T, summary ?? null, priority ?? null,
      verificationStatus, managementStatus, T, T);
  database.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(topicId, id, relation, T, T);
}

function seedPublicationChain(database, { projectId, topicId, platformVersionId, publicationId, platform, snapshot, snapshotId }) {
  database.prepare(`INSERT INTO content_projects (id, topic_id, title, status, created_at, updated_at, revision)
    VALUES (?, ?, ?, 'completed', ?, ?, 1)`).run(projectId, topicId, `${projectId}-title`, T, T);
  const contentVersionId = `cv-${projectId}`;
  database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, '正文', 1, ?)`)
    .run(contentVersionId, projectId, T);
  database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, 'post', '标题', '正文', '[]', ?, ?, 1)`)
    .run(platformVersionId, projectId, contentVersionId, platform, T, T);
  database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status,
    prepared_assets_json, prepared_evidence_url, external_url, external_id, published_at, created_at, updated_at, revision)
    VALUES (?, ?, 1, ?, ?, ?, 'published', '[]', NULL, ?, ?, ?, ?, ?, 1)`)
    .run(publicationId, platformVersionId, platform, platform === 'x' ? 'acct-x' : 'acct-xhs',
      platform === 'x' ? '@acct-x' : '@acct-xhs', `https://example.com/${publicationId}`, `ext-${publicationId}`, T, T, T);
  if (snapshot) {
    database.prepare(`INSERT INTO publication_metric_snapshots (id, publication_id, scheduled_for, captured_at, source_url, normalized_json, raw_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`)
      .run(snapshotId, publicationId, T, T, `https://example.com/${publicationId}`, JSON.stringify(snapshot), T);
  }
  return { contentVersionId };
}

function seedFinalReview(database, { id, publicationId, summary, findings, keep = ['开头钩子'], stop = ['泛 CTA'], change = ['封面先给结论'] }) {
  database.prepare(`INSERT INTO reviews (id, publication_id, content_version_id, metric_snapshot_ids_json, status, keep_json, stop_json, change_json, summary, created_at, updated_at, finalized_at, revision)
    VALUES (?, ?, 'cv-x', '[]', 'final', ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, publicationId, JSON.stringify(keep), JSON.stringify(stop), JSON.stringify(change), summary ?? null, T, T, T);
  for (const finding of findings) {
    database.prepare(`INSERT INTO method_findings (id, review_id, title, body, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(finding.id, id, finding.title, finding.body ?? '', T, T);
  }
}

/** 预置一个已编译 Topic Wiki（模拟 WMB-5211/5216 已生效的 Topic；初始化应跳过）。 */
function seedExistingWiki(database, topicId) {
  applyKnowledgeChangeSet(database, {
    workspaceId: WORKSPACE, requestId: `seed-wiki:${topicId}`, reason: 'seed existing wiki', triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'system'
  }, {
    wikiPages: [{
      id: `page-seed-${topicId}`, scope: 'global', pageType: 'topic', canonicalKey: `wiki-topic:${topicId}`, title: '已编译话题',
      subjectType: 'topic', subjectId: topicId,
      version: { versionId: `wv-seed-${topicId}`, body: { kind: 'topic-wiki', title: '已编译话题', summary: 's' }, adoptedNoteVersionIds: [], changeSummary: '首版', compileReason: 'seed' }
    }]
  });
}

/** 预置一个 WMB-5216 已生成的 case 观察 Note（final Review 去重目标）。 */
function seedOutcomeCaseNote(database, reviewId) {
  applyKnowledgeChangeSet(database, {
    workspaceId: WORKSPACE, requestId: `seed-case:${reviewId}`, reason: 'seed outcome case', triggerSource: 'review', resolutionMode: 'none', createdBy: 'system'
  }, {
    notes: [{
      id: `note-seed-${reviewId}`, scope: 'global', kind: 'case', canonicalKey: `case:outcome:${reviewId}`, title: '结果案例',
      version: { versionId: `nv-seed-${reviewId}`, statement: '既有 case 观察（WMB-5216）', conclusionStatus: 'unverified', evidenceLevel: 'insufficient', adoptedTopicIds: [], changeType: 'created', changeReason: 'seed' }
    }]
  });
}

function seedLegacyFixture(database) {
  seedWorkspace(database);

  // Topic A：active，混合证据（1 晋升 Source + 4 弱证据 Source + 2 final Review + 2 Findings）
  seedTopic(database, { id: 'topic-a', title: 'AI 自媒体方法论', summary: '关于 AI 自媒体内容方法论的沉淀与复用。', status: 'active', canonicalKey: 'ai-selfmedia-method' });
  seedSource(database, { id: 'src-a1', title: '钩子决定完播', summary: 'Source A：首屏钩子直接决定完播率，前三行应给结论。', priority: 1, verificationStatus: 'verified', relation: 'primary', topicId: 'topic-a' });
  seedSource(database, { id: 'src-a2', title: '低价值资料', summary: '低优先级但有总结。', priority: 4, verificationStatus: 'verified', relation: 'primary', topicId: 'topic-a' });
  seedSource(database, { id: 'src-a3', title: '未核验资料', summary: '未核验但有总结。', priority: 1, verificationStatus: 'pending', relation: 'primary', topicId: 'topic-a' });
  seedSource(database, { id: 'src-a4', title: '无总结资料', summary: null, priority: 1, verificationStatus: 'verified', relation: 'primary', topicId: 'topic-a' });
  seedSource(database, { id: 'src-a5', title: '反方资料', summary: '反方观点有总结。', priority: 2, verificationStatus: 'verified', relation: 'contradicting', topicId: 'topic-a' });
  seedPublicationChain(database, { projectId: 'proj-a1', topicId: 'topic-a', platformVersionId: 'pv-a1', publicationId: 'pub-a1', platform: 'x', snapshot: { views: { status: 'value', value: 1000 } }, snapshotId: 'snap-a1' });
  seedFinalReview(database, { id: 'rev-a1', publicationId: 'pub-a1', summary: '复盘：标题钩子方向正确，需缩短首屏铺垫。', findings: [{ id: 'find-a1', title: '首屏先给结论', body: '首屏钩子决定打开率，前三行给结论。' }] });
  seedFinalReview(database, { id: 'rev-a2', publicationId: 'pub-a1', summary: null, findings: [{ id: 'find-a2', title: '弱发现', body: '' }] });

  // Topic B：watching，supporting Source + 有指标 final Review + 已存在 case Note 的 Review
  seedTopic(database, { id: 'topic-b', title: '小红书图文排版', summary: '小红书图文排版的观察与复用。', status: 'watching', canonicalKey: 'xhs-layout' });
  seedSource(database, { id: 'src-b1', title: '排版节奏', summary: 'Source B：图文排版三秒留人，首图信息密度决定滑动率。', priority: 1, verificationStatus: 'verified', relation: 'supporting', topicId: 'topic-b' });
  seedPublicationChain(database, { projectId: 'proj-b1', topicId: 'topic-b', platformVersionId: 'pv-b1', publicationId: 'pub-b1', platform: 'xiaohongshu', snapshot: { likes: { status: 'value', value: 200 } }, snapshotId: 'snap-b1' });
  seedFinalReview(database, { id: 'rev-b1', publicationId: 'pub-b1', summary: '复盘：首图信息密度提升后滑动率改善。', findings: [{ id: 'find-b1', title: '首图信息密度', body: '首图信息密度决定滑动率，单图结论优先。' }] });
  seedPublicationChain(database, { projectId: 'proj-b2', topicId: 'topic-b', platformVersionId: 'pv-b2', publicationId: 'pub-b2', platform: 'xiaohongshu', snapshot: null, snapshotId: 'snap-b2' });
  seedFinalReview(database, { id: 'rev-b2', publicationId: 'pub-b2', summary: '既有回流的复盘。', findings: [] });
  seedOutcomeCaseNote(database, 'rev-b2');

  // Topic C：dormant（inactive，不得初始化）；Topic D：archived（inactive）
  seedTopic(database, { id: 'topic-c', title: '休眠话题', summary: '休眠话题总结。', status: 'dormant', canonicalKey: 'dormant-topic' });
  seedSource(database, { id: 'src-c1', title: '休眠来源', summary: '休眠来源总结。', priority: 1, verificationStatus: 'verified', relation: 'primary', topicId: 'topic-c' });
  seedTopic(database, { id: 'topic-d', title: '归档话题', summary: '归档话题总结。', status: 'archived', canonicalKey: 'archived-topic' });

  // Topic E：已有编译器 Wiki（跳过）；Topic F：弱证据零 Note；Topic G：孤岛（orphan 健康问题）
  seedTopic(database, { id: 'topic-e', title: '已编译话题', summary: '已由编译器接管的话题。', status: 'active', canonicalKey: 'compiled-topic' });
  seedExistingWiki(database, 'topic-e');
  seedTopic(database, { id: 'topic-f', title: '弱证据话题', summary: '只有弱证据的话题。', status: 'active', canonicalKey: 'weak-topic' });
  seedSource(database, { id: 'src-f1', title: '无总结', summary: null, priority: 2, verificationStatus: 'verified', relation: 'primary', topicId: 'topic-f' });
  seedSource(database, { id: 'src-f2', title: '未核验', summary: '未核验总结。', priority: 1, verificationStatus: 'pending', relation: 'primary', topicId: 'topic-f' });
  seedTopic(database, { id: 'topic-g', title: '孤岛话题', summary: '没有任何来源证据的话题。', status: 'active', canonicalKey: 'orphan-topic' });
}

function snapshotLegacy(database) {
  return {
    topics: count(database, 'topics'),
    sources: count(database, 'source_items'),
    links: count(database, 'topic_source_links'),
    projects: count(database, 'content_projects'),
    contentVersions: count(database, 'content_versions'),
    platformVersions: count(database, 'platform_versions'),
    publications: count(database, 'publications'),
    reviews: count(database, 'reviews'),
    findings: count(database, 'method_findings'),
    metrics: count(database, 'publication_metric_snapshots')
  };
}

// ============ 1. 主库：完整历史初始化验收 ============
const rootDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5217-init-'));
const database = migrateDatabase(path.join(rootDir, 'wmb.db'));
seedLegacyFixture(database);
const legacyBefore = snapshotLegacy(database);
const topicIdsBefore = database.prepare('SELECT id FROM topics ORDER BY id').all().map((row) => row.id);

// ---- A. 定点首跑（模拟可中断后的续跑入口：只初始化 topic-a 与 dormant topic-c） ----
const partial = runLegacyKnowledgeInit(database, { topicIds: ['topic-a', 'topic-c'] });
check('A 定点首跑：topic-a initialized、topic-c skipped_inactive',
  partial.topics.length === 2
  && partial.topics.find((t) => t.topicId === 'topic-a')?.status === 'initialized'
  && partial.topics.find((t) => t.topicId === 'topic-c')?.status === 'skipped_inactive');
const topicA = partial.topics.find((t) => t.topicId === 'topic-a');

const pagesA = listWikiPages(database, { scope: 'global', pageType: 'topic', subjectType: 'topic', subjectId: 'topic-a' });
check('A 唯一 Topic Wiki 页（topic-a 恰好 1 个 active）', pagesA.items.length === 1 && pagesA.items[0].lifecycle === 'active');
const pageA = database.prepare(`SELECT id, canonical_key AS canonicalKey, subject_type AS subjectType, subject_id AS subjectId,
  compile_status AS compileStatus, current_version_id AS currentVersionId FROM knowledge_wiki_pages WHERE subject_type='topic' AND subject_id='topic-a'`).get();
const versionA = database.prepare(`SELECT version_number AS versionNumber, flags_json AS flags, body_json AS bodyJson, creator_nature AS creatorNature,
  change_summary AS changeSummary, adopted_note_version_ids_json AS adopted FROM knowledge_wiki_page_versions WHERE page_id = ?`).get(pageA.id);
const flagsA = JSON.parse(versionA.flags);
const bodyA = JSON.parse(versionA.bodyJson);
check('A Wiki v1 标记 migration + derived-from-legacy', versionA.versionNumber === 1
  && flagsA.includes('migration') && flagsA.includes('derived-from-legacy')
  && versionA.creatorNature === 'migration');
check('A Wiki 正文 kind=topic-wiki 且 migration/derivedFromLegacy 标记、asOf 为 legacy 时间',
  bodyA.kind === 'topic-wiki' && bodyA.migration === true && bodyA.derivedFromLegacy === true
  && bodyA.asOf === T && bodyA.topicId === 'topic-a' && bodyA.versionCount === 3);

check('A 晋升计数：Source 1 / Review 1 / Finding 1（弱证据全保持 Raw）',
  topicA.counts.sourcesTotal === 5 && topicA.counts.sourcesPromoted === 1 && topicA.counts.sourcesKeptRaw === 4
  && topicA.counts.reviewsFinal === 2 && topicA.counts.reviewsPromoted === 1 && topicA.counts.reviewsKeptRaw === 1
  && topicA.counts.findingsTotal === 2 && topicA.counts.findingsPromoted === 1 && topicA.counts.findingsKeptRaw === 1
  && topicA.counts.notesCreated === 3 && topicA.counts.evidenceLinks === 3 && topicA.counts.wikiPagesCompiled === 1);

check('A keptRaw 明细（弱证据原因完整可读）',
  topicA.keptRaw.includes('raw:source:src-a2:low_priority')
  && topicA.keptRaw.includes('raw:source:src-a3:not_verified')
  && topicA.keptRaw.includes('raw:source:src-a4:no_summary')
  && topicA.keptRaw.includes('raw:source:src-a5:unlinked_relation')
  && topicA.keptRaw.includes('raw:review:rev-a2:no_summary')
  && topicA.keptRaw.includes('raw:finding:find-a2:weak_evidence'));

const notesA = database.prepare(`SELECT n.id, n.kind, n.canonical_key AS canonicalKey, nv.conclusion_status AS conclusionStatus, nv.evidence_level AS evidenceLevel, nv.change_type AS changeType, nv.statement
  FROM knowledge_notes n JOIN knowledge_note_versions nv ON nv.id = n.current_version_id
  WHERE n.canonical_key IN ('claim:legacy:src-a1','case:outcome:rev-a1','method:legacy:find-a1') ORDER BY n.id`).all();
check('A 晋升 Note 形状（claim/case/method 各一；未验证/推断状态，零伪造 verified）',
  notesA.length === 3
  && notesA.some((n) => n.canonicalKey === 'claim:legacy:src-a1' && n.kind === 'claim' && n.conclusionStatus === 'unverified' && n.evidenceLevel === 'single')
  && notesA.some((n) => n.canonicalKey === 'case:outcome:rev-a1' && n.kind === 'case' && n.conclusionStatus === 'unverified' && n.evidenceLevel === 'outcome_observed')
  && notesA.some((n) => n.canonicalKey === 'method:legacy:find-a1' && n.kind === 'method' && n.conclusionStatus === 'inference' && n.evidenceLevel === 'outcome_observed')
  && notesA.every((n) => !['supported', 'contradicted', 'disputed'].includes(n.conclusionStatus)));
const evidenceA = database.prepare('SELECT evidence_object_type AS t, evidence_object_id AS id, relation, source_nature AS nature FROM knowledge_evidence_links ORDER BY evidence_object_id').all();
check('A 证据链：source 证据（primary→primary_source）+ review 证据（review 性质）',
  evidenceA.length === 3
  && evidenceA.some((e) => e.t === 'source' && e.id === 'src-a1' && e.nature === 'primary_source' && e.relation === 'supports')
  && evidenceA.some((e) => e.t === 'review' && e.id === 'rev-a1' && e.nature === 'review' && e.relation === 'supports'));

const receiptA = getUpdateReceiptByRequest(database, WORKSPACE, legacyInitRequestId('topic-a'));
check('A 可读初始化回执（triggerType=migration、requestId、计数、影响、keptRaw）',
  Boolean(receiptA) && receiptA.triggerType === 'migration'
  && receiptA.requestId === legacyInitRequestId('topic-a')
  && receiptA.counts.notesCreated === 3 && receiptA.counts.sourcesKeptRaw === 4
  && receiptA.affectedTopics.length === 1 && receiptA.affectedTopics[0] === 'topic-a'
  && receiptA.wikiPageVersions.length === 1
  && receiptA.impact.topicId === 'topic-a' && receiptA.impact.initializedFrom === 'legacy'
  && receiptA.impact.migrationVersion === LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION
  && receiptA.failures.length === 6);
check('A 回执可按 triggerType=migration 过滤读回', listUpdateReceipts(database, { triggerType: 'migration' }).items.length === 1);
check('A 初始化 ChangeSet 触发源/创建者 = migration（无伪造历史）',
  database.prepare('SELECT trigger_source AS t, created_by AS c, resolution_mode AS r FROM knowledge_change_sets WHERE request_id = ?').get(legacyInitRequestId('topic-a')).t === 'migration'
  && database.prepare('SELECT trigger_source AS t, created_by AS c, resolution_mode AS r FROM knowledge_change_sets WHERE request_id = ?').get(legacyInitRequestId('topic-a')).c === 'migration');
check('A 状态表 checkpoint 落库（initialized + 原子引用）',
  database.prepare(`SELECT status, wiki_page_id AS pageId, change_set_id AS csId, receipt_id AS rId, migration_version AS mv
    FROM knowledge_legacy_init_state WHERE topic_id = 'topic-a'`).get().status === 'initialized'
  && database.prepare(`SELECT wiki_page_id AS pageId FROM knowledge_legacy_init_state WHERE topic_id = 'topic-a'`).get().pageId === pageA.id
  && database.prepare(`SELECT migration_version AS mv FROM knowledge_legacy_init_state WHERE topic_id = 'topic-a'`).get().mv === LEGACY_KNOWLEDGE_INIT_MIGRATION_VERSION);

// ---- B. 全量续跑（可中断恢复：A 已初始化跳过，B 首初始化，E 已有 Wiki 跳过） ----
const full = runLegacyKnowledgeInit(database);
check('B 全量续跑：A already_initialized、B initialized、E skipped_already_has_wiki、F/G initialized',
  full.topics.find((t) => t.topicId === 'topic-a')?.status === 'already_initialized'
  && full.topics.find((t) => t.topicId === 'topic-b')?.status === 'initialized'
  && full.topics.find((t) => t.topicId === 'topic-e')?.status === 'skipped_already_has_wiki'
  && full.topics.find((t) => t.topicId === 'topic-f')?.status === 'initialized'
  && full.topics.find((t) => t.topicId === 'topic-g')?.status === 'initialized'
  && !full.topics.some((t) => t.topicId === 'topic-c' || t.topicId === 'topic-d'));
check('B 无 workspace 的 skipped_no_workspace 未出现（本库已绑定）', !full.topics.some((t) => t.status === 'skipped_no_workspace'));
check('B totals 汇总正确', full.totals.topics === 5 && full.totals.alreadyInitialized === 1 && full.totals.initialized === 3
  && full.totals.skipped === 1 && full.totals.failed === 0 && full.ok === true);

const pagesB = listWikiPages(database, { scope: 'global', pageType: 'topic', limit: 50 });
check('B 一 Topic 一 Wiki：topic-a/b/e/f/g 各恰好 1 个 active Topic Wiki（C/D 无）',
  pagesB.items.filter((p) => p.subjectId === 'topic-a').length === 1
  && pagesB.items.filter((p) => p.subjectId === 'topic-b').length === 1
  && pagesB.items.filter((p) => p.subjectId === 'topic-e').length === 1
  && pagesB.items.filter((p) => p.subjectId === 'topic-f').length === 1
  && pagesB.items.filter((p) => p.subjectId === 'topic-g').length === 1
  && pagesB.items.filter((p) => p.subjectId === 'topic-c' || p.subjectId === 'topic-d').length === 0);

const topicB = full.topics.find((t) => t.topicId === 'topic-b');
check('B topic-b 晋升：supporting Source + 有指标 Review + Finding；已回流 Review 去重',
  topicB.counts.sourcesPromoted === 1 && topicB.counts.reviewsPromoted === 1 && topicB.counts.reviewsKeptRaw === 1
  && topicB.counts.findingsPromoted === 1
  && topicB.keptRaw.includes('raw:review:rev-b2:already_exists'));
check('B 已回流 Review 不重复创建 case Note', count(database, 'knowledge_notes', "canonical_key = 'case:outcome:rev-b2'") === 1);
check('B 弱证据 Topic（topic-f）零 Note：Wiki 建、Note 零、keptRaw 两条',
  full.topics.find((t) => t.topicId === 'topic-f').counts.notesCreated === 0
  && full.topics.find((t) => t.topicId === 'topic-f').counts.wikiPagesCompiled === 1
  && full.topics.find((t) => t.topicId === 'topic-f').keptRaw.length === 2);
check('B 孤岛 Topic（topic-g）零 Note + orphan_knowledge 健康问题',
  full.topics.find((t) => t.topicId === 'topic-g').counts.notesCreated === 0
  && Boolean(database.prepare(`SELECT 1 FROM knowledge_health_issues hi JOIN knowledge_wiki_pages p ON p.id = hi.affected_object_id
      WHERE hi.issue_type='orphan_knowledge' AND p.subject_id='topic-g'`).get()));
check('B 弱证据 topic-f 不产生 orphan 健康问题（有来源证据）',
  !database.prepare(`SELECT 1 FROM knowledge_health_issues hi JOIN knowledge_wiki_pages p ON p.id = hi.affected_object_id
      WHERE hi.issue_type='orphan_knowledge' AND p.subject_id='topic-f'`).get());

// ---- C. 幂等重跑：零新增行、同一对象 ----
const changeSetsBefore = count(database, 'knowledge_change_sets');
const receiptsBefore = count(database, 'knowledge_update_receipts');
const wikiVersionsBefore = count(database, 'knowledge_wiki_page_versions');
const rerun = runLegacyKnowledgeInit(database);
check('C 重跑零增量（ChangeSet/Receipt/Wiki 版本不变；全部 already_initialized/skipped）',
  count(database, 'knowledge_change_sets') === changeSetsBefore
  && count(database, 'knowledge_update_receipts') === receiptsBefore
  && count(database, 'knowledge_wiki_page_versions') === wikiVersionsBefore
  && rerun.totals.alreadyInitialized === 4 && rerun.totals.skipped === 1);

// ---- D. 迁移前后 legacy 不变量：数量/ID/链路一致 ----
const legacyAfter = snapshotLegacy(database);
check('D legacy 表数量与 ID 完全不变',
  JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter)
  && JSON.stringify(database.prepare('SELECT id FROM topics ORDER BY id').all().map((row) => row.id)) === JSON.stringify(topicIdsBefore));
const chain = database.prepare(`SELECT r.id AS reviewId, p.id AS pubId, pv.id AS pvId, cv.project_id AS projectId, cp.topic_id AS topicId
  FROM reviews r JOIN publications p ON p.id = r.publication_id
  JOIN platform_versions pv ON pv.id = p.platform_version_id
  JOIN content_versions cv ON cv.id = pv.content_version_id
  JOIN content_projects cp ON cp.id = cv.project_id WHERE r.status='final' ORDER BY r.id`).all();
check('D 贡献/发布链仍可查询（review→pub→pv→cv→project→topic 六环）',
  chain.length === 4 && chain.some((row) => row.reviewId === 'rev-a1' && row.pubId === 'pub-a1' && row.topicId === 'topic-a'));
const dossierA = getKnowledgeTopicDossier(database, { topicId: 'topic-a' });
check('D dossier 读回不变（4 sources + 1 counter_evidence + reviews/method_findings/content_history/metrics）',
  dossierA.counts.sources === 4 && dossierA.counts.counter_evidence === 1
  && dossierA.counts.reviews === 2 && dossierA.counts.method_findings === 2
  && dossierA.counts.content_history === 1 && dossierA.counts.metrics === 1);

// ---- E. 定点重跑 / 中断恢复语义 ----
const resume = runLegacyKnowledgeInit(database, { topicIds: ['topic-a'] });
check('E 定点重跑（中断恢复续跑）不重做已初始化 Topic', resume.topics.length === 1 && resume.topics[0].status === 'already_initialized');

// ---- F. state 行缺失 + 同输入 → store 重放补齐（零增量） ----
database.prepare("DELETE FROM knowledge_legacy_init_state WHERE topic_id = 'topic-a'").run();
const replayBefore = snapshotLegacy(database);
const replay = runLegacyKnowledgeInit(database, { topicIds: ['topic-a'] });
check('F 同输入重放：status=replayed、零增量、状态行补齐',
  replay.topics[0].status === 'replayed'
  && replay.topics[0].changeSetId === receiptA.changeSetId
  && count(database, 'knowledge_change_sets') === changeSetsBefore
  && database.prepare("SELECT status FROM knowledge_legacy_init_state WHERE topic_id = 'topic-a'").get().status === 'initialized'
  && JSON.stringify(snapshotLegacy(database)) === JSON.stringify(replayBefore));

// ---- G. 状态行缺失 + 异输入 → skipped_state_changed，不覆盖已发布初始 Wiki ----
database.prepare("DELETE FROM knowledge_legacy_init_state WHERE topic_id = 'topic-a'").run();
database.prepare("UPDATE topics SET summary = '修改后的总结', revision = revision + 1, updated_at = ? WHERE id = 'topic-a'").run(T);
const changed = runLegacyKnowledgeInit(database, { topicIds: ['topic-a'] });
check('G 异输入跳过：skipped_state_changed、零新增 Wiki 版本、零新 ChangeSet',
  changed.topics[0].status === 'skipped_state_changed'
  && count(database, 'knowledge_wiki_page_versions') === wikiVersionsBefore
  && count(database, 'knowledge_change_sets') === changeSetsBefore
  && database.prepare("SELECT status FROM knowledge_legacy_init_state WHERE topic_id = 'topic-a'").get().status === 'skipped_state_changed');

// ---- H. 无 workspace 身份（精简 fixture/历史库）→ 全量跳过零写 ----
const noWs = migrateDatabase(path.join(rootDir, 'no-ws.db'));
seedTopic(noWs, { id: 'topic-nw', title: '无工作空间话题', summary: 's', status: 'active', canonicalKey: 'no-ws-topic' });
const skipRun = runLegacyKnowledgeInit(noWs);
check('H 无 workspace：全量 skipped_no_workspace 且零知识写',
  skipRun.ok === true && skipRun.topics.length === 1 && skipRun.topics[0].status === 'skipped_no_workspace'
  && count(noWs, 'knowledge_change_sets') === 0 && count(noWs, 'knowledge_notes') === 0
  && count(noWs, 'knowledge_wiki_pages') === 0 && count(noWs, 'knowledge_legacy_init_state') === 0);
noWs.close();

// ---- I. 跨 Topic 来源去重：同一 Source 链接两个 Topic，第二个保持 Raw ----
seedTopic(database, { id: 'topic-h', title: '共享来源话题', summary: '与 topic-a 共享 src-a1 的话题。', status: 'active', canonicalKey: 'shared-source-topic' });
database.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at) VALUES ('topic-h', 'src-a1', 'primary', ?, ?)`).run(T, T);
const shared = runLegacyKnowledgeInit(database, { topicIds: ['topic-h'] });
check('I 共享 Source 去重：topic-h 零晋升 Note，src-a1 保持 Raw 不重复创建',
  shared.topics[0].status === 'initialized' && shared.topics[0].counts.notesCreated === 0
  && shared.topics[0].keptRaw.includes('raw:source:src-a1:already_exists')
  && count(database, 'knowledge_notes', "canonical_key = 'claim:legacy:src-a1'") === 1);

database.close();

// ============ 2. v58 迁移本身：receipt 表重建保留存量行 + trigger_type 扩展 ============
const v57Dir = path.join(rootDir, 'v57.db');
const v57db = new DatabaseSync(v57Dir);
v57db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
for (const migration of migrations) {
  if (migration.version >= 58) continue;
  if (v57db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version)) continue;
  v57db.exec('PRAGMA foreign_keys = OFF');
  v57db.exec('BEGIN IMMEDIATE');
  try {
    v57db.exec(migration.sql);
    v57db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, T);
    v57db.exec('COMMIT');
  } catch (error) {
    v57db.exec('ROLLBACK');
    throw error;
  }
  v57db.exec('PRAGMA foreign_keys = ON');
}
v57db.exec('PRAGMA foreign_keys = ON');
v57db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-v57', ?, ?, 1)").run(T, T);
v57db.prepare(`INSERT INTO knowledge_change_sets (id, workspace_id, request_id, input_hash, reason, trigger_source, resolution_mode, created_by, created_at)
  VALUES ('cs-v57', 'ws-v57', 'legacy-r1', 'hash', 'before v58', 'ingest', 'none', 'system', ?)`).run(T);
v57db.prepare(`INSERT INTO knowledge_update_receipts (id, workspace_id, change_set_id, trigger_type, request_id, summary, counts_json,
  affected_topics_json, affected_entities_json, affected_methods_json, affected_syntheses_json, wiki_page_versions_json,
  impact_json, auto_resolutions_json, retained_disputes_json, failures_json, created_by, created_at)
  VALUES ('rpt-v57', 'ws-v57', 'cs-v57', 'ingest', 'legacy-r1', 'v57 receipt', '{"n":1}', '[]', '[]', '[]', '[]', '[]', '{}', '[]', '[]', '[]', 'system', ?)`).run(T);
v57db.close();
const upgraded = migrateDatabase(v57Dir);
const preserved = upgraded.prepare(`SELECT id, workspace_id AS ws, change_set_id AS cs, trigger_type AS tt, request_id AS rq, summary FROM knowledge_update_receipts WHERE id = 'rpt-v57'`).get();
check('J v58 重建 receipt 表保留存量行（内容逐字段原样）',
  Boolean(preserved) && preserved.id === 'rpt-v57' && preserved.ws === 'ws-v57' && preserved.cs === 'cs-v57'
  && preserved.tt === 'ingest' && preserved.rq === 'legacy-r1' && preserved.summary === 'v57 receipt');
check('J v58 后 receipt 允许 trigger_type=migration',
  upgraded.prepare(`INSERT INTO knowledge_update_receipts (id, workspace_id, change_set_id, trigger_type, request_id, summary, counts_json,
    affected_topics_json, affected_entities_json, affected_methods_json, affected_syntheses_json, wiki_page_versions_json,
    impact_json, auto_resolutions_json, retained_disputes_json, failures_json, created_by, created_at)
    VALUES ('rpt-mig', 'ws-v57', 'cs-v57', 'migration', 'legacy-mig', 'migration receipt', '{}', '[]', '[]', '[]', '[]', '[]', '{}', '[]', '[]', '[]', 'migration', ?)`).run(T) !== undefined);
check('J v58 后 knowledge_legacy_init_state 可用且主键唯一',
  upgraded.prepare(`INSERT INTO knowledge_legacy_init_state (topic_id, workspace_id, scope, migration_version, status, wiki_page_id, change_set_id, receipt_id, last_error, completed_at)
    VALUES ('t1', 'ws-v57', 'global', 58, 'initialized', NULL, 'cs-v57', 'rpt-mig', NULL, ?)`).run(T) !== undefined
  && upgraded.prepare(`INSERT OR IGNORE INTO knowledge_legacy_init_state (topic_id, workspace_id, scope, migration_version, status, completed_at) VALUES ('t1', 'ws-v57', 'global', 58, 'initialized', ?)`).run(T).changes === 0);
upgraded.close();

console.log(`WMB-5217 child: ${checks} checks passed`);
await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
