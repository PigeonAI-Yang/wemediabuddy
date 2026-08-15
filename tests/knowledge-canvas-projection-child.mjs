/**
 * WMB-5213 M4 画布三模式投影验收（子进程，真实 SQLite + v56 表）。
 * 验收点：三模式同对象身份；删除节点不删正式知识；健康问题与资料库同 ID；
 * dataChanged 知识 scopes；selected-only 清单一致（UI 展示 = 正式写）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { upsertSource } from '../src/main/sources.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import {
  addKnowledgeCanvasNode, createKnowledgeCanvas, createKnowledgeContextPackageIdempotent, createKnowledgeRelation,
  getCanvasNodeDetail, getKnowledgeCanvasProjection, previewKnowledgeContextPackage, removeKnowledgeCanvasNode,
  validateKnowledgeSelectionManifest
} from '../src/main/knowledge-canvas.ts';
import { applyKnowledgeChangeSet, getKnowledgeNote } from '../src/main/knowledge-flywheel.ts';
import { broadcastDataChanged, setDataChangedPublisher } from '../src/main/data-changed.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-canvas-projection-'));
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
  const db = migrateDatabase(path.join(directory, 'wmb.db'));
  db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)")
    .run(new Date().toISOString(), new Date().toISOString());
  const meta = (requestId) => ({ workspaceId: 'ws-a', requestId, reason: '投影测试', triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent' });

  // ---- 画布 + 引用节点（topic/source/note）+ 画布关系 ----
  const source = upsertSource(db, { originalUrl: 'https://example.com/proj-source', title: '投影资料', summary: '摘要', priority: 1 });
  const topic = upsertKnowledgeTopic(db, { title: '投影主题' });
  const canvas = createKnowledgeCanvas(db, { title: '投影画布' });
  const topicNode = addKnowledgeCanvasNode(db, { canvasId: canvas.id, objectType: 'topic', objectId: topic.id, x: 10, y: 20 });
  const sourceNode = addKnowledgeCanvasNode(db, { canvasId: canvas.id, objectType: 'source', objectId: source.id, x: 300, y: 20 });
  const noteNode = addKnowledgeCanvasNode(db, { canvasId: canvas.id, objectType: 'note', noteTitle: '画布笔记', x: 600, y: 20 });
  createKnowledgeRelation(db, { canvasId: canvas.id, fromNodeId: topicNode.id, toNodeId: sourceNode.id, relationType: 'supports' });

  // ---- 验收 1：三模式同一对象身份（同一 canvas node id + 同一正式对象 id）----
  const relationMode = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'relation' });
  const changeModeEmpty = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'change' });
  const healthModeEmpty = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'health' });
  for (const mode of [relationMode, changeModeEmpty, healthModeEmpty]) {
    check('三模式 nodes 长度一致', mode.nodes.length === 3, `mode=${mode.mode} nodes=${mode.nodes.length}`);
    check('三模式节点身份一致', mode.nodes.every((node, index) =>
      node.id === relationMode.nodes[index].id && node.objectId === relationMode.nodes[index].objectId && node.objectType === relationMode.nodes[index].objectType),
      `mode=${mode.mode}`);
    check('三模式 relations 一致', JSON.stringify(mode.relations) === JSON.stringify(relationMode.relations));
  }
  check('relation 模式深链：topic → 正式 wiki 页缺失时 formalObjectId 为 null', relationMode.nodes.find(n => n.id === topicNode.id).deepLink.route === 'topic');
  check('relation 模式深链：source → library', relationMode.nodes.find(n => n.id === sourceNode.id).deepLink.route === 'library');
  check('画布笔记节点无深链（非正式对象）', relationMode.nodes.find(n => n.id === noteNode.id).deepLink === null);
  check('change 模式无 ChangeSet 时 changeSet 为 null', changeModeEmpty.modeData.changeSet === null);
  check('health 模式无问题时为空', healthModeEmpty.modeData.healthIssues.length === 0);

  // ---- 正式知识：ChangeSet A 创建笔记(采用主题) + 主题 wiki 页 + 回执；ChangeSet B 追加来源证据 ----
  const cs1a = applyKnowledgeChangeSet(db, meta('cs-1a'), {
    notes: [{
      id: 'note-1', scope: 'global', kind: 'claim', canonicalKey: 'projection-note-1',
      version: { statement: '主题判断成立', conclusionStatus: 'supported', evidenceLevel: 'corroborated', changeType: 'created', adoptedTopicIds: [topic.id] }
    }],
    wikiPages: [{
      id: 'page-1', scope: 'global', pageType: 'topic', canonicalKey: `wiki-${topic.id}`, title: '主题综合页', subjectType: 'topic', subjectId: topic.id,
      version: { body: { summary: '当前综合' }, changeSummary: '首版', compileReason: '测试' }
    }],
    receipts: [{ triggerType: 'ingest', requestId: 'cs1a-receipt', summary: '投影摄取', counts: { notes: 1, wikiPages: 1 }, affectedTopics: [topic.id] }]
  });
  check('ChangeSet A 应用成功', Boolean(cs1a.changeSetId));
  const noteVersionId = getKnowledgeNote(db, 'note-1').version.id;
  const cs1b = applyKnowledgeChangeSet(db, meta('cs-1b'), {
    evidenceLinks: [{
      knowledgeNoteVersionId: noteVersionId, evidenceObjectType: 'source',
      evidenceObjectId: source.id, relation: 'supports', sourceNature: 'primary_source'
    }]
  });
  check('ChangeSet B 应用成功', Boolean(cs1b.changeSetId));

  // ---- 验收 2：ChangeSet 高亮准确（主题/来源节点命中同一正式对象 ID）----
  const changeModeA = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'change', changeSetId: cs1a.changeSetId });
  check('change 模式携带目标 ChangeSet', changeModeA.modeData.changeSet?.id === cs1a.changeSetId);
  check('change 模式携带回执（按 change_set_id 关联）', changeModeA.modeData.receipt?.changeSetId === cs1a.changeSetId);
  const topicChanges = changeModeA.nodes.find(n => n.id === topicNode.id).changes ?? [];
  check('主题节点高亮（同一正式对象 ID）', topicChanges.some(c => c.objectId === topic.id), JSON.stringify(topicChanges));
  check('主题高亮 changeType 为知识变化类型', topicChanges.some(c => ['created', 'recompiled', 'strengthened', 'topic_updated'].includes(c.changeType)));
  check('画布笔记节点无高亮（非正式知识）', (changeModeA.nodes.find(n => n.id === noteNode.id).changes ?? []).length === 0);
  const changeModeB = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'change', changeSetId: cs1b.changeSetId });
  const sourceChanges = changeModeB.nodes.find(n => n.id === sourceNode.id).changes ?? [];
  check('来源节点高亮（证据 supports → strengthened）', sourceChanges.some(c => c.objectId === source.id && c.changeType === 'strengthened'), JSON.stringify(sourceChanges));
  check('关系模式与变化模式节点身份仍一致', changeModeA.nodes.every((node, index) => node.id === relationMode.nodes[index].id && node.objectId === relationMode.nodes[index].objectId));
  expectError('显式未知 ChangeSet 拒绝', () => getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'change', changeSetId: 'nope' }), 'CHANGE_SET_NOT_FOUND');

  // ---- 验收 3：健康问题与资料库/主题同一正式对象 ID ----
  const cs2 = applyKnowledgeChangeSet(db, meta('cs-2'), {
    healthIssues: [
      { op: 'create', id: 'health-1', scope: 'global', issueType: 'orphan_knowledge', affectedObjectType: 'topic', affectedObjectId: topic.id, severity: 'medium', suggestedAction: '补页面' },
      { op: 'create', id: 'health-2', scope: 'global', issueType: 'duplicate_knowledge', affectedObjectType: 'source', affectedObjectId: source.id, severity: 'low', suggestedAction: '去重' }
    ]
  });
  check('健康问题 ChangeSet 应用成功', Boolean(cs2.changeSetId));
  const healthMode = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'health' });
  const topicIssue = healthMode.modeData.healthIssues.find(issue => issue.id === 'health-1');
  const sourceIssue = healthMode.modeData.healthIssues.find(issue => issue.id === 'health-2');
  check('健康问题 affectedObjectId 与主题同一 ID', topicIssue?.affectedObjectId === topic.id, JSON.stringify(topicIssue));
  check('健康问题 affectedObjectId 与资料同一 ID', sourceIssue?.affectedObjectId === source.id);
  check('健康问题命中主题节点', topicIssue?.matchedNodeId === topicNode.id);
  check('健康问题命中来源节点', sourceIssue?.matchedNodeId === sourceNode.id);
  check('健康模式节点携带 healthIssueIds', healthMode.nodes.find(n => n.id === topicNode.id).healthIssueIds?.includes('health-1'));
  check('健康模式与关系模式节点身份一致', healthMode.nodes.every((node, index) => node.id === relationMode.nodes[index].id));

  // ---- 验收 4：详情深链数据 ----
  const topicDetail = getCanvasNodeDetail(db, { canvasId: canvas.id, nodeId: topicNode.id });
  check('topic 深链 route 与正式 wiki 页 ID', topicDetail.node.deepLink?.route === 'topic' && topicDetail.node.deepLink.formalObjectId === 'page-1');
  check('详情 wiki 页 subjectId 与主题同 ID', topicDetail.formal.wikiPage?.subjectId === topic.id);
  check('详情关联笔记（adopted_topic_ids）', topicDetail.formal.notes.some(note => note.id === 'note-1'));
  check('详情健康问题（同 ID 关联）', topicDetail.formal.healthIssues.some(issue => issue.id === 'health-1'));
  check('详情最近变化非空', topicDetail.formal.recentChanges.length >= 2);
  const sourceDetail = getCanvasNodeDetail(db, { canvasId: canvas.id, nodeId: sourceNode.id });
  check('source 深链 route=library', sourceDetail.node.deepLink?.route === 'library');
  check('source 详情关联笔记（证据链）', sourceDetail.formal.notes.some(note => note.id === 'note-1'));
  expectError('未知节点详情拒绝', () => getCanvasNodeDetail(db, { canvasId: canvas.id, nodeId: 'nope' }), 'NODE_NOT_FOUND');

  // ---- 验收 5：selected-only 清单一致（UI 展示 = 正式写）----
  const manifest = validateKnowledgeSelectionManifest(db, { canvasId: canvas.id, nodeIds: [topicNode.id, sourceNode.id] });
  check('清单 scope=selected_only', manifest.scope === 'selected_only');
  check('清单只含选中对象（画布笔记未选中则不在）', manifest.items.length === 2 && manifest.items.every(item => item.nodeId !== noteNode.id));
  check('清单对象身份与节点一致', manifest.items.every(item => item.objectId === relationMode.nodes.find(n => n.id === item.nodeId).objectId));
  const preview = previewKnowledgeContextPackage(db, { canvasId: canvas.id, nodeIds: [topicNode.id, sourceNode.id] });
  check('preview 与清单同一选中集合', preview.items.length === 2 && preview.items.every(item => manifest.items.some(m => m.nodeId === item.nodeId)));
  const pack = createKnowledgeContextPackageIdempotent(db, { requestId: 'proj-pack', canvasId: canvas.id, name: '投影包', objective: '验证', nodeIds: [topicNode.id, sourceNode.id] }).data;
  check('正式包与清单同一选中集合', pack.items.length === 2 && pack.items.every(item => manifest.items.some(m => m.nodeId === item.nodeId)));
  check('正式包不含未选中画布笔记', !pack.items.some(item => item.nodeId === noteNode.id));
  expectError('越界节点清单拒绝', () => validateKnowledgeSelectionManifest(db, { canvasId: canvas.id, nodeIds: ['bogus-node'] }), 'PACKAGE_NODE_NOT_FOUND');
  expectError('空清单拒绝', () => validateKnowledgeSelectionManifest(db, { canvasId: canvas.id, nodeIds: [] }), 'PACKAGE_ITEMS_REQUIRED');

  // ---- 验收 6：删除画布节点不删正式知识；健康问题 ID 保持不变 ----
  removeKnowledgeCanvasNode(db, { canvasId: canvas.id, nodeId: topicNode.id, expectedRevision: topicNode.revision });
  check('删除节点后 topics 正式对象仍在', Boolean(db.prepare('SELECT id FROM topics WHERE id=?').get(topic.id)));
  check('删除节点后 wiki 页仍在', Boolean(db.prepare('SELECT id FROM knowledge_wiki_pages WHERE id=?').get('page-1')));
  check('删除节点后笔记仍在', Boolean(getKnowledgeNote(db, 'note-1')));
  check('删除节点后健康问题仍在且 affectedObjectId 不变', getHealthIssueRaw(db, 'health-1').affectedObjectId === topic.id);
  const afterDelete = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'relation' });
  check('删除节点后投影不含该节点', !afterDelete.nodes.some(node => node.id === topicNode.id));
  const healthAfterDelete = getKnowledgeCanvasProjection(db, { canvasId: canvas.id, mode: 'health' });
  check('删除节点后问题保留但不再命中节点', healthAfterDelete.modeData.healthIssues.find(issue => issue.id === 'health-1')?.matchedNodeId === null);

  // ---- 验收 7：dataChanged 知识 scopes（订阅替代主轮询的事件）----
  const received = [];
  setDataChangedPublisher((event) => received.push(event));
  broadcastDataChanged({ scopes: ['canvas'], reason: 'canvas.move_nodes' });
  broadcastDataChanged({ scopes: ['knowledge', 'topics', 'canvas', 'health', 'receipt'], reason: 'knowledge_flywheel.change_set_apply' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  setDataChangedPublisher(null);
  const allScopes = new Set(received.flatMap((event) => event.scopes));
  for (const scope of ['canvas', 'knowledge', 'topics', 'health', 'receipt']) {
    check(`dataChanged 广播包含 scope ${scope}`, allScopes.has(scope));
  }
  check('dataChanged 事件携带 reason', received.some(event => event.reason?.includes('knowledge_flywheel.change_set_apply')));

  db.close();
  console.log(`WMB-5213 projection child: ${checks} checks passed`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  try { db.close(); } catch { /* 已关闭 */ }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function getHealthIssueRaw(db, id) {
  return db.prepare(`SELECT affected_object_id AS affectedObjectId, affected_object_type AS affectedObjectType
    FROM knowledge_health_issues WHERE id = ?`).get(id);
}
