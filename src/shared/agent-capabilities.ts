/**
 * Agent Capability Registry (L2) — single source for role×command bindings.
 * Design: docs/spark/2026-08-07-role-permission-design.md
 *
 * NOTE: This is the *authorization* capability axis.
 * Do not confuse with workspace-mcp `workspace.capabilities` (feature flags).
 */

export type RoleId = 'desk' | 'reporter' | 'planner' | 'writer' | 'librarian';

export type EntityFace =
  | 'sources'
  | 'knowledge'
  | 'plans'
  | 'content'
  | 'reviews'
  | 'metrics'
  | 'x_lists'
  | 'desk'
  | 'canvas'
  | 'publication'
  | 'settings';

export type AgentCapabilityId =
  | 'cap.collect'
  | 'cap.research'
  | 'cap.lane_judge'
  | 'cap.library_organize'
  | 'cap.topic_approval'
  | 'cap.topic_decide'
  | 'cap.knowledge_curate'
  | 'cap.write'
  | 'cap.review'
  | 'cap.desk'
  | 'cap.internal_prepare'
  | 'cap.wiki_maintain'
  | 'cap.publish_prep'
  | 'cap.hard_delete'
  | 'cap.platform_mutation';

export type AgentCapability = Readonly<{
  id: AgentCapabilityId;
  displayName: string;
  description: string;
  commands: readonly string[];
  readProfiles: readonly EntityFace[];
  /** Optional read-tool hard whitelist (research sessions fail-closed to this set). Absent = no constraint (zero regression for other roles/intents). */
  readToolWhitelist?: readonly string[];
  defaultRoleBindings: Readonly<Partial<Record<RoleId, boolean>>>;
  grantKinds: Readonly<{ task?: readonly string[]; page?: readonly string[] }>;
  precise: boolean;
  agentGrantable: boolean;
  owner: string;
  since: string;
}>;

export type RoleCatalogEntry = Readonly<{
  roleId: RoleId;
  labelZh: string;
  roomZh: string;
  skills: readonly string[];
}>;

/** Infrastructure command available on every automatic grant; not a business capability. */
export const INFRA_GRANT_COMMANDS = Object.freeze(['agent_tasks.report_progress'] as const);

export const ROLE_CATALOG: Readonly<Record<RoleId, RoleCatalogEntry>> = Object.freeze({
  desk: Object.freeze({ roleId: 'desk', labelZh: '主管', roomZh: '主编席', skills: Object.freeze(['wemedia-buddy-operator'] as const) }),
  reporter: Object.freeze({ roleId: 'reporter', labelZh: '记者', roomZh: '前线', skills: Object.freeze(['role-reporter'] as const) }),
  planner: Object.freeze({ roleId: 'planner', labelZh: '策划', roomZh: '策划组', skills: Object.freeze(['role-planner'] as const) }),
  writer: Object.freeze({ roleId: 'writer', labelZh: '写手', roomZh: '写字间', skills: Object.freeze(['role-writer'] as const) }),
  librarian: Object.freeze({ roleId: 'librarian', labelZh: '资料员', roomZh: '资料室', skills: Object.freeze(['role-librarian'] as const) })
});

