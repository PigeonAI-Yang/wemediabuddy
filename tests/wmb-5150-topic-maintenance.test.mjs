import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'node:module';

const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);
const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { createTopicMaintenanceProposal, decideTopicMaintenanceProposal } = await import('../src/main/topic-maintenance.ts');
const { fingerprintTopic } = await import('../src/main/ferment.ts');
const { roleWriteCommands } = await import('../src/shared/agent-capabilities.ts');
const { dispatchCancelAgentTask, dispatchStartAgentTask } = await import('../src/main/agent-task-commands.ts');
const { dispatchBusinessCommand } = await import('../src/main/business-command.ts');
const { writeJobContractRefs } = await import('../src/main/generic-employee-runner.ts');
const { buildJobObjectBoundary } = await import('../src/main/role-job-registry.ts');
const { dispatchIssueTaskGrant } = await import('../src/main/task-grants.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { ensureOfficialWorkspaceProfile } = await import('../src/main/workspace-profiles.ts');
const { JobSpawner } = await import('../src/main/job-spawner.ts');
const { kickTopicReproposals, recordTopicReproposalFailure, resumeTopicReproposal } = await import('../src/main/topic-maintenance-reproposal.ts');

async function withDb(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5150-')); const db = migrateDatabase(path.join(root, 'wmb.db'));
  try { await work(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
async function withRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5150-runtime-')); let runtime;
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db')), now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`ws-${randomUUID()}`, now, now);
    ensureOfficialWorkspaceProfile(db, 'official.ai'); const ids = seed(db); db.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'epoch-5150' });
    await work(runtime, ids);
  } finally { if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {}); await rm(root, { recursive: true, force: true }); }
}
async function withReproposalRuntime(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5159-runtime-')); let runtime;
  try {
    const db = migrateDatabase(path.join(root, 'wmb.db')), now = new Date().toISOString();
    db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(`ws-${randomUUID()}`, now, now);
    const ids = seed(db), proposal = createTopicMaintenanceProposal(db, { title: 'durable stale', reason: 'revision', changes: [{ kind: 'archive', topicId: ids.keep }] });
    db.prepare('UPDATE topics SET revision=revision+1 WHERE id=?').run(ids.keep);
    const stale = decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision: 'approve' }); db.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => `epoch-${randomUUID()}` });
    await work(runtime, ids, stale);
  } finally { if (runtime?.isActive) await runtime.stop({ drain: false }).catch(() => {}); await rm(root, { recursive: true, force: true }); }
}
async function boundTask(runtime, request) {
  const started = await dispatchStartAgentTask(runtime, { intent: 'page_library', businessDate: '2026-08-10', contextRefs: { workspaceId: runtime.identity.workspaceId } }, { actor: { type: 'scheduler', id: 'test' }, requestId: randomUUID() });
  await writeJobContractRefs(runtime, started.task.id, { jobId: `job-${randomUUID()}`, request, boundary: buildJobObjectBoundary(request, null) });
  const issued = await dispatchIssueTaskGrant(runtime, { requestId: randomUUID(), taskId: started.task.id, ownerGoal: request.brief, allowedCommands: ['knowledge.topic_maintenance_propose', 'knowledge.topic_maintenance_approve'], workers: [{ type: 'external_agent', id: 'mcp' }], relevantContext: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(issued.ok, true); return { taskId: started.task.id, grantId: issued.data.id };
}
function seed(db) {
  const now = new Date().toISOString(), [keep, old, source, plan, item, project, carry, canvas, canvasNode, domain, version, platformVersion, account, publication, review] = Array.from({ length: 15 }, randomUUID);
  for (const [id, title] of [[keep, 'Agent 工作流'], [old, 'Agent工作流方法']]) db.prepare('INSERT INTO topics(id,title,created_at,updated_at,revision,canonical_key,kind,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,1,?,?,?, ?,?)').run(id,title,now,now,title.toLowerCase(),'theme','active',now,now);
  db.prepare("INSERT INTO source_items(id,canonical_url,title,collected_at,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision,verification_status,management_status) VALUES(?,?,?,?,?,?,?,?,?,?,1,'pending','active')").run(source,`https://example.com/${source}`,'source',now,'[]','[]','[]','[]',now,now);
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)').run(old,source,'primary',now,now);
  db.prepare('INSERT INTO plans(id,plan_date,timezone,summary,is_current,created_at,updated_at,revision) VALUES(?,?,?,?,1,?,?,1)').run(plan,'2026-08-10','Asia/Shanghai','p',now,now);
  db.prepare("INSERT INTO plan_items(id,plan_id,topic_id,title,priority,why_now,timeliness,target_audience,angle,point_of_view,platforms_json,formats_json,title_guidance,opening_guidance,structure_guidance,effort_estimate,source_ids_json,review_ids_json,method_finding_ids_json,sort_order,created_at,updated_at,revision) VALUES(?,?,?,?,0,'','','','','','[]','[]','','','','','[]','[]','[]',0,?,?,1)").run(item,plan,old,'item',now,now);
  db.prepare('INSERT INTO content_projects(id,topic_id,plan_item_id,title,created_at,updated_at,revision,status) VALUES(?,?,?,?,?,?,1,?)').run(project,old,item,'project',now,now,'idea');
  db.prepare("INSERT INTO work_carry_items(id,object_type,object_id,fingerprint,title,state,topic_id,first_seen_at,last_seen_at,expires_at,created_at,updated_at,revision,story_key) VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,1,?)").run(carry,'topic',old,fingerprintTopic(old),'carry',old,now,now,now,now,now,`topic:${old}`);
  db.prepare('INSERT INTO knowledge_canvases(id,title,topic_id,created_at,updated_at,revision) VALUES(?,?,?,?,?,1)').run(canvas,'canvas',old,now,now);
  db.prepare("INSERT INTO knowledge_canvas_nodes(id,canvas_id,object_type,object_id,x,y,created_at,updated_at,revision) VALUES(?,?,'topic',?,0,0,?,?,1)").run(canvasNode,canvas,old,now,now);
  db.prepare('INSERT INTO knowledge_domains(id,title,created_at,updated_at,revision) VALUES(?,?,?,?,1)').run(domain,`domain-${domain}`,now,now);
  db.prepare('INSERT INTO knowledge_domain_topics(domain_id,topic_id,sort_order,added_at) VALUES(?,?,0,?)').run(domain,old,now);
  db.prepare('INSERT INTO content_versions(id,project_id,body,version_number,created_at) VALUES(?,?,?,?,?)').run(version,project,'body',1,now);
  db.prepare('INSERT INTO platform_versions(id,project_id,content_version_id,platform,format,body,asset_ids_json,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?, ?,?,1)').run(platformVersion,project,version,'x','text','body','[]',now,now);
  db.prepare("INSERT INTO platform_accounts(id,platform,account_key,display_name,login_state,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,1)").run(account,'x','@owner','owner','authenticated',now,now);
  db.prepare("INSERT INTO publications(id,platform_version_id,platform_version_revision,platform,account_id,account_key,status,prepared_assets_json,created_at,updated_at,revision) VALUES(?,?,1,'x',?,?,'draft','[]',?,?,1)").run(publication,platformVersion,account,'@owner',now,now);
  db.prepare("INSERT INTO reviews(id,publication_id,content_version_id,metric_snapshot_ids_json,status,keep_json,stop_json,change_json,created_at,updated_at,revision) VALUES(?,?,?,'[]','draft','[]','[]','[]',?,?,1)").run(review,publication,version,now,now);
  return { keep, old, source, plan, item, project, carry, canvas, canvasNode, domain, review };
}

test('WMB-5150: proposal/reject/approve/stale preserve or atomically migrate formal topic facts', async () => withDb((db) => {
  const ids = seed(db), before = db.prepare('SELECT count(*) count FROM topics').get().count;
  const proposal = createTopicMaintenanceProposal(db, { title: '合并重复主题', reason: 'duplicate', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] });
  assert.equal(db.prepare('SELECT count(*) count FROM topics').get().count, before);
  const rejected = decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision: 'reject' });
  assert.equal(rejected.status, 'rejected'); assert.equal(db.prepare('SELECT topic_id id FROM plan_items WHERE id=?').get(ids.item).id, ids.old);
  const accepted = createTopicMaintenanceProposal(db, { title: '合并重复主题', reason: 'duplicate', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] });
  assert.deepEqual(accepted.snapshot.before.reviews.map((row) => row.review_id), [ids.review], 'review 只经既有项目谱系派生');
  assert.equal(accepted.snapshot.counts.workCarryItems, 1);
  const applied = decideTopicMaintenanceProposal(db, { id: accepted.id, expectedRevision: accepted.revision, decision: 'approve' });
  assert.equal(applied.status, 'approved');
  assert.equal(db.prepare('SELECT status FROM topics WHERE id=?').get(ids.old).status, 'archived');
  assert.equal(db.prepare('SELECT topic_id id FROM topic_source_links WHERE source_id=?').get(ids.source).id, ids.keep);
  assert.equal(db.prepare('SELECT topic_id id FROM plan_items WHERE id=?').get(ids.item).id, ids.keep);
  assert.equal(db.prepare('SELECT topic_id id FROM content_projects WHERE id=?').get(ids.project).id, ids.keep);
  assert.equal(db.prepare('SELECT topic_id id FROM work_carry_items WHERE id=?').get(ids.carry).id, ids.keep);
  assert.equal(db.prepare('SELECT object_id id FROM work_carry_items WHERE id=?').get(ids.carry).id, ids.keep);
  assert.equal(db.prepare('SELECT fingerprint FROM work_carry_items WHERE id=?').get(ids.carry).fingerprint, fingerprintTopic(ids.keep));
  assert.equal(db.prepare('SELECT story_key key FROM work_carry_items WHERE id=?').get(ids.carry).key, `topic:${ids.keep}`);
  assert.equal(db.prepare('SELECT topic_id id FROM knowledge_canvases WHERE id=?').get(ids.canvas).id, ids.keep);
  assert.equal(db.prepare('SELECT object_id id FROM knowledge_canvas_nodes WHERE id=?').get(ids.canvasNode).id, ids.keep);
  assert.equal(db.prepare('SELECT topic_id id FROM knowledge_domain_topics WHERE domain_id=?').get(ids.domain).id, ids.keep);
  assert.equal(db.prepare('SELECT cp.topic_id id FROM reviews r JOIN publications p ON p.id=r.publication_id JOIN platform_versions pv ON pv.id=p.platform_version_id JOIN content_projects cp ON cp.id=pv.project_id WHERE r.id=?').get(ids.review).id, ids.keep);
  assert.equal(db.prepare("SELECT (SELECT count(*) FROM topic_source_links WHERE topic_id=?) + (SELECT count(*) FROM plan_items WHERE topic_id=?) + (SELECT count(*) FROM content_projects WHERE topic_id=?) + (SELECT count(*) FROM work_carry_items WHERE topic_id=? OR (object_type='topic' AND object_id=?)) + (SELECT count(*) FROM knowledge_canvases WHERE topic_id=?) + (SELECT count(*) FROM knowledge_canvas_nodes WHERE object_type='topic' AND object_id=?) + (SELECT count(*) FROM knowledge_domain_topics WHERE topic_id=?) AS count").get(ids.old,ids.old,ids.old,ids.old,ids.old,ids.old,ids.old,ids.old).count, 0);
  const stale = createTopicMaintenanceProposal(db, { title: 'stale', reason: 'revision', changes: [{ kind: 'archive', topicId: ids.keep }] });
  db.prepare('UPDATE topics SET revision=revision+1 WHERE id=?').run(ids.keep);
  assert.equal(decideTopicMaintenanceProposal(db, { id: stale.id, expectedRevision: stale.revision, decision: 'approve' }).status, 'stale');
  assert.equal(db.prepare('SELECT status FROM topics WHERE id=?').get(ids.keep).status, 'active');
}));

