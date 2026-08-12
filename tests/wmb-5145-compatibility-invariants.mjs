import assert from 'node:assert/strict';

// —— 只读 registry 结构（A14 兼容不变量基线；从 5145 验收套件抽出）——
import {
  AGENT_CAPABILITIES, INFRA_GRANT_COMMANDS, REDLINE_COMMANDS, ROLE_CATALOG, TASK_INTENT_NEEDED_CAPS,
  roleReadProfiles, roleWriteCommands
} from '../src/shared/agent-capabilities.ts';

/**
 * WMB-5145 A14 兼容不变量（抽自 tests/wmb-5145-crew-multi-instance-acceptance.test.mjs）。
 * 锚定本批次（5135 前基线 + 2026-08-10 主管全站授权翻转）能力/角色/schema 快照，逐项可证伪：
 * - exact 冻结面：三表 schema、五角色目录、红线命令、红线三能力属性、批内 intent 所需能力、基建 grant 命令——任一改动即失败；
 * - 子集面：核心能力（11 项基线）与五角色 standing 写权/读面按「批内基线 ⊆ 派生值」校验，
 *   仅允许后续合法新增能力/命令只增扩展（如 WMB-5150 的 knowledge.topic_maintenance_propose
 *   与 cap.topic_approval），任何删除/变更即失败；标量属性必须等值（零漂移）；
 * - 新能力不白名单其语义，仅须不扰动上述批次交集面即可通过。
 * 不依赖整树 git 状态；与 WMB-5150 改动共存时仍须通过。
 *
 * 2026-08-10 re-baseline（WMB-5185 显式评审，approach A / Owner lock 2026-08-10）：
 * - `roleHasPagePassThrough` 与 `pageScopePassThrough` 字段已按 WMB-5182 删除（页透传冻结面移除）；
 * - desk（主管/主编席）standing 写权从「空集」翻转为「全量内部命令」——批内基线锚定
 *   `commandsCoveredByGrantableCapabilities() ∪ INFRA_GRANT_COMMANDS` 的当前 25 命令（只增语义，
 *   删除即失败）；等值/红线负断言由 `tests/agent-capabilities.test.mjs`（WMB-5182 A1）负责，不在此重复；
 * - `REDLINE_COMMANDS` 随红线三类别化（WMB-5182）补入 `publication.editor_prepare_execute`；
 * - cap.desk 元数据（主管全站写权）随 5182/5184 翻转。
 */

/** pinned ⊆ live：数组按成员包含（允许只增），普通对象按键递归，标量必须等值。 */
function assertPinnedSubset(pinned, live, label) {
  if (Array.isArray(pinned)) {
    assert.ok(Array.isArray(live), `${label} 仍为数组`);
    for (const item of pinned) {
      assert.ok(live.includes(item), `${label} 必须仍包含 ${item}（批内基线不被移除）`);
    }
    return;
  }
  if (pinned !== null && typeof pinned === 'object') {
    assert.ok(live !== null && typeof live === 'object', `${label} 仍为对象`);
    for (const key of Object.keys(pinned)) {
      assertPinnedSubset(pinned[key], live[key], `${label}.${key}`);
    }
    return;
  }
  assert.equal(live, pinned, `${label} 属性零漂移`);
}

