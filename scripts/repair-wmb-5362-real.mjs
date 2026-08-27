import assert from 'node:assert/strict';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import {
  enqueueKnowledgeRouteJob,
  enqueueKnowledgeReactivationJob,
  drainPersistentKnowledgeJobs,
  stopPersistentKnowledgeJobs
} from '../src/main/knowledge-compile-trigger.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { getProposalDetail } from '../src/main/proposals.ts';

const databasePath = process.argv[2] ?? 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const oldSourceId = 'c0ee77c3-173d-4ad3-83e9-cfa15ddfffb7';
const currentSourceId = '8844ca91-8b38-4c6f-ac9c-09537d20fb3e';
const db = migrateDatabase(databasePath);

function fenced(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function routeResponse(topic) {
  return fenced({ wmb_knowledge_route: {
    reason: '当前资料明确揭示 Ox Alpha 与 GLM-5.3-Flash 的产品身份，并归入现有 AI 模型发布与实测主题。',
    entityCandidates: [{
      entityType: 'product', canonicalKey: 'product:ox-alpha', canonicalName: 'GLM-5.3-Flash',
      aliases: ['Ox Alpha'], externalIdentity: {}, identityStrength: 'strong',
      locator: 'L1', excerpt: 'Ox Alpha finally has a name: GLM-5.3-Flash.'
    }],
    topicCandidates: [{
      topicId: topic.id, canonicalKey: topic.canonicalKey, title: topic.title, kind: 'theme',
      summary: 'AI 模型发布、免费额度与真实任务成本证据。', relation: 'primary',
      locator: 'L1', excerpt: 'Ox Alpha finally has a name: GLM-5.3-Flash.'
    }],
    selectedEntityKey: 'product:ox-alpha', selectedTopicKey: topic.canonicalKey,
    evidenceGaps: [{
      code: 'COMPUTE_PROVIDER_UNVERIFIED', statement: '100T 免费容量是否由国产算力集群提供仍缺可靠证据。',
      locator: 'L1', excerpt: 'Ox Alpha finally has a name: GLM-5.3-Flash.'
    }]
  }});
}

function compileResponse(prompt) {
  if (prompt.includes(`sourceId=${oldSourceId}`) || prompt.includes(oldSourceId)) {
    return fenced({ wmb_knowledge_candidates: {
      reason: '保留来源对免费容量的原始声称，并明确维持未核实状态。',
      topicCompile: { title: 'AI 模型发布、免费额度与实测', summary: '跨日归集模型身份、额度声称与任务实测。' },
      entities: [],
      notes: [{
        kind: 'claim', canonicalKey: 'ox-alpha-command-code-100t-daily-claim',
        statement: 'Command Code 声称 Ox Alpha 每天提供 100T tokens 免费容量且无 5 小时限制。',
        conclusionStatus: 'unverified', evidenceLevel: 'single', changeType: 'created',
        locator: 'L1-L3', excerpt: '100T tokens per day free capacity', relation: 'supports',
        valueRationale: '这是用户判断免费额度实际价值所需的原始主张，但尚无独立核验。'
      }]
    }});
  }
  return fenced({ wmb_knowledge_candidates: {
    reason: '记录产品身份揭晓与同任务成本实测，保留来源性质。',
    topicCompile: { title: 'AI 模型发布、免费额度与实测', summary: '跨日归集模型身份、额度声称与任务实测。' },
    entities: [],
    notes: [
      {
        kind: 'claim', canonicalKey: 'ox-alpha-is-glm-5-3-flash',
        statement: '该来源明确称 Ox Alpha 的正式名称是 GLM-5.3-Flash。',
        conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'created',
        locator: 'L1', excerpt: 'Ox Alpha finally has a name: GLM-5.3-Flash.', relation: 'supports',
        valueRationale: '身份揭晓使此前匿名模型的历史证据可被重新归集。'
      },
      {
        kind: 'case', canonicalKey: 'glm-5-3-flash-ego-lite-backlink-run',
        statement: '在该来源描述的 backlink submission 任务中，GLM-5.3-Flash 使用 12 次工具调用、耗时 2 分 50 秒、成本 0.01 美元。',
        conclusionStatus: 'supported', evidenceLevel: 'outcome_observed', changeType: 'created',
        locator: 'L3-L5', excerpt: '12 tool calls, 2m50s, $0.01', relation: 'supports',
        valueRationale: '提供比单纯发布公告更接近真实工作负载的成本与效率证据。'
      }
    ]
  }});
}

try {
  const schema = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='plan_source_decisions'").get();
  assert.equal(schema?.ok, 1, 'migration 78 is required');
  const sources = db.prepare('SELECT id,title,summary,revision FROM source_items WHERE id IN (?,?) ORDER BY id').all(oldSourceId, currentSourceId);
  assert.equal(sources.length, 2, 'frozen Source set changed');
  const byId = new Map(sources.map((source) => [source.id, source]));
  assert.equal(byId.get(oldSourceId)?.revision, 16, 'old Source revision changed');
  assert.equal(byId.get(currentSourceId)?.revision, 1, 'current Source revision changed');

  const topic = upsertKnowledgeTopic(db, {
    title: 'AI 模型发布、免费额度与实测', kind: 'theme',
    summary: '跨日归集模型身份、免费额度声称与真实任务成本证据。', status: 'active'
  });
  const topicRow = db.prepare('SELECT id,canonical_key AS canonicalKey,title FROM topics WHERE id=?').get(topic.id);
  assert.ok(topicRow);

  enqueueKnowledgeRouteJob(db, { sourceId: currentSourceId, revision: 1 });
  const deps = {
    databasePath: path.resolve(databasePath), openDatabase: migrateDatabase,
    modelCall: async (prompt) => prompt.includes('wmb_knowledge_route') ? routeResponse(topicRow) : compileResponse(prompt)
  };
  await drainPersistentKnowledgeJobs(deps);

  const routedEntity = db.prepare("SELECT id,revision,canonical_name AS canonicalName,aliases_json AS aliasesJson FROM knowledge_entities WHERE canonical_key='product:ox-alpha'").get();
  const routedTopic = db.prepare('SELECT topic_id AS topicId FROM topic_source_links WHERE source_id=? ORDER BY updated_at DESC LIMIT 1').get(currentSourceId);
  assert.ok(routedEntity && routedTopic, 'current Source route must persist Entity and Topic before compensation');
  const oldLinked = db.prepare('SELECT 1 AS ok FROM topic_source_links WHERE topic_id=? AND source_id=?').get(routedTopic.topicId, oldSourceId);
  if (!oldLinked) {
    enqueueKnowledgeReactivationJob(db, {
      sourceId: oldSourceId, sourceRevision: 16, currentSourceId, currentSourceRevision: 1,
      entityId: routedEntity.id, entityRevision: routedEntity.revision, topicId: routedTopic.topicId,
      reason: 'WMB-5362 冻结真实场景补偿：强身份确认后重激活被旧查询截断的历史 Source。',
      matchedAliases: ['Ox Alpha'],
      evidenceGaps: [{ code: 'COMPUTE_PROVIDER_UNVERIFIED', statement: '100T 免费容量是否由国产算力集群提供仍缺可靠证据。', locator: 'L1', excerpt: 'Ox Alpha' }]
    });
    await drainPersistentKnowledgeJobs(deps);
  }

  const links = db.prepare('SELECT topic_id AS topicId,source_id AS sourceId,relation FROM topic_source_links WHERE topic_id=? AND source_id IN (?,?) ORDER BY source_id').all(topic.id, oldSourceId, currentSourceId);
  assert.deepEqual([...new Set(links.map((link) => link.sourceId))].sort(), [oldSourceId, currentSourceId].sort(), 'both frozen Sources must be linked through route/reactivation');
  const entity = db.prepare("SELECT id,canonical_name AS canonicalName,aliases_json AS aliasesJson,revision FROM knowledge_entities WHERE canonical_key='product:ox-alpha'").get();
  assert.ok(entity);
  const names = [entity.canonicalName, ...JSON.parse(entity.aliasesJson)].map((value) => value.toLowerCase());
  assert.ok(names.includes('ox alpha') && names.includes('glm-5.3-flash'), 'strong alias must be persisted');

  const jobs = db.prepare(`SELECT id,kind,status,dedupe_key AS dedupeKey,payload_json AS payloadJson,last_error AS lastError
    FROM jobs WHERE kind IN ('knowledge_route','knowledge_reactivate_sources','knowledge_compile')
      AND (payload_json LIKE ? OR payload_json LIKE ?) ORDER BY created_at,id`).all(`%${oldSourceId}%`, `%${currentSourceId}%`);
  assert.ok(jobs.some((job) => job.kind === 'knowledge_route' && job.status === 'succeeded'));
  assert.ok(jobs.some((job) => job.kind === 'knowledge_reactivate_sources' && job.status === 'succeeded'));
  assert.ok(jobs.filter((job) => job.kind === 'knowledge_compile').every((job) => job.status === 'succeeded'), JSON.stringify(jobs));
  const receipts = db.prepare(`SELECT id,request_id AS requestId,summary,impact_json AS impactJson,created_at AS createdAt
    FROM knowledge_update_receipts WHERE impact_json LIKE ? OR impact_json LIKE ? OR request_id LIKE ? OR request_id LIKE ?
    ORDER BY created_at,id`).all(`%${oldSourceId}%`, `%${currentSourceId}%`, `%${oldSourceId}%`, `%${currentSourceId}%`);
  assert.ok(receipts.length >= 3, 'route and both compile receipts are required');

  const scoreReasons = [
    ['reader_immediacy_benefit', 20, 18, '免费额度与低成本实测可直接帮助 AI 工具用户判断是否值得尝试。'],
    ['tension_curiosity_gap', 20, 18, '匿名免费模型身份揭晓，并与此前 100T 声称形成跨日反转。'],
    ['why_now_window', 20, 19, '正式身份与实测刚出现，旧额度证据此时才具备重新解释价值。'],
    ['save_share_comment_motive', 20, 17, '额度、调用次数、耗时和成本适合保存对比并讨论真实性。'],
    ['evidence_credibility', 15, 10, '有两条可追溯来源，但 100T 与算力提供方仍需独立核验。'],
    ['account_fit', 5, 5, '符合面向普通用户解释 AI 产品真实价值与使用门槛的定位。']
  ].map(([criterion, weight, score, reason]) => ({ criterion, weight, score, reason }));
  const existingPlan = db.prepare(`SELECT p.id,p.revision,pi.id AS planItemId FROM plans p JOIN plan_items pi ON pi.plan_id=p.id
    WHERE p.plan_date=? AND p.is_current=1 AND pi.title=? AND pi.source_ids_json=? LIMIT 1`).get(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
      'GLM-5.3 Flash 免费 100T：真正值得关注的不是“免费”两个字', JSON.stringify([oldSourceId, currentSourceId])
    );
  const plan = existingPlan ?? saveCurrentPlan(db, {
    planDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    timezone: 'Asia/Shanghai',
    summary: 'GLM-5.3-Flash 身份揭晓后，重新激活 Ox Alpha 的 100T 免费额度历史证据，并保留算力来源核验缺口。',
    candidateSources: [{ sourceId: oldSourceId, sourceRevision: 16 }, { sourceId: currentSourceId, sourceRevision: 1 }],
    sourceDecisions: [
      { sourceId: oldSourceId, decision: 'selected', reasonCode: 'REACTIVATED_CROSS_DAY_EVIDENCE', reason: '身份揭晓后，旧的 100T 免费额度声称成为当前选题不可缺少的跨日证据。' },
      { sourceId: currentSourceId, decision: 'selected', reasonCode: 'IDENTITY_AND_OUTCOME_EVIDENCE', reason: '该资料同时提供正式身份与可量化任务实测，支撑为什么现在值得重判。' }
    ],
    items: [{
      topicId: topic.id, title: 'GLM-5.3 Flash 免费 100T：真正值得关注的不是“免费”两个字', priority: 1,
      whyNow: 'Ox Alpha 的正式身份刚被揭晓为 GLM-5.3-Flash，使 6 天前的 100T 免费容量声称与最新任务实测第一次能放进同一条证据链。',
      timeliness: 'today', targetAudience: '正在选择低成本 AI Coding 与 Agent 模型的开发者和内容创作者',
      angle: '把发布身份、历史额度声称和真实任务成本拆开核验，不用“免费”替代产品判断。',
      pointOfView: '这条新闻真正的价值，是一个可用 100T 声称与 0.01 美元任务实测交叉验证的新模型入口；但在算力提供方和额度兑现机制核实前，不能把“国产算力集群提供 100T”当成事实。',
      platforms: ['wechat', 'x', 'xiaohongshu'], formats: ['article'],
      titleGuidance: '先写身份揭晓与 100T 冲突，再把“免费是否真能用”作为判断主线。',
      openingGuidance: '开头直接给出 Ox Alpha=GLM-5.3-Flash，以及 12 次工具调用、2 分 50 秒、0.01 美元的实测数字。',
      structureGuidance: '身份揭晓→旧 100T 声称为何被重新激活→实测数据→已证实/未证实边界→普通用户如何判断是否值得用。',
      effortEstimate: '60–90 分钟，需补充官方额度条款与算力提供方核验。',
      sourceIds: [oldSourceId, currentSourceId],
      availableMaterials: ['Ox Alpha 每日 100T 免费容量的历史来源', 'Ox Alpha=GLM-5.3-Flash 的身份来源', '12 次工具调用、2 分 50 秒、0.01 美元的任务实测'],
      missingMaterials: ['100T 免费额度的官方条款与持续时间', '国产算力集群是否为额度提供方的可靠证据', '独立第三方的稳定性与限流测试'],
      scoreReasons: { status: 'scored', score: 87, reasons: scoreReasons }
    }]
  });
  const item = db.prepare('SELECT id,planning_status AS planningStatus,score_reasons_json AS scoreReasonsJson FROM plan_items WHERE plan_id=?').get(plan.id);
  assert.equal(item.planningStatus, 'ready_for_review');
  const decisions = db.prepare('SELECT source_id AS sourceId,source_revision AS sourceRevision,decision,reason_code AS reasonCode,reason,plan_item_id AS planItemId FROM plan_source_decisions WHERE plan_id=? ORDER BY source_id').all(plan.id);
  assert.equal(decisions.length, 2);
  const detail = getProposalDetail(db, item.id);
  assert.ok(detail);
  assert.equal(detail.sources.length, 2);
  assert.equal(detail.sourceDecisions.length, 2);
  assert.ok(JSON.stringify(detail).includes('国产算力集群'));

  console.log(JSON.stringify({ ok: true, databasePath, schemaVersion: db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version,
    sourceIds: [oldSourceId, currentSourceId], topic: topicRow, entity: { ...entity, aliases: JSON.parse(entity.aliasesJson) },
    links, jobs, receiptCount: receipts.length, receipts, plan, planItem: { id: item.id, planningStatus: item.planningStatus, score: JSON.parse(item.scoreReasonsJson).score }, decisions,
    detailReadback: { title: detail.item.title, sources: detail.sources.map((source) => source.id), decisionCount: detail.sourceDecisions.length, evidenceGaps: detail.evidenceGaps }
  }, null, 2));
} finally {
  db.close();
  await stopPersistentKnowledgeJobs();
}