test('WMB-5150: changed membership, missing objects, and invalid merge graph make a proposal stale or rejected', async () => withDb((db) => {
  const ids = seed(db);
  const relation = createTopicMaintenanceProposal(db, { title: 'relation stale', reason: 'r', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] });
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)').run(ids.old, ids.source, 'supporting', new Date().toISOString(), new Date().toISOString());
  assert.equal(decideTopicMaintenanceProposal(db, { id: relation.id, expectedRevision: relation.revision, decision: 'approve' }).status, 'stale');
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'cycle', reason: 'c', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }, { kind: 'merge', retainedTopicId: ids.old, mergedTopicId: ids.keep }] }), /TOPIC_MERGE_CHAIN|TOPIC_CHANGE_CONTRADICTORY/);
  const third = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO topics(id,title,created_at,updated_at,revision,canonical_key,kind,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,1,?,?,?, ?,?)').run(third,'第三主题',now,now,third,'theme','active',now,now);
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'chain', reason: 'c', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }, { kind: 'merge', retainedTopicId: third, mergedTopicId: ids.keep }] }), /TOPIC_MERGE_CHAIN/);
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'empty reassign', reason: 'r', changes: [{ kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: ids.keep, relation: 'missing' }] }), /TOPIC_REASSIGN_LINK_NOT_FOUND/);
  const missing = createTopicMaintenanceProposal(db, { title: 'missing stale', reason: 'm', changes: [{ kind: 'archive', topicId: ids.keep }] });
  db.prepare('DELETE FROM topics WHERE id=?').run(ids.keep);
  assert.equal(decideTopicMaintenanceProposal(db, { id: missing.id, expectedRevision: missing.revision, decision: 'approve' }).status, 'stale');
}));

