import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { classifyRecommendationItem, isValidPropagationV2Reasons } from '../src/shared/propagation.ts';
import { validateEditorialDecision } from '../src/shared/editorial-thesis.ts';
import { validateEditorialKnowledgeRefs } from '../src/main/planning-stage.ts';

const legacyGlmScore = {
  status: 'scored',
  score: 87,
  scoredAt: '2026-08-28T10:00:00.000Z',
  reasons: [
    { criterion: 'reader_immediacy_benefit', weight: 20, score: 18, reason: '免费额度帮助用户判断是否尝试' },
    { criterion: 'tension_curiosity_gap', weight: 20, score: 18, reason: '匿名模型身份揭晓' },
    { criterion: 'why_now_window', weight: 20, score: 19, reason: '身份刚刚公开' },
    { criterion: 'save_share_comment_motive', weight: 20, score: 17, reason: '适合讨论免费是否真实' },
    { criterion: 'evidence_credibility', weight: 15, score: 10, reason: '两条可追溯来源' },
    { criterion: 'account_fit', weight: 5, score: 5, reason: '符合 AI 工具受众' },
  ],
};

function legacyGlmPlanItem() {
  return {
    planning_status: 'ready_for_review',
    plan_date: '2026-08-28',
    title: 'GLM-5.3 Flash 免费 100T：真正值得关注的不是“免费”两个字',
    why_now: 'Ox Alpha 身份刚揭晓，使六天前的 100T 免费容量声称与任务实测第一次进入同一证据链。',
    timeliness: '热点 2-3 天',
    target_audience: '正在选择低成本 AI Coding 与 Agent 模型的开发者和内容创作者',
    angle: '核验免费额度和真实任务成本，不用免费替代产品判断。',
    point_of_view: '真正价值是低成本模型入口，但需要继续核验额度机制。',
    platforms_json: '["wechat","x","xiaohongshu"]',
    formats_json: '["article"]',
    title_guidance: '把免费是否真能用作为判断主线。',
    opening_guidance: '开头给出身份和任务实测数字。',
    structure_guidance: '身份揭晓→额度声称→实测数据→证据边界→使用判断',
    effort_estimate: '60–90 分钟',
    source_ids_json: '["source-100t","source-identity"]',
    available_materials_json: '["100T 声称","身份揭晓","任务实测"]',
    missing_materials_json: '["国产算力承载证据"]',
    score_reasons_json: JSON.stringify(legacyGlmScore),
    planning_provenance_json: JSON.stringify({
      origin: 'daily_judge',
      transitions: [{ from: 'draft', to: 'ready_for_review', by: 'planner', at: '2026-08-28T10:00:00.000Z' }],
    }),
  };
}

test('WMB-5364 reproduces the GLM bug: a complete, high-scoring single safe thesis must not be approvable', () => {
  const result = classifyRecommendationItem(legacyGlmPlanItem(), {
    businessDate: '2026-08-28',
    asOf: new Date('2026-08-28T12:00:00.000Z'),
  });

  assert.deepEqual(result, {
    kind: 'invalid',
    reasonCode: 'thesis_competition_missing',
    reason: '缺少事件层、用户层、产业或社会层的中心主张竞争与赢家依据',
  });
});

