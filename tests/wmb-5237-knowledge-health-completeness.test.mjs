// WMB-5237：知识健康完整性检测（Detector 切片）聚焦测试（自包含，真实 SQLite）。
// 覆盖（合同逐项）：
// - 七类检测各至少一条：orphan / missing-page / duplicate（知识 + 实体）/ unsupported /
//   stale-claim / cross-reference / data-gap；
// - 同一缺陷重复 Lint 不重复建 Issue（局部去重 + 周期去重，稳定 fingerprint）；
// - 确定性缺陷修复后自动 resolved（条件消除）；disputed/contradicted 保持可见不自动裁决；
// - 周期 Lint 遍历全部 14 个 phase 并完成；第二轮周期零新增 Issue；
// - data-gap 阈值语义：未达阈值（captured 且时间不足）的 FreeNote 不报警；
// - unsupported 语义：inference/disputed 不误判为 supported。
// 运行：node --test --test-concurrency=1 tests/wmb-5237-knowledge-health-completeness.test.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { DatabaseSync } = await import('node:sqlite');
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const {
  applyKnowledgeChangeSet,
  getHealthIssue,
  getKnowledgeNote,
  listHealthIssues
} = await import('../src/main/knowledge-flywheel.ts');
const {
  beginPeriodicLint,
  KNOWLEDGE_HEALTH_DETECTOR_VERSION,
  runLocalLint,
  runPeriodicLintStep
} = await import('../src/main/knowledge-health.ts');

const DAY_MS = 86_400_000;
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * DAY_MS).toISOString();
const FUTURE = new Date(Date.now() + 30 * DAY_MS).toISOString();

function meta(requestId, triggerSource = 'ingest', extra = {}) {
  return {
    workspaceId: 'ws-a', requestId, reason: 'WMB-5237 测试种子', triggerSource,
    resolutionMode: 'none', createdBy: 'background_agent', ...extra
  };
}