test('WMB-5157: unrelated links for non-target sources do not make approval stale', async () => withDb((db) => {
  const ids = seed(db), unrelatedTopic = randomUUID(), unrelatedSource = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO topics(id,title,created_at,updated_at,revision,canonical_key,kind,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,1,?,?,?, ?,?)').run(unrelatedTopic,'第三主题',now,now,unrelatedTopic,'theme','active',now,now);
  db.prepare("INSERT INTO source_items(id,canonical_url,title,collected_at,categories_json,keywords_json,recommended_platforms_json,recommended_formats_json,created_at,updated_at,revision,verification_status,management_status) VALUES(?,?,?,?,?,?,?,?,?,?,1,'pending','active')").run(unrelatedSource,`https://example.com/${unrelatedSource}`,'unrelated',now,'[]','[]','[]','[]',now,now);
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)').run(ids.keep,unrelatedSource,'primary',now,now);
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)').run(unrelatedTopic,unrelatedSource,'supporting',now,now);
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)').run(unrelatedTopic,ids.source,'supporting',now,now);
  const proposal = createTopicMaintenanceProposal(db, { title: '迁移后归档', reason: 'duplicate', changes: [{ kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: ids.keep, relation: 'primary' }, { kind: 'archive', topicId: ids.old }] });
  assert.equal(proposal.snapshot.before.sourceLinks.length, 3, '快照包含两个目标主题及显式迁移资料的第三主题关系');
  const applied = decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision: 'approve' });
  assert.equal(applied.status, 'approved');
  assert.deepEqual(db.prepare('SELECT topic_id,relation FROM topic_source_links WHERE source_id=? ORDER BY topic_id,relation').all(ids.source).map((row) => `${row.topic_id}|${row.relation}`), [`${ids.keep}|primary`, `${unrelatedTopic}|supporting`].sort());
  assert.equal(db.prepare('SELECT status FROM topics WHERE id=?').get(ids.old).status, 'archived');
  assert.deepEqual(db.prepare('SELECT topic_id,relation FROM topic_source_links WHERE source_id=? ORDER BY topic_id,relation').all(unrelatedSource).map((row) => `${row.topic_id}|${row.relation}`), [`${ids.keep}|primary`, `${unrelatedTopic}|supporting`].sort(), '无关资料关系保持不变');
}));