// —— 5135 前基线 11 项核心能力（不含 WMB-5150 新增的 knowledge.topic_maintenance_propose / cap.topic_approval）——
const CORE_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'cap.collect', displayName: '采集', description: '渠道扫描入库与有界观察',
    commands: Object.freeze(['sources.upsert_batch', 'x_lists.observation_start', 'x_lists.observation_stop']),
    readProfiles: Object.freeze(['sources', 'x_lists']), defaultRoleBindings: Object.freeze({ reporter: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['daily_scan', 'daily_intelligence']), page: Object.freeze(['discover']) }),
    precise: false, agentGrantable: true, owner: 'intelligence', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.lane_judge', displayName: '赛道判定', description: '赛道相关性判定（判断侧）',
    commands: Object.freeze(['sources.lane_gate']), readProfiles: Object.freeze(['sources', 'plans', 'knowledge']),
    defaultRoleBindings: Object.freeze({ planner: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['daily_judge', 'daily_intelligence']), page: Object.freeze(['library']) }),
    precise: false, agentGrantable: true, owner: 'judgment', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.library_organize', displayName: '库房整理', description: '归档/恢复/状态/挂主题组织',
    commands: Object.freeze(['sources.lane_gate', 'sources.lane_restore', 'sources.update_status', 'knowledge.record_batch']),
    readProfiles: Object.freeze(['sources', 'knowledge']), defaultRoleBindings: Object.freeze({ librarian: true }),
    grantKinds: Object.freeze({ page: Object.freeze(['library']) }),
    precise: false, agentGrantable: true, owner: 'library', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.topic_decide', displayName: '选题决策', description: '保存运营方案与选题建议',
    commands: Object.freeze(['plans.save', 'knowledge.suggestion_create']),
    readProfiles: Object.freeze(['plans', 'knowledge', 'metrics', 'reviews', 'content']),
    defaultRoleBindings: Object.freeze({ planner: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['daily_judge', 'daily_intelligence']), page: Object.freeze(['today', 'proposals']) }),
    precise: false, agentGrantable: true, owner: 'planning', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.knowledge_curate', displayName: '知识归纳', description: '主题/领域/简报沉淀',
    commands: Object.freeze(['knowledge.record_batch', 'knowledge.domain_create', 'knowledge.domain_update', 'knowledge.creative_brief_create', 'knowledge.creative_brief_update', 'knowledge.creative_brief_create_project']),
    readProfiles: Object.freeze(['knowledge', 'canvas']), defaultRoleBindings: Object.freeze({ planner: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['daily_judge', 'daily_intelligence']), page: Object.freeze(['topic', 'canvas']) }),
    precise: false, agentGrantable: true, owner: 'knowledge', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.write', displayName: '写作', description: '内容项目创建与版本保存；资料库只读借阅',
    commands: Object.freeze(['content.create', 'content.save_version']),
    readProfiles: Object.freeze(['sources', 'knowledge', 'plans', 'content', 'reviews']),
    defaultRoleBindings: Object.freeze({ writer: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['studio_draft']), page: Object.freeze(['studio', 'proposals']) }),
    precise: false, agentGrantable: true, owner: 'studio', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.review', displayName: '复盘', description: '结果复盘沉淀（策划兼岗）',
    commands: Object.freeze(['reviews.save', 'knowledge.record_batch']),
    readProfiles: Object.freeze(['metrics', 'reviews', 'content']), defaultRoleBindings: Object.freeze({ planner: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['results_review']), page: Object.freeze(['results']) }),
    precise: false, agentGrantable: true, owner: 'results', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.desk', displayName: '主管全站写权', description: '全站内部 standing 写权（grantable 能力命令 ∪ 基建命令）；红线类别执行命令不可达',
    commands: Object.freeze([]),
    readProfiles: Object.freeze(['sources', 'knowledge', 'plans', 'content', 'reviews', 'metrics', 'x_lists', 'desk', 'canvas', 'publication']),
    defaultRoleBindings: Object.freeze({ desk: true }),
    grantKinds: Object.freeze({ page: Object.freeze(['today', 'discover', 'proposals', 'topic', 'library', 'canvas', 'studio', 'publish', 'results']) }),
    precise: false, agentGrantable: true, owner: 'desk', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.publish_prep', displayName: '发布准备（红线）', description: '平台发布准备；仅 Precise + Owner UI',
    commands: Object.freeze([]), readProfiles: Object.freeze(['publication', 'content']),
    defaultRoleBindings: Object.freeze({}), grantKinds: Object.freeze({}),
    precise: true, agentGrantable: false, owner: 'publish', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.hard_delete', displayName: '硬删（红线）', description: '硬删资料/项目；Owner UI only',
    commands: Object.freeze([]), readProfiles: Object.freeze([]),
    defaultRoleBindings: Object.freeze({}), grantKinds: Object.freeze({}),
    precise: true, agentGrantable: false, owner: 'owner-ui', since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.platform_mutation', displayName: '平台副作用（红线）', description: 'X List 执行变更与渠道提案应用；Precise + Owner UI',
    commands: Object.freeze(['x_lists.operation_execute', 'intelligence_channels.proposal_apply']),
    readProfiles: Object.freeze(['x_lists']), defaultRoleBindings: Object.freeze({}), grantKinds: Object.freeze({}),
    precise: true, agentGrantable: false, owner: 'platform', since: '2026-08-07'
  })
]);

