import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { writeSourceBodyCache } from '../src/main/source-body-cache.ts';
import { compileSourceKnowledge, sourceCompileRequestId } from '../src/main/knowledge-compiler.ts';
import {
  KNOWLEDGE_CANDIDATES_MANIFEST_KEY,
  downgradeConclusionStatus,
  extractKnowledgeCandidatesManifest,
  generateKnowledgeCandidatePlan,
  knowledgeCandidatePlanHash,
  normalizeKnowledgeCandidatesManifest,
  verifyCandidateLocator
} from '../src/main/knowledge-candidates.ts';

/**
 * WMB-5228 生产知识候选生成上游聚焦测试（真实 SQLite + 注入 fake 模型）。
 * 覆盖：合法计划（含排序与 compileSourceKnowledge 可消费）；locator 门（可定位晋升 /
 * 不可定位结构化跳过）；伪 supported/contradicted/disputed 机器降级；非法 manifest 整批
 * 失败（无围栏/坏 JSON/缺键/未知字段/缺必填/枚举非法/外层未知键/多 manifest 块/模型异常）；
 * 重复 canonicalKey 整批失败；低价值 → 合法空计划；同输入同输出字节稳定（含乱序 manifest）。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
test('WMB-5228 knowledge candidate plan upstream contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5228-'));
  let database;
  try {
    database = migrateDatabase(path.join(directory, 'wmb.db'));
    const now = new Date().toISOString();
    database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)")
      .run(now, now);

    let checks = 0;
    function check(label, condition, detail = '') {
      checks += 1;
      if (!condition) throw new Error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
    }

    // ============ 固定 fixture：真实 Source（6 行摘要正文）+ 已关联 Topic ============
    const source = upsertSource(database, {
      originalUrl: 'https://news.example/agentforge-v2-launch',
      title: 'AgentForge v2 官方公告',
      author: 'AgentForge Team',
      publishedAt: '2026-08-12T00:00:00.000Z',
      summary: [
        'AgentForge v2 正式发布，支持多模型路由。',
        '路由策略支持成本优先与质量优先两种模式。',
        '官方定价为每百万 token 0.8 美元。',
        '社区反馈称高峰时段延迟明显上升。',
        '团队承诺下季度修复延迟问题。',
        '平台限制：企业版暂不支持私有化部署。'
      ].join('\n')
    });
    const topic = upsertKnowledgeTopic(database, { title: 'AI Agent 工具链' });
    check('fixture Source 已保存（r1）', source.revision === 1);
    check('fixture Topic 已保存', Boolean(topic.id));
    const baseInput = { workspaceId: 'ws-a', sourceId: source.id, topicId: topic.id };

    function modelOf(text) {
      return async () => text;
    }
    function fenced(manifest) {
      return `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
    }

    // ============ A. 合法计划：冻结 + 排序 + 字段完整 + prompt 确定 ============
    const manifestA = {
      [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: {
        reason: 'AgentForge v2 发布带来多模型路由与定价信息，值得晋升。',
        topicCompile: { title: 'AgentForge 研究', summary: '官方发布信息汇总' },
        entities: [
          { entityType: 'product', canonicalKey: 'agentforge', canonicalName: 'AgentForge', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方产品身份，可独立验证。' },
          { entityType: 'platform', canonicalKey: 'zzz-late-entity', canonicalName: '延迟平台', excerpt: '社区反馈称高峰时段延迟明显上升。', valueRationale: '社区反馈案例身份。' }
        ],
        notes: [
          { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: 'AgentForge v2 支持多模型路由。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方发布，可验证。' },
          { kind: 'claim', canonicalKey: 'agentforge-v2-pricing', statement: 'AgentForge 官方定价为每百万 token 0.8 美元。', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L3', excerpt: '官方定价为每百万 token 0.8 美元。', valueRationale: '明确数字，未来复用。' }
        ]
      }
    };
    const a = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf(fenced(manifestA)) });
    check('A ok 且零跳过零降级', a.ok === true && a.skipped.length === 0 && a.downgraded.length === 0);
    const planA = a.plan;
    check('A requestId 稳定（sourceCompileRequestId）', planA.requestId === sourceCompileRequestId(source.id, source.revision));
    check('A 冻结字段（sourceId/revision/topicId/workspaceId/scope）',
      planA.sourceId === source.id && planA.sourceRevision === source.revision
      && planA.topicId === topic.id && planA.workspaceId === 'ws-a' && planA.scope === 'global');
    check('A reason + topicCompile 透传', planA.reason === manifestA[KNOWLEDGE_CANDIDATES_MANIFEST_KEY].reason
      && planA.topicCompile.title === 'AgentForge 研究' && planA.topicCompile.summary === '官方发布信息汇总');
    check('A Entity 按 canonicalKey 排序', planA.entities.map((e) => e.canonicalKey).join(',') === 'agentforge,zzz-late-entity');
    check('A Entity 字段完整',
      planA.entities[0].entityType === 'product' && planA.entities[0].canonicalName === 'AgentForge'
      && planA.entities[0].valueRationale.includes('官方产品') && !('excerpt' in planA.entities[0]));
    check('A Note 按 canonicalKey 排序',
      planA.notes.map((n) => n.canonicalKey).join(',') === 'agentforge-v2-multi-router,agentforge-v2-pricing');
    check('A Note 字段完整（含 locator/excerpt/证据）',
      planA.notes[0].kind === 'claim' && planA.notes[0].conclusionStatus === 'supported'
      && planA.notes[0].evidenceLevel === 'corroborated' && planA.notes[0].locator === 'L1'
      && planA.notes[0].excerpt === 'AgentForge v2 正式发布，支持多模型路由。'
      && planA.notes[1].locator === 'L3' && planA.notes[1].evidenceLevel === 'primary');
    check('A 计划整体冻结', Object.isFrozen(planA) && Object.isFrozen(planA.notes) && Object.isFrozen(planA.entities));
    check('A prompt 含冻结 Source 与 Topic 上下文',
      a.prompt.includes('AgentForge v2 官方公告') && a.prompt.includes('AgentForge v2 正式发布') && a.prompt.includes('AI Agent 工具链'));
    check('A frozen 快照（bodyKind=summary）',
      a.frozen.sourceId === source.id && a.frozen.sourceRevision === 1 && a.frozen.bodyKind === 'summary');

    // ============ B. locator 门：可定位晋升 / 不可定位结构化跳过 ============
    const manifestB = {
      [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: {
        reason: 'locator 门测试。',
        entities: [
          { entityType: 'product', canonicalKey: 'ok-entity', canonicalName: 'OK', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: 'x' },
          { entityType: 'product', canonicalKey: 'no-excerpt-entity', canonicalName: 'NoExcerpt', valueRationale: 'x' },
          { entityType: 'product', canonicalKey: 'bad-excerpt-entity', canonicalName: 'BadExcerpt', excerpt: '这句话完全不在正文里。', valueRationale: 'x' }
        ],
        notes: [
          { kind: 'claim', canonicalKey: 'ok-note', statement: '支持成本优先路由。', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L2', excerpt: '路由策略支持成本优先与质量优先两种模式。', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'span-note', statement: '前三行可定位。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1-3', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'excerpt-miss-note', statement: 'excerpt 不匹配。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L2', excerpt: '完全不存在于正文的一句话', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'out-of-range-note', statement: '行号越界。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L99', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'out-of-order-note', statement: '行序乱序。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L5-3', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'malformed-note', statement: 'locator 格式非法。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'P12', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'zero-note', statement: '0 行非法。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L0', valueRationale: 'x' }
        ]
      }
    };
    const b = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf(fenced(manifestB)) });
    check('B ok', b.ok === true);
    const planB = b.plan;
    check('B 仅可定位 Note 进入计划（ok-note/span-note）',
      planB.notes.map((n) => n.canonicalKey).join(',') === 'ok-note,span-note');
    check('B 仅可定位 Entity 进入计划（ok-entity）', planB.entities.map((e) => e.canonicalKey).join(',') === 'ok-entity');
    const reasonsB = Object.fromEntries(b.skipped.map((s) => [s.canonicalKey, s.reasonCode]));
    check('B 不可定位 Note 结构化原因',
      reasonsB['excerpt-miss-note'] === 'EXCERPT_NOT_IN_LOCATOR_LINES'
      && reasonsB['out-of-range-note'] === 'LOCATOR_OUT_OF_RANGE'
      && reasonsB['out-of-order-note'] === 'LOCATOR_MALFORMED'
      && reasonsB['malformed-note'] === 'LOCATOR_MALFORMED'
      && reasonsB['zero-note'] === 'LOCATOR_MALFORMED');
    check('B 不可定位 Entity 结构化原因',
      reasonsB['no-excerpt-entity'] === 'ENTITY_EXCERPT_MISSING'
      && reasonsB['bad-excerpt-entity'] === 'ENTITY_EXCERPT_NOT_IN_BODY');
    check('B skipped 按 canonicalKey 排序',
      b.skipped.every((s, i, arr) => i === 0 || arr[i - 1].canonicalKey < s.canonicalKey));

    // ============ C. 伪 supported/disputed/contradicted 机器降级 ============
    const manifestC = {
      [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: {
        reason: '证据状态机测试。',
        notes: [
          { kind: 'claim', canonicalKey: 'claim-weak', statement: 'A', conclusionStatus: 'supported', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' },
          { kind: 'insight', canonicalKey: 'insight-weak', statement: 'B', conclusionStatus: 'contradicted', evidenceLevel: 'insufficient', locator: 'L1', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'claim-strong', statement: 'C', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', valueRationale: 'x' },
          { kind: 'claim', canonicalKey: 'claim-disputed-weak', statement: 'D', conclusionStatus: 'disputed', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' }
        ]
      }
    };
    const c = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf(fenced(manifestC)) });
    check('C ok', c.ok === true);
    const statusC = Object.fromEntries(c.plan.notes.map((n) => [n.canonicalKey, n.conclusionStatus]));
    check('C claim+none → unverified；insight+insufficient → inference；强证据保持 supported',
      statusC['claim-weak'] === 'unverified' && statusC['insight-weak'] === 'inference'
      && statusC['claim-strong'] === 'supported' && statusC['claim-disputed-weak'] === 'unverified');
    check('C 降级记录完整（from/to）',
      c.downgraded.length === 3
      && c.downgraded.some((d) => d.canonicalKey === 'claim-weak' && d.from === 'supported' && d.to === 'unverified')
      && c.downgraded.some((d) => d.canonicalKey === 'insight-weak' && d.from === 'contradicted' && d.to === 'inference')
      && c.downgraded.some((d) => d.canonicalKey === 'claim-disputed-weak' && d.from === 'disputed' && d.to === 'unverified'));

    // ============ D. 非法 manifest / 模型异常：整批失败（零计划） ============
    async function expectFail(label, text, code) {
      const result = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf(text) });
      check(label, result.ok === false && result.error.code === code, JSON.stringify(result.error));
    }
    await expectFail('D 无围栏 → MANIFEST_NOT_FOUND', '模型只输出普通文字', 'MANIFEST_NOT_FOUND');
    await expectFail('D 坏 JSON → MANIFEST_JSON_INVALID', '```json\n{ 不是合法 json\n```', 'MANIFEST_JSON_INVALID');
    await expectFail('D 缺 manifest 键 → MANIFEST_KEY_MISSING', fenced({ other: 1 }), 'MANIFEST_KEY_MISSING');
    await expectFail('D 外层未知键 → MANIFEST_INVALID',
      `\`\`\`json\n{ "${KNOWLEDGE_CANDIDATES_MANIFEST_KEY}": { "reason": "x" }, "extra": 1 }\n\`\`\``, 'MANIFEST_INVALID');
    await expectFail('D Note 未知字段 → MANIFEST_INVALID',
      fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', notes: [{ kind: 'claim', canonicalKey: 'k', statement: 's', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x', extraField: 1 }] } }),
      'MANIFEST_INVALID');
    await expectFail('D Note 缺必填（statement）→ MANIFEST_INVALID',
      fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', notes: [{ kind: 'claim', canonicalKey: 'k', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' }] } }),
      'MANIFEST_INVALID');
    await expectFail('D Note 枚举非法（conclusionStatus）→ MANIFEST_INVALID',
      fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', notes: [{ kind: 'claim', canonicalKey: 'k', statement: 's', conclusionStatus: 'confirmed', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' }] } }),
      'MANIFEST_INVALID');
    await expectFail('D Entity 缺必填（valueRationale）→ MANIFEST_INVALID',
      fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', entities: [{ entityType: 'product', canonicalKey: 'k', canonicalName: 'n' }] } }),
      'MANIFEST_INVALID');
    await expectFail('D kind=question+supported → MANIFEST_INVALID',
      fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', notes: [{ kind: 'question', canonicalKey: 'q', statement: 's', conclusionStatus: 'supported', evidenceLevel: 'primary', locator: 'L1', valueRationale: 'x' }] } }),
      'MANIFEST_INVALID');
    await expectFail('D 两个 manifest 块 → MANIFEST_AMBIGUOUS',
      `${fenced(manifestA)}\n${fenced(manifestA)}`, 'MANIFEST_AMBIGUOUS');
    const thrown = await generateKnowledgeCandidatePlan(database, {
      ...baseInput, modelCall: async () => { throw new Error('boom'); }
    });
    check('D 模型抛错 → MODEL_CALL_FAILED', thrown.ok === false && thrown.error.code === 'MODEL_CALL_FAILED');
    const emptyText = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf('   ') });
    check('D 空输出 → MODEL_CALL_FAILED', emptyText.ok === false && emptyText.error.code === 'MODEL_CALL_FAILED');
    const missingInput = await generateKnowledgeCandidatePlan(database, { ...baseInput, sourceId: '', modelCall: modelOf('x') });
    check('D 输入非法 → INPUT_INVALID', missingInput.ok === false && missingInput.error.code === 'INPUT_INVALID');
    const ghostSource = await generateKnowledgeCandidatePlan(database, { ...baseInput, sourceId: 'ghost-source', modelCall: modelOf('x') });
    check('D 幽灵 Source → SOURCE_NOT_FOUND', ghostSource.ok === false && ghostSource.error.code === 'SOURCE_NOT_FOUND');
    const ghostTopic = await generateKnowledgeCandidatePlan(database, { ...baseInput, topicId: 'ghost-topic', modelCall: modelOf('x') });
    check('D 幽灵 Topic → TOPIC_NOT_FOUND', ghostTopic.ok === false && ghostTopic.error.code === 'TOPIC_NOT_FOUND');

    // ---- D2. 纯函数直接校验 ----
    check('D2 normalize(null) 失败', normalizeKnowledgeCandidatesManifest(null).ok === false);
    check('D2 normalize(数组) 失败', normalizeKnowledgeCandidatesManifest([1]).ok === false);
    const twoFences = '```json\n{"other": 1}\n```' + '\n' + fenced(manifestA);
    check('D2 多围栏恰一个 manifest → ok', extractKnowledgeCandidatesManifest(twoFences).ok === true);
    check('D2 verifyCandidateLocator 空正文 → LOCATOR_NO_BODY',
      verifyCandidateLocator('', 'L1').ok === false && verifyCandidateLocator('', 'L1').reasonCode === 'LOCATOR_NO_BODY');
    check('D2 excerpt 不在定位行 → EXCERPT_NOT_IN_LOCATOR_LINES',
      verifyCandidateLocator('a\nb', 'L2', 'x').reasonCode === 'EXCERPT_NOT_IN_LOCATOR_LINES');
    check('D2 空白折叠匹配 → ok', verifyCandidateLocator('a  \n b ', 'L2', 'b').ok === true);
    check('D2 单行定位 → ok', verifyCandidateLocator('a\nb\nc', 'L2').ok === true);
    check('D2 纯降级函数 claim→unverified / insight→inference / 强证据不变',
      downgradeConclusionStatus('claim', 'supported', 'none').status === 'unverified'
      && downgradeConclusionStatus('insight', 'supported', 'none').status === 'inference'
      && downgradeConclusionStatus('claim', 'supported', 'single').downgraded === false);

    // ============ E. 重复 canonicalKey：整批失败 ============
    const dupNotes = await generateKnowledgeCandidatePlan(database, {
      ...baseInput,
      modelCall: modelOf(fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', notes: [
        { kind: 'claim', canonicalKey: 'dup-key', statement: 's1', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' },
        { kind: 'claim', canonicalKey: 'dup-key', statement: 's2', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' }
      ] } }))
    });
    check('E Note 重复键 → MANIFEST_DUPLICATE_KEY',
      dupNotes.ok === false && dupNotes.error.code === 'MANIFEST_DUPLICATE_KEY' && dupNotes.error.details.keys.length === 1);
    const dupEntities = await generateKnowledgeCandidatePlan(database, {
      ...baseInput,
      modelCall: modelOf(fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', entities: [
        { entityType: 'product', canonicalKey: 'dup-ent', canonicalName: 'n1', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: 'x' },
        { entityType: 'product', canonicalKey: 'dup-ent', canonicalName: 'n2', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: 'x' }
      ] } }))
    });
    check('E Entity 重复键 → MANIFEST_DUPLICATE_KEY',
      dupEntities.ok === false && dupEntities.error.code === 'MANIFEST_DUPLICATE_KEY');

    // ============ F. 低价值：合法空计划 ============
    const lowValue = await generateKnowledgeCandidatePlan(database, {
      ...baseInput,
      modelCall: modelOf(fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: '纯复述，不晋升。', notes: [
        { kind: 'claim', canonicalKey: 'restate-1', statement: '复述 A', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', changeType: 'no_change', valueRationale: 'x' },
        { kind: 'claim', canonicalKey: 'restate-2', statement: '复述 B', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L2', changeType: 'no_change', valueRationale: 'x' }
      ] } }))
    });
    check('F 纯复述 → 合法空计划（零 Note）+ 结构化原因',
      lowValue.ok === true && lowValue.plan.notes.length === 0
      && lowValue.skipped.length === 2
      && lowValue.skipped.every((s) => s.reasonCode === 'LOW_VALUE_RESTATEMENT'));
    const emptyManifest = await generateKnowledgeCandidatePlan(database, {
      ...baseInput,
      modelCall: modelOf(fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: '无增量。' } }))
    });
    check('F 空 manifest → 合法空计划（entities/notes 均空）',
      emptyManifest.ok === true && emptyManifest.plan.entities.length === 0
      && emptyManifest.plan.notes.length === 0 && emptyManifest.skipped.length === 0);
    check('F 空计划整体冻结', Object.isFrozen(emptyManifest.plan));
    const planEmpty = emptyManifest.plan;

    // ============ G. 确定性：同输入同输出字节稳定（含乱序 manifest） ============
    const g1 = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf(fenced(manifestA)) });
    const g2 = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf(fenced(manifestA)) });
    check('G 同输入两次 → plan 字节相同', JSON.stringify(g1.plan) === JSON.stringify(g2.plan));
    check('G 同输入两次 → prompt 字节相同', g1.prompt === g2.prompt);
    check('G 同输入两次 → hash 相同', knowledgeCandidatePlanHash(g1.plan) === knowledgeCandidatePlanHash(g2.plan));
    const reordered = { [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: {
      reason: manifestA[KNOWLEDGE_CANDIDATES_MANIFEST_KEY].reason,
      topicCompile: manifestA[KNOWLEDGE_CANDIDATES_MANIFEST_KEY].topicCompile,
      entities: [...manifestA[KNOWLEDGE_CANDIDATES_MANIFEST_KEY].entities].reverse(),
      notes: [...manifestA[KNOWLEDGE_CANDIDATES_MANIFEST_KEY].notes].reverse()
    } };
    const g3 = await generateKnowledgeCandidatePlan(database, { ...baseInput, modelCall: modelOf(fenced(reordered)) });
    check('G 乱序 manifest → 同一计划字节（按 canonicalKey 稳定排序）',
      JSON.stringify(g3.plan) === JSON.stringify(g1.plan));
    const different = await generateKnowledgeCandidatePlan(database, {
      ...baseInput,
      modelCall: modelOf(fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: '另一个原因。', notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-multi-router', statement: '不同的陈述。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', valueRationale: 'x' }
      ] } }))
    });
    check('G 不同输入 → 计划字节不同（非恒等）', JSON.stringify(different.plan) !== JSON.stringify(g1.plan));

    // ============ H. 计划可直接传给 compileSourceKnowledge ============
    const compiled = compileSourceKnowledge(database, planA);
    check('H 合法计划可编译（2 Entity / 2 Note / 2 证据 / 1 Wiki）',
      compiled.ok === true && compiled.replay === false
      && compiled.counts.entitiesCreated === 2 && compiled.counts.notesCreated === 2
      && compiled.counts.noteVersionsCreated === 2 && compiled.counts.evidenceLinks === 2
      && compiled.counts.wikiPagesCompiled === 1);
    const compiledEmpty = compileSourceKnowledge(database, {
      ...planEmpty,
      requestId: `${sourceCompileRequestId(source.id, source.revision)}:lowvalue-check`
    });
    check('H 低价值空计划可编译（零 Note/零 Wiki，receipt 持久）',
      compiledEmpty.ok === true && compiledEmpty.counts.notesCreated === 0
      && compiledEmpty.counts.wikiPagesCompiled === 0 && compiledEmpty.receipt !== null);

    // ============ I. 正文缓存优先（body_cache ready > summary）与无正文 ============
    const source2 = upsertSource(database, { originalUrl: 'https://news.example/body-cached', title: '正文缓存来源' });
    const bodyText = [
      '第一行：正文缓存内容。',
      '第二行：可定位的行。'
    ].join('\n');
    writeSourceBodyCache(database, {
      sourceId: source2.id,
      url: 'https://news.example/body-cached',
      status: 'ready',
      contentType: 'text/plain',
      extractedText: bodyText,
      extractedChars: bodyText.length,
      errorMessage: null,
      fetchedAt: now,
      updatedAt: now
    });
    const bodyCached = await generateKnowledgeCandidatePlan(database, {
      ...baseInput,
      sourceId: source2.id,
      modelCall: modelOf(fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', notes: [
        { kind: 'claim', canonicalKey: 'cached-note', statement: '正文缓存可定位。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L2', excerpt: '第二行：可定位的行。', valueRationale: 'x' }
      ] } }))
    });
    check('I body_cache ready 优先 → bodyKind=body_cache 且 L2 定位成功',
      bodyCached.ok === true && bodyCached.frozen.bodyKind === 'body_cache'
      && bodyCached.plan.notes.length === 1 && bodyCached.plan.notes[0].locator === 'L2');
    const source3 = upsertSource(database, { originalUrl: 'https://news.example/no-body', title: '无正文来源' });
    const noBody = await generateKnowledgeCandidatePlan(database, {
      ...baseInput,
      sourceId: source3.id,
      modelCall: modelOf(fenced({ [KNOWLEDGE_CANDIDATES_MANIFEST_KEY]: { reason: 'x', notes: [
        { kind: 'claim', canonicalKey: 'no-body-note', statement: '无法定位。', conclusionStatus: 'unverified', evidenceLevel: 'none', locator: 'L1', valueRationale: 'x' }
      ] } }))
    });
    check('I 无正文（无缓存无摘要）→ bodyKind=none 且 Note 以 LOCATOR_NO_BODY 跳过',
      noBody.ok === true && noBody.frozen.bodyKind === 'none'
      && noBody.plan.notes.length === 0
      && noBody.skipped.some((s) => s.canonicalKey === 'no-body-note' && s.reasonCode === 'LOCATOR_NO_BODY'));

    database.close();
    database = null;
    console.log(`WMB-5228 test: ${checks} checks passed`);
  } finally {
    if (database) {
      try { database.close(); } catch { /* 断言失败路径：先释放句柄再清理目录 */ }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