export const AGENT_CAPABILITIES: readonly AgentCapability[] = Object.freeze([
  Object.freeze({
    id: 'cap.collect',
    displayName: '采集',
    description: '渠道扫描入库与有界观察',
    commands: Object.freeze(['sources.upsert_batch', 'x_lists.observation_start', 'x_lists.observation_stop'] as const),
    readProfiles: Object.freeze(['sources', 'x_lists'] as const),
    defaultRoleBindings: Object.freeze({ reporter: true, desk: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['daily_scan', 'daily_intelligence'] as const), page: Object.freeze(['discover'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'intelligence',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.research',
    displayName: '研究补料',
    description: '按需研究：白名单读（Web/X/XHS 只读）→ 证据入库 → claim 判定',
    commands: Object.freeze(['sources.upsert_batch'] as const),
    readProfiles: Object.freeze(['sources', 'x_lists'] as const),
    readToolWhitelist: Object.freeze([
      'wmb_search_web', 'wmb_read_web_page',
      'wmb_read_x_list_index', 'wmb_read_x_list_detail', 'wmb_read_x_list_members', 'wmb_read_x_list_timeline',
      'xhs_check_login_status', 'xhs_search_feeds', 'xhs_get_feed_detail', 'xhs_user_profile',
      'wmb_get_source', 'wmb_search_sources'
    ] as const),
    defaultRoleBindings: Object.freeze({ reporter: true, desk: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['research'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'intelligence',
    since: '2026-08-10'
  }),
  Object.freeze({
    id: 'cap.lane_judge',
    displayName: '赛道判定',
    description: '赛道相关性判定（判断侧）',
    commands: Object.freeze(['sources.lane_gate'] as const),
    readProfiles: Object.freeze(['sources', 'plans', 'knowledge'] as const),
    defaultRoleBindings: Object.freeze({ planner: true, desk: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['daily_judge', 'daily_intelligence'] as const), page: Object.freeze(['library'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'judgment',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.library_organize',
    displayName: '库房整理',
    description: '归档/恢复/状态/挂主题组织',
    commands: Object.freeze([
      'sources.lane_gate',
      'sources.lane_restore',
      'sources.update_status',
      'knowledge.record_batch',
      'knowledge.topic_maintenance_propose',
      'knowledge_flywheel.change_set_apply'
    ] as const),
    readProfiles: Object.freeze(['sources', 'knowledge'] as const),
    defaultRoleBindings: Object.freeze({ librarian: true, desk: true }),
    grantKinds: Object.freeze({ page: Object.freeze(['library'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'library',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.topic_approval',
    displayName: '主题提案审批',
    description: '主管批准/驳回/恢复；系统只维护冲突重提生命周期；员工与外部 Agent 零绑定',
    commands: Object.freeze(['knowledge.topic_maintenance_approve', 'knowledge.topic_maintenance_reject', 'knowledge.topic_maintenance_reproposal_retry'] as const),
    readProfiles: Object.freeze(['knowledge'] as const),
    defaultRoleBindings: Object.freeze({ desk: true }),
    grantKinds: Object.freeze({ page: Object.freeze(['publish', 'agents'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'desk',
    since: '2026-08-10'
  }),
  Object.freeze({
    id: 'cap.topic_decide',
    displayName: '选题决策',
    description: '保存运营方案与选题建议',
    commands: Object.freeze(['plans.save', 'knowledge.suggestion_create'] as const),
    readProfiles: Object.freeze(['plans', 'knowledge', 'metrics', 'reviews', 'content'] as const),
    defaultRoleBindings: Object.freeze({ planner: true, desk: true }),
    grantKinds: Object.freeze({
      task: Object.freeze(['daily_judge', 'daily_intelligence'] as const),
      page: Object.freeze(['today', 'proposals'] as const)
    }),
    precise: false,
    agentGrantable: true,
    owner: 'planning',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.knowledge_curate',
    displayName: '知识归纳',
    description: '主题/领域/简报沉淀',
    commands: Object.freeze([
      'knowledge.record_batch',
      'knowledge.domain_create',
      'knowledge.domain_update',
      'knowledge.creative_brief_create',
      'knowledge.creative_brief_update',
      'knowledge.creative_brief_create_project',
      'knowledge_flywheel.change_set_apply'
    ] as const),
    readProfiles: Object.freeze(['knowledge', 'canvas'] as const),
    defaultRoleBindings: Object.freeze({ planner: true, desk: true }),
    grantKinds: Object.freeze({
      task: Object.freeze(['daily_judge', 'daily_intelligence'] as const),
      page: Object.freeze(['topic', 'canvas'] as const)
    }),
    precise: false,
    agentGrantable: true,
    owner: 'knowledge',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.write',
    displayName: '写作',
    description: '内容项目创建与版本保存；资料库只读借阅',
    commands: Object.freeze(['content.create', 'content.save_version'] as const),
    readProfiles: Object.freeze(['sources', 'knowledge', 'plans', 'content', 'reviews'] as const),
    defaultRoleBindings: Object.freeze({ writer: true, desk: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['studio_draft'] as const), page: Object.freeze(['studio', 'proposals'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'studio',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.review',
    displayName: '复盘',
    description: '结果复盘沉淀（策划兼岗）',
    commands: Object.freeze(['reviews.save', 'knowledge.record_batch'] as const),
    readProfiles: Object.freeze(['metrics', 'reviews', 'content'] as const),
    defaultRoleBindings: Object.freeze({ planner: true, desk: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['results_review'] as const), page: Object.freeze(['results'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'results',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.desk',
    displayName: '主管全站写权',
    description: '全站内部 standing 写权（grantable 能力命令 ∪ 基建命令）；红线类别执行命令不可达',
    commands: Object.freeze([] as const),
    readProfiles: Object.freeze([
      'sources', 'knowledge', 'plans', 'content', 'reviews', 'metrics', 'x_lists', 'desk', 'canvas', 'publication'
    ] as const),
    defaultRoleBindings: Object.freeze({ desk: true }),
    grantKinds: Object.freeze({
      page: Object.freeze([
        'today', 'discover', 'proposals', 'topic', 'library', 'canvas', 'studio', 'publish', 'results'
      ] as const)
    }),
    precise: false,
    agentGrantable: true,
    owner: 'desk',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.internal_prepare',
    displayName: '内部准备（红线预备）',
    description: '红线类别动作的准备路径：渠道无 remove 安全应用、X List 准备、发布快照冻结；仅主管 standing（WMB-5183 §4.4 表）',
    commands: Object.freeze([
      'intelligence_channels.proposal_apply_safe',
      'x_lists.prepare',
      'publication.snapshot_create'
    ] as const),
    readProfiles: Object.freeze(['sources', 'x_lists', 'publication'] as const),
    defaultRoleBindings: Object.freeze({ desk: true }),
    grantKinds: Object.freeze({}),
    precise: false,
    agentGrantable: true,
    owner: 'desk',
    since: '2026-08-10'
  }),
  Object.freeze({
    id: 'cap.wiki_maintain',
    displayName: '全库维护与 Lint',
    description: 'WMB-5240 全 Wiki 操作：维护 run 生命周期（start/pause/resume）与全局 Lint 有界步进；仅主管 standing；Ingest 复用 cap.collect/research 的 sources.upsert_batch',
    commands: Object.freeze([
      'knowledge.maintenance',
      'knowledge.lint'
    ] as const),
    readProfiles: Object.freeze(['knowledge'] as const),
    defaultRoleBindings: Object.freeze({ desk: true }),
    grantKinds: Object.freeze({ page: Object.freeze(['library', 'topic'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'desk',
    since: '2026-08-14'
  }),
  Object.freeze({
    id: 'cap.publish_prep',
    displayName: '发布准备（红线）',
    description: '平台发布准备；仅 Precise + Owner UI',
    commands: Object.freeze([] as const),
    readProfiles: Object.freeze(['publication', 'content'] as const),
    defaultRoleBindings: Object.freeze({}),
    grantKinds: Object.freeze({}),
    precise: true,
    agentGrantable: false,
    owner: 'publish',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.hard_delete',
    displayName: '硬删（红线）',
    description: '硬删资料/项目；Owner UI only',
    commands: Object.freeze([] as const),
    readProfiles: Object.freeze([] as const),
    defaultRoleBindings: Object.freeze({}),
    grantKinds: Object.freeze({}),
    precise: true,
    agentGrantable: false,
    owner: 'owner-ui',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.platform_mutation',
    displayName: '平台副作用（红线）',
    description: 'X List 执行变更与渠道提案应用；Precise + Owner UI',
    commands: Object.freeze(['x_lists.operation_execute', 'intelligence_channels.proposal_apply'] as const),
    readProfiles: Object.freeze(['x_lists'] as const),
    defaultRoleBindings: Object.freeze({}),
    grantKinds: Object.freeze({}),
    precise: true,
    agentGrantable: false,
    owner: 'platform',
    since: '2026-08-07'
  })
]);

export const TASK_INTENT_NEEDED_CAPS: Readonly<Record<string, readonly AgentCapabilityId[]>> = Object.freeze({
  daily_scan: Object.freeze(['cap.collect'] as const),
  daily_judge: Object.freeze(['cap.lane_judge', 'cap.topic_decide', 'cap.knowledge_curate'] as const),
  daily_intelligence: Object.freeze([
    'cap.collect',
    'cap.lane_judge',
    'cap.topic_decide',
    'cap.knowledge_curate'
  ] as const),
  studio_draft: Object.freeze(['cap.write'] as const),
  results_review: Object.freeze(['cap.review'] as const),
  research: Object.freeze(['cap.research'] as const)
});

/**
 * 红线三类（design §4.4 不变量 I5，且是全部）。红线是**类别**，不是命令清单：
 * ① 最终平台发布：平台最终发布点击永不自动（人类浏览器动作，无命令）；`publication.editor_prepare_execute`
 *    是外部浏览器副作用，须精确人工确认。
 * ② 硬删执行：`deleteKnowledgeSource` 等硬删仅 Owner UI（IPC actor 门，无 dispatcher 命令）；渠道
 *    `intelligence_channels.proposal_apply` 的 remove 路径在 5183 拆分。
 * ③ 外部平台变更执行：`x_lists.operation_execute` 保持 precise Owner UI。
 * 类别最终动作命令永不进入任何 grant / deskStanding（CI 负断言，§7 A1）。
 */
export const REDLINE_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'final_publish',
    label: '最终平台发布',
    finalActCommands: Object.freeze(['publication.editor_prepare_execute'] as const)
  }),
  Object.freeze({
    id: 'hard_delete',
    label: '硬删执行',
    finalActCommands: Object.freeze([] as const)
  }),
  Object.freeze({
    id: 'external_platform_mutation',
    label: '外部平台变更执行',
    finalActCommands: Object.freeze(['x_lists.operation_execute', 'intelligence_channels.proposal_apply'] as const)
  })
] as const);

/** 红线最终动作命令并集（三类；永不进入 grant/standing）。 */
export const REDLINE_COMMANDS: readonly string[] = Object.freeze(
  REDLINE_CATEGORIES.flatMap((category) => category.finalActCommands)
);

/**
 * 主管全站 standing 写权（design §4.2 不变量 I1）：`commandsCoveredByGrantableCapabilities() ∪ INFRA_GRANT_COMMANDS`
 * （全量内部命令，含内部准备命令，不含红线类别执行命令）。5183 新增的内部 prepare 命令登记为 grantable 后自动进入。
 */
export const deskStanding: ReadonlySet<string> = Object.freeze(new Set<string>([
  ...commandsCoveredByGrantableCapabilities(),
  ...INFRA_GRANT_COMMANDS
]));

/** 排序后的 standing 命令数组（签发与 CI 断言用）。 */
export function deskStandingCommands(): readonly string[] {
  return Object.freeze([...deskStanding].sort());
}

export function isRoleId(value: string | null | undefined): value is RoleId {
  return Boolean(value && value in ROLE_CATALOG);
}

export function listCapabilitiesForRole(roleId: RoleId, includeNonGrantable = false): AgentCapability[] {
  return AGENT_CAPABILITIES.filter((cap) => {
    if (!includeNonGrantable && !cap.agentGrantable) return false;
    return cap.defaultRoleBindings[roleId] === true;
  });
}

/**
 * Standing write commands for a fixed role.
 * Desk（主管）返回 deskStanding 全量（A1：`commandsCoveredByGrantableCapabilities() ∪ INFRA_GRANT_COMMANDS`，
 * 排序后；不含红线类别执行命令）；员工返回各自绑定能力的命令并集。
 */
export function roleWriteCommands(roleId: RoleId): readonly string[] {
  if (roleId === 'desk') return deskStandingCommands();
  const set = new Set<string>();
  for (const cap of listCapabilitiesForRole(roleId)) {
    for (const command of cap.commands) set.add(command);
  }
  return Object.freeze([...set].sort());
}

export function roleReadProfiles(roleId: RoleId): readonly EntityFace[] {
  const set = new Set<EntityFace>();
  for (const cap of listCapabilitiesForRole(roleId, true)) {
    for (const face of cap.readProfiles) set.add(face);
  }
  return Object.freeze([...set]);
}

/**
 * Read-tool hard whitelist projection for a role: ∪ readToolWhitelist(enabled caps).
 * Absent whitelists contribute nothing — roles without whitelisted capabilities project an empty set (zero regression).
 */
export function roleReadTools(roleId: RoleId): readonly string[] {
  const set = new Set<string>();
  for (const cap of listCapabilitiesForRole(roleId, true)) {
    for (const tool of cap.readToolWhitelist ?? []) set.add(tool);
  }
  return Object.freeze([...set].sort());
}

/**
 * Intersect a grant command list with the role's standing write set.
 * Desk 不再透传：按 deskStanding 交集（主管签发基底在 ensureAutomaticTaskGrant 直接取 standing 全量）。
 * 缺失/未知角色保持零回归（legacy pass-through）。
 */
export function filterCommandsForRole(roleId: RoleId | null | undefined, commands: readonly string[]): string[] {
  if (!roleId || !isRoleId(roleId)) {
    return [...commands];
  }
  const allowed = new Set(roleWriteCommands(roleId));
  for (const infra of INFRA_GRANT_COMMANDS) allowed.add(infra);
  return commands.filter((command) => allowed.has(command));
}

export function commandsCoveredByGrantableCapabilities(): Set<string> {
  const set = new Set<string>();
  for (const cap of AGENT_CAPABILITIES) {
    if (!cap.agentGrantable) continue;
    for (const command of cap.commands) set.add(command);
  }
  return set;
}

export function redlineCommandsFromRegistry(): Set<string> {
  const set = new Set<string>(REDLINE_COMMANDS);
  for (const cap of AGENT_CAPABILITIES) {
    if (cap.agentGrantable) continue;
    for (const command of cap.commands) set.add(command);
  }
  return set;
}
