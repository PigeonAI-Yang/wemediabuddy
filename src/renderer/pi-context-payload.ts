import type { PiContextRef } from './app-types';

export type PiDirectCanvasContext = {
  scope: string;
  items: Array<{ nodeId: string }>;
  relations: Array<{ id: string }>;
  estimatedCharacters: number;
};

/** Pure builder for the [WMB_CONTEXT] prefix sent with each Pi user message. */

function pageDispatchRule(page: string, objectType?: string | null, objectId?: string | null, objectTitle?: string | null): string {
  const title = objectTitle?.trim() || '';
  const id = objectId?.trim() || '';
  if (page === 'studio') {
    const projectHint = objectType === 'project' && id
      ? `当前项目 projectId=${id}${title ? `「${title}」` : ''}。`
      : '若上下文没有 projectId，先用工具确认当前创作项目再派工。';
    return `\nmanagerRole=desk`
      + `\ncontextRule=你在创作页。用户要写正文/补全文/改稿时，不要自己长写完稿；应派写手：wmb_spawn_job({ roleId:"writer", projectId, brief })；系统按角色自动选择固定工作流，只传角色与业务参数。`
      + projectHint
      + '派单后等 JOB_EVENT 终态推送再汇报，不要 sleep/bash 轮询；必要时 wmb_get_job 看 monitor.task；完成后 wmb_get_content 核对。你可讨论结构与标准，但交付正文是写手的活。';
  }
  if (page === 'today' || page === 'agents') {
    return `\nmanagerRole=desk`
      + `\ncontextRule=你在${page === 'today' ? '今日' : '班组'}页。情报采集/方案用 wmb_run_daily_stage、wmb_continue_after_scan 或 wmb_spawn_job(reporter|planner)；写正文仍派 writer 并带 projectId。先 readiness/roster，再派工监工。`;
  }
  if (page === 'library') {
    return `\nmanagerRole=desk`
      + `\ncontextRule=你在资料库。整理/判定/恢复优先派 librarian 或使用资料工具；不要把长整理活自己扛完。需要成稿时再派 writer。`;
  }
  if (page === 'discover') {
    return `\nmanagerRole=desk`
      + `\ncontextRule=你在发现页。线索观察与采集优先派 reporter；沉淀选题可派 planner；成稿派 writer。`;
  }
  return `\nmanagerRole=desk`
    + `\ncontextRule=你是主管。按页面目标派员工：扫=reporter，方案=planner，正文=writer，资料=librarian。用 wmb_spawn_job / list_jobs / roster；需要业务细节时用 wmb_* 读取，不要臆造。`;
}