// —— 五角色 standing 写权（批内基线 + 2026-08-10 主管翻转；5150 只增的 topic_maintenance_propose 不在此锚定）——
const ROLE_WRITE_SNAPSHOT = Object.freeze({
  // WMB-5185 re-baseline（approach A）：desk（主管/主编席）standing = 全量内部命令
  // （commandsCoveredByGrantableCapabilities() ∪ INFRA_GRANT_COMMANDS，2026-08-10 当前 25 命令排序集）。
  // 只增语义：后续合法新增内部命令可扩展，任何删除即失败；等值 + 红线负断言见 agent-capabilities.test.mjs WMB-5182 A1。
  desk: Object.freeze([
    'agent_tasks.report_progress',
    'content.create',
    'content.save_version',
    'intelligence_channels.proposal_apply_safe',
    'knowledge.creative_brief_create',
    'knowledge.creative_brief_create_project',
    'knowledge.creative_brief_update',
    'knowledge.domain_create',
    'knowledge.domain_update',
    'knowledge.record_batch',
    'knowledge.suggestion_create',
    'knowledge.topic_maintenance_approve',
    'knowledge.topic_maintenance_propose',
    'knowledge.topic_maintenance_reject',
    'knowledge.topic_maintenance_reproposal_retry',
    'plans.save',
    'publication.snapshot_create',
    'reviews.save',
    'sources.lane_gate',
    'sources.lane_restore',
    'sources.update_status',
    'sources.upsert_batch',
    'x_lists.observation_start',
    'x_lists.observation_stop',
    'x_lists.prepare'
  ]),
  librarian: Object.freeze(['knowledge.record_batch', 'sources.lane_gate', 'sources.lane_restore', 'sources.update_status']),
  planner: Object.freeze(['knowledge.creative_brief_create', 'knowledge.creative_brief_create_project', 'knowledge.creative_brief_update', 'knowledge.domain_create', 'knowledge.domain_update', 'knowledge.record_batch', 'knowledge.suggestion_create', 'plans.save', 'reviews.save', 'sources.lane_gate']),
  reporter: Object.freeze(['sources.upsert_batch', 'x_lists.observation_start', 'x_lists.observation_stop']),
  writer: Object.freeze(['content.create', 'content.save_version'])
});

// —— 五角色读面（批内基线；5150 未触碰）——
const ROLE_READ_SNAPSHOT = Object.freeze({
  desk: Object.freeze(['sources', 'knowledge', 'plans', 'content', 'reviews', 'metrics', 'x_lists', 'desk', 'canvas', 'publication']),
  librarian: Object.freeze(['sources', 'knowledge']),
  planner: Object.freeze(['sources', 'plans', 'knowledge', 'metrics', 'reviews', 'content', 'canvas']),
  reporter: Object.freeze(['sources', 'x_lists']),
  writer: Object.freeze(['sources', 'knowledge', 'plans', 'content', 'reviews'])
});

// —— 批内 intent 所需能力（exact 冻结）——
const INTENT_NEEDED_SNAPSHOT = Object.freeze({
  daily_scan: Object.freeze(['cap.collect']),
  daily_judge: Object.freeze(['cap.lane_judge', 'cap.topic_decide', 'cap.knowledge_curate']),
  daily_intelligence: Object.freeze(['cap.collect', 'cap.lane_judge', 'cap.topic_decide', 'cap.knowledge_curate']),
  studio_draft: Object.freeze(['cap.write']),
  results_review: Object.freeze(['cap.review'])
});

// —— 红线三能力 exact 快照（Precise + Owner-only；5150 未触碰）——
const REDLINE_CAP_SNAPSHOTS = Object.freeze({
  'cap.publish_prep': Object.freeze({
    id: 'cap.publish_prep', displayName: '发布准备（红线）', description: '平台发布准备；仅 Precise + Owner UI',
    commands: Object.freeze([]), readProfiles: Object.freeze(['publication', 'content']),
    defaultRoleBindings: Object.freeze({}), grantKinds: Object.freeze({}),
    precise: true, agentGrantable: false, owner: 'publish', since: '2026-08-07'
  }),
  'cap.hard_delete': Object.freeze({
    id: 'cap.hard_delete', displayName: '硬删（红线）', description: '硬删资料/项目；Owner UI only',
    commands: Object.freeze([]), readProfiles: Object.freeze([]),
    defaultRoleBindings: Object.freeze({}), grantKinds: Object.freeze({}),
    precise: true, agentGrantable: false, owner: 'owner-ui', since: '2026-08-07'
  }),
  'cap.platform_mutation': Object.freeze({
    id: 'cap.platform_mutation', displayName: '平台副作用（红线）', description: 'X List 执行变更与渠道提案应用；Precise + Owner UI',
    commands: Object.freeze(['x_lists.operation_execute', 'intelligence_channels.proposal_apply']),
    readProfiles: Object.freeze(['x_lists']), defaultRoleBindings: Object.freeze({}), grantKinds: Object.freeze({}),
    precise: true, agentGrantable: false, owner: 'platform', since: '2026-08-07'
  })
});

/**
 * A14 兼容不变量断言。需在 runtime database 上下文内调用（schema 走真实 PRAGMA）。
 */
