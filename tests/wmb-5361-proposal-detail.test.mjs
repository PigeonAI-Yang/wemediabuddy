import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { getProposalDetail } from '../src/main/proposals.ts';
import { upsertSource } from '../src/main/sources.ts';
import { editorialDecision, scoredReasons } from './helpers/planning-fixture.mjs';

test('WMB-5361 getProposalDetail reads the complete approval snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5361-'));
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  try {
    const source = upsertSource(database, { title:'官方来源', originalUrl:'https://example.test/source', summary:'证据' });
    const saved = saveCurrentPlan(database, { planDate:'2026-08-28', timezone:'Asia/Shanghai', summary:'detail',
      items:[{ title:'完整选题',priority:1,whyNow:'窗口事实',timeliness:'today',targetAudience:'目标读者',angle:'独特角度',pointOfView:'核心观点',platforms:['wechat'],formats:['article'],titleGuidance:'标题建议',openingGuidance:'开头建议',structureGuidance:'结构建议',effortEstimate:'40分钟',sourceIds:[source.id],availableMaterials:['已有A'],missingMaterials:['缺失B'],scoreReasons:scoredReasons(78),editorialDecision:editorialDecision('核心观点') }],
      candidateSources:[{sourceId:source.id,sourceRevision:source.revision}], sourceDecisions:[{sourceId:source.id,decision:'selected',reasonCode:'included',reason:'入选'}]
    });
    const id = database.prepare('SELECT id FROM plan_items WHERE plan_id=?').get(saved.id).id;
    const detail = getProposalDetail(database,id);
    assert.equal(detail.item.whyNow,'窗口事实');
    assert.equal(detail.item.targetAudience,'目标读者');
    assert.equal(detail.item.angle,'独特角度');
    assert.equal(detail.item.pointOfView,'核心观点');
    assert.deepEqual(detail.item.availableMaterials,['已有A']);
    assert.deepEqual(detail.item.missingMaterials,['缺失B']);
    assert.equal(detail.sources[0].url,'https://example.test/source');
    assert.equal(detail.score.reasons.length,6);
    assert.equal(detail.sourceDecisions[0].decision,'selected');
  } finally { database.close(); await rm(root,{recursive:true,force:true}); }
});

test('WMB-5361 renderer exposes detail and Pi focus as separate actions with real fields', async () => {
  const text = await readFile(new URL('../src/renderer/proposals-view.tsx', import.meta.url),'utf8');
  for (const label of ['查看详情','设置 Pi 焦点','为什么现在','目标读者','表达角度','核心观点','标题建议','开头建议','内容结构','已有材料','缺失材料','来源证据','六维评分','证据缺口']) assert.match(text,new RegExp(label));
  assert.match(text,/getProposalDetail/);
  assert.match(text,/data-testid="proposal-detail"/);
});
