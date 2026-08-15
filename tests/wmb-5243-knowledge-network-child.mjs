/**
 * WMB-5243 全局 Wiki 知识网络只读投影验收（子进程，真实 SQLite 全 schema）。
 * 验收点：空库有效空投影；三类节点（topic/knowledge_note/knowledge_entity，短标题+知识摘要来自
 * 既有正式字段）；正式关系投影（knowledge_note_version 端点解析到笔记；本页无悬空端点；
 * filters 合并可见集合口径）；WMB-5255 当前版本派生采纳边（零正式关系 → about 边；正式重复
 * 去重不翻倍；不活动/缺失目的地与被取代版本不泄漏；跨页集合级稳定）；分页稳定不重不漏；
 * 节点知识本体详情（完整认识/适用范围/证据边界/依据摘要/相关认识/最近更新时间 + 固定版本引用
 * + 深链）；canvasId='global' 冻结选择包（工作空间校验、按正式身份去重、有界字符裁剪并明示
 * excluded）；旧画布接口保留兼容。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import {
  addKnowledgeCanvasNode, createKnowledgeCanvas, createKnowledgeContextPackageIdempotent,
  getKnowledgeCanvasProjection, getKnowledgeNetworkNodeDetail, getKnowledgeNetworkProjection,
  previewKnowledgeContextPackage, validateKnowledgeSelectionManifest
} from '../src/main/knowledge-canvas.ts';
import { applyKnowledgeChangeSet } from '../src/main/knowledge-flywheel.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-network-'));
let db;
let checks = 0;
function check(label, condition, detail = '') {
  if (!condition) throw new Error(`${label}${detail ? ` — ${detail}` : ''}`);
  checks += 1;
}
function expectError(label, fn, code) {
  try { fn(); } catch (error) { if (String(error).includes(code)) return; throw new Error(`${label} 期望 ${code}，实际 ${String(error)}`); }
  throw new Error(`${label} 未抛错`);
}

try {
  db = migrateDatabase(path.join(directory, 'wmb.db'));
  db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-net', ?, ?, 1)")
    .run(new Date().toISOString(), new Date().toISOString());
  const meta = (requestId) => ({ workspaceId: 'ws-net', requestId, reason: '知识网络测试', triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent' });

  // ---- 验收 1：空库为有效空投影（不是错误；renderer 显示空态） ----
  const emptyProjection = getKnowledgeNetworkProjection(db, {});
  check('空库投影 networkId=global', emptyProjection.networkId === 'global');
  check('空库投影 nodes 为空且 hasMore=false', emptyProjection.nodes.length === 0 && emptyProjection.totalNodes === 0 && emptyProjection.hasMore === false);
  check('空库投影 filters 为有效空分组', Array.isArray(emptyProjection.filters.nodeTypes) && Array.isArray(emptyProjection.filters.relationTypes));

  // ---- 正式知识 fixture（实体 + 三类笔记 + 主题 wiki 页 + 正式关系 + 证据；显式版本 ID 供同事务引用） ----
  const source = upsertSource(db, { originalUrl: 'https://example.com/net-source', title: '网络资料', summary: '资料摘要', priority: 1 });
  const topicA = upsertKnowledgeTopic(db, { title: '综合主题A' });
  const topicB = upsertKnowledgeTopic(db, { title: '主题B' });
  db.prepare('UPDATE topics SET summary=? WHERE id=?').run('主题A当前综合：内容创作判断', topicA.id);
  const cs1 = applyKnowledgeChangeSet(db, meta('cs-net-1'), {
    entities: [{
      id: 'entity-1', scope: 'global', entityType: 'organization', canonicalKey: 'acme', canonicalName: 'Acme 公司'
    }],
    notes: [
      { id: 'note-1', scope: 'global', kind: 'claim', canonicalKey: 'net-note-1', title: '结论一（稳定短标题）',
        version: { versionId: 'note-1-v1', statement: '结论一：X 支持 Y', conclusionStatus: 'supported', evidenceLevel: 'corroborated',
          appliesTo: '适用于内容创作场景', adoptedTopicIds: [topicA.id], adoptedEntityIds: ['entity-1'], changeType: 'created' } },
      { id: 'note-2', scope: 'global', kind: 'insight', canonicalKey: 'net-note-2', title: '结论二',
        version: { versionId: 'note-2-v1', statement: '结论二：Z 相关', conclusionStatus: 'inference', evidenceLevel: 'single',
          adoptedTopicIds: [topicB.id], adoptedEntityIds: ['entity-1'], changeType: 'created' } },
      { id: 'note-3', scope: 'global', kind: 'concept', canonicalKey: 'net-note-3', title: '超大结论',
        version: { versionId: 'note-3-v1', statement: '大'.repeat(40000), conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'created' } }
    ],
    wikiPages: [{
      id: 'page-1', scope: 'global', pageType: 'topic', canonicalKey: 'wiki-topic-a', title: '主题A综合页',
      subjectType: 'topic', subjectId: topicA.id,
      version: { versionId: 'page-1-v1', body: { kind: 'topic-wiki', summary: '主题A综合页说明' }, changeSummary: '首版', compileReason: '测试' }
    }],
    relations: [
      { op: 'create', id: 'rel-support', scope: 'global', relationKey: 'supports', fromObjectType: 'knowledge_note', fromObjectId: 'note-1', toObjectType: 'knowledge_note', toObjectId: 'note-2' },
      { op: 'create', id: 'rel-derived', scope: 'global', relationKey: 'derived_from', fromObjectType: 'knowledge_note_version', fromObjectId: 'note-1-v1', toObjectType: 'knowledge_note', toObjectId: 'note-2' },
      { op: 'create', id: 'rel-about-topic', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: 'note-2', toObjectType: 'topic', toObjectId: topicB.id },
      { op: 'create', id: 'rel-about-entity', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: 'note-1', toObjectType: 'knowledge_entity', toObjectId: 'entity-1' }
    ],
    evidenceLinks: [
      { knowledgeNoteVersionId: 'note-1-v1', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source', excerpt: '证据摘录：来自一手资料', locator: 'p.12' },
      { knowledgeNoteVersionId: 'note-2-v1', evidenceObjectType: 'source', evidenceObjectId: source.id, relation: 'qualifies', sourceNature: 'user_experience', excerpt: '证据摘录：实操体验' }
    ]
  });
  check('知识网络 ChangeSet 应用成功', Boolean(cs1.changeSetId));

  // ---- 验收 2：三类节点（正式对象；短标题与知识摘要来自既有正式字段；稳定复合节点 ID） ----
  const projection = getKnowledgeNetworkProjection(db, {});
  check('三类节点齐全', ['topic', 'knowledge_note', 'knowledge_entity'].every((type) => projection.nodes.some((node) => node.objectType === type)),
    JSON.stringify(projection.nodes.map((node) => node.objectType)));
  check('totalNodes=2 主题+3 笔记+1 实体', projection.totalNodes === 6, `total=${projection.totalNodes}`);
  const topicNode = projection.nodes.find((node) => node.objectType === 'topic' && node.objectId === topicA.id);
  check('topic 节点 ID 为稳定复合身份', topicNode.id === `topic:${topicA.id}`);
  check('topic 短标题=topics.title', topicNode.shortTitle === '综合主题A');
  check('topic 知识摘要=topics.summary', topicNode.summary === '主题A当前综合：内容创作判断');
  const noteNode = projection.nodes.find((node) => node.objectType === 'knowledge_note' && node.objectId === 'note-1');
  check('note 节点 ID 为稳定复合身份', noteNode.id === 'knowledge_note:note-1');
  check('note 短标题=note.title（AI 稳定短标题，非截断正文）', noteNode.shortTitle === '结论一（稳定短标题）');
  check('note 知识摘要=当前版本 statement', noteNode.summary === '结论一：X 支持 Y');
  const entityNode = projection.nodes.find((node) => node.objectType === 'knowledge_entity' && node.objectId === 'entity-1');
  check('entity 短标题=canonical_name', entityNode.shortTitle === 'Acme 公司');
  check('entity 知识摘要诚实为空（无正式摘要字段不造工程元数据）', entityNode.summary === '');
  check('节点携带 updatedAt 与位置权重', typeof topicNode.updatedAt === 'string' && topicNode.updatedAt.length > 0 && typeof topicNode.weight === 'number');
  check('权重=合并可见关系度数（note-1：3 正式 + 1 派生采纳=4）', projection.nodes.find((node) => node.objectId === 'note-1').weight === 4, `weight=${projection.nodes.find((node) => node.objectId === 'note-1').weight}`);

  // ---- 验收 3：正式关系投影（版本端点解析；本页无悬空端点；filters 全图口径） ----
  check('totalRelations=合并可见集合 6 条（4 正式 + 2 派生采纳边；正式重复去重）', projection.totalRelations === 6, `total=${projection.totalRelations}`);
  const supportRelation = projection.relations.find((relation) => relation.id === 'rel-support');
  check('supports 关系投影（两端为可见节点 ID）', supportRelation?.from === 'knowledge_note:note-1' && supportRelation?.to === 'knowledge_note:note-2' && supportRelation?.relationType === 'supports');
  check('关系带语义中文名（registry display_name）', supportRelation?.displayName === '支持');
  const derivedRelation = projection.relations.find((relation) => relation.id === 'rel-derived');
  check('knowledge_note_version 端点解析到其笔记', derivedRelation?.from === 'knowledge_note:note-1' && derivedRelation?.to === 'knowledge_note:note-2');
  check('关系无悬空端点（全部在投影节点集合内）', projection.relations.every((relation) =>
    projection.nodes.some((node) => node.id === relation.from) && projection.nodes.some((node) => node.id === relation.to)));
  const supportsFilter = projection.filters.relationTypes.find((filter) => filter.id === 'supports');
  const aboutFilter = projection.filters.relationTypes.find((filter) => filter.id === 'about');
  check('filters.relationTypes 计数为合并可见集合口径', supportsFilter?.count === 1 && aboutFilter?.count === 4, JSON.stringify(projection.filters.relationTypes));
  check('filters.nodeTypes 计数为全图口径', projection.filters.nodeTypes.find((filter) => filter.id === 'topic')?.count === 2
    && projection.filters.nodeTypes.find((filter) => filter.id === 'knowledge_entity')?.count === 1);

  // ---- 验收 4：分页有界且稳定（不重不漏）；过滤参数生效 ----
  const page1 = getKnowledgeNetworkProjection(db, { limit: 2, offset: 0 });
  const page2 = getKnowledgeNetworkProjection(db, { limit: 2, offset: 2 });
  check('分页 hasMore 正确（2+2<6）', page1.hasMore === true && page2.hasMore === true);
  const pagedIds = new Set([...page1.nodes, ...page2.nodes].map((node) => node.id));
  check('分页不重不漏', pagedIds.size === page1.nodes.length + page2.nodes.length);
  check('全量页 hasMore=false', getKnowledgeNetworkProjection(db, { limit: 6 }).hasMore === false);
  const supportsOnly = getKnowledgeNetworkProjection(db, { relationKeys: ['supports'] });
  check('relationKeys 过滤关系', supportsOnly.relations.every((relation) => relation.relationType === 'supports') && supportsOnly.totalRelations === 1);
  const notesOnly = getKnowledgeNetworkProjection(db, { nodeTypes: ['knowledge_note'] });
  check('nodeTypes 过滤节点', notesOnly.nodes.every((node) => node.objectType === 'knowledge_note') && notesOnly.totalNodes === 3);
  expectError('空 nodeTypes 拒绝', () => getKnowledgeNetworkProjection(db, { nodeTypes: [] }), 'NETWORK_NODE_TYPES_REQUIRED');

  // ---- 验收 4b：跨页正式关系不丢失（fixture：端点落在分页边界两侧；集合级关系每页都返回） ----
  const csCross = applyKnowledgeChangeSet(db, meta('cs-net-cross'), {
    notes: [
      { id: 'note-page-a', scope: 'global', kind: 'claim', canonicalKey: 'net-page-a', title: '分页首端结论',
        version: { versionId: 'note-page-a-v1', statement: '分页首端：关系端点横跨分页边界', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'created' } },
      { id: 'note-page-z', scope: 'global', kind: 'claim', canonicalKey: 'net-page-z', title: '分页末端结论',
        version: { versionId: 'note-page-z-v1', statement: '分页末端：关系端点横跨分页边界', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'created' } }
    ],
    relations: [
      { op: 'create', id: 'rel-cross-page', scope: 'global', relationKey: 'supports', fromObjectType: 'knowledge_note', fromObjectId: 'note-page-a', toObjectType: 'knowledge_note', toObjectId: 'note-page-z' }
    ]
  });
  check('跨页 fixture ChangeSet 应用成功', Boolean(csCross.changeSetId));
  // 人为控制 updated_at 排序：两端必落在 limit:2 分页的两端（首页/末页），且都在 ≤2000 节点集合内
  db.prepare('UPDATE knowledge_notes SET updated_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', 'note-page-a');
  db.prepare('UPDATE knowledge_notes SET updated_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', 'note-page-z');
  const crossFirst = getKnowledgeNetworkProjection(db, { limit: 2, offset: 0 });
  const crossLast = getKnowledgeNetworkProjection(db, { limit: 2, offset: 6 });
  check('跨页 fixture 端点分属不同页（首页含 note-page-a 不含 note-page-z）',
    crossFirst.nodes.some((node) => node.id === 'knowledge_note:note-page-a') && !crossFirst.nodes.some((node) => node.id === 'knowledge_note:note-page-z'));
  check('跨页 fixture 末端节点在末页', crossLast.nodes.some((node) => node.id === 'knowledge_note:note-page-z'));
  check('跨页关系在每页投影均返回（分页不丢失；渲染合并按 id 去重后仍存在）',
    crossFirst.relations.some((relation) => relation.id === 'rel-cross-page') && crossLast.relations.some((relation) => relation.id === 'rel-cross-page'));
  const crossFull = getKnowledgeNetworkProjection(db, {});
  check('全量投影含跨页关系且端点均在集合内（端点永不悬空）', crossFull.relations.some((relation) => relation.id === 'rel-cross-page')
    && crossFull.relations.every((relation) => crossFull.nodes.some((node) => node.id === relation.from) && crossFull.nodes.some((node) => node.id === relation.to)));

  // ---- 验收 4c：WMB-5255 当前版本派生采纳边（零正式关系 → 2 条 about 边；正式重复不翻倍；不泄漏） ----
  const topicAdopt = upsertKnowledgeTopic(db, { title: '派生采纳主题' });
  const csDerived = applyKnowledgeChangeSet(db, meta('cs-net-derived'), {
    entities: [{ id: 'entity-der', scope: 'global', entityType: 'product', canonicalKey: 'der-prod', canonicalName: '派生实体产品' }],
    notes: [
      { id: 'note-der-1', scope: 'global', kind: 'claim', canonicalKey: 'net-der-1', title: '派生笔记一',
        version: { versionId: 'note-der-1-v1', statement: '派生笔记一：采纳主题与实体', conclusionStatus: 'supported', evidenceLevel: 'corroborated',
          adoptedTopicIds: [topicAdopt.id], adoptedEntityIds: ['entity-der'], changeType: 'created' } }
    ]
  });
  check('派生采纳 fixture ChangeSet 应用成功', Boolean(csDerived.changeSetId));
  const derivedProj = getKnowledgeNetworkProjection(db, {});
  const derivedEdges = derivedProj.relations.filter((relation) => relation.from === 'knowledge_note:note-der-1');
  check('零正式关系 fixture：当前版本采纳 → 2 条派生 about 边', derivedEdges.length === 2, `edges=${derivedEdges.length}`);
  check('派生边 relationType=about / displayName=关于', derivedEdges.every((relation) => relation.relationType === 'about' && relation.displayName === '关于'));
  check('派生边稳定确定 ID（derived:about:<note>:<destType>:<destId>；两次投影恒等）',
    derivedEdges.every((relation) => relation.id.startsWith('derived:about:note-der-1:'))
    && JSON.stringify(derivedProj.relations) === JSON.stringify(getKnowledgeNetworkProjection(db, {}).relations));
  check('派生边端点无悬空（两端均在投影节点集合）', derivedProj.relations.every((relation) =>
    derivedProj.nodes.some((node) => node.id === relation.from) && derivedProj.nodes.some((node) => node.id === relation.to)));
  check('派生边计入度数（note-der-1 weight=2；topicAdopt weight=1；entity-der weight=1）',
    derivedProj.nodes.find((node) => node.objectId === 'note-der-1')?.weight === 2
    && derivedProj.nodes.find((node) => node.objectType === 'topic' && node.objectId === topicAdopt.id)?.weight === 1
    && derivedProj.nodes.find((node) => node.objectId === 'entity-der')?.weight === 1);
  check('totalRelations/filters 反映合并可见集合（5 正式 + 4 派生 = 9；about=6）',
    derivedProj.totalRelations === 9 && derivedProj.filters.relationTypes.find((filter) => filter.id === 'about')?.count === 6,
    `total=${derivedProj.totalRelations}`);
  // 正式重复 about 边（与派生边同 from/to/relationType）：正式身份保留，派生 ID 不出现（不翻倍）
  const csDup = applyKnowledgeChangeSet(db, meta('cs-net-dup'), {
    relations: [
      { op: 'create', id: 'rel-dup-about', scope: 'global', relationKey: 'about', fromObjectType: 'knowledge_note', fromObjectId: 'note-der-1', toObjectType: 'topic', toObjectId: topicAdopt.id }
    ]
  });
  check('重复 formal about 边创建成功', Boolean(csDup.changeSetId));
  const dupProj = getKnowledgeNetworkProjection(db, {});
  const dupEdges = dupProj.relations.filter((relation) => relation.from === 'knowledge_note:note-der-1');
  check('正式重复 about 边不翻倍（仍 2 条；正式身份保留、派生 ID 不出现）',
    dupEdges.length === 2 && dupEdges.some((relation) => relation.id === 'rel-dup-about')
    && !dupEdges.some((relation) => relation.id === `derived:about:note-der-1:topic:${topicAdopt.id}`), `edges=${dupEdges.length}`);
  // 目的地不活动/缺失：归档主题、归档实体、从未存在的目的地 ID（直接插版本行模拟孤儿采纳）都不泄漏
  const topicGone = upsertKnowledgeTopic(db, { title: '将被归档主题' });
  applyKnowledgeChangeSet(db, meta('cs-net-gone'), {
    entities: [{ id: 'entity-gone', scope: 'global', entityType: 'organization', canonicalKey: 'gone-org', canonicalName: '将归档实体' }],
    notes: [
      { id: 'note-gone', scope: 'global', kind: 'claim', canonicalKey: 'net-gone', title: '归档目的地笔记',
        version: { versionId: 'note-gone-v1', statement: '归档目的地笔记', conclusionStatus: 'supported', evidenceLevel: 'single',
          adoptedTopicIds: [topicGone.id], adoptedEntityIds: ['entity-gone'], changeType: 'created' } }
    ]
  });
  db.prepare('UPDATE topics SET status=? WHERE id=?').run('archived', topicGone.id);
  db.prepare('UPDATE knowledge_entities SET lifecycle=? WHERE id=?').run('archived', 'entity-gone');
  // 孤儿采纳模拟：版本表只禁 UPDATE/DELETE（INSERT 放行）；直接插入引用不存在主题/实体 ID 的当前版本
  db.prepare(`INSERT INTO knowledge_note_versions
    (id, note_id, version_number, title, statement, body, conclusion_status, evidence_level, applies_to, valid_from, valid_until,
     adopted_entity_ids_json, adopted_topic_ids_json, adopted_knowledge_version_ids_json, change_type, change_reason, creator_nature,
     change_set_id, created_at)
    VALUES (?, ?, ?, ?, ?, '', 'unverified', 'none', '', NULL, NULL, ?, ?, '[]', 'recompiled', '孤儿采纳数据模拟', 'background_agent', ?, ?)`)
    .run('note-gone-v2', 'note-gone', 2, '归档目的地笔记', '孤儿采纳版本（目的地不存在）', JSON.stringify(['entity-missing']), JSON.stringify(['topic-missing']), csDerived.changeSetId, new Date().toISOString());
  db.prepare('UPDATE knowledge_notes SET current_version_id=? WHERE id=?').run('note-gone-v2', 'note-gone');
  const goneProj = getKnowledgeNetworkProjection(db, {});
  check('不活动/缺失目的地不泄漏派生边（note-gone 无任何关系）', !goneProj.relations.some((relation) => relation.from === 'knowledge_note:note-gone'));
  // 被取代版本不泄漏：note-der-2 v1 采纳主题 → beforeRevision 追加 v2 不再采纳 → 派生边消失
  applyKnowledgeChangeSet(db, meta('cs-net-super'), {
    notes: [
      { id: 'note-der-2', scope: 'global', kind: 'claim', canonicalKey: 'net-der-2', title: '派生笔记二',
        version: { versionId: 'note-der-2-v1', statement: '派生笔记二 v1：采纳主题', conclusionStatus: 'supported', evidenceLevel: 'single',
          adoptedTopicIds: [topicAdopt.id], changeType: 'created' } }
    ]
  });
  const superBefore = getKnowledgeNetworkProjection(db, {});
  check('v1 采纳产生派生边', superBefore.relations.some((relation) => relation.id === `derived:about:note-der-2:topic:${topicAdopt.id}`));
  applyKnowledgeChangeSet(db, meta('cs-net-super2'), {
    notes: [
      { id: 'note-der-2', scope: 'global', kind: 'claim', canonicalKey: 'net-der-2', title: '派生笔记二', beforeRevision: 1,
        version: { versionId: 'note-der-2-v2', statement: '派生笔记二 v2：不再采纳', conclusionStatus: 'supported', evidenceLevel: 'single', changeType: 'strengthened' } }
    ]
  });
  const superAfter = getKnowledgeNetworkProjection(db, {});
  check('被取代版本（非当前版本）不泄漏派生边', !superAfter.relations.some((relation) => relation.id === `derived:about:note-der-2:topic:${topicAdopt.id}`));
  // 分页稳定性：派生采纳边为集合级关系，每页返回同一集合
  const pagedA = getKnowledgeNetworkProjection(db, { limit: 2, offset: 0 });
  const pagedB = getKnowledgeNetworkProjection(db, { limit: 2, offset: 8 });
  check('派生采纳边跨页集合级返回（每页同一集合关系）',
    pagedA.relations.some((relation) => relation.id === 'derived:about:note-der-1:knowledge_entity:entity-der')
    && pagedB.relations.some((relation) => relation.id === 'derived:about:note-der-1:knowledge_entity:entity-der'));

  // ---- 验收 5：节点知识本体详情（知识卡片第一屏字段；固定版本引用；深链） ----
  const topicDetail = getKnowledgeNetworkNodeDetail(db, { nodeId: `topic:${topicA.id}` });
  check('topic 详情 primary=主题当前综合', topicDetail.knowledge.primary === '主题A当前综合：内容创作判断');
  check('topic 详情 scope 诚实为空（无正式适用范围字段）', topicDetail.knowledge.scope === '');
  check('topic 详情固定版本引用=wiki 页当前版本', topicDetail.versionRef?.versionKind === 'wiki_page_version' && topicDetail.versionRef?.versionId === 'page-1-v1');
  check('topic 详情深链 route=topic', topicDetail.deepLink?.route === 'topic' && topicDetail.deepLink?.objectId === topicA.id);
  check('topic 相关认识含采纳笔记（about）', topicDetail.knowledge.related.some((entry) => entry.objectId === 'note-1' && entry.relationKey === 'about'));
  check('topic 证据边界来自采纳笔记版本证据', topicDetail.knowledge.evidenceBoundary.evidenceCount === 1 && topicDetail.knowledge.evidenceBoundary.byRelation.supports === 1);
  check('topic 依据摘要解析 source 标题', topicDetail.knowledge.evidenceSummary.some((entry) => entry.excerpt?.includes('一手资料') && entry.sourceTitle === '网络资料'));

  const noteDetail = getKnowledgeNetworkNodeDetail(db, { nodeId: 'knowledge_note:note-1' });
  check('note 详情 primary=当前版本 statement（完整认识）', noteDetail.knowledge.primary === '结论一：X 支持 Y');
  check('note 详情 scope=applies_to（适用范围）', noteDetail.knowledge.scope === '适用于内容创作场景');
  check('note 详情固定版本引用=note_version', noteDetail.versionRef?.versionKind === 'note_version' && noteDetail.versionRef?.versionId === 'note-1-v1');
  check('note 详情深链 route=object', noteDetail.deepLink?.route === 'object' && noteDetail.deepLink?.objectId === 'note-1');
  check('note 相关认识=实体(about)+主题(about)+相关笔记(supports)', noteDetail.knowledge.related.some((entry) => entry.objectId === 'entity-1' && entry.relationKey === 'about')
    && noteDetail.knowledge.related.some((entry) => entry.objectId === topicA.id)
    && noteDetail.knowledge.related.some((entry) => entry.objectId === 'note-2' && entry.relationKey === 'supports'));

  const entityDetail = getKnowledgeNetworkNodeDetail(db, { nodeId: 'knowledge_entity:entity-1' });
  check('entity 详情 primary=canonical_name 诚实回退（无实体 wiki 页）', entityDetail.knowledge.primary === 'Acme 公司');
  check('entity 详情无固定版本引用', entityDetail.versionRef === null);
  check('entity 详情深链 route=object', entityDetail.deepLink?.route === 'object');
  check('entity 相关认识=采纳该实体的笔记', entityDetail.knowledge.related.some((entry) => entry.objectId === 'note-1') && entityDetail.knowledge.related.some((entry) => entry.objectId === 'note-2'));
  check('entity 证据边界=采纳笔记版本证据（2 条）', entityDetail.knowledge.evidenceBoundary.evidenceCount === 2
    && entityDetail.knowledge.evidenceBoundary.bySourceNature.primary_source === 1 && entityDetail.knowledge.evidenceBoundary.bySourceNature.user_experience === 1);
  expectError('未知节点详情拒绝', () => getKnowledgeNetworkNodeDetail(db, { nodeId: 'topic:missing-id' }), 'NETWORK_NODE_NOT_FOUND');
  expectError('非法节点 ID 拒绝', () => getKnowledgeNetworkNodeDetail(db, { nodeId: 'bogus:1' }), 'NETWORK_NODE_NOT_FOUND');

  // ---- 验收 6：canvasId='global' 冻结选择包（工作空间校验 + 正式身份去重 + 冻结正文 + 版本引用） ----
  const manifest = validateKnowledgeSelectionManifest(db, {
    canvasId: 'global',
    nodeIds: [`topic:${topicA.id}`, 'knowledge_note:note-1', `topic:${topicA.id}`, 'knowledge_note:note-1']
  });
  check('清单 scope=selected_only', manifest.scope === 'selected_only' && manifest.canvasId === 'global');
  check('清单按正式知识身份去重（4 选 2）', manifest.items.length === 2, `items=${manifest.items.length}`);
  check('清单 excludedCount=重复未纳入数（4 选 2 → 2）', manifest.excludedCount === 2, `excludedCount=${manifest.excludedCount}`);
  check('清单 excludedReasons 有界且带 duplicate 原因', manifest.excludedReasons?.length === 2
    && manifest.excludedReasons.every((entry) => entry.reason === 'duplicate' && (entry.objectType === 'topic' || entry.objectType === 'knowledge_note')));
  check('清单顺序按知识优先级（topic 在前）', manifest.items[0].objectType === 'topic' && manifest.items[1].objectType === 'knowledge_note');
  check('清单 snapshot=自动展开冻结正文包（非节点名称清单）', manifest.items.every((item) =>
    item.snapshot && typeof item.snapshot.coreStatement === 'string' && typeof item.snapshot.appliesTo === 'string'
    && typeof item.snapshot.evidenceSummary === 'string' && 'versionRef' in item.snapshot));
  const noteManifestItem = manifest.items.find((item) => item.objectType === 'knowledge_note');
  check('冻结正文含完整认识', noteManifestItem.snapshot.coreStatement === '结论一：X 支持 Y');
  check('冻结正文含适用范围', noteManifestItem.snapshot.appliesTo === '适用于内容创作场景');
  check('冻结正文含证据边界与依据摘要', noteManifestItem.snapshot.evidenceBoundary.evidenceCount === 1 && noteManifestItem.snapshot.evidenceSummary.includes('一手资料'));
  check('冻结正文含固定版本引用', noteManifestItem.snapshot.versionRef?.versionId === 'note-1-v1');
  // 单节点无未纳入 → excludedCount=0
  const plainManifest = validateKnowledgeSelectionManifest(db, { canvasId: 'global', nodeIds: [`topic:${topicA.id}`] });
  check('单节点无未纳入 excludedCount=0', plainManifest.excludedCount === 0 && plainManifest.items.length === 1, `excludedCount=${plainManifest.excludedCount}`);
  // 混合：非法 ID + 已消失节点 + 重复正式身份全部计入 excludedCount（2 invalid + 1 duplicate）
  const mixed = validateKnowledgeSelectionManifest(db, { canvasId: 'global', nodeIds: ['bogus:1', 'topic:missing-id', `topic:${topicA.id}`, `topic:${topicA.id}`] });
  check('混合清单：无效/已消失 + 重复全部计入 excludedCount（3）', mixed.items.length === 1 && mixed.excludedCount === 3, `items=${mixed.items.length}, excludedCount=${mixed.excludedCount}`);
  check('excludedReasons 覆盖 invalid（非法 ID objectType=null）与 invalid（已消失）与 duplicate',
    mixed.excludedReasons?.some((entry) => entry.nodeId === 'bogus:1' && entry.reason === 'invalid' && entry.objectType === null)
    && mixed.excludedReasons?.some((entry) => entry.nodeId === 'topic:missing-id' && entry.reason === 'invalid' && entry.objectType === 'topic')
    && mixed.excludedReasons?.some((entry) => entry.nodeId === `topic:${topicA.id}` && entry.reason === 'duplicate' && entry.objectType === 'topic'));
  expectError('全部越界节点无有效清单（工作空间校验；空冻结拒绝）', () => validateKnowledgeSelectionManifest(db, { canvasId: 'global', nodeIds: ['topic:missing-id'] }), 'PACKAGE_ITEMS_REQUIRED');
  expectError('全部非法节点 ID 无有效清单（空冻结拒绝）', () => validateKnowledgeSelectionManifest(db, { canvasId: 'global', nodeIds: ['bogus:1'] }), 'PACKAGE_ITEMS_REQUIRED');
  expectError('空清单拒绝', () => validateKnowledgeSelectionManifest(db, { canvasId: 'global', nodeIds: [] }), 'PACKAGE_ITEMS_REQUIRED');

  // ---- 验收 7：preview 与清单同源；重复显式 excluded；超限按优先级裁剪并明示未纳入 ----
  const preview = previewKnowledgeContextPackage(db, { canvasId: 'global', nodeIds: ['knowledge_note:note-1', 'knowledge_note:note-2', 'knowledge_entity:entity-1', `topic:${topicB.id}`, `topic:${topicA.id}`] });
  check('preview 选中集合=输入去重后全集（5 项）', preview.items.length === 5
    && ['topic', 'knowledge_note', 'knowledge_entity'].every((type) => preview.items.some((item) => item.objectType === type)), `items=${preview.items.length}`);
  check('preview 关系=选中集合内正式关系（4 条全命中）', preview.relations.length === 4 && preview.relations.some((relation) => relation.relationType === 'supports'), `relations=${preview.relations.length}`);
  check('preview 关系为正式关系 ID', preview.relations.some((relation) => relation.id === 'rel-about-entity'));
  const dupPreview = previewKnowledgeContextPackage(db, { canvasId: 'global', nodeIds: ['knowledge_note:note-1', 'knowledge_note:note-1'] });
  check('重复选中去重且显式 excluded(duplicate)', dupPreview.items.length === 1 && dupPreview.excluded.some((entry) => entry.reason === 'duplicate'));
  check('preview excludedCount=excluded 明细数（同源；无用户排除时与清单一致）', dupPreview.excludedCount === 1 && dupPreview.excludedCount === dupPreview.excluded.length, `excludedCount=${dupPreview.excludedCount}`);
  const bounded = previewKnowledgeContextPackage(db, { canvasId: 'global', nodeIds: ['knowledge_note:note-1', 'knowledge_note:note-3'] });
  check('超限按优先级+顺序裁剪并明示 excluded(over_limit)', bounded.items.length === 1 && bounded.excluded.some((entry) => entry.reason === 'over_limit' && entry.id === 'knowledge_note:note-3'));
  check('超限裁剪 preview excludedCount=1', bounded.excludedCount === 1 && bounded.excludedCount === bounded.excluded.length, `excludedCount=${bounded.excludedCount}`);
  check('裁剪后包有界有效（overLimit=false）', bounded.overLimit === false && bounded.estimatedCharacters <= bounded.limitCharacters);
  const zeroExcluded = previewKnowledgeContextPackage(db, { canvasId: 'global', nodeIds: ['knowledge_note:note-1', `topic:${topicA.id}`] });
  check('无未纳入 preview excludedCount=0', zeroExcluded.excludedCount === 0 && zeroExcluded.excluded.length === 0, `excludedCount=${zeroExcluded.excludedCount}`);

  // ---- 验收 8：正式包创建对全局网络显式拒绝（只读投影；包为画布作用域遗留能力）；旧画布接口保留兼容 ----
  expectError('全局网络不支持正式包创建（canvas_id FK 要求真实画布；只读投影）',
    () => createKnowledgeContextPackageIdempotent(db, { requestId: 'net-pack', canvasId: 'global', name: '网络包', objective: '验证', nodeIds: ['knowledge_note:note-1', 'knowledge_note:note-2'] }),
    'PACKAGE_GLOBAL_CREATE_UNSUPPORTED');
  const oldCanvas = createKnowledgeCanvas(db, { title: '旧画布兼容' });
  const oldNode = addKnowledgeCanvasNode(db, { canvasId: oldCanvas.id, objectType: 'topic', objectId: topicA.id, x: 1, y: 2 });
  const oldManifest = validateKnowledgeSelectionManifest(db, { canvasId: oldCanvas.id, nodeIds: [oldNode.id] });
  check('旧画布清单仍可用（兼容已有数据）', oldManifest.scope === 'selected_only' && oldManifest.items.length === 1);
  const oldProjection = getKnowledgeCanvasProjection(db, { canvasId: oldCanvas.id, mode: 'relation' });
  check('旧画布三模式投影仍可用', oldProjection.nodes.length === 1 && oldProjection.mode === 'relation');
  const oldPreview = previewKnowledgeContextPackage(db, { canvasId: oldCanvas.id, nodeIds: [oldNode.id] });
  check('旧画布 preview 仍可用', oldPreview.items.length === 1 && oldPreview.scope === 'selected_only');

  db.close();
  console.log(`WMB-5243 knowledge-network child: ${checks} checks passed`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  try { db.close(); } catch { /* 已关闭 */ }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
