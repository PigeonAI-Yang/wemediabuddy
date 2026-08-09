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
  | 'cap.lane_judge'
  | 'cap.library_organize'
  | 'cap.topic_decide'
  | 'cap.knowledge_curate'
  | 'cap.write'
  | 'cap.review'
  | 'cap.desk'
  | 'cap.publish_prep'
  | 'cap.hard_delete'
  | 'cap.platform_mutation';

export type AgentCapability = Readonly<{
  id: AgentCapabilityId;
  displayName: string;
  description: string;
  commands: readonly string[];
  readProfiles: readonly EntityFace[];
  defaultRoleBindings: Readonly<Partial<Record<RoleId, boolean>>>;
  grantKinds: Readonly<{ task?: readonly string[]; page?: readonly string[] }>;
  precise: boolean;
  agentGrantable: boolean;
  pageScopePassThrough?: boolean;
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
    defaultRoleBindings: Object.freeze({ reporter: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['daily_scan', 'daily_intelligence'] as const), page: Object.freeze(['discover'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'intelligence',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.lane_judge',
    displayName: '赛道判定',
    description: '赛道相关性判定（判断侧）',
    commands: Object.freeze(['sources.lane_gate'] as const),
    readProfiles: Object.freeze(['sources', 'plans', 'knowledge'] as const),
    defaultRoleBindings: Object.freeze({ planner: true }),
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
      'knowledge.record_batch'
    ] as const),
    readProfiles: Object.freeze(['sources', 'knowledge'] as const),
    defaultRoleBindings: Object.freeze({ librarian: true }),
    grantKinds: Object.freeze({ page: Object.freeze(['library'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'library',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.topic_decide',
    displayName: '选题决策',
    description: '保存运营方案与选题建议',
    commands: Object.freeze(['plans.save', 'knowledge.suggestion_create'] as const),
    readProfiles: Object.freeze(['plans', 'knowledge', 'metrics', 'reviews', 'content'] as const),
    defaultRoleBindings: Object.freeze({ planner: true }),
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
      'knowledge.creative_brief_create_project'
    ] as const),
    readProfiles: Object.freeze(['knowledge', 'canvas'] as const),
    defaultRoleBindings: Object.freeze({ planner: true }),
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
    defaultRoleBindings: Object.freeze({ writer: true }),
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
    defaultRoleBindings: Object.freeze({ planner: true }),
    grantKinds: Object.freeze({ task: Object.freeze(['results_review'] as const), page: Object.freeze(['results'] as const) }),
    precise: false,
    agentGrantable: true,
    owner: 'results',
    since: '2026-08-07'
  }),
  Object.freeze({
    id: 'cap.desk',
    displayName: '桌助知答',
    description: '页级作用域透传；standing 写权为空',
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
    pageScopePassThrough: true,
    owner: 'desk',
    since: '2026-08-07'
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
  results_review: Object.freeze(['cap.review'] as const)
});

export const REDLINE_COMMANDS = Object.freeze([
  'x_lists.operation_execute',
  'intelligence_channels.proposal_apply'
] as const);

export function isRoleId(value: string | null | undefined): value is RoleId {
  return Boolean(value && value in ROLE_CATALOG);
}

export function listCapabilitiesForRole(roleId: RoleId, includeNonGrantable = false): AgentCapability[] {
  return AGENT_CAPABILITIES.filter((cap) => {
    if (!includeNonGrantable && !cap.agentGrantable) return false;
    return cap.defaultRoleBindings[roleId] === true;
  });
}

/** Standing write commands for a fixed role (desk returns empty — page pass-through). */
export function roleWriteCommands(roleId: RoleId): readonly string[] {
  if (roleId === 'desk') return Object.freeze([]);
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

export function roleHasPagePassThrough(roleId: RoleId): boolean {
  return listCapabilitiesForRole(roleId).some((cap) => cap.pageScopePassThrough === true);
}

/**
 * Intersect a grant command list with the role's standing write set.
 * Desk / missing role → unchanged (page pass-through / legacy zero-regression).
 */
export function filterCommandsForRole(roleId: RoleId | null | undefined, commands: readonly string[]): string[] {
  if (!roleId || !isRoleId(roleId) || roleHasPagePassThrough(roleId)) {
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