test('WMB-5158: unrelated third-topic link for the reassign source does not change the approved move', async () => withDb((db) => {
  const ids = seed(db), third = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO topics(id,title,created_at,updated_at,revision,canonical_key,kind,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,1,?,?,?, ?,?)').run(third,'第三主题',now,now,third,'theme','active',now,now);
  const proposal = createTopicMaintenanceProposal(db, { title: '迁移后归档', reason: 'duplicate', changes: [{ kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: ids.keep, relation: 'primary' }, { kind: 'archive', topicId: ids.old }] });
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)').run(third,ids.source,'supporting',now,now);
  const applied = decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision: 'approve' });
  assert.equal(applied.status, 'approved');
  assert.equal(db.prepare('SELECT status FROM topics WHERE id=?').get(ids.old).status, 'archived');
  assert.deepEqual(db.prepare('SELECT topic_id,relation FROM topic_source_links WHERE source_id=? ORDER BY topic_id,relation').all(ids.source).map((row) => `${row.topic_id}|${row.relation}`), [`${ids.keep}|primary`, `${third}|supporting`].sort());
}));

test('WMB-5158: v2 contract reports only outcome-changing topic, canonical and merge-membership conflicts', async () => withDb((db) => {
  const ids = seed(db);
  const merge = createTopicMaintenanceProposal(db, { title: 'merge conflict', reason: 'membership', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] });
  db.prepare('UPDATE plan_items SET revision=revision+1 WHERE id=?').run(ids.item);
  const stale = decideTopicMaintenanceProposal(db, { id: merge.id, expectedRevision: merge.revision, decision: 'approve' });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.staleReason.some((item) => item.kind === 'merge_membership'), true);
  assert.equal(db.prepare('SELECT status FROM topics WHERE id=?').get(ids.old).status, 'active');

  const update = createTopicMaintenanceProposal(db, { title: 'rename', reason: 'rename', changes: [{ kind: 'update', topicId: ids.keep, after: { title: '全新主题名', canonicalKey: 'fresh-key' } }] });
  const now = new Date().toISOString(), occupied = randomUUID();
  db.prepare('INSERT INTO topics(id,title,created_at,updated_at,revision,canonical_key,kind,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,1,?,?,?, ?,?)').run(occupied,'抢占',now,now,'fresh-key','theme','active',now,now);
  const canonicalStale = decideTopicMaintenanceProposal(db, { id: update.id, expectedRevision: update.revision, decision: 'approve' });
  assert.equal(canonicalStale.status, 'stale');
  assert.equal(canonicalStale.staleReason.some((item) => item.kind === 'canonical_absent'), true);

  const targetCollision = createTopicMaintenanceProposal(db, { title: 'target collision', reason: 'canvas key', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] });
  db.prepare("INSERT INTO knowledge_canvas_nodes(id,canvas_id,object_type,object_id,x,y,created_at,updated_at,revision) VALUES(?,?,'topic',?,0,0,?,?,1)").run(randomUUID(), ids.canvas, ids.keep, now, now);
  const collisionStale = decideTopicMaintenanceProposal(db, { id: targetCollision.id, expectedRevision: targetCollision.revision, decision: 'approve' });
  assert.equal(collisionStale.status, 'stale');
  assert.equal(collisionStale.staleReason.some((item) => item.kind === 'merge_target_keys'), true);
}));