export function assertCompatibilityInvariants({ database }) {
  // —— 三表 schema 零改动（本批次基线；任一新增列即失败）——
  const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_tasks','task_grants','execution_grants') ORDER BY name`).all().map((r) => r.name);
  assert.deepEqual(tables, ['agent_tasks', 'execution_grants', 'task_grants'], '无新表（JobPool 保持内存态）');
  const columns = (t) => database.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.deepEqual(columns('agent_tasks'), ['id', 'intent', 'business_date', 'status', 'phase', 'pi_session_id', 'context_refs_json', 'result_refs_json', 'progress_json', 'checkpoint_json', 'events_json', 'control_action', 'heartbeat_at', 'error_code', 'error_message', 'created_at', 'updated_at', 'finished_at'], 'agent_tasks schema 零改动（无新增列）');
  assert.deepEqual(columns('task_grants'), ['id', 'workspace_id', 'runtime_epoch', 'task_id', 'owner_goal', 'allowed_commands_json', 'workers_json', 'relevant_context_json', 'status', 'issued_at', 'expires_at', 'revoked_at', 'revision'], 'task_grants schema 零改动');
  assert.deepEqual(columns('execution_grants'), ['id', 'workspace_id', 'runtime_epoch', 'task_id', 'task_grant_id', 'command', 'input_hash', 'bound_identity_json', 'target_actor_type', 'target_actor_id', 'browser_profile_id', 'binding_revision', 'expected_account', 'allowed_transition', 'required_readback_json', 'status', 'issued_at', 'expires_at', 'consumed_at', 'revoked_at', 'revision'], 'execution_grants schema 零改动');

  // —— 五角色固定：id 与元数据均不漂移 ——
  assert.deepEqual(
    Object.fromEntries(Object.keys(ROLE_CATALOG).sort().map((r) => [r, ROLE_CATALOG[r]])),
    {
      desk: { roleId: 'desk', labelZh: '主管', roomZh: '主编席', skills: ['wemedia-buddy-operator'] },
      librarian: { roleId: 'librarian', labelZh: '资料员', roomZh: '资料室', skills: ['role-librarian'] },
      planner: { roleId: 'planner', labelZh: '策划', roomZh: '策划组', skills: ['role-planner'] },
      reporter: { roleId: 'reporter', labelZh: '记者', roomZh: '前线', skills: ['role-reporter'] },
      writer: { roleId: 'writer', labelZh: '写手', roomZh: '写字间', skills: ['role-writer'] }
    },
    '五角色固定（不增不减、元数据不漂移）'
  );

  // —— 核心能力（5135 前基线 11 项）仍是子集且属性零漂移（集合字段 pinned ⊆ live，标量等值）——
  const capsById = new Map(AGENT_CAPABILITIES.map((c) => [c.id, c]));
  for (const pinned of CORE_CAPABILITIES) {
    assert.equal(capsById.has(pinned.id), true, `${pinned.id} 必须仍在能力面（子集成立）`);
    assertPinnedSubset(pinned, capsById.get(pinned.id), pinned.id);
  }

  // —— 红线属性不漂移：红线命令冻结（2026-08-10 三类别化补入 publication.editor_prepare_execute），红线条目保持 Precise + Owner-only（零角色绑定/零 grant 通道）——
  assert.deepEqual([...REDLINE_COMMANDS], ['publication.editor_prepare_execute', 'x_lists.operation_execute', 'intelligence_channels.proposal_apply'], '红线命令冻结（三类别并集）');
  for (const [id, pinned] of Object.entries(REDLINE_CAP_SNAPSHOTS)) {
    assert.deepEqual(capsById.get(id), pinned, `${id} 红线属性零漂移`);
  }

  // —— 新增能力不扰动本批次交集面：五角色 standing 写权/读面保留批内基线、批内 intent 所需能力、基建 grant 命令 ——
  // （页透传冻结面已随 WMB-5182 删除 `roleHasPagePassThrough` / `pageScopePassThrough` 移除，approach A）
  for (const [role, write] of Object.entries(ROLE_WRITE_SNAPSHOT)) {
    const live = roleWriteCommands(role);
    assert.ok(live.length > 0, `${role} standing 写权非空`);
    for (const command of write) {
      assert.ok(live.includes(command), `${role} standing 写权保留 ${command}（批内基线不被移除）`);
    }
  }
  for (const [role, read] of Object.entries(ROLE_READ_SNAPSHOT)) {
    const live = roleReadProfiles(role);
    for (const face of read) {
      assert.ok(live.includes(face), `${role} 读面保留 ${face}（批内基线不被移除）`);
    }
  }
  for (const [intent, caps] of Object.entries(INTENT_NEEDED_SNAPSHOT)) {
    assert.deepEqual(TASK_INTENT_NEEDED_CAPS[intent], caps, `${intent} 所需能力不被新增能力扰动`);
  }
  assert.deepEqual([...INFRA_GRANT_COMMANDS], ['agent_tasks.report_progress'], '基建 grant 命令不漂移');
}