export function buildPiContextPayload(
  context: PiContextRef,
  userText: string,
  directContext?: PiDirectCanvasContext
): string {
  const selectedContext = context.selectedItems?.map((item) => ({
    id: item.id,
    title: item.title,
    whyNow: item.whyNow,
    angle: item.angle,
    pointOfView: item.pointOfView,
    titleGuidance: item.titleGuidance,
    openingGuidance: item.openingGuidance,
    structureGuidance: item.structureGuidance,
    sourceIds: item.sourceIds,
    priority: item.priority,
    planDate: 'planDate' in item ? (item as { planDate?: string }).planDate : undefined
  })) ?? [];
  const selectedSources = context.selectedSources?.map((source) => ({
    id: source.id,
    title: source.title,
    url: source.canonicalUrl,
    author: source.author,
    publishedAt: source.publishedAt,
    collectedAt: source.collectedAt,
    summary: source.summary,
    categories: source.categories,
    bodyStatus: source.bodyStatus ?? 'none',
    bodyChars: source.bodyChars ?? 0,
    bodyExcerpt: source.bodyExcerpt ?? null
  })) ?? [];
  const xList = context.xListContext;
  const dispatchRule = pageDispatchRule(context.page, context.objectType, context.objectId, context.objectTitle);
  const objectContextRule = context.focus
    ? `\nobjectRule=focus 是用户点选的当前对象（点选不等于进入详情）。有 bodyExcerpt 时优先依据正文；否则用 summary。不要把摘要当成全文，也不要假设未提供的页面内容。`
    : selectedSources.length || selectedContext.length
      ? `\nobjectRule=selectedItems/selectedSources 是用户显式点选的对象（点选不等于进入详情）。资料默认只有摘要；bodyStatus=ready 且 bodyExcerpt 非空时才有正文摘录。fermenting 是持续关注事件。不要假设未选中的列表项。`
      : ((context.fermenting?.items?.length ?? 0) + (context.fermenting?.watchingItems?.length ?? 0))
        ? `\nobjectRule=fermenting.items 是持续关注事件；fermenting.watchingItems 是观察中项。讨论时优先 selectedItems，再看持续关注补充。`
        : `\nobjectRule=当前页没有点选具体对象时，以 page/pageLabel 与 manager 派工规则为准；需要业务细节时用 wmb_* 工具按 id 读取，不要臆造页面内容。`;
  const contextInstruction = directContext
    ? `\ncontextRule=只使用下面直接提供的页面上下文，不得调用上下文包工具，也不得扩展到选中范围之外。`
      + `\nmode=${context.packagePurpose ?? 'discussion'}`
      + `\ncanvasId=${context.canvasId ?? ''}`
      + `\nselectionMode=${context.contextSelection?.mode ?? 'current_page'}`
      + `\nsuggestionRule=若要提出新节点或关系，只能调用 wmb_suggest_knowledge 创建待确认建议；用户确认前不得视为正式知识。`
      + `\ncontextNodeIds=${JSON.stringify(directContext.items.map((item) => item.nodeId))}`
      + `\ncontextManifest=${JSON.stringify(directContext)}`
    : xList
      ? `${dispatchRule}\nobjectRule=优先使用下面直接提供的 X List 页面上下文；用户没点帖子时讨论当前列表已加载的全部动态（loadedCount/visiblePosts），点了帖子时只讨论该帖及其评论。不要假设未加载的更早帖子。`
      : `${dispatchRule}${objectContextRule}`;
  const xListPayload = xList
    ? JSON.stringify({
      accountKey: xList.accountKey,
      listId: xList.listId,
      listName: xList.listName,
      listKind: xList.listKind,
      mode: xList.mode,
      loadedCount: xList.loadedCount ?? xList.visiblePosts.length,
      selectedPost: xList.selectedPost,
      visiblePosts: xList.visiblePosts
    })
    : 'null';

  const fermentingPayload = JSON.stringify({
    items: (context.fermenting?.items ?? []).slice(0, 5).map((item) => ({
      id: item.id,
      objectType: item.objectType,
      objectId: item.objectId,
      title: item.title,
      state: item.state,
      priority: item.priority,
      topicId: item.topicId,
      sourceIds: item.sourceIds,
      originPlanDate: item.originPlanDate,
      fermentedDays: item.fermentedDays,
      decayScore: item.decayScore,
      reason: item.reason,
      aftershocks: item.aftershocks?.slice(0, 3) ?? []
    })),
    watchingItems: (context.fermenting?.watchingItems ?? []).slice(0, 5).map((item) => ({
      id: item.id,
      objectType: item.objectType,
      objectId: item.objectId,
      title: item.title,
      state: item.state,
      priority: item.priority,
      topicId: item.topicId,
      sourceIds: item.sourceIds,
      originPlanDate: item.originPlanDate,
      fermentedDays: item.fermentedDays
    })),
    topics: (context.fermenting?.topics ?? []).slice(0, 6),
    pinnedSources: (context.fermenting?.pinnedSources ?? []).slice(0, 3)
  });

  return (
    `[WMB_CONTEXT]\npage=${context.page}\npageLabel=${context.pageLabel}\nobjectType=${context.objectType ?? ''}\nobjectId=${context.objectId ?? ''}\nobjectTitle=${context.objectTitle ?? ''}${contextInstruction}\nfocus=${JSON.stringify(context.focus ?? null)}\nselectedItems=${JSON.stringify(selectedContext)}\nselectedSources=${JSON.stringify(selectedSources)}\nfermenting=${fermentingPayload}\nrankingContext=${JSON.stringify(context.rankingContext ?? { boards: [], items: [] })}\nxListContext=${xListPayload}\n[USER_MESSAGE]\n${userText}`
  );
}

export function describePiContextChip(context: PiContextRef): string {
  const rankingCount = (context.rankingContext?.boards.length ?? 0) + (context.rankingContext?.items.length ?? 0);
  const xList = context.xListContext;
  if (context.contextSelection) {
    return `${context.pageLabel} · ${context.contextSelection.mode === 'selected' ? `已选 ${context.contextSelection.nodeIds.length} 项` : `当前页 ${context.contextSelection.nodeIds.length} 项`}`;
  }
  if (xList) {
    if (xList.mode === 'post' && xList.selectedPost) return `${context.pageLabel} · 帖子 ${xList.selectedPost.authorHandle || ''}`.trim();
    if (xList.listName) return `${context.pageLabel} · ${xList.listName}${xList.loadedCount ? ` · 已加载 ${xList.loadedCount} 条` : (xList.visiblePosts.length ? ` · ${xList.visiblePosts.length} 条动态` : '')}`;
    return `${context.pageLabel} · 当前页`;
  }
  if (rankingCount) return `${context.pageLabel} · 已选 ${context.rankingContext?.boards.length ?? 0} 个榜单、${context.rankingContext?.items.length ?? 0} 个项目`;
  if (context.focus) return `${context.pageLabel} · ${context.focus.title}${context.focus.bodyStatus === 'ready' ? ' · 含正文' : ''}`;
  const oppCount = context.selectedItems?.length ?? 0;
  const sourceCount = context.selectedSources?.length ?? 0;
  const bodyCount = context.selectedSources?.filter((item) => item.bodyStatus === 'ready' && item.bodyExcerpt).length ?? 0;
  const fermentCount = (context.fermenting?.items?.length ?? 0) + (context.fermenting?.watchingItems?.length ?? 0);
  if (oppCount || sourceCount || fermentCount) {
    const parts = [context.pageLabel];
    if (oppCount) parts.push(oppCount === 1 ? context.selectedItems![0].title : `已选 ${oppCount} 个机会`);
    if (sourceCount) parts.push(`${sourceCount} 条资料${bodyCount ? `（${bodyCount} 含正文）` : '（摘要）'}`);
    if (fermentCount && !oppCount && !sourceCount) parts.push(`持续关注 ${fermentCount}`);
    return parts.join(' · ');
  }
  return context.objectTitle ? `${context.pageLabel} · ${context.objectTitle}` : context.pageLabel;
}