test('WMB-5158: target carry wording is irrelevant while baseline canvas collision and merge/reassign overlap are rejected', async () => withDb((db) => {
  const ids = seed(db), now = new Date().toISOString();
  const collisionNode = randomUUID();
  db.prepare("INSERT INTO knowledge_canvas_nodes(id,canvas_id,object_type,object_id,x,y,created_at,updated_at,revision) VALUES(?,?,'topic',?,0,0,?,?,1)").run(collisionNode, ids.canvas, ids.keep, now, now);
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'canvas collision', reason: 'invalid', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] }), /TOPIC_MERGE_CANVAS_COLLISION/);
  db.prepare('DELETE FROM knowledge_canvas_nodes WHERE id=?').run(collisionNode);

  const third = randomUUID();
  db.prepare('INSERT INTO topics(id,title,created_at,updated_at,revision,canonical_key,kind,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,1,?,?,?, ?,?)').run(third,'顺序第三主题',now,now,third,'theme','active',now,now);
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'order dependent', reason: 'invalid', changes: [{ kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: third, relation: 'primary' }, { kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] }), /TOPIC_CHANGE_CONTRADICTORY/);
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'reactivate merged', reason: 'invalid', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }, { kind: 'update', topicId: ids.old, after: { title: 'reactivated', canonicalKey: 'reactivated' } }] }), /TOPIC_CHANGE_CONTRADICTORY/);
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)').run(ids.keep, ids.source, 'primary', now, now);
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'retained order dependent', reason: 'invalid', changes: [{ kind: 'reassign', sourceId: ids.source, fromTopicId: ids.keep, toTopicId: third, relation: 'primary' }, { kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] }), /TOPIC_CHANGE_CONTRADICTORY/);
  db.prepare('DELETE FROM topic_source_links WHERE topic_id=? AND source_id=? AND relation=?').run(ids.keep, ids.source, 'primary');
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'overlap all then one', reason: 'invalid', changes: [{ kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: ids.keep }, { kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: third, relation: 'primary' }] }), /TOPIC_CHANGE_CONTRADICTORY/);
  assert.throws(() => createTopicMaintenanceProposal(db, { title: 'overlap one then all', reason: 'invalid', changes: [{ kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: third, relation: 'primary' }, { kind: 'reassign', sourceId: ids.source, fromTopicId: ids.old, toTopicId: ids.keep }] }), /TOPIC_CHANGE_CONTRADICTORY/);

  db.prepare("INSERT INTO work_carry_items(id,object_type,object_id,fingerprint,title,state,topic_id,first_seen_at,last_seen_at,expires_at,created_at,updated_at,revision,story_key) VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,1,?)").run(randomUUID(),'topic',ids.keep,fingerprintTopic(ids.keep),'retained wording',ids.keep,now,now,now,now,now,`topic:${ids.keep}`);
  const proposal = createTopicMaintenanceProposal(db, { title: 'carry wording', reason: 'irrelevant', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] });
  db.prepare("UPDATE work_carry_items SET title='editorial wording only',revision=revision+1 WHERE object_type='topic' AND object_id=?").run(ids.keep);
  assert.equal(decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision: 'approve' }).status, 'approved');
}));

