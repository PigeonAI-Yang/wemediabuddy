/**
 * WMB-5216 M7 结果回流契约验收（子进程，真实 SQLite）。
 * Design: docs/spark/2026-08-12-wmb-outcome-feedback-knowledge-health-design.md §2–§5/§12。
 * 验收：
 *  1) final Review 幂等回流恰好一次：case 观察 Note（evidence=review+publication+metric_snapshot）、
 *     回执（triggerType=review、affectedTopics）、发布时固定 Usage 血缘 pinned 到版本；
 *  2) 重放零增量（同 requestId + 同输入 → replay=true，同 ChangeSet）；
 *  3) 单次高表现不生成因果 Method、不建 pattern（只观察）；
 *  4) 重复同向结果（同 topic + 同 platform/audience + 同 keep ≥ 2）才限域建/强化
 *     creative_pattern（inference + corroborated + appliesTo 平台/受众/时间窗）；跨平台/受众不聚合；
 *  5) usage/version lineage：结果版本固定发布时版本，后续 Wiki 更新不改写历史；
 *  6) 失败零部分写：快照损坏 → 整个 final Review 保存回滚（review/ChangeSet/Note/Receipt 全无）；
 *  7) 稳定 requestId 同输入重放、异输入 REQUEST_REPLAY_CONFLICT 且零部分写；
 *  8) 无 workspace 身份（历史库/精简 fixture）→ 回流跳过、不失败。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { applyKnowledgeChangeSet, getUpdateReceiptByRequest, getKnowledgeNoteVersion, getWikiPageVersion } from '../src/main/knowledge-flywheel.ts';
import { createKnowledgeUsage } from '../src/main/knowledge-usage.ts';
import { saveReview } from '../src/main/reviews.ts';
import { flowBackOutcome, outcomeFeedbackRequestId } from '../src/main/outcome-feedback.ts';

const WORKSPACE = 'ws-outcome';
const rootDir = await mkdtemp(path.join(os.tmpdir(), 'wmb-5216-of-db-'));
const openDbs = [];
function freshDb(name) {
  const db = migrateDatabase(path.join(rootDir, `${name}.db`));
  openDbs.push(db);
  return db;
}

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
async function expectError(label, fn, code) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    if (code) {
      const actual = error?.code ?? '';
      if (actual !== code) throw new Error(`FAIL [${checks}] ${label} — 期望错误码 ${code}，实际 ${actual ?? error?.message}`);
    }
    return;
  }
  throw new Error(`FAIL [${checks}] ${label} — 未抛出 ${code ?? '错误'}`);
}
function count(database, table) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
function countWhere(database, table, where) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${where}`).get().count);
}
function csMeta(requestId, reason = '测试') {
  return { workspaceId: WORKSPACE, requestId, reason, triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'system' };
}
function usageMeta(requestId, reason = '测试血缘') {
  return { workspaceId: WORKSPACE, requestId, reason, createdBy: 'background_agent' };
}

// ============ 0. 种子：业务链 + 正式知识 + 发布时固定 Usage 血缘 ============
function seedKnowledgeBase(database, { workspaceId = WORKSPACE } = {}) {
  const stamp = new Date().toISOString();
  if (workspaceId) {
    database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
      .run(workspaceId, stamp, stamp);
  }
  database.prepare('INSERT INTO topics (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)').run('topic-1', '主题A', stamp, stamp);
  database.prepare('INSERT INTO content_projects (id, topic_id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 1)')
    .run('proj-1', 'topic-1', '项目A', stamp, stamp);
  database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 1, ?)')
    .run('cv-1', 'proj-1', '核心正文V1', stamp);
  for (const [id, platform] of [['acct-x', 'x'], ['acct-xhs', 'xiaohongshu']]) {
    database.prepare(`INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, 'authenticated', ?, ?, 1)`).run(id, platform, `@${id}`, id, stamp, stamp);
  }
  if (!workspaceId) return { noteV1: null, pageV1: null };
  applyKnowledgeChangeSet(database, csMeta('cs-seed-base'), {
    notes: [{
      id: 'note-1', scope: 'global', kind: 'claim', canonicalKey: 'acme-claim', title: '核心事实',
      version: { versionId: 'nv-1', statement: '核心事实：Acme 发布新产品', conclusionStatus: 'supported', evidenceLevel: 'primary' }
    }],
    wikiPages: [{
      id: 'wiki-1', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-topic:topic-1', title: '主题A',
      subjectType: 'topic', subjectId: 'topic-1',
      version: { versionId: 'wv-1', body: { kind: 'topic-wiki', title: '主题A', summary: 's' }, adoptedNoteVersionIds: ['nv-1'], changeSummary: '首版', compileReason: 'seed' }
    }]
  });
  const noteV1 = database.prepare('SELECT current_version_id AS c FROM knowledge_notes WHERE id = ?').get('note-1').c;
  const pageV1 = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get('wiki-1').c;
  return { noteV1, pageV1 };
}

function seedCorePackage(database, lineage) {
  createKnowledgeUsage(database, usageMeta('usage:core_draft:cv-1'), {
    package: {
      scope: 'global', stage: 'core_draft', projectId: 'proj-1', topicId: 'topic-1',
      wikiPageVersionIds: [lineage.pageV1], noteVersionIds: [lineage.noteV1], compilerSchemaVersion: 'v1'
    },
    records: [{ outputObjectType: 'content_version', outputObjectId: 'cv-1', versionKind: 'wiki_page', versionId: lineage.pageV1, usageKind: 'reasoning_basis', actor: 'ai' }]
  });
}

function seedPublication(database, input) {
  const stamp = input.publishedAt ?? new Date().toISOString();
  const platform = input.platform;
  const accountId = platform === 'xiaohongshu' ? 'acct-xhs' : 'acct-x';
  database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
    VALUES (?, 'proj-1', 'cv-1', ?, 'post', '标题', '正文', '[]', ?, ?, 1)`)
    .run(input.platformVersionId, platform, stamp, stamp);
  database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status,
    prepared_assets_json, external_url, external_id, published_at, created_at, updated_at, revision)
    VALUES (?, ?, 1, ?, ?, ?, 'published', '[]', ?, ?, ?, ?, ?, 1)`)
    .run(input.id, input.platformVersionId, platform, accountId, `@${accountId}`, `https://example.com/${input.id}`, `ext-${input.id}`, stamp, stamp, stamp);
  const snapshotId = `snap-${input.id}`;
  database.prepare(`INSERT INTO publication_metric_snapshots (id, publication_id, scheduled_for, captured_at, source_url, normalized_json, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(snapshotId, input.id, stamp, stamp, `https://example.com/${input.id}`, JSON.stringify(input.snapshot ?? {}), '{}', stamp);
  if (input.withUsage !== false) {
    createKnowledgeUsage(database, usageMeta(`usage:platform_adaptation:${input.platformVersionId}`), {
      package: {
        scope: 'global', stage: 'platform_adaptation', projectId: 'proj-1', topicId: 'topic-1',
        platform, audience: input.audience ?? '', format: 'post',
        wikiPageVersionIds: [input.lineage.pageV1], noteVersionIds: [input.lineage.noteV1], compilerSchemaVersion: 'v1'
      },
      records: [{ outputObjectType: 'platform_version', outputObjectId: input.platformVersionId, versionKind: 'wiki_page', versionId: input.lineage.pageV1, usageKind: 'structure_pattern', actor: 'user' }]
    });
  }
  return { snapshotId };
}

function finalizeReview(database, input) {
  const result = saveReview(database, {
    publicationId: input.publicationId,
    metricSnapshotIds: input.metricSnapshotIds,
    keep: input.keep ?? ['开头钩子'],
    stop: input.stop ?? ['泛 CTA'],
    change: input.change ?? ['封面先给结论'],
    summary: input.summary ?? '复盘摘要',
    status: 'final',
    findings: input.findings ?? [{ title: '先给结论', body: '封面先给结论' }]
  });
  if (!result.ok) throw new Error(`finalizeReview 失败：${result.error?.code} ${result.error?.message}`);
  return result.data;
}

function latestNoteVersion(database, noteId) {
  const row = database.prepare(`SELECT id, version_number AS versionNumber FROM knowledge_note_versions WHERE note_id = ? ORDER BY version_number DESC LIMIT 1`).get(noteId);
  return row ? getKnowledgeNoteVersion(database, row.id) : null;
}

// ============ 1. final Review 一次回流：case + 证据 + 回执 + 血缘（无 Method/Pattern） ============
{
  const database = freshDb('a-once');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);
  seedPublication(database, {
    id: 'pub-1', platformVersionId: 'pv-1', platform: 'x', audience: '在英华人', lineage,
    snapshot: { views: { status: 'value', value: 1000 }, likes: { status: 'value', value: 200 } }
  });
  const review = finalizeReview(database, { publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'] });
  const reviewId = review.id;

  check('恰好一条 outcome ChangeSet（trigger=review, createdBy=system）', countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'") === 1
    && database.prepare("SELECT trigger_source AS t, created_by AS c FROM knowledge_change_sets WHERE request_id = ?").get(`outcome:review:${reviewId}`).t === 'review'
    && database.prepare("SELECT created_by AS c FROM knowledge_change_sets WHERE request_id = ?").get(`outcome:review:${reviewId}`).c === 'system');
  check('requestId 契约 = outcome:review:{reviewId}', outcomeFeedbackRequestId(reviewId) === `outcome:review:${reviewId}`);

  const caseNote = database.prepare('SELECT id, kind, canonical_key AS canonicalKey FROM knowledge_notes WHERE canonical_key = ?').get(`case:outcome:${reviewId}`);
  check('case 观察 Note 创建', Boolean(caseNote) && caseNote.kind === 'case');
  const caseVersion = latestNoteVersion(database, caseNote.id);
  check('case 版本 unverified + outcome_observed（不宣称支持）', caseVersion.conclusionStatus === 'unverified' && caseVersion.evidenceLevel === 'outcome_observed');
  const adopted = [...caseVersion.adoptedKnowledgeVersionIds];
  check('case 血缘（note 版本）固定发布时 Usage 版本', adopted.length === 1 && adopted.includes(lineage.noteV1) && !adopted.includes('wv-2'), `adopted=${JSON.stringify(adopted)}`);
  check('case 归属 topic', caseVersion.adoptedTopicIds.includes('topic-1'));
  check('case 限域 appliesTo 含平台/受众', caseVersion.appliesTo.includes('platform:x') && caseVersion.appliesTo.includes('audience:在英华人'));
  check('case 语句保守（不证明因果）', caseVersion.statement.includes('不证明因果') && caseVersion.statement.includes('单次样本观察'));

  const evidence = database.prepare('SELECT evidence_object_type AS t, evidence_object_id AS id, source_nature AS s FROM knowledge_evidence_links WHERE knowledge_note_version_id = ?').all(caseVersion.id);
  check('case 证据：review（review 性质）', evidence.some((e) => e.t === 'review' && e.id === reviewId && e.s === 'review'));
  check('case 证据：publication（performance_observation）', evidence.some((e) => e.t === 'publication' && e.id === 'pub-1' && e.s === 'performance_observation'));
  check('case 证据：metric_snapshot（performance_observation）', evidence.some((e) => e.t === 'metric_snapshot' && e.id === 'snap-pub-1' && e.s === 'performance_observation'));

  check('单次结果零因果 Method', countWhere(database, 'knowledge_notes', "kind='method'") === 0);
  check('单次结果零 pattern', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 0);

  const receipt = getUpdateReceiptByRequest(database, WORKSPACE, `outcome:review:${reviewId}`);
  check('回执 triggerType=review + requestId', Boolean(receipt) && receipt.triggerType === 'review' && receipt.requestId === `outcome:review:${reviewId}`);
  check('回执计数 caseNotesCreated=1', receipt.counts.caseNotesCreated === 1 && receipt.counts.notesQualified === 0 && receipt.counts.patternsCreated === 0);
  check('回执 affectedTopics 含 topic', receipt.affectedTopics.includes('topic-1'));
  check('回执 impact 记录血缘与非晋升项', receipt.impact.lineagePresent === true && receipt.impact.lineageVersionIds.length === 2
    && receipt.impact.nonPromoted.length === 2 && receipt.impact.stopItems.includes('泛 CTA'));

  // 结果回流与 final Review 同一 ChangeSet 原子重编译 Topic Wiki（Review 后立即可见）
  const wikiVersions = database.prepare('SELECT id, version_number AS n FROM knowledge_wiki_page_versions WHERE page_id = ? ORDER BY version_number').all('wiki-1');
  check('Topic Wiki 新增结果版本', wikiVersions.length === 2);
  const outcomeWiki = getWikiPageVersion(database, wikiVersions[1].id);
  check('Wiki 新版本立即包含结果观察', Array.isArray(outcomeWiki.body.recentOutcomes) && outcomeWiki.body.recentOutcomes.length === 1
    && outcomeWiki.body.recentOutcomes[0].reviewId === reviewId && outcomeWiki.body.recentOutcomes[0].caseNoteVersionId === caseVersion.id);
  check('Wiki 新版本采纳结果 Note 版本', outcomeWiki.adoptedNoteVersionIds.includes(caseVersion.id));
  check('Wiki 新版本 recentChanges 含 case 变更', Array.isArray(outcomeWiki.body.recentChanges)
    && outcomeWiki.body.recentChanges.some((entry) => entry.versionId === caseVersion.id && entry.changeType === 'created'));

  // ============ 2. 重复回流：重放幂等零增量 ============
  const before = {
    changeSets: countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'"),
    notes: count(database, 'knowledge_notes'),
    evidence: count(database, 'knowledge_evidence_links'),
    receipts: countWhere(database, 'knowledge_update_receipts', "request_id LIKE 'outcome:review:%'")
  };
  const replayed = flowBackOutcome(database, { reviewId });
  check('重放 replay=true + 同 ChangeSet', replayed.replay === true && replayed.changeSetId === database.prepare("SELECT id FROM knowledge_change_sets WHERE request_id = ?").get(`outcome:review:${reviewId}`).id);
  check('重放零新增行', countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'") === before.changeSets
    && count(database, 'knowledge_notes') === before.notes
    && count(database, 'knowledge_evidence_links') === before.evidence
    && countWhere(database, 'knowledge_update_receipts', "request_id LIKE 'outcome:review:%'") === before.receipts);
  check('重放回读同一回执计数', replayed.receipt.counts.caseNotesCreated === 1 && replayed.counts.caseNotesCreated === 1);

  // ============ 3. 稳定 requestId 异输入冲突（零部分写） ============
  await expectError('同 requestId 异输入 → REQUEST_REPLAY_CONFLICT', async () => {
    applyKnowledgeChangeSet(database, { ...csMeta(`outcome:review:${reviewId}`, 'tamper'), triggerSource: 'review' }, {
      freeNotes: [{ scope: 'global', sourceNature: 'user_quick_note', body: '入侵知识库' }]
    });
  }, 'REQUEST_REPLAY_CONFLICT');
  check('冲突零部分写（free note 未落库）', countWhere(database, 'knowledge_free_notes', "body = '入侵知识库'") === 0);
}

// ============ 4. 单次高表现：只观察，不证明方法有效 ============
{
  const database = freshDb('c-high');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);
  seedPublication(database, {
    id: 'pub-h', platformVersionId: 'pv-h', platform: 'x', audience: '', lineage,
    snapshot: { views: 100000, likes: 20000 }
  });
  const review = finalizeReview(database, { publicationId: 'pub-h', metricSnapshotIds: ['snap-pub-h'], keep: ['高表现模式'] });
  const caseVersion = latestNoteVersion(database, database.prepare('SELECT id FROM knowledge_notes WHERE canonical_key = ?').get(`case:outcome:${review.id}`).id);
  check('高表现 case 仍 unverified（不自动证明有效）', caseVersion.conclusionStatus === 'unverified' && caseVersion.evidenceLevel === 'outcome_observed');
  check('高表现仍零 Method', countWhere(database, 'knowledge_notes', "kind='method'") === 0);
  check('高表现单次仍零 pattern', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 0);
  check('高表现语句不宣称因果', caseVersion.statement.includes('不证明因果'));
}

// ============ 5. 重复结果限域：同 topic+platform+audience ≥2 建 pattern；跨平台分离；第 3 次强化 ============
{
  const database = freshDb('d-repeat');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);

  seedPublication(database, { id: 'pub-1', platformVersionId: 'pv-1', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 100 } });
  const r1 = finalizeReview(database, {
    publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'], keep: ['开头钩子']
  });
  check('第一次结果：无 pattern', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 0);

  seedPublication(database, { id: 'pub-2', platformVersionId: 'pv-2', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 200 } });
  const r2 = finalizeReview(database, { publicationId: 'pub-2', metricSnapshotIds: ['snap-pub-2'], keep: ['开头钩子'] });
  check('第二次同向结果：pattern 建立', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 1);
  const pattern = database.prepare(`SELECT id, canonical_key AS canonicalKey, title FROM knowledge_notes WHERE kind='creative_pattern'`).get();
  check('pattern 身份限域化 canonicalKey', pattern.canonicalKey.startsWith('pattern:keep:') && pattern.canonicalKey.includes(':x:'));
  const patternVersion = latestNoteVersion(database, pattern.id);
  check('pattern 结论 inference + corroborated（不宣称因果）', patternVersion.conclusionStatus === 'inference' && patternVersion.evidenceLevel === 'corroborated');
  check('pattern appliesTo 平台/受众/时间窗限定', patternVersion.appliesTo.includes('platform:x') && patternVersion.appliesTo.includes('audience:在英华人') && patternVersion.appliesTo.includes('window:'));
  check('pattern 语句含保守声明', patternVersion.statement.includes('2 次发布样本') && patternVersion.statement.includes('不构成因果证明'));
  const patternEvidenceReviews = database.prepare(`SELECT evidence_object_id AS id FROM knowledge_evidence_links
    WHERE knowledge_note_version_id = ? AND evidence_object_type = 'review'`).all(patternVersion.id).map((row) => row.id);
  check('pattern 证据含两次 Review', patternEvidenceReviews.includes(r1.id) && patternEvidenceReviews.includes(r2.id));

  // Wiki 新版本立即包含限域结果（pattern 建立随 Review 同一 ChangeSet 可见）
  const wikiAfterR2 = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get('wiki-1').c;
  const wikiBodyR2 = getWikiPageVersion(database, wikiAfterR2).body;
  check('Wiki 立即可见限域 pattern（patternUpdates）', Array.isArray(wikiBodyR2.recentOutcomes) && wikiBodyR2.recentOutcomes.length === 2
    && wikiBodyR2.recentOutcomes[1].patternUpdates.some((entry) => entry.changeType === 'created'));

  seedPublication(database, { id: 'pub-3', platformVersionId: 'pv-3', platform: 'xiaohongshu', audience: '在英华人', lineage, snapshot: { views: 50 } });
  finalizeReview(database, { publicationId: 'pub-3', metricSnapshotIds: ['snap-pub-3'], keep: ['开头钩子'] });
  check('跨平台不聚合：x pattern 未被强化、xhs 单次不建 pattern', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 1);
  check('x pattern 版本仍为 1（未被 xhs 强化）', Number(database.prepare('SELECT count(*) AS c FROM knowledge_note_versions WHERE note_id = ?').get(pattern.id).c) === 1);

  seedPublication(database, { id: 'pub-4', platformVersionId: 'pv-4', platform: 'xiaohongshu', audience: '在英华人', lineage, snapshot: { views: 60 } });
  finalizeReview(database, { publicationId: 'pub-4', metricSnapshotIds: ['snap-pub-4'], keep: ['开头钩子'] });
  check('xhs 第二次同向：xhs pattern 独立建立', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 2);
  const xhsPattern = database.prepare(`SELECT id FROM knowledge_notes WHERE kind='creative_pattern' AND canonical_key LIKE '%:xiaohongshu:%'`).get();
  check('xhs pattern 按平台限域', latestNoteVersion(database, xhsPattern.id).appliesTo.includes('platform:xiaohongshu'));
  check('x pattern 仍未被 xhs 触碰', Number(database.prepare('SELECT count(*) AS c FROM knowledge_note_versions WHERE note_id = ?').get(pattern.id).c) === 1);

  seedPublication(database, { id: 'pub-5', platformVersionId: 'pv-5', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 300 } });
  finalizeReview(database, { publicationId: 'pub-5', metricSnapshotIds: ['snap-pub-5'], keep: ['开头钩子'] });
  check('x 第三次同向：pattern 强化', Number(database.prepare('SELECT count(*) AS c FROM knowledge_note_versions WHERE note_id = ?').get(pattern.id).c) === 2);
  const strengthened = latestNoteVersion(database, pattern.id);
  check('强化版本 changeType=strengthened + 窗口扩展', strengthened.changeType === 'strengthened' && strengthened.evidenceLevel === 'corroborated' && strengthened.statement.includes('3 次发布样本'));
  const wikiAfterR5 = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get('wiki-1').c;
  const wikiBodyR5 = getWikiPageVersion(database, wikiAfterR5).body;
  check('Wiki 立即可见强化 pattern（strengthened）', Array.isArray(wikiBodyR5.recentOutcomes) && wikiBodyR5.recentOutcomes.length === 5
    && wikiBodyR5.recentOutcomes.at(-1).patternUpdates.some((entry) => entry.changeType === 'strengthened'));
  check('全流程零因果 Method', countWhere(database, 'knowledge_notes', "kind='method'") === 0);
}

// ============ 6. 受众维度限域：同平台不同受众不聚合 ============
{
  const database = freshDb('d-audience');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);
  seedPublication(database, { id: 'pub-a', platformVersionId: 'pv-a', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 100 } });
  finalizeReview(database, { publicationId: 'pub-a', metricSnapshotIds: ['snap-pub-a'], keep: ['钩子前置'] });
  seedPublication(database, { id: 'pub-b', platformVersionId: 'pv-b', platform: 'x', audience: '留学生', lineage, snapshot: { views: 100 } });
  finalizeReview(database, { publicationId: 'pub-b', metricSnapshotIds: ['snap-pub-b'], keep: ['钩子前置'] });
  check('跨受众不聚合（各 1 次不建 pattern）', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 0);
  seedPublication(database, { id: 'pub-c', platformVersionId: 'pv-c', platform: 'x', audience: '留学生', lineage, snapshot: { views: 150 } });
  finalizeReview(database, { publicationId: 'pub-c', metricSnapshotIds: ['snap-pub-c'], keep: ['钩子前置'] });
  check('留学生受众 2 次 → 建立限域 pattern', countWhere(database, 'knowledge_notes', "kind='creative_pattern'") === 1);
  const pattern = database.prepare(`SELECT id FROM knowledge_notes WHERE kind='creative_pattern'`).get();
  const patternVersion = latestNoteVersion(database, pattern.id);
  check('pattern 限定受众=留学生，不含在英华人', patternVersion.appliesTo.includes('audience:留学生') && !patternVersion.appliesTo.includes('audience:在英华人'));
}

// ============ 7. usage/version lineage：结果固定发布时版本，不随后续知识更新改写 ============
{
  const database = freshDb('e-lineage');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);
  seedPublication(database, { id: 'pub-1', platformVersionId: 'pv-1', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 100 } });
  const review = finalizeReview(database, { publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'], keep: ['开头钩子'] });
  const caseNoteId = database.prepare('SELECT id FROM knowledge_notes WHERE canonical_key = ?').get(`case:outcome:${review.id}`).id;
  const pinned = [...latestNoteVersion(database, caseNoteId).adoptedKnowledgeVersionIds];
  check('回流时固定发布时血缘（note 版本）', pinned.includes(lineage.noteV1) && pinned.length === 1);
  const receiptImpact = getUpdateReceiptByRequest(database, WORKSPACE, `outcome:review:${review.id}`).impact;
  check('完整血缘（wiki+note 版本）保留在回执', receiptImpact.lineageVersionIds.includes(lineage.pageV1) && receiptImpact.lineageVersionIds.includes(lineage.noteV1) && receiptImpact.lineageVersionIds.length === 2);

  // Topic 读模型可见：Review 后 Wiki 新版本立即可读（recentOutcomes + 回执 + 采纳结果 Note 证据）
  const { getTopicWikiDetail } = await import('../src/main/knowledge-topic-library.ts');
  const detailAfterReview = getTopicWikiDetail(database, { topicId: 'topic-1' });
  check('Topic 读模型回读结果回流版本（recentOutcomes）', detailAfterReview.wiki.current.body.recentOutcomes.length === 1
    && detailAfterReview.wiki.current.body.recentOutcomes[0].reviewId === review.id);
  const caseVersionId = latestNoteVersion(database, caseNoteId).id;
  check('Topic 读模型 recentChanges 含结果版本', detailAfterReview.wiki.body.recentChanges.some((entry) => entry.versionId === caseVersionId));
  check('Topic 读模型回执按 topic 可见', detailAfterReview.receipts.items.some((receipt) => receipt.requestId === `outcome:review:${review.id}`));
  check('Topic 读模型证据含结果 Note（review 证据）', detailAfterReview.evidence.items.some((entry) => entry.evidenceObjectType === 'review' && entry.evidenceObjectId === review.id));

  // 知识随后更新（Wiki 新版本 wv-2；语义断言当前 revision，兼容结果回流已追加版本）
  const pageBefore = database.prepare('SELECT revision FROM knowledge_wiki_pages WHERE id = ?').get('wiki-1').revision;
  applyKnowledgeChangeSet(database, csMeta('cs-later', '知识更新'), {
    wikiPages: [{
      id: 'wiki-1', beforeRevision: pageBefore, scope: 'global', pageType: 'topic', canonicalKey: 'wiki-topic:topic-1', subjectType: 'topic', subjectId: 'topic-1',
      version: { versionId: 'wv-2', body: { summary: '更新后综合' }, adoptedNoteVersionIds: ['nv-1'], changeSummary: '更新', compileReason: 'test' }
    }]
  });
  const wikiCurrent = database.prepare('SELECT current_version_id AS c FROM knowledge_wiki_pages WHERE id = ?').get('wiki-1').c;
  check('知识已更新到 wv-2', wikiCurrent === 'wv-2');
  const after = [...latestNoteVersion(database, caseNoteId).adoptedKnowledgeVersionIds];
  check('结果血缘不随后续知识更新改写', JSON.stringify(after) === JSON.stringify(pinned) && !after.includes('wv-2'));
  const { readPublicationTimeUsage } = await import('../src/main/knowledge-usage-integration.ts');
  const history = readPublicationTimeUsage(database, { publicationId: 'pub-1' });
  check('历史复盘仍读发布时固定血缘', history.platformPackage.wikiPageVersionIds[0] === lineage.pageV1 && history.corePackage.wikiPageVersionIds[0] === lineage.pageV1);
}

// ============ 8. 失败零部分写：快照损坏 → final Review 保存整体回滚 ============
{
  const database = freshDb('f-rollback');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);
  seedPublication(database, { id: 'pub-1', platformVersionId: 'pv-1', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 100 } });
  database.prepare("UPDATE publication_metric_snapshots SET normalized_json = ? WHERE id = 'snap-pub-1'").run('{corrupt');
  const reviewsBefore = count(database, 'reviews');
  const usageBefore = count(database, 'knowledge_usage_packages');
  await expectError('快照损坏 → 回流抛 OUTCOME_SNAPSHOT_CORRUPT', async () => {
    saveReview(database, { publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'], keep: ['k'], stop: ['s'], change: ['c'], status: 'final' });
  }, 'OUTCOME_SNAPSHOT_CORRUPT');
  check('失败后 review 零写', count(database, 'reviews') === reviewsBefore);
  check('失败后 review usage 包零写', count(database, 'knowledge_usage_packages') === usageBefore);
  check('失败后零 outcome ChangeSet', countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'") === 0);
  check('失败后零 case Note', countWhere(database, 'knowledge_notes', "canonical_key LIKE 'case:outcome:%'") === 0);
  check('失败后零回执', countWhere(database, 'knowledge_update_receipts', "request_id LIKE 'outcome:review:%'") === 0);
  check('失败后 Wiki 零新增版本', count(database, 'knowledge_wiki_page_versions') === 1 && count(database, 'knowledge_notes') === 1);

  // 修复后重试成功（可恢复）
  database.prepare("UPDATE publication_metric_snapshots SET normalized_json = ? WHERE id = 'snap-pub-1'").run(JSON.stringify({ views: 10 }));
  const retried = saveReview(database, { publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'], keep: ['k'], stop: ['s'], change: ['c'], status: 'final' });
  check('修复后 final Review 保存成功且回流一次', retried.ok === true
    && countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'") === 1);
}

// ============ 9. 无 workspace 身份（历史库/精简 fixture）：回流跳过、不失败 ============
{
  const database = freshDb('h-skip');
  seedKnowledgeBase(database, { workspaceId: null }); // 不写 workspace_id；知识表存在但无归属
  // 无 usage 包（无 workspace 身份时不造血缘）
  seedPublication(database, { id: 'pub-1', platformVersionId: 'pv-1', platform: 'x', audience: '', lineage: { pageV1: 'p', noteV1: 'n' }, snapshot: { views: 10 }, withUsage: false });
  const result = saveReview(database, { publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'], keep: ['k'], stop: ['s'], change: ['c'], status: 'final' });
  check('无 workspace 身份 final Review 保存成功', result.ok === true);
  check('回流跳过（零知识写）', count(database, 'knowledge_change_sets') === 0 && countWhere(database, 'knowledge_notes', "canonical_key LIKE 'case:outcome:%'") === 0);
}

// ============ 10. 单次限域表述：keep 精确命中既有 pattern/method → qualified（不新增 Method） ============
{
  const database = freshDb('i-qualify');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);
  applyKnowledgeChangeSet(database, csMeta('cs-patterns'), {
    notes: [
      { id: 'pat-1', scope: 'global', kind: 'creative_pattern', canonicalKey: '开头钩子', title: '开头钩子', version: { versionId: 'pat-v1', statement: '开头钩子有效', conclusionStatus: 'inference', evidenceLevel: 'single' } },
      { id: 'mtd-1', scope: 'global', kind: 'method', canonicalKey: '某方法', title: '某方法', version: { versionId: 'mtd-v1', statement: '某方法流程', conclusionStatus: 'inference', evidenceLevel: 'single' } }
    ]
  });
  seedPublication(database, { id: 'pub-1', platformVersionId: 'pv-1', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 100 } });
  const review = finalizeReview(database, { publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'], keep: ['开头钩子', '某方法'] });
  check('既有 method 只限域不新增（method 数不变）', countWhere(database, 'knowledge_notes', "kind='method'") === 1);

  const patVersions = database.prepare('SELECT change_type AS changeType FROM knowledge_note_versions WHERE note_id = ? ORDER BY version_number').all('pat-1');
  check('既有 pattern 追加 qualified 版本（限域表述）', patVersions.length === 2 && patVersions[1].changeType === 'qualified');
  const patLatest = latestNoteVersion(database, 'pat-1');
  check('qualified 版本限域平台/受众', patLatest.appliesTo.includes('platform:x') && patLatest.appliesTo.includes('audience:在英华人'));
  check('qualified 版本不宣称支持', patLatest.conclusionStatus === 'inference' && patLatest.evidenceLevel === 'outcome_observed');

  const mtdVersions = database.prepare('SELECT change_type AS changeType FROM knowledge_note_versions WHERE note_id = ? ORDER BY version_number').all('mtd-1');
  check('既有 method 限域表述（qualified）', mtdVersions.length === 2 && mtdVersions[1].changeType === 'qualified');
  const qualifiedEvidence = database.prepare(`SELECT count(*) AS c FROM knowledge_evidence_links WHERE knowledge_note_version_id = ?`).get(database.prepare('SELECT current_version_id AS c FROM knowledge_notes WHERE id = ?').get('mtd-1').c).c;
  check('qualified 版本带结果证据', Number(qualifiedEvidence) === 3);

  const caseNoteId = database.prepare('SELECT id FROM knowledge_notes WHERE canonical_key = ?').get(`case:outcome:${review.id}`).id;
  const receipt = getUpdateReceiptByRequest(database, WORKSPACE, `outcome:review:${review.id}`);
  check('回执计数 notesQualified=2', receipt.counts.notesQualified === 2 && receipt.counts.patternsCreated === 0 && receipt.counts.patternsStrengthened === 0);
  check('单次结果仍零自动 Method 创建', countWhere(database, 'knowledge_notes', "kind='method'") === 1 && caseNoteId);
}

// ============ 11. 真实保存链（dispatcher → saveReview）：首回流一次 + 命令级重放幂等 ============
{
  const { CommandDispatcher } = await import('../src/main/command-dispatcher.ts');
  const { dispatchSaveReview } = await import('../src/main/reviews.ts');
  const database = freshDb('j-dispatch');
  const lineage = seedKnowledgeBase(database);
  seedCorePackage(database, lineage);
  seedPublication(database, { id: 'pub-1', platformVersionId: 'pv-1', platform: 'x', audience: '在英华人', lineage, snapshot: { views: 99 } });
  const dispatcher = new CommandDispatcher(database, { workspaceId: WORKSPACE, rootPath: rootDir, runtimeEpoch: 'e1' });
  const runtime = {
    isActive: true,
    identity: { workspaceId: WORKSPACE, runtimeEpoch: 'e1' },
    database,
    dispatchCommand: (envelope, execute) => dispatcher.dispatch(envelope, execute)
  };
  const reviewInput = {
    publicationId: 'pub-1', metricSnapshotIds: ['snap-pub-1'],
    keep: ['开头钩子'], stop: ['s'], change: ['c'], summary: 'ok', status: 'final',
    findings: [{ title: 't', body: 'b' }]
  };
  const first = await dispatchSaveReview(runtime, 'dispatch-review-1', reviewInput);
  check('dispatcher 路径首回流成功', first.ok === true);
  check('dispatcher 路径恰好一次回流', countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'") === 1
    && countWhere(database, 'knowledge_notes', "canonical_key LIKE 'case:outcome:%'") === 1
    && countWhere(database, 'knowledge_notes', "kind='method'") === 0);
  const replayed = await dispatchSaveReview(runtime, 'dispatch-review-1', reviewInput);
  check('dispatcher 命令级重放零增量', replayed.ok === true
    && countWhere(database, 'knowledge_change_sets', "request_id LIKE 'outcome:review:%'") === 1
    && countWhere(database, 'knowledge_notes', "canonical_key LIKE 'case:outcome:%'") === 1);
}

// ============ 清理 ============
for (const db of openDbs) db.close();
await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`WMB-5216 outcome feedback: ${checks} checks PASS`);