test('WMB-5364 accepts three distinct meaning levels only when the highest-value supported thesis wins', () => {
  const decision = {
    version: 'editorial_thesis_v1',
    candidates: [
      { level: 'event', thesis: 'Ox Alpha 正式揭晓为 GLM-5.3-Flash', claimType: 'fact', evidenceStatus: 'supported', evidenceBoundary: '官方身份映射', score: 51, reason: '信息明确但只是发布事件' },
      { level: 'user', thesis: '100T 免费额度让开发者获得低成本模型入口', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: '额度声称只证明服务入口，不证明长期兑现', score: 70, reason: '有即时利益但容易退化为产品测评' },
      { level: 'industry_or_society', thesis: '国产算力开始承接大规模公共 AI 服务是本次新闻最重要的产业信号', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: '国产芯片承载流量与 100T 服务规模交叉支持商业化信号，不等于已证明全行业成熟', score: 91, reason: '改变国产算力仍停留在实验室的旧认知' },
    ],
    winnerLevel: 'industry_or_society',
    winnerThesis: '国产算力开始承接大规模公共 AI 服务是本次新闻最重要的产业信号',
    winnerReason: '产业变化比免费使用判断更重要、更可转述',
    knowledgeContext: { status: 'used', contextRefs: ['knowledge-package-glm'], queryDimensions: ['国产芯片', '商业推理服务', '免费容量'], reason: '用于判断该事件是否改变既有产业阶段' },
  };
  assert.equal(validateEditorialDecision(decision, decision.winnerThesis).valid, true);

  const score = {
    status: 'scored', version: 'propagation_v2', score: 91,
    truthGate: { status: 'passed', reason: '事实、推断与观点边界完整', claims: [
      { text: '测试流量由国产 AI 芯片承载', type: 'fact', status: 'supported', sourceIds: ['source-domestic-chip'] },
      { text: '这是国产算力商业服务规模扩大的信号', type: 'inference', status: 'supported', sourceIds: ['source-domestic-chip', 'source-100t'] },
    ] },
    reasons: [
      { criterion: 'reality_change_significance', weight: 25, score: 24, reason: '从实验能力跨到公共商业服务' },
      { criterion: 'tension_curiosity_gap', weight: 20, score: 18, reason: '免费模型背后是国产算力商业化' },
      { criterion: 'audience_stakes', weight: 20, score: 18, reason: '影响开发者对国产基础设施能力的判断' },
      { criterion: 'why_now_window', weight: 15, score: 14, reason: '模型身份刚公开，跨日证据首次闭环' },
      { criterion: 'one_sentence_relayability', weight: 15, score: 12, reason: '一句话即可转述产业变化' },
      { criterion: 'account_fit', weight: 5, score: 5, reason: '符合 AI 时代认知栏目' },
    ],
  };
  assert.equal(isValidPropagationV2Reasons(score), true);
});