test('WMB-5150: savepoint rolls back an interrupted batch', async () => withDb((db) => {
  const ids = seed(db);
  const proposal = createTopicMaintenanceProposal(db, { title: 'rollback', reason: 'injected failure', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] });
  db.exec("CREATE TRIGGER fail_plan_topic BEFORE UPDATE OF topic_id ON plan_items BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: 1, decision: 'approve' }), /injected/);
  assert.equal(db.prepare('SELECT topic_id id FROM topic_source_links WHERE source_id=?').get(ids.source).id, ids.old);
  assert.equal(db.prepare('SELECT status FROM topic_maintenance_proposals WHERE id=?').get(proposal.id).status, 'proposed');
}));

test('WMB-5150: dispatcher enforces librarian object scope, Owner replay, and Agent decision redline', async () => withRuntime(async (runtime, ids) => {
  const scoped = await boundTask(runtime, { roleId: 'librarian', brief: '整理指定资料', sourceIds: [ids.source] });
  const blocked = await dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_propose', requestId: randomUUID(), actor: { type: 'external_agent', id: 'mcp' }, taskId: scoped.taskId, grantId: scoped.grantId, input: { title: '越界合并', reason: 'blocked', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] }, boundIdentity: { entityType: 'topic_maintenance_proposal' }, entityType: 'topic_maintenance_proposal', execute: () => { throw new Error('HANDLER_MUST_NOT_RUN'); } });
  assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'TASK_SCOPE_BROADENED'); assert.equal(blocked.error.details.reason, 'OBJECT_SCOPE_MISMATCH');
  await dispatchCancelAgentTask(runtime, scoped.taskId, { actor: { type: 'scheduler', id: 'test' }, requestId: randomUUID() });

  const workspace = await boundTask(runtime, { roleId: 'librarian', brief: '整理全库', scope: 'workspace' });
  const proposed = await dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_propose', requestId: 'proposal-create', actor: { type: 'external_agent', id: 'mcp' }, taskId: workspace.taskId, grantId: workspace.grantId, input: { title: '合并重复主题', reason: 'duplicate', changes: [{ kind: 'merge', retainedTopicId: ids.keep, mergedTopicId: ids.old }] }, boundIdentity: { entityType: 'topic_maintenance_proposal' }, entityType: 'topic_maintenance_proposal', execute: (database, input) => { const data = createTopicMaintenanceProposal(database, { ...input, taskId: workspace.taskId }); return { data, entityId: data.id, readback: data }; } });
  assert.equal(proposed.ok, true);
  const denied = await dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_approve', requestId: 'agent-approve', actor: { type: 'external_agent', id: 'mcp' }, taskId: workspace.taskId, grantId: workspace.grantId, input: { id: proposed.data.id, expectedRevision: 1, decision: 'approve' }, boundIdentity: { entityType: 'topic_maintenance_proposal', entityId: proposed.data.id }, entityType: 'topic_maintenance_proposal', execute: () => { throw new Error('HANDLER_MUST_NOT_RUN'); } });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'TASK_SCOPE_BROADENED');
  const approve = () => dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_approve', requestId: 'owner-approve', actor: { type: 'owner_ui', id: 'renderer' }, input: { id: proposed.data.id, expectedRevision: 1, decision: 'approve' }, boundIdentity: { entityType: 'topic_maintenance_proposal', entityId: proposed.data.id }, entityType: 'topic_maintenance_proposal', execute: (database, input) => { const data = decideTopicMaintenanceProposal(database, input); return { data, entityId: data.id, readback: data }; } });
  const first = await approve(), replay = await approve(); assert.equal(first.ok, true); assert.deepEqual(replay, first);
}));

