import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { applyKnowledgeChangeSet } from '../src/main/knowledge-flywheel.ts';
import { assembleEditorialBrief, renderEditorialBrief } from '../src/main/editorial-brief.ts';
import {
  drainPersistentKnowledgeJobs,
  enqueueKnowledgeReactivationJob,
  scheduleSourceKnowledgeCompileWith,
  stopPersistentKnowledgeJobs
} from '../src/main/knowledge-compile-trigger.ts';
import {
  KNOWLEDGE_ROUTE_MANIFEST_KEY,
  extractKnowledgeRouteManifest,
  resolveKnowledgeRoute
} from '../src/main/knowledge-routing.ts';
import { findHistoricalKnowledgeSources } from '../src/main/knowledge-reactivation.ts';

function fenced(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5359-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id','ws-5359',?,?,1)")
    .run(now, now);
  return { root, database, databasePath: path.join(root, 'wmb.db') };
}

function seedEntity(database, input) {
  const result = applyKnowledgeChangeSet(database, {
    workspaceId: 'ws-5359',
    requestId: `seed:${input.canonicalKey}`,
    reason: 'WMB-5359 fixture',
    triggerSource: 'ingest',
    resolutionMode: 'none',
    createdBy: 'migration'
  }, { entities: [input] });
  return result.changeSet?.id;
}