test('WMB-5364 knowledge receipt rejects invented refs and accepts a real fixed version', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_wiki_page_versions (id TEXT PRIMARY KEY, page_id TEXT NOT NULL);
    CREATE TABLE knowledge_note_versions (id TEXT PRIMARY KEY, note_id TEXT NOT NULL);
    CREATE TABLE knowledge_evidence_links (id TEXT PRIMARY KEY);
    INSERT INTO knowledge_wiki_page_versions VALUES ('version-glm','page-glm');
  `);
  const decision = {
    version: 'editorial_thesis_v1',
    candidates: [
      { level: 'event', thesis: 'GLM 模型身份公开', claimType: 'fact', evidenceStatus: 'supported', evidenceBoundary: '只确认身份', score: 40, reason: '事件层' },
      { level: 'user', thesis: '开发者获得低成本模型入口', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: '只确认可用入口', score: 60, reason: '用户层' },
      { level: 'industry_or_society', thesis: '国产算力开始承接大规模公共 AI 服务', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: '只作为商业服务规模扩大的信号', score: 90, reason: '产业层' },
    ],
    winnerLevel: 'industry_or_society', winnerThesis: '国产算力开始承接大规模公共 AI 服务', winnerReason: '现实变化最大',
    knowledgeContext: { status: 'used', contextRefs: ['wiki_page:page-glm:missing'], queryDimensions: ['GLM', '国产算力产业关联'], reason: '核对产业阶段' },
  };
  assert.throws(() => validateEditorialKnowledgeRefs(db, decision, decision.winnerThesis), (error) => error?.errors?.includes('knowledge_context_ref_not_found'));
  decision.knowledgeContext.contextRefs = ['wiki_page:page-glm:version-glm'];
  assert.doesNotThrow(() => validateEditorialKnowledgeRefs(db, decision, decision.winnerThesis));
  db.close();
});

test('WMB-5364 historical blind benchmark freezes exactly 20 real plan item identities with no regression', () => {
  const benchmark = JSON.parse(readFileSync(new URL('../.ai/wmb-5364-historical-blind-benchmark.json', import.meta.url), 'utf8'));
  const expected = [
    '66e77c11-8252-47d8-86f5-2e5515c022cb','fbb6a8fd-e386-4092-85de-122d1af56f1f','2d915956-a6e4-4cc9-ba76-0e6473a0c2d9','e2d60cd8-92b1-49fe-a30f-92ccbc88a0e1','6e07efde-1e95-4714-89d1-3596af6253eb','c5e08c46-e90a-4c92-89d9-10daefd94540','049be40c-8b5b-4489-82cf-eff68ca403b6','907a3e16-6156-499d-9710-26f5b7f9b5cd','8f5f6336-7e85-475d-9500-c4d8b0565f82','350297c6-0503-46f9-a50f-e24cbcad368e','c99e5fe8-6d7e-44a2-bb1a-aca79ae66f44','d4cf9aa2-6511-4ca4-8a38-62ec2eeba8b6','55a17dc2-8792-4812-b653-8412639c31ed','37e804e5-2412-4821-bc56-bd586e29441d','72a9eb9f-a7ca-473f-bff5-9930d0340768','ff64172d-1589-48eb-950f-c6fdcbd8b21a','96829073-3822-4c6d-8a3b-913e0be00bf9','b7e6fcf0-90be-4329-a226-00e34f226b7b','7e059a05-ef0b-4da4-bdcb-c7a2119744ec','155497fd-575c-4332-a118-832c36511159'
  ];
  assert.equal(benchmark.items.length, 20);
  assert.deepEqual(new Set(benchmark.items.map((item) => item.planItemId)), new Set(expected));
  assert.equal(benchmark.items.some((item) => item.result === 'regression'), false);
  assert.ok(benchmark.items.filter((item) => item.result === 'improved').length > benchmark.items.filter((item) => item.result === 'no_regression').length);
  const glm = benchmark.items.find((item) => item.planItemId === expected[0]);
  assert.equal(glm.winnerLevel, 'industry_or_society');
  assert.equal(glm.evidenceStatus, 'research_required');
});

test('WMB-5364 GLM industrial thesis wins only with supported domestic-compute evidence', () => {
  const base = {
    version: 'editorial_thesis_v1',
    candidates: [
      { level: 'event', thesis: 'Ox Alpha 被识别为 GLM-5.3-Flash', claimType: 'fact', evidenceStatus: 'supported', evidenceBoundary: '只确认身份映射', score: 50, reason: '事件明确但传播意义有限' },
      { level: 'user', thesis: '100T 免费额度提供低成本模型入口', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: '只确认服务声称，不保证长期兑现', score: 68, reason: '有用户利益但容易退化为工具测评' },
      { level: 'industry_or_society', thesis: '国产算力开始承接大规模公共 AI 服务', claimType: 'inference', evidenceStatus: 'supported', evidenceBoundary: '只说明商业服务规模扩大，不证明全行业成熟', score: 92, reason: '改变国产算力仍停留在实验室的旧认知' }
    ],
    winnerLevel: 'industry_or_society', winnerThesis: '国产算力开始承接大规模公共 AI 服务', winnerReason: '现实变化和转述价值最高',
    knowledgeContext: { status: 'no_relevant_context', contextRefs: [], queryDimensions: ['GLM-5.3-Flash', '国产算力商业服务'], reason: '机器测试不伪造知识版本' }
  };
  assert.equal(validateEditorialDecision(base, base.winnerThesis).valid, true);
  const unsupported = structuredClone(base);
  unsupported.candidates[2].evidenceStatus = 'research_required';
  const rejected = validateEditorialDecision(unsupported, unsupported.winnerThesis);
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.includes('thesis_winner_research_required'));
  assert.equal(isValidPropagationV2Reasons(legacyGlmScore), false);
});