test('WMB-5150: only librarian receives proposal write, never Owner decision commands', () => {
  const librarian = roleWriteCommands('librarian');
  assert.ok(librarian.includes('knowledge.topic_maintenance_propose'));
  for (const role of ['desk', 'planner', 'librarian']) {
    const commands = roleWriteCommands(role);
    assert.equal(commands.includes('knowledge.topic_maintenance_approve'), false);
    assert.equal(commands.includes('knowledge.topic_maintenance_reject'), false);
  }
});

test('WMB-5159: true stale atomically persists one reproposal job and one idempotent successor', async () => withReproposalRuntime(async (runtime, ids, stale) => {
  assert.equal(stale.status, 'stale'); assert.equal(stale.reproposal.status, 'pending'); assert.equal(stale.reproposal.attempts, 0);
  assert.equal(runtime.database.prepare('SELECT count(*) count FROM topic_maintenance_reproposal_jobs WHERE proposal_id=?').get(stale.id).count, 1);

  const firstSpawner = new JobSpawner(runtime, { maxWorkers: 1, execute: async () => ({ status: 'failed', code: 'TEST', message: 'test', readback: null }) });
  assert.equal(await kickTopicReproposals(runtime, firstSpawner), 1);
  assert.equal(firstSpawner.get(stale.reproposal.runId)?.id, stale.reproposal.runId);
  firstSpawner.dispose();
  const restartedSpawner = new JobSpawner(runtime, { maxWorkers: 1, execute: async () => ({ status: 'failed', code: 'TEST', message: 'test', readback: null }) });
  assert.equal(await kickTopicReproposals(runtime, restartedSpawner), 1);
  assert.equal(restartedSpawner.get(stale.reproposal.runId)?.id, stale.reproposal.runId, 'cold pool consumes the persisted run identity');

  const successorInput = { supersedesProposalId: stale.id, title: 'latest facts', reason: 'recomputed', changes: [{ kind: 'archive', topicId: ids.keep }] };
  const save = (requestId) => dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_propose', requestId, actor: { type: 'owner_ui', id: 'test' }, input: successorInput, boundIdentity: { entityType: 'topic_maintenance_proposal' }, entityType: 'topic_maintenance_proposal', execute: (database, input) => { const data = createTopicMaintenanceProposal(database, input); return { data, entityId: data.id, readback: data }; } });
  const successor = (await save('successor-1')).data;
  const replay = (await save('successor-2')).data;
  assert.equal(replay.id, successor.id); assert.equal(successor.supersedesProposalId, stale.id);
  assert.equal(runtime.database.prepare('SELECT status FROM topic_maintenance_reproposal_jobs WHERE proposal_id=?').get(stale.id).status, 'completed');
  restartedSpawner.dispose();
}));

