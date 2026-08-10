/** Page-scoped dock freeform authority (M-4980). Shared main + renderer — single source of truth. */

export type PageAuthorityView =
  | 'today'
  | 'agents'
  | 'discover'
  | 'proposals'
  | 'topic'
  | 'library'
  | 'canvas'
  | 'studio'
  | 'publish'
  | 'results';

export type PageTaskIntent =
  | 'page_today'
  | 'page_agents'
  | 'page_discover'
  | 'page_proposals'
  | 'page_topic'
  | 'page_library'
  | 'page_canvas'
  | 'page_studio'
  | 'page_publish'
  | 'page_results';

/** Subset of TASK_INTERNAL_COMMANDS allowed on a page dock session. */
export type PageAuthorityCommand =
  | 'agent_tasks.report_progress'
  | 'sources.upsert_batch'
  | 'sources.lane_gate'
  | 'sources.lane_restore'
  | 'sources.update_status'
  | 'knowledge.record_batch'
  | 'knowledge.topic_maintenance_propose'
  | 'knowledge.suggestion_create'
  | 'knowledge.domain_create'
  | 'knowledge.domain_update'
  | 'knowledge.creative_brief_create'
  | 'knowledge.creative_brief_update'
  | 'knowledge.creative_brief_create_project'
  | 'plans.save'
  | 'content.create'
  | 'content.save_version'
  | 'reviews.save'
  | 'x_lists.observation_start'
  | 'x_lists.observation_stop';

export type PageAuthoritySpec = {
  intent: PageTaskIntent;
  /** null = readonly page: no task, no grant */
  writeScope: readonly PageAuthorityCommand[] | null;
  chipLabel: string;
  chipTone: 'write' | 'readonly' | 'prepare';
};

export const PAGE_TASK_GRANT_SCOPES: Readonly<Record<PageAuthorityView, PageAuthoritySpec>> = Object.freeze({
  today: Object.freeze({
    intent: 'page_today',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'sources.upsert_batch',
      'sources.lane_gate',
      'knowledge.record_batch',
      'knowledge.suggestion_create',
      'plans.save'
    ] as const),
    chipLabel: '存资料/改方案/判定',
    chipTone: 'write'
  }),
  agents: Object.freeze({
    intent: 'page_agents',
    // 班组页有限写权：编排旁路可存资料/挂建议/报进度；派单与席位占用仍走 UI/JobPool。
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'sources.upsert_batch',
      'knowledge.record_batch',
      'knowledge.suggestion_create'
    ] as const),
    chipLabel: '进度/存资料/建议 · 派工走主管工具',
    chipTone: 'prepare'
  }),
  discover: Object.freeze({
    intent: 'page_discover',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'sources.upsert_batch',
      'knowledge.record_batch',
      'x_lists.observation_start',
      'x_lists.observation_stop'
    ] as const),
    chipLabel: '存库/归主题/观察 · List 变更需 UI 确认',
    chipTone: 'prepare'
  }),
  proposals: Object.freeze({
    intent: 'page_proposals',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'sources.upsert_batch',
      'knowledge.record_batch',
      'knowledge.suggestion_create',
      'content.create',
      'content.save_version'
    ] as const),
    chipLabel: '立项/写稿/挂知识',
    chipTone: 'write'
  }),
  topic: Object.freeze({
    intent: 'page_topic',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'sources.upsert_batch',
      'knowledge.record_batch',
      'knowledge.suggestion_create',
      'knowledge.domain_create',
      'knowledge.domain_update'
    ] as const),
    chipLabel: '沉主题/建域',
    chipTone: 'write'
  }),
  library: Object.freeze({
    intent: 'page_library',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'sources.upsert_batch',
      'sources.lane_gate',
      'sources.lane_restore',
      'sources.update_status',
      'knowledge.record_batch',
      'knowledge.topic_maintenance_propose',
      'knowledge.suggestion_create'
    ] as const),
    chipLabel: '移出/恢复/状态/主题整理提案',
    chipTone: 'write'
  }),
  canvas: Object.freeze({
    intent: 'page_canvas',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'knowledge.suggestion_create',
      'knowledge.record_batch',
      'knowledge.creative_brief_create',
      'knowledge.creative_brief_update',
      'knowledge.creative_brief_create_project',
      'content.save_version'
    ] as const),
    chipLabel: '简报/立项/建议',
    chipTone: 'write'
  }),
  studio: Object.freeze({
    intent: 'page_studio',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'content.create',
      'content.save_version'
    ] as const),
    chipLabel: '写正文/新建项目',
    chipTone: 'write'
  }),
  publish: Object.freeze({
    intent: 'page_publish',
    writeScope: null,
    chipLabel: '只读 · 发布需 UI 确认',
    chipTone: 'readonly'
  }),
  results: Object.freeze({
    intent: 'page_results',
    writeScope: Object.freeze([
      'agent_tasks.report_progress',
      'knowledge.record_batch',
      'reviews.save'
    ] as const),
    chipLabel: '写复盘/沉淀',
    chipTone: 'write'
  })
});

export function isPageAuthorityView(value: string | null | undefined): value is PageAuthorityView {
  return Boolean(value && value in PAGE_TASK_GRANT_SCOPES);
}

export function pageAuthoritySpec(page: string | null | undefined): PageAuthoritySpec | null {
  if (!isPageAuthorityView(page)) return null;
  return PAGE_TASK_GRANT_SCOPES[page];
}
