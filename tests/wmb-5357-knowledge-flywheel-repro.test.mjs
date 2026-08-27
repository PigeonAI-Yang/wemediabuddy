import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { recordKnowledgeBatch } = await import('../src/main/knowledge.ts');
const { assembleEditorialBrief } = await import('../src/main/editorial-brief.ts');
const { saveCurrentPlan } = await import('../src/main/planning.ts');
const {
  KNOWLEDGE_COMPILE_COMMAND,
  runSourceKnowledgeCompile
} = await import('../src/main/knowledge-compile-trigger.ts');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5357-'));
  const databasePath = path.join(root, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id',?,?,?,1)")
    .run(`ws-${randomUUID()}`, now, now);
  return { root, databasePath, database };
}

function compileDeps(databasePath) {
  return {
    databasePath,
    openDatabase: migrateDatabase,
    modelCall: async () => {
      throw new Error('model must not run when no Topic is linked');
    }
  };
}

function compileCounts(database) {
  return {
    operations: database.prepare('SELECT count(*) AS count FROM operation_log WHERE command=?')
      .get(KNOWLEDGE_COMPILE_COMMAND).count,
    receipts: database.prepare('SELECT count(*) AS count FROM knowledge_update_receipts').get().count
  };
}

test('WMB-5357 repro 1: a newly stored Source without Topic produces zero compile operation and receipt', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, {
      title: '新模型正式发布',
      originalUrl: 'https://example.test/model-release',
      summary: '模型发布、额度和基础设施信息仍待知识路由识别。'
    });

    const result = await runSourceKnowledgeCompile(compileDeps(state.databasePath), {
      sourceId: source.id,
      revision: source.revision
    });

    assert.deepEqual(result.topics, [], '编译器只解析已有 topic_source_links');
    assert.deepEqual(compileCounts(state.database), { operations: 0, receipts: 0 });
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5357 repro 2: linking the Topic later does not automatically back-compile the unchanged Source revision', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, {
      title: '待识别产品发布',
      originalUrl: 'https://example.test/later-identity',
      summary: '首日只知道代号，次日才确认产品身份。'
    });
    await runSourceKnowledgeCompile(compileDeps(state.databasePath), {
      sourceId: source.id,
      revision: source.revision
    });

    const linked = recordKnowledgeBatch(state.database, {
      items: [{ sourceId: source.id, topic: { title: '次日确认的产品身份' }, relation: 'primary' }]
    });
    assert.equal(linked.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(compileCounts(state.database), { operations: 0, receipts: 0 },
      'Topic 关系写入没有触发该 Source revision 的补编译');
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5357 repro 3: identity revealed after the watermark does not reactivate the older Source for Planner input', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, {
      title: '代号产品的早期线索',
      originalUrl: 'https://example.test/old-clue',
      summary: '旧线索在当日未能确认正式产品身份。'
    });
    state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?')
      .run('2026-08-26T00:00:00.000Z', source.id);
    recordKnowledgeBatch(state.database, {
      items: [{ sourceId: source.id, topic: { title: '2026-08-28 才确认的产品身份' }, relation: 'primary' }]
    });

    const brief = assembleEditorialBrief(state.database, {
      now: new Date('2026-08-28T08:00:00.000Z'),
      watermark: '2026-08-27T00:00:00.000Z'
    });

    assert.equal(brief.increment.sources.some((item) => item.id === source.id), false,
      '增量只按 collected_at > watermark 取 Source，后补 Topic 身份不会重新激活旧证据');
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5357 repro 4: approval query has complete fields but the open-card DOM path selects compact Opportunity projection', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, {
      title: '审批详情证据', originalUrl: 'https://example.test/approval', summary: '完整策划字段的证据来源。'
    });
    const saved = saveCurrentPlan(state.database, {
      planDate: '2026-08-28',
      timezone: 'Asia/Shanghai',
      summary: '审批详情复现',
      items: [{
        title: '不能只显示标题的方案', priority: 1, timeliness: '24h', whyNow: '现在值得讲',
        angle: '独特表达角度', pointOfView: '明确核心观点', targetAudience: '目标受众',
        platforms: ['wechat'], formats: ['article'], titleGuidance: '标题指导', openingGuidance: '开头指导',
        structureGuidance: '完整结构指导', effortEstimate: '2h', sourceIds: [source.id]
      }]
    });
    const item = state.database.prepare(`SELECT angle, point_of_view AS pointOfView,
      target_audience AS targetAudience, structure_guidance AS structureGuidance,
      source_ids_json AS sourceIds FROM plan_items WHERE plan_id=? AND title=?`)
      .get(saved.id, '不能只显示标题的方案');
    assert.ok(item, '方案完整字段已持久化');
    assert.equal(item.angle, '独特表达角度');
    assert.equal(item.pointOfView, '明确核心观点');
    assert.equal(item.targetAudience, '目标受众');
    assert.equal(item.structureGuidance, '完整结构指导');
    assert.deepEqual(JSON.parse(item.sourceIds), [source.id]);

    const renderer = await readFile(new URL('../src/renderer/proposals-view.tsx', import.meta.url), 'utf8');
    const opportunityCall = renderer.match(/<Opportunity[\s\S]*?\/>/)?.[0] ?? '';
    assert.match(opportunityCall, /item=\{planItem\}/);
    assert.doesNotMatch(opportunityCall, /\bprimary(?:=|\s)/,
      'Opportunity 未传 primary 时命中 today-view-parts 的 compact 分支，只渲染标题、whyNow 和标签');
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});