test('WMB-5159: outbox insert failure rolls stale back and repeated failures terminate needs_user', async () => {
  await withDb((db) => {
    const ids = seed(db), proposal = createTopicMaintenanceProposal(db, { title: 'rollback outbox', reason: 'failure', changes: [{ kind: 'archive', topicId: ids.keep }] });
    db.prepare('UPDATE topics SET revision=revision+1 WHERE id=?').run(ids.keep);
    db.exec("CREATE TRIGGER fail_topic_reproposal BEFORE INSERT ON topic_maintenance_reproposal_jobs BEGIN SELECT RAISE(ABORT,'outbox failed'); END");
    assert.throws(() => decideTopicMaintenanceProposal(db, { id: proposal.id, expectedRevision: proposal.revision, decision: 'approve' }), /outbox failed/);
    assert.equal(db.prepare('SELECT status FROM topic_maintenance_proposals WHERE id=?').get(proposal.id).status, 'proposed');
    assert.equal(db.prepare('SELECT count(*) count FROM topic_maintenance_reproposal_jobs').get().count, 0);
  });
  await withReproposalRuntime(async (runtime, _ids, stale) => {
    let current = stale.reproposal;
    const stableJobId = current.jobId;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await recordTopicReproposalFailure(runtime, current.runId, `failure-${attempt}`);
      current = runtime.database.prepare('SELECT job_id jobId,run_id runId,status,attempts FROM topic_maintenance_reproposal_jobs WHERE proposal_id=?').get(stale.id);
      assert.equal(current.jobId, stableJobId, 'logical outbox job identity never changes');
    }
    assert.equal(current.status, 'needs_user'); assert.equal(current.attempts, 3);
    const resumed = await dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_reproposal_retry', requestId: randomUUID(), actor: { type: 'owner_ui', id: 'test' }, input: { proposalId: stale.id }, boundIdentity: { entityType: 'topic_maintenance_reproposal_job', entityId: stale.id }, entityType: 'topic_maintenance_reproposal_job', execute: (database, input) => { const data = resumeTopicReproposal(database, input.proposalId, new Date().toISOString()); return { data, entityId: data.proposalId, readback: data }; } });
    assert.equal(resumed.ok, true); assert.equal(resumed.data.status, 'pending'); assert.equal(resumed.data.attempts, 0); assert.equal(resumed.data.jobId, stableJobId); assert.notEqual(resumed.data.runId, current.runId);
    current = resumed.data;
    for (let attempt = 1; attempt <= 3; attempt += 1) { await recordTopicReproposalFailure(runtime, current.runId, `second-${attempt}`); current = runtime.database.prepare('SELECT job_id jobId,run_id runId,status,attempts FROM topic_maintenance_reproposal_jobs WHERE proposal_id=?').get(stale.id); }
    const secondResume = await dispatchBusinessCommand(runtime, { command: 'knowledge.topic_maintenance_reproposal_retry', requestId: randomUUID(), actor: { type: 'owner_ui', id: 'test' }, input: { proposalId: stale.id }, boundIdentity: { entityType: 'topic_maintenance_reproposal_job', entityId: stale.id }, entityType: 'topic_maintenance_reproposal_job', execute: (database, input) => { const data = resumeTopicReproposal(database, input.proposalId, new Date().toISOString()); return { data, entityId: data.proposalId, readback: data }; } });
    assert.equal(secondResume.ok, true); assert.equal(secondResume.data.status, 'pending'); assert.equal(secondResume.data.jobId, stableJobId); assert.notEqual(secondResume.data.runId, resumed.data.runId);
  });
});

test('WMB-5159: disabled employee capacity leaves durable reproposal pending without consuming retries', async () => withReproposalRuntime(async (runtime, _ids, stale) => {
  const spawner = new JobSpawner(runtime, { maxWorkers: 0, execute: async () => ({ status: 'succeeded', code: 'OK', message: null, readback: null }) });
  assert.equal(await kickTopicReproposals(runtime, spawner), 0);
  const row = runtime.database.prepare('SELECT status,attempts,job_id jobId,run_id runId FROM topic_maintenance_reproposal_jobs WHERE proposal_id=?').get(stale.id);
  assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0); assert.equal(row.jobId, stale.reproposal.jobId); assert.equal(row.runId, stale.reproposal.runId);
  spawner.setMaxWorkers(1);
  assert.equal(await kickTopicReproposals(runtime, spawner), 1);
  assert.equal(spawner.get(stale.reproposal.runId)?.id, stale.reproposal.runId);
  spawner.dispose();
}));

test('WMB-5159: a terminal run advances to a new run without changing the durable job identity', async () => withReproposalRuntime(async (runtime, _ids, stale) => {
  const spawner = new JobSpawner(runtime, { maxWorkers: 1, execute: async () => ({ status: 'failed', code: 'TEST', message: 'retry', readback: null }) });
  assert.equal(await kickTopicReproposals(runtime, spawner), 1);
  while (spawner.get(stale.reproposal.runId)?.status !== 'failed') await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await kickTopicReproposals(runtime, spawner), 0);
  const retry = runtime.database.prepare('SELECT job_id jobId,run_id runId,attempts FROM topic_maintenance_reproposal_jobs WHERE proposal_id=?').get(stale.id);
  assert.equal(retry.jobId, stale.reproposal.jobId); assert.equal(retry.runId, `${retry.jobId}:1`); assert.equal(retry.attempts, 1);
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  assert.equal(await kickTopicReproposals(runtime, spawner), 1);
  assert.equal(spawner.get(retry.runId)?.id, retry.runId);
  spawner.dispose();
}));