test('WMB-5237 knowledge health completeness detectors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5237-health-'));
  let database;
  let failure;
  try {
    database = migrateDatabase(path.join(directory, 'wmb.db'));
    database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)")
      .run(NOW, NOW);

    let checks = 0;
    function check(label, condition, detail = '') {
      checks += 1;
      if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
    }
    const count = (table) => Number(database.prepare(`SELECT count(*) AS c FROM ${table}`).get().c);
    const issueFor = (items, objectType, objectId, issueType) =>
      items.find((item) => item.affectedObjectType === objectType && item.affectedObjectId === objectId && item.issueType === issueType) ?? null;

    // ============ 种子：真实业务对象 + 正式知识写（唯一写入口） ============
    const source = upsertSource(database, { originalUrl: 'https://news.example/health-completeness', title: '完整性测试源' });
    const topic = upsertKnowledgeTopic(database, { title: '知识完整性测试主题' });

    const seed = applyKnowledgeChangeSet(database, meta('wmb5237-seed-1'), {
      entities: [
        { id: 'entity-a', scope: 'global', entityType: 'organization', canonicalKey: 'acme', canonicalName: 'Acme Inc', externalIdentity: { domain: 'acme.example' } },
        { id: 'entity-b', scope: 'global', entityType: 'organization', canonicalKey: 'acme-eu', canonicalName: 'Acme EU', externalIdentity: { domain: 'acme.example' } },
        { id: 'entity-ok', scope: 'global', entityType: 'person', canonicalKey: 'kate', canonicalName: 'Kate', externalIdentity: { x_user: 'kate_123' } }
      ],
      notes: [
        { id: 'note-orphan', scope: 'global', kind: 'claim', canonicalKey: 'orphan-claim', version: { versionId: 'nver-orphan', statement: '孤立认识：从未接入知识图谱', conclusionStatus: 'inference', evidenceLevel: 'none' } },
        { id: 'note-unsupported', scope: 'global', kind: 'claim', canonicalKey: 'unsupported-claim', version: { versionId: 'nver-unsupported', statement: '宣称受支持但无证据链接', conclusionStatus: 'supported', evidenceLevel: 'single' } },
        { id: 'note-stale', scope: 'global', kind: 'claim', canonicalKey: 'stale-claim', version: { versionId: 'nver-stale', statement: '已过有效期的认识', conclusionStatus: 'supported', evidenceLevel: 'primary', validUntil: OLD } },
        { id: 'note-dup-1', scope: 'global', kind: 'claim', canonicalKey: 'dup-statement-1', version: { versionId: 'nver-dup-1', statement: '完全相同的重复陈述内容', conclusionStatus: 'supported', evidenceLevel: 'primary' } },
        { id: 'note-dup-2', scope: 'global', kind: 'claim', canonicalKey: 'dup-statement-2', version: { versionId: 'nver-dup-2', statement: '完全相同的重复陈述内容', conclusionStatus: 'supported', evidenceLevel: 'primary' } },
        { id: 'note-disputed', scope: 'global', kind: 'claim', canonicalKey: 'disputed-claim', version: { versionId: 'nver-disputed', statement: '可信来源仍存在实质分歧', conclusionStatus: 'disputed', evidenceLevel: 'single' } },
        { id: 'note-adopting', scope: 'global', kind: 'claim', canonicalKey: 'adopting-entity', version: { versionId: 'nver-adopting', statement: '引用实体但实体无页面', conclusionStatus: 'supported', evidenceLevel: 'primary', adoptedEntityIds: ['entity-a'], adoptedTopicIds: [topic.id] } }
      ],
      wikiPages: [{
        id: 'page-broken-refs', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-broken-refs',
        subjectType: 'topic', subjectId: topic.id,
        version: { versionId: 'wver-broken-1', title: '坏引用页面', body: { kind: 'topic-wiki' }, adoptedNoteVersionIds: [], businessObjectRefs: ['source:ghost-source-deleted'], changeSummary: '坏引用种子', compileReason: '测试' }
      }],
      freeNotes: [
        { id: 'free-note-old', scope: 'global', sourceNature: 'user_quick_note', body: '30 天前捕获未处理', processingState: 'captured' },
        { id: 'free-note-recent', scope: 'global', sourceNature: 'user_quick_note', body: '刚捕获未处理', processingState: 'captured' }
      ],
      evidenceLinks: [
        { id: 'ev-dup-1', knowledgeNoteVersionId: 'nver-dup-1', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source' },
        { id: 'ev-dup-2', knowledgeNoteVersionId: 'nver-dup-2', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source' },
        { id: 'ev-disputed', knowledgeNoteVersionId: 'nver-disputed', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'contradicts', sourceNature: 'primary_source' },
        { id: 'ev-adopting', knowledgeNoteVersionId: 'nver-adopting', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source' },
        { id: 'ev-stale', knowledgeNoteVersionId: 'nver-stale', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source' }
      ],
      relations: [
        { op: 'create', id: 'rel-adopt', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: 'note-adopting', toObjectType: 'topic', toObjectId: topic.id }
      ]
    });
    check('WMB5237 种子 ChangeSet 已提交', Boolean(seed.changeSetId));
    // data-gap 阈值语义：把 free-note-old 的捕获时间拨到 30 天前（created_at 非不可变列）
    database.prepare('UPDATE knowledge_free_notes SET created_at = ? WHERE id = ?').run(OLD, 'free-note-old');

    const lintObjects = [
      { objectType: 'knowledge_note', objectId: 'note-orphan' },
      { objectType: 'knowledge_note', objectId: 'note-unsupported' },
      { objectType: 'knowledge_note', objectId: 'note-stale' },
      { objectType: 'knowledge_note', objectId: 'note-dup-1' },
      { objectType: 'knowledge_note', objectId: 'note-dup-2' },
      { objectType: 'knowledge_note', objectId: 'note-disputed' },
      { objectType: 'knowledge_note', objectId: 'note-adopting' },
      { objectType: 'knowledge_entity', objectId: 'entity-a' },
      { objectType: 'knowledge_entity', objectId: 'entity-b' },
      { objectType: 'knowledge_entity', objectId: 'entity-ok' },
      { objectType: 'wiki_page', objectId: 'page-broken-refs' },
      { objectType: 'knowledge_free_note', objectId: 'free-note-old' },
      { objectType: 'knowledge_free_note', objectId: 'free-note-recent' },
      { objectType: 'topic', objectId: topic.id }
    ];

    // ============ 1. 七类检测各至少一条（局部 Lint，默认检测器全集） ============
    const lint1 = runLocalLint(database, {
      requestId: 'wmb5237-lint-1', workspaceId: 'ws-a', scope: 'global', affectedObjects: lintObjects
    });
    check('L1 首轮局部 Lint 新建 12 个 Issue（精确矩阵）', lint1.counts.issuesCreated === 12, `实际 ${lint1.counts.issuesCreated}`);
    check('L1 全部 Issue 携带稳定 fingerprint 与当前检测器版本',
      lint1.issues.every((item) => typeof item.evidence?.fingerprint === 'string' && item.evidence?.detectorVersion === KNOWLEDGE_HEALTH_DETECTOR_VERSION));

    const orphanIssueId = issueFor(lint1.issues, 'knowledge_note', 'note-orphan', 'orphan_knowledge')?.id;
    const unsupportedIssueId = issueFor(lint1.issues, 'knowledge_note', 'note-unsupported', 'unsupported_claim')?.id;
    const staleIssueId = issueFor(lint1.issues, 'knowledge_note', 'note-stale', 'stale_claim')?.id;
    const dup1IssueId = issueFor(lint1.issues, 'knowledge_note', 'note-dup-1', 'duplicate_knowledge')?.id;
    const dup2IssueId = issueFor(lint1.issues, 'knowledge_note', 'note-dup-2', 'duplicate_knowledge')?.id;
    const disputedIssueId = issueFor(lint1.issues, 'knowledge_note', 'note-disputed', 'unresolved_contradiction')?.id;
    const dupEntityAIssueId = issueFor(lint1.issues, 'knowledge_entity', 'entity-a', 'duplicate_entity')?.id;
    const dupEntityBIssueId = issueFor(lint1.issues, 'knowledge_entity', 'entity-b', 'duplicate_entity')?.id;
    const missingPageIssueId = issueFor(lint1.issues, 'knowledge_entity', 'entity-a', 'missing_wiki_page')?.id;
    const crossIssueId = issueFor(lint1.issues, 'wiki_page', 'page-broken-refs', 'broken_reference')?.id;
    const gapIssueId = issueFor(lint1.issues, 'knowledge_free_note', 'free-note-old', 'data_gap')?.id;

    check('L1 orphan：孤立 Note 报警', Boolean(orphanIssueId));
    check('L1 unsupported：无证据的 supported Claim 报警（inference 不误判）',
      Boolean(unsupportedIssueId) && issueFor(lint1.issues, 'knowledge_note', 'note-orphan', 'unsupported_claim') === null);
    check('L1 stale-claim：valid_until 已过期的 Claim 报警', Boolean(staleIssueId));
    check('L1 duplicate（知识）：同陈述 Note 双方各报警', Boolean(dup1IssueId) && Boolean(dup2IssueId) && dup1IssueId !== dup2IssueId);
    check('L1 duplicate（实体）：同强外部身份 Entity 双方各报警', Boolean(dupEntityAIssueId) && Boolean(dupEntityBIssueId));
    check('L1 missing-page：被引用但无页面 Entity 报警', Boolean(missingPageIssueId));
    check('L1 cross-reference：Wiki 页面不可解析正式引用报警（复用 broken_reference@wiki_page）', Boolean(crossIssueId));
    check('L1 data-gap：超期 captured FreeNote 报警', Boolean(gapIssueId));
    check('L1 data-gap 阈值：未超期 captured FreeNote 不报警', issueFor(lint1.issues, 'knowledge_free_note', 'free-note-recent', 'data_gap') === null);
    check('L1 可信冲突可见：disputed Note 报警 unresolved_contradiction', Boolean(disputedIssueId));
    check('L1 已连接 Note 不误报孤儿（note-adopting/dup-1/dup-2/disputed）',
      ['note-adopting', 'note-dup-1', 'note-dup-2', 'note-disputed'].every((id) => issueFor(lint1.issues, 'knowledge_note', id, 'orphan_knowledge') === null));
    check('L1 已有页面的 Topic 不误报 missing-page', issueFor(lint1.issues, 'topic', topic.id, 'missing_wiki_page') === null);

    // ============ 2. 去重：同一缺陷重复 Lint 不重复建 Issue ============
    const lint2 = runLocalLint(database, {
      requestId: 'wmb5237-lint-2', workspaceId: 'ws-a', scope: 'global', affectedObjects: lintObjects
    });
    check('L2 重复局部 Lint 零新建、12 去重', lint2.counts.issuesCreated === 0 && lint2.counts.issuesDeduplicated === 12);
    check('L2 Issue 行数不变', count('knowledge_health_issues') === 12);

    // ============ 3. 确定性修复 → 条件消除自动 resolved（真实争议保持 open） ============
    // 3a. orphan + unsupported：补证据链接
    applyKnowledgeChangeSet(database, meta('wmb5237-fix-evidence'), {
      evidenceLinks: [
        { id: 'ev-orphan', knowledgeNoteVersionId: 'nver-orphan', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'derived_from', sourceNature: 'primary_source' },
        { id: 'ev-unsupported', knowledgeNoteVersionId: 'nver-unsupported', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source' }
      ]
    });
    const fix1 = runLocalLint(database, {
      requestId: 'wmb5237-fix-lint-1', workspaceId: 'ws-a', scope: 'global',
      affectedObjects: [
        { objectType: 'knowledge_note', objectId: 'note-orphan' },
        { objectType: 'knowledge_note', objectId: 'note-unsupported' }
      ]
    });
    check('F1 孤儿/无证据 Issue 自动 resolved（3 条：orphan + unsupported + orphan）',
      fix1.counts.issuesAutoResolved === 3 && getHealthIssue(database, orphanIssueId)?.status === 'resolved'
      && getHealthIssue(database, unsupportedIssueId)?.status === 'resolved'
      && String(getHealthIssue(database, unsupportedIssueId)?.resolutionNote ?? '').includes('条件已消除'));

    // 3b. stale-claim：更新当前版本有效期（追加版本 + 新证据）
    const staleNote = getKnowledgeNote(database, 'note-stale');
    applyKnowledgeChangeSet(database, meta('wmb5237-fix-stale'), {
      notes: [{
        id: 'note-stale', scope: 'global', kind: 'claim', canonicalKey: 'stale-claim', beforeRevision: staleNote.note.revision,
        version: { versionId: 'nver-stale-2', statement: '已更新有效期的认识', conclusionStatus: 'supported', evidenceLevel: 'primary', validUntil: FUTURE, changeType: 'qualified' }
      }],
      evidenceLinks: [
        { id: 'ev-stale-2', knowledgeNoteVersionId: 'nver-stale-2', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source' }
      ]
    });
    const fix2 = runLocalLint(database, {
      requestId: 'wmb5237-fix-lint-2', workspaceId: 'ws-a', scope: 'global',
      affectedObjects: [{ objectType: 'knowledge_note', objectId: 'note-stale' }]
    });
    check('F2 过期 Claim 更新后自动 resolved（且零新建）',
      fix2.counts.issuesAutoResolved === 1 && fix2.counts.issuesCreated === 0 && getHealthIssue(database, staleIssueId)?.status === 'resolved');

    // 3c. duplicate（知识）：归档其中一个 Note
    const dup2Note = getKnowledgeNote(database, 'note-dup-2');
    applyKnowledgeChangeSet(database, meta('wmb5237-fix-dup-note'), {
      notes: [{
        id: 'note-dup-2', scope: 'global', kind: 'claim', canonicalKey: 'dup-statement-2', beforeRevision: dup2Note.note.revision,
        version: { versionId: 'nver-dup-2a', statement: '完全相同的重复陈述内容', conclusionStatus: 'supported', evidenceLevel: 'primary', changeType: 'archived' },
        lifecycle: 'archived'
      }]
    });
    const fix3 = runLocalLint(database, {
      requestId: 'wmb5237-fix-lint-3', workspaceId: 'ws-a', scope: 'global',
      affectedObjects: [
        { objectType: 'knowledge_note', objectId: 'note-dup-1' },
        { objectType: 'knowledge_note', objectId: 'note-dup-2' }
      ]
    });
    check('F3 归档重复方后双方 duplicate_knowledge 自动 resolved',
      fix3.counts.issuesAutoResolved === 2 && getHealthIssue(database, dup1IssueId)?.status === 'resolved'
      && getHealthIssue(database, dup2IssueId)?.status === 'resolved');

    // 3d. duplicate（实体）：归档其中一个 Entity
    const entityBRevision = Number(database.prepare('SELECT revision FROM knowledge_entities WHERE id = ?').get('entity-b').revision);
    applyKnowledgeChangeSet(database, meta('wmb5237-fix-dup-entity'), {
      entities: [{
        id: 'entity-b', scope: 'global', entityType: 'organization', canonicalKey: 'acme-eu', canonicalName: 'Acme EU',
        beforeRevision: entityBRevision, lifecycle: 'archived'
      }]
    });
    const fix4 = runLocalLint(database, {
      requestId: 'wmb5237-fix-lint-4', workspaceId: 'ws-a', scope: 'global',
      affectedObjects: [
        { objectType: 'knowledge_entity', objectId: 'entity-a' },
        { objectType: 'knowledge_entity', objectId: 'entity-b' }
      ]
    });
    check('F4 归档重复实体后双方 duplicate_entity 自动 resolved',
      fix4.counts.issuesAutoResolved === 2 && getHealthIssue(database, dupEntityAIssueId)?.status === 'resolved'
      && getHealthIssue(database, dupEntityBIssueId)?.status === 'resolved');
    check('F4 仍未建页面前 missing-page Issue 保持 open', getHealthIssue(database, missingPageIssueId)?.status === 'open');

    // 3e. missing-page：为 Entity 创建活动 Wiki 页面
    applyKnowledgeChangeSet(database, meta('wmb5237-fix-page'), {
      wikiPages: [{
        id: 'page-entity-a', scope: 'global', pageType: 'entity', canonicalKey: 'wiki-entity-a',
        subjectType: 'entity', subjectId: 'entity-a',
        version: { versionId: 'wver-entity-a', title: 'Acme Inc 页面', body: { kind: 'entity-wiki' }, adoptedNoteVersionIds: [], businessObjectRefs: [], changeSummary: '补 Entity 页面', compileReason: '测试' }
      }]
    });
    const fix5 = runLocalLint(database, {
      requestId: 'wmb5237-fix-lint-5', workspaceId: 'ws-a', scope: 'global',
      affectedObjects: [{ objectType: 'knowledge_entity', objectId: 'entity-a' }]
    });
    check('F5 补页后 missing-page 自动 resolved', fix5.counts.issuesAutoResolved === 1 && getHealthIssue(database, missingPageIssueId)?.status === 'resolved');

    // 3f. cross-reference：重编译 Wiki 页面清除失效引用
    applyKnowledgeChangeSet(database, meta('wmb5237-fix-refs'), {
      wikiPages: [{
        id: 'page-broken-refs', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-broken-refs',
        subjectType: 'topic', subjectId: topic.id, beforeRevision: 1,
        version: { versionId: 'wver-broken-2', title: '干净页面', body: { kind: 'topic-wiki' }, adoptedNoteVersionIds: [], businessObjectRefs: [`source:${source.id}`], changeSummary: '重编译清除坏引用', compileReason: '测试' }
      }]
    });
    const fix6 = runLocalLint(database, {
      requestId: 'wmb5237-fix-lint-6', workspaceId: 'ws-a', scope: 'global',
      affectedObjects: [{ objectType: 'wiki_page', objectId: 'page-broken-refs' }]
    });
    check('F6 重编译干净后 cross-reference 自动 resolved', fix6.counts.issuesAutoResolved === 1 && getHealthIssue(database, crossIssueId)?.status === 'resolved');

    // 3g. data-gap：处理超期 captured FreeNote
    applyKnowledgeChangeSet(database, meta('wmb5237-fix-gap'), {
      freeNoteTransitions: [{ id: 'free-note-old', beforeRevision: 1, processingState: 'processed', processingReason: '测试处理' }]
    });
    const fix7 = runLocalLint(database, {
      requestId: 'wmb5237-fix-lint-7', workspaceId: 'ws-a', scope: 'global',
      affectedObjects: [{ objectType: 'knowledge_free_note', objectId: 'free-note-old' }]
    });
    check('F7 处理后 data-gap 自动 resolved', fix7.counts.issuesAutoResolved === 1 && getHealthIssue(database, gapIssueId)?.status === 'resolved');

    // 3h. 可信冲突恒可见：所有确定性修复完成后 disputed 仍 open
    check('F8 disputed/contradicted 不被自动抹除', getHealthIssue(database, disputedIssueId)?.status === 'open');
    const openAfterFixes = listHealthIssues(database, { status: 'open' }).items;
    check('F8 仅 disputed 保持 open', openAfterFixes.length === 1 && openAfterFixes[0]?.id === disputedIssueId);

    // ============ 4. 周期 Lint：遍历全部 14 个 phase；不重复 Issue ============
    const issuesBeforePeriodic = count('knowledge_health_issues');
    const begin1 = beginPeriodicLint(database, { workspaceId: 'ws-a', scope: 'global', pageSize: 2, resume: false });
    check('P1 周期 Lint 开始（新 run，全部检测器）', begin1.resumed === false && begin1.checkpoint.status === 'running');
    const seenPhases = new Set();
    let guard = 0;
    let cp = begin1.checkpoint;
    while (cp.status === 'running') {
      guard += 1;
      if (guard > 500) throw new Error(`FAIL 周期 Lint 未在步数上限内完成（phase=${cp.phase} step=${cp.step}）`);
      seenPhases.add(cp.phase);
      const step = runPeriodicLintStep(database);
      cp = step.checkpoint;
    }
    check('P2 周期 Lint 完成', cp.status === 'completed' && cp.completedAt !== null);
    check('P3 周期 Lint 遍历全部 14 个 phase', seenPhases.size === 14, `实际 ${seenPhases.size}`);
    check('P4 周期扫描零新增 Issue（全部去重）', count('knowledge_health_issues') === issuesBeforePeriodic);
    check('P5 周期后 disputed 仍 open', getHealthIssue(database, disputedIssueId)?.status === 'open');

    // 第二轮完整周期：重复扫描仍不重复建 Issue
    const begin2 = beginPeriodicLint(database, { workspaceId: 'ws-a', scope: 'global', pageSize: 10, resume: false });
    let guard2 = 0;
    let cp2 = begin2.checkpoint;
    while (cp2.status === 'running') {
      guard2 += 1;
      if (guard2 > 100) throw new Error('FAIL 第二轮周期未完成');
      cp2 = runPeriodicLintStep(database).checkpoint;
    }
    check('P6 第二轮周期完成且零新增 Issue', cp2.status === 'completed' && count('knowledge_health_issues') === issuesBeforePeriodic);

    console.log(`WMB-5237 knowledge health completeness PASS (${checks} checks)`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // 无论断言/运行路径如何：先关闭数据库（否则 Windows 上 rm 会因文件锁报 EBUSY），再删目录。
    // close 自身失败不得遮蔽原始断言错误；无原始错误时 close 失败就是真实错误，照常抛出。
    try {
      database?.close();
    } catch (error) {
      if (failure === undefined) throw error;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