test('WMB-5359 route resolves a strong alias and keeps evidence gap unresolved', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, {
      title: 'GLM-5.3 Flash 发布',
      originalUrl: 'https://example.test/glm-flash',
      summary: 'GLM-5.3 Flash 正式发布，代号 Ox Alpha。每天提供 100T 免费额度。'
    });
    const topic = upsertKnowledgeTopic(state.database, { title: 'AI 模型发布' });
    seedEntity(state.database, {
      scope: 'global', entityType: 'product', canonicalKey: 'ox-alpha', canonicalName: 'Ox Alpha',
      aliases: [], valueRationale: 'fixture'
    });
    const manifest = {
      [KNOWLEDGE_ROUTE_MANIFEST_KEY]: {
        reason: '正式名称与旧代号在同一公告中被明确对应。',
        entityCandidates: [{
          entityType: 'product', canonicalKey: 'glm-5.3-flash', canonicalName: 'GLM-5.3 Flash',
          aliases: ['Ox Alpha'], identityStrength: 'strong', locator: 'L1',
          excerpt: 'GLM-5.3 Flash 正式发布，代号 Ox Alpha。'
        }],
        topicCandidates: [{
          topicId: topic.id, canonicalKey: 'ai-model-release', title: 'AI 模型发布', kind: 'theme',
          relation: 'primary', locator: 'L1', excerpt: 'GLM-5.3 Flash 正式发布，代号 Ox Alpha。'
        }],
        selectedEntityKey: 'glm-5.3-flash',
        selectedTopicKey: 'ai-model-release',
        evidenceGaps: [{
          code: 'CLAIM_UNVERIFIED', statement: '国产算力集群是否提供 100T 免费额度仍缺可靠证据。',
          locator: 'L1', excerpt: '每天提供 100T 免费额度。'
        }]
      }
    };
    const result = await resolveKnowledgeRoute(state.database, {
      workspaceId: 'ws-5359', sourceId: source.id, revision: source.revision,
      modelCall: async () => fenced(manifest)
    });
    assert.equal(result.status, 'resolved', JSON.stringify(result));
    assert.equal(result.topicId, topic.id);
    assert.equal(result.entity?.matchedCanonicalName, 'Ox Alpha');
    assert.deepEqual(result.entity?.aliasesToAdd, ['Ox Alpha', 'GLM-5.3 Flash']);
    assert.equal(result.evidenceGaps[0].code, 'CLAIM_UNVERIFIED');
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5359 route refuses an ambiguous entity instead of guessing', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, {
      title: '代号出现', originalUrl: 'https://example.test/ambiguous', summary: '某产品代号 Alpha 发布。'
    });
    seedEntity(state.database, {
      scope: 'global', entityType: 'product', canonicalKey: 'alpha-a', canonicalName: '产品 A',
      aliases: ['Alpha'], valueRationale: 'fixture'
    });
    seedEntity(state.database, {
      scope: 'global', entityType: 'product', canonicalKey: 'alpha-b', canonicalName: '产品 B',
      aliases: ['Alpha'], valueRationale: 'fixture'
    });
    const manifest = {
      [KNOWLEDGE_ROUTE_MANIFEST_KEY]: {
        reason: '仅有共享代号，无法确认正式身份。', entityCandidates: [{
          entityType: 'product', canonicalKey: 'alpha', canonicalName: 'Alpha', aliases: ['Alpha'],
          identityStrength: 'confirmed_alias', locator: 'L1', excerpt: '某产品代号 Alpha 发布。'
        }], topicCandidates: [], selectedEntityKey: 'alpha', selectedTopicKey: null, evidenceGaps: []
      }
    };
    const result = await resolveKnowledgeRoute(state.database, {
      workspaceId: 'ws-5359', sourceId: source.id, revision: source.revision,
      modelCall: async () => fenced(manifest)
    });
    assert.equal(result.status, 'unresolved');
    assert.equal(result.reasonCode, 'ENTITY_AMBIGUOUS');
    assert.equal(result.entity, null);
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5359 strong external identity conflict must not merge a same-name entity', async () => {
  const state = await fixture();
  try {
    const source = upsertSource(state.database, {
      title: 'Alpha 新产品发布', originalUrl: 'https://example.test/alpha-new',
      summary: 'Alpha 新产品发布，官方产品 ID 是 product-new。'
    });
    const topic = upsertKnowledgeTopic(state.database, { title: 'AI 产品发布' });
    seedEntity(state.database, {
      scope: 'global', entityType: 'product', canonicalKey: 'alpha-old', canonicalName: 'Alpha',
      aliases: [], externalIdentity: { provider: 'vendor-a', productId: 'product-old' }, valueRationale: 'fixture'
    });
    const manifest = { [KNOWLEDGE_ROUTE_MANIFEST_KEY]: {
      reason: '正文给出新的稳定产品 ID。',
      entityCandidates: [{
        entityType: 'product', canonicalKey: 'alpha-new', canonicalName: 'Alpha', aliases: [],
        externalIdentity: { provider: 'vendor-a', productId: 'product-new' }, identityStrength: 'strong',
        locator: 'L1', excerpt: 'Alpha 新产品发布，官方产品 ID 是 product-new。'
      }],
      topicCandidates: [{
        topicId: topic.id, canonicalKey: 'ai-product-release', title: 'AI 产品发布', kind: 'theme',
        relation: 'primary', locator: 'L1', excerpt: 'Alpha 新产品发布，官方产品 ID 是 product-new。'
      }],
      selectedEntityKey: 'alpha-new', selectedTopicKey: 'ai-product-release', evidenceGaps: []
    } };
    const result = await resolveKnowledgeRoute(state.database, {
      workspaceId: 'ws-5359', sourceId: source.id, revision: source.revision,
      modelCall: async () => fenced(manifest)
    });
    assert.equal(result.status, 'resolved', JSON.stringify(result));
    assert.equal(result.entity?.action, 'create');
    assert.equal(result.entity?.entityId, null);
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5359 route manifest is strict and rejects unknown fields', () => {
  const result = extractKnowledgeRouteManifest(fenced({
    [KNOWLEDGE_ROUTE_MANIFEST_KEY]: {
      reason: 'bad', entityCandidates: [], topicCandidates: [], selectedEntityKey: null,
      selectedTopicKey: null, evidenceGaps: [], unexpected: true
    }
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROUTE_MANIFEST_INVALID');
});

test('WMB-5359 alias prefilter finds old evidence behind more than 100 newer unrelated Sources', async () => {
  const state = await fixture();
  try {
    const oldSource = upsertSource(state.database, {
      title: 'Ox Alpha 历史额度', originalUrl: 'https://example.test/old-ox-alpha',
      summary: 'Ox Alpha 每日免费容量的历史声称。'
    });
    state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-22T08:00:00.000Z', oldSource.id);
    for (let index = 0; index < 120; index += 1) {
      const noise = upsertSource(state.database, {
        title: `无关新资料 ${index}`, originalUrl: `https://example.test/noise-${index}`, summary: '与目标产品无关。'
      });
      state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run(`2026-08-27T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`, noise.id);
    }
    const current = upsertSource(state.database, {
      title: 'GLM-5.3-Flash 身份揭晓', originalUrl: 'https://example.test/current-glm', summary: 'Ox Alpha 就是 GLM-5.3-Flash。'
    });
    state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-28T08:00:00.000Z', current.id);
    const result = findHistoricalKnowledgeSources(state.database, {
      entityId: 'entity-test', entityRevision: 1, aliases: ['Ox Alpha', 'GLM-5.3-Flash'],
      currentSourceId: current.id, currentCollectedAt: '2026-08-28T08:00:00.000Z', now: new Date('2026-08-28T08:00:00.000Z')
    });
    assert.ok(result.candidates.some((candidate) => candidate.sourceId === oldSource.id));
  } finally {
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5359 strong identity reactivates bounded old evidence and injects a cross-day Evidence Pack', async () => {
  const state = await fixture();
  try {
    const oldSource = upsertSource(state.database, {
      title: 'Ox Alpha 早期实测', originalUrl: 'https://example.test/ox-alpha-benchmark',
      summary: 'Ox Alpha 完成 12 次调用，任务成本与耗时需要结合正式身份重新判断。'
    });
    state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-26T08:00:00.000Z', oldSource.id);
    const currentSource = upsertSource(state.database, {
      title: 'GLM-5.3 Flash 正式发布', originalUrl: 'https://example.test/glm-official',
      summary: 'GLM-5.3 Flash 正式发布，代号 Ox Alpha。每天提供 100T 免费额度。'
    });
    state.database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-28T08:00:00.000Z', currentSource.id);
    const topic = upsertKnowledgeTopic(state.database, { title: 'AI 模型发布' });
    seedEntity(state.database, {
      scope: 'global', entityType: 'product', canonicalKey: 'ox-alpha', canonicalName: 'Ox Alpha', aliases: [], valueRationale: 'fixture'
    });

    const route = fenced({ [KNOWLEDGE_ROUTE_MANIFEST_KEY]: {
      reason: '同一官方句子明确确认正式名称与旧代号。',
      entityCandidates: [{ entityType: 'product', canonicalKey: 'glm-5.3-flash', canonicalName: 'GLM-5.3 Flash', aliases: ['Ox Alpha'], externalIdentity: {}, identityStrength: 'strong', locator: 'L1', excerpt: 'GLM-5.3 Flash 正式发布，代号 Ox Alpha。' }],
      topicCandidates: [{ topicId: topic.id, canonicalKey: 'ai-model-release', title: 'AI 模型发布', kind: 'theme', summary: '', relation: 'primary', locator: 'L1', excerpt: 'GLM-5.3 Flash 正式发布，代号 Ox Alpha。' }],
      selectedEntityKey: 'glm-5.3-flash', selectedTopicKey: 'ai-model-release',
      evidenceGaps: [{ code: 'INFRA_PROVIDER_UNVERIFIED', statement: '100T 是否由国产算力集群提供仍缺可靠证据。', locator: 'L1', excerpt: '每天提供 100T 免费额度。' }]
    } });
    const compile = fenced({ wmb_knowledge_candidates: {
      reason: '跨日证据编译', topicCompile: { title: 'AI 模型发布 Wiki', summary: '正式发布与历史实测' },
      entities: [], notes: [{ kind: 'claim', canonicalKey: 'identity-or-benchmark', statement: '该 Source 提供产品身份或历史实测证据。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'Ox Alpha', valueRationale: '跨来源重激活。' }]
    } });
    const deps = { databasePath: state.databasePath, openDatabase: migrateDatabase, modelCall: async (prompt) => prompt.includes('wmb_knowledge_route') ? route : compile };
    assert.equal(scheduleSourceKnowledgeCompileWith(deps, { sourceId: currentSource.id, revision: currentSource.revision }), true);
    await drainPersistentKnowledgeJobs(deps);

    const entity = state.database.prepare("SELECT canonical_name AS canonicalName,aliases_json AS aliasesJson,revision FROM knowledge_entities WHERE canonical_key='ox-alpha'").get();
    assert.equal(entity.canonicalName, 'GLM-5.3 Flash');
    assert.ok(JSON.parse(entity.aliasesJson).includes('Ox Alpha'));
    const oldLink = state.database.prepare('SELECT topic_id AS topicId FROM topic_source_links WHERE source_id=?').get(oldSource.id);
    assert.equal(oldLink.topicId, topic.id);
    const react = state.database.prepare("SELECT status,payload_json AS payloadJson FROM jobs WHERE kind='knowledge_reactivate_sources'").get();
    assert.equal(react.status, 'succeeded');

    const brief = assembleEditorialBrief(state.database, { now: new Date('2026-08-28T12:00:00.000Z'), watermark: '2026-08-27T00:00:00.000Z' });
    assert.equal(brief.continuity.reactivated.length, 1);
    assert.deepEqual(new Set(brief.continuity.reactivated[0].sources.map((source) => source.id)), new Set([oldSource.id, currentSource.id]));
    assert.equal(brief.continuity.reactivated[0].evidenceGaps[0].code, 'INFRA_PROVIDER_UNVERIFIED');
    assert.match(renderEditorialBrief(brief), /本轮重新激活的跨日证据/);
  } finally {
    await stopPersistentKnowledgeJobs();
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5359 reactivation fails closed when the current identity Source revision is stale', async () => {
  const state = await fixture();
  try {
    const oldSource = upsertSource(state.database, {
      title: 'Ox Alpha 历史材料', originalUrl: 'https://example.test/old-alpha', summary: 'Ox Alpha 历史证据。'
    });
    const currentSource = upsertSource(state.database, {
      title: 'GLM 身份公告', originalUrl: 'https://example.test/current-glm', summary: 'GLM 正式身份公告。'
    });
    const topic = upsertKnowledgeTopic(state.database, { title: 'AI 模型发布' });
    seedEntity(state.database, {
      scope: 'global', entityType: 'product', canonicalKey: 'glm', canonicalName: 'GLM', aliases: ['Ox Alpha'], valueRationale: 'fixture'
    });
    const entity = state.database.prepare("SELECT id,revision FROM knowledge_entities WHERE canonical_key='glm'").get();
    assert.equal(enqueueKnowledgeReactivationJob(state.database, {
      sourceId: oldSource.id, sourceRevision: oldSource.revision,
      currentSourceId: currentSource.id, currentSourceRevision: currentSource.revision,
      entityId: entity.id, entityRevision: entity.revision, topicId: topic.id,
      reason: 'fixture stale current source', matchedAliases: ['Ox Alpha'], evidenceGaps: []
    }), true);
    upsertSource(state.database, {
      title: 'GLM 身份公告（修订）', originalUrl: 'https://example.test/current-glm', summary: 'GLM 正式身份公告修订。'
    });
    await drainPersistentKnowledgeJobs({ databasePath: state.databasePath, openDatabase: migrateDatabase, modelCall: async () => '' });
    const job = state.database.prepare("SELECT status,last_error AS error FROM jobs WHERE kind='knowledge_reactivate_sources'").get();
    assert.equal(job.status, 'failed');
    assert.match(job.error, /CURRENT_SOURCE_REVISION_STALE/);
    assert.equal(state.database.prepare('SELECT COUNT(*) AS count FROM topic_source_links WHERE source_id=?').get(oldSource.id).count, 0);
  } finally {
    await stopPersistentKnowledgeJobs();
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});
