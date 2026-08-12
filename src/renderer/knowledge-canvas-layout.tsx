import { CanvasRelations } from './knowledge-canvas-relations';
import { relationNames } from './knowledge-canvas-types';
import {
  changeKindLabel,
  issueTypeLabel,
  projectionNodeClass,
  severityLabel,
  severityRank,
} from './knowledge-canvas-projection';

const compileStatusLabel = (status: string | undefined) =>
  ({ current: '当前', stale: '陈旧', compiling: '编译中', failed: '编译失败' })[
    String(status ?? '')
  ] ?? null;

const triggerSourceLabel = (source: string | undefined) =>
  ({ ingest: '摄取', query: '查询', lint: '检查', creation: '创作', review: '复盘', user: '用户', migration: '迁移' })[
    String(source ?? '')
  ] ?? source ?? '';

export function KnowledgeCanvasLayout({ c }: { c: any }) {
  const { canvases, canvas, projectionMode, projection, changeSetList, selectedChangeSetId, selectChangeSet, switchMode, nodeStatus, sources, topics, selected, box, connecting, pendingRelation, selectedRelation, drawer, assetQuery, mode, undoStack, redoStack, boardRef, manifest, briefOpen, briefForm, setBriefForm, openBriefForm, closeBriefForm, createOrUpdateBrief, confirmBriefAndCreateProject, refreshAnnounce, nodeDetail, detailNodeId, openNodeDetail, closeNodeDetail, deepLinkTarget, jumpToDetail, setCanvas, setSelected, setBox, setConnecting, setKeyboardConnectionSource, setPendingRelation, setSelectedRelation, setDrawer, setAssetQuery, setMode, loadCanvas, createCanvas, renameCanvas, updateViewport, undo, redo, addObject, addNote, createRelation, connectByKeyboard, saveRelation, hideRelation, archiveRelation, decideSuggestion, beginConnection, beginDrag, beginBox, removeNode, onDiscuss } = c;
  const openIssueCount = (projection?.modeData?.healthIssues ?? []).filter(
    (item: any) => item.status === 'open' || item.status === 'repairing',
  ).length;
  const board = boardRef as React.RefObject<HTMLDivElement> | null;
  const focusIssueNode = (matchedNodeId: string | null) => {
    if (!matchedNodeId) return;
    setSelected([matchedNodeId]);
    requestAnimationFrame(() => {
      const element = board?.current?.querySelector<HTMLElement>(
        `[data-kc-node-id="${matchedNodeId}"]`,
      );
      element?.scrollIntoView({ block: 'center', inline: 'center' });
      element?.focus();
    });
  };
  const detailTarget =
    nodeDetail?.node && deepLinkTarget(nodeDetail.node.deepLink, nodeDetail);
  return (
    <section className={`kc-page${drawer ? " drawer-open" : ""}`}>
      <header className="kc-header">
        <div className="kc-breadcrumb">
          知识系统 / <strong>关系画布</strong>
        </div>
        <div className="kc-actions">
          <button onClick={() => setDrawer("assets")}>打开主题档案</button>
          <button onClick={() => void createCanvas()}>新建画布</button>
          <select
            value={canvas?.id ?? ""}
            onChange={(e) => void loadCanvas(e.target.value)}
          >
            {canvases.map((item: any) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <button onClick={() => void renameCanvas()}>重命名</button>
          <button className="primary-button" onClick={onDiscuss}>和 Pi 讨论</button>
        </div>
      </header>
      <div className="kc-shell">
        {drawer && (
          <button
            className="kc-drawer-backdrop"
            aria-label="关闭侧栏"
            onClick={() => setDrawer(null)}
          />
        )}
        <aside className={`kc-assets${drawer === "assets" ? " open" : ""}`}>
          <div className="kc-panel-title">
            <strong>放入画布</strong>
            <button aria-label="关闭资产侧栏" onClick={() => setDrawer(null)}>
              ×
            </button>
          </div>
          <input
            aria-label="搜索画布资产"
            placeholder="搜索主题或资料"
            value={assetQuery}
            onChange={(event) => setAssetQuery(event.target.value)}
          />
          <h3>长期主题</h3>
          {topics
            .filter((item: any) =>
              item.title.toLowerCase().includes(assetQuery.toLowerCase()),
            )
            .map((item: any) => (
              <button
                key={item.id}
                onClick={() => void addObject("topic", item.id)}
              >
                <b>{item.title}</b>
                <small>{item.sourceCount} 条资料</small>
              </button>
            ))}
          <h3>最近资料</h3>
          {sources
            .filter((item: any) =>
              item.title.toLowerCase().includes(assetQuery.toLowerCase()),
            )
            .map((item: any) => (
              <button
                key={item.id}
                onClick={() => void addObject("source", item.id)}
              >
                <b>{item.title}</b>
                <small>{item.topics || "尚未归题"}</small>
              </button>
            ))}
          {canvas?.relations.some((item: any) => item.hidden) && (
            <>
              <h3>已隐藏关系</h3>
              {canvas.relations
                .filter((item: any) => item.hidden)
                .map((item: any) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelectedRelation(item);
                      setDrawer(null);
                    }}
                  >
                    <b>{item.label || relationNames[item.relationType]}</b>
                    <small>点击恢复或编辑</small>
                  </button>
                ))}
            </>
          )}
        </aside>
        <div className="kc-board-wrap">
          <div className="kc-board-toolbar">
            <div className="kc-board-name">
              <strong>{canvas?.title ?? "关系画布"}</strong>
              <small>
                {canvas
                  ? `${canvas.nodes.length} 个节点 · ${canvas.relations.length} 条关系`
                  : "正在载入"}
              </small>
            </div>
            <div
              className="kc-modes"
              role="tablist"
              aria-label="画布投影模式"
            >
              {(
                [
                  ['relation', '关系'],
                  ['change', '变化'],
                  ['health', `健康${openIssueCount ? ` ${openIssueCount}` : ''}`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={projectionMode === value}
                  className={projectionMode === value ? "active" : ""}
                  onClick={() => switchMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="kc-tools" role="toolbar" aria-label="画布工具">
              <button
                className={mode === "select" ? "active" : ""}
                onClick={() => setMode("select")}
              >
                ✦ 选择
              </button>
              <button
                className={mode === "pan" ? "active" : ""}
                onClick={() => setMode("pan")}
              >
                ✥ 平移
              </button>
              <button disabled={!undoStack.length} onClick={() => void undo()}>
                ↶ 撤销
              </button>
              <button disabled={!redoStack.length} onClick={() => void redo()}>
                ↷ 重做
              </button>
              <button onClick={addNote}>＋ 添加</button>
              <button onClick={() => setDrawer("assets")}>▣ 资料</button>
            </div>
            <div className="kc-zoom">
              <button
                disabled={(canvas?.zoom ?? 1) <= 0.5}
                onClick={() =>
                  void updateViewport({
                    zoom: Math.max(0.5, (canvas.zoom ?? 1) - 0.1),
                  })
                }
              >
                −
              </button>
              <span>{Math.round((canvas?.zoom ?? 1) * 100)}%</span>
              <button
                disabled={(canvas?.zoom ?? 1) >= 2}
                onClick={() =>
                  void updateViewport({
                    zoom: Math.min(2, (canvas.zoom ?? 1) + 0.1),
                  })
                }
              >
                ＋
              </button>
            </div>
          </div>
          <div
            className={`kc-board mode-${mode} projection-${projectionMode}`}
            ref={boardRef}
            tabIndex={0}
            aria-label={`关系画布；${projectionMode === 'change' ? '变化投影：按 Esc 清除选择' : projectionMode === 'health' ? '健康投影：按 Esc 清除选择' : '按 Escape 清除选择，按 Ctrl+A 选择全部节点'}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSelected([]);
                setKeyboardConnectionSource(null);
                setPendingRelation(null);
                closeBriefForm();
                if (drawer === 'detail') closeNodeDetail();
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "a"
              ) {
                event.preventDefault();
                setSelected(canvas?.nodes.map((node: any) => node.id) ?? []);
              }
            }}
            onPointerDown={beginBox}
          >
            {!canvas && <section className="empty-state"><h2>还没有关系画布</h2><p>画布只会在你明确创建后写入当前工作空间。</p><button className="primary-button" onClick={() => void createCanvas()}>创建第一张画布</button></section>}
            <svg className="kc-edges" aria-label="语义关系列表">
              <defs>
                <marker
                  id="kc-arrow"
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M0 0 7 3.5 0 7Z" />
                </marker>
              </defs>
              <CanvasRelations
                canvas={canvas}
                selectedRelation={selectedRelation}
                setSelectedRelation={setSelectedRelation}
                setPendingRelation={setPendingRelation}
                projectionMode={projectionMode}
              />
              {connecting && (
                <line
                  className="preview"
                  x1={connecting.x1}
                  y1={connecting.y1}
                  x2={connecting.x2}
                  y2={connecting.y2}
                />
              )}
            </svg>
            {(canvas?.nodes ?? []).map((node: any) => {
              const status = nodeStatus?.[node.id];
              const issueSeverity = status?.maxSeverity
                ? ` issue-${status.maxSeverity}`
                : "";
              const nodeClass = [
                `kc-node type-${node.objectType}`,
                selected.includes(node.id) ? "selected" : "",
                connecting?.targetNodeId === node.id ? "connection-target" : "",
                projectionNodeClass(node),
                issueSeverity,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <article
                  role="button"
                  tabIndex={0}
                  data-kc-node-id={node.id}
                  key={node.id}
                  className={nodeClass}
                  style={{
                    left: node.x * (canvas.zoom ?? 1),
                    top: node.y * (canvas.zoom ?? 1),
                    width: node.width * (canvas.zoom ?? 1),
                    height: node.height * (canvas.zoom ?? 1),
                  }}
                  onPointerDown={(e) => beginDrag(e, node)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(
                        selected.includes(node.id)
                          ? selected.filter((id: string) => id !== node.id)
                          : [...selected, node.id],
                      );
                    }
                    if (event.key === "Delete") {
                      event.preventDefault();
                      void removeNode(node);
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(
                      e.shiftKey
                        ? selected.includes(node.id)
                          ? selected.filter((id: string) => id !== node.id)
                          : [...selected, node.id]
                        : [node.id],
                    );
                  }}
                >
                  <input
                    className="kc-node-check"
                    type="checkbox"
                    aria-label={`选择 ${node.object.title}`}
                    checked={selected.includes(node.id)}
                    onChange={() =>
                      setSelected(
                        selected.includes(node.id)
                          ? selected.filter((id: string) => id !== node.id)
                          : [...selected, node.id],
                      )
                    }
                    onClick={(event) => event.stopPropagation()}
                  />
                  <small>
                    <i />
                    {node.objectType === "source"
                      ? "核心资料"
                      : node.objectType === "topic"
                        ? "长期主题"
                        : node.objectType === "note"
                          ? "当前判断"
                          : node.objectType}
                    {status?.compileStatus && (
                      <em className={`kc-compile compile-${status.compileStatus}`}>
                        {compileStatusLabel(status.compileStatus)}
                      </em>
                    )}
                    {status?.issueCount > 0 && (
                      <em className="kc-issue-count">健康 {status.issueCount}</em>
                    )}
                    {Array.isArray(node.changes) && node.changes.length > 0 && (
                      <em className="kc-change-count">变化 {node.changes.length}</em>
                    )}
                  </small>
                  <strong>{node.object.title}</strong>
                  <span>{node.object.body || "暂无摘要"}</span>
                  <button
                    className="kc-node-detail"
                    type="button"
                    aria-label={`查看 ${node.object.title} 的正式详情`}
                    title="正式详情"
                    onClick={(event) => {
                      event.stopPropagation();
                      void openNodeDetail(node.id);
                    }}
                  >
                    ⓘ
                  </button>
                  <button
                    className="kc-port input"
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      connectByKeyboard(node);
                    }}
                    onPointerDown={(event) => beginConnection(event, node)}
                  />
                  <button
                    className="kc-port output"
                    type="button"
                    aria-label={`选择${node.object.title}作为关系端点`}
                    onClick={(event) => {
                      event.stopPropagation();
                      connectByKeyboard(node);
                    }}
                    onPointerDown={(event) => beginConnection(event, node)}
                  />
                </article>
              );
            })}
            {box && (
              <div
                className="kc-selection-box"
                style={{
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                }}
              />
            )}
            {pendingRelation && (
              <div
                className="kc-relation-menu"
                style={{ left: pendingRelation.x, top: pendingRelation.y }}
              >
                <strong>选择关系</strong>
                {Object.entries(relationNames)
                  .filter(([key]) => key !== "custom")
                  .map(([key, label]) => (
                    <button key={key} onClick={() => void createRelation(key)}>
                      {label}
                    </button>
                  ))}
                <button
                  className="cancel"
                  onClick={() => {
                    setPendingRelation(null);
                    setConnecting(null);
                  }}
                >
                  取消
                </button>
              </div>
            )}
            {selectedRelation && (
              <form
                className="kc-edge-menu"
                onSubmit={saveRelation}
                style={{
                  left:
                    (canvas.nodes.find(
                      (node: any) => node.id === selectedRelation.fromNodeId,
                    )?.x +
                      canvas.nodes.find(
                        (node: any) => node.id === selectedRelation.toNodeId,
                      )?.x) /
                      2 +
                    120,
                  top:
                    (canvas.nodes.find(
                      (node: any) => node.id === selectedRelation.fromNodeId,
                    )?.y +
                      canvas.nodes.find(
                        (node: any) => node.id === selectedRelation.toNodeId,
                      )?.y) /
                      2 +
                    70,
                }}
              >
                <strong>编辑关系</strong>
                <label>
                  起点
                  <select
                    name="fromNodeId"
                    defaultValue={selectedRelation.fromNodeId}
                  >
                    {canvas.nodes.map((node: any) => (
                      <option key={node.id} value={node.id}>
                        {node.object.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  终点
                  <select
                    name="toNodeId"
                    defaultValue={selectedRelation.toNodeId}
                  >
                    {canvas.nodes.map((node: any) => (
                      <option key={node.id} value={node.id}>
                        {node.object.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  类型
                  <select
                    name="relationType"
                    defaultValue={selectedRelation.relationType}
                  >
                    {Object.entries(relationNames).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  标签
                  <input
                    name="label"
                    defaultValue={selectedRelation.label ?? ""}
                    placeholder={relationNames[selectedRelation.relationType]}
                  />
                </label>
                <div>
                  <button type="button" onClick={() => void hideRelation()}>
                    {selectedRelation.hidden ? "显示关系" : "在本画布隐藏"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void archiveRelation()}
                  >
                    删除关系
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedRelation(null)}
                  >
                    取消
                  </button>
                  <button className="primary" type="submit">
                    保存更改
                  </button>
                </div>
              </form>
            )}
            {!canvas?.nodes.length && (
              <div className="kc-empty">
                <h2>把资料放进画布，再从节点端口拖出关系</h2>
                <p>画布只显示你正在处理的对象，不会自动铺满整个资料库。</p>
                <button onClick={() => setDrawer("assets")}>
                  放入第一个资料
                </button>
              </div>
            )}
          </div>
          {projectionMode === "change" && (
            <aside
              className="kc-projection-panel kc-change-panel"
              aria-label="知识变化投影"
            >
              <div className="kc-panel-title">
                <strong>最近知识变化</strong>
                <button aria-label="返回关系模式" onClick={() => switchMode("relation")}>
                  ×
                </button>
              </div>
              {projection?.modeData?.changeSet ? (
                <>
                  <div className="kc-change-head">
                    <strong>{projection.modeData.changeSet.reason}</strong>
                    <small>
                      {triggerSourceLabel(projection.modeData.changeSet.triggerSource)} ·{" "}
                      {new Date(projection.modeData.changeSet.createdAt).toLocaleString()}
                    </small>
                  </div>
                  {projection.modeData.receipt && (
                    <div className="kc-change-receipt">
                      <strong>知识更新回执</strong>
                      <p>{projection.modeData.receipt.summary || "本次知识更新完成"}</p>
                      <small>
                        影响 {projection.modeData.receipt.affectedTopics?.length ?? 0} 个主题 ·
                        {" "}
                        {Object.entries(projection.modeData.receipt.counts ?? {})
                          .map(([key, value]) => `${key} ${value}`)
                          .join(" · ") || "无计数"}
                      </small>
                    </div>
                  )}
                </>
              ) : (
                <p className="kc-panel-empty">还没有正式知识变化。</p>
              )}
              <h3>本次影响节点</h3>
              {(projection?.nodes ?? []).some(
                (node: any) => Array.isArray(node.changes) && node.changes.length,
              ) ? (
                <div className="kc-change-nodes">
                  {projection?.nodes
                    .filter(
                      (node: any) =>
                        Array.isArray(node.changes) && node.changes.length,
                    )
                    .map((node: any) => (
                      <button
                        key={node.id}
                        onClick={() => focusIssueNode(node.id)}
                      >
                        <b>{node.object?.title ?? node.noteTitle}</b>
                        <small>
                          {node.changes
                            .map((change: any) => changeKindLabel(change.changeType))
                            .join("、")}
                        </small>
                      </button>
                    ))}
                </div>
              ) : (
                <p className="kc-panel-empty">该次变化没有命中画布节点。</p>
              )}
              {changeSetList.length > 0 && (
                <>
                  <h3>更早的变化</h3>
                  <div className="kc-change-list">
                    {changeSetList.map((item: any) => (
                      <button
                        key={item.id}
                        className={
                          selectedChangeSetId === item.id ||
                          (!selectedChangeSetId && projection?.modeData?.changeSet?.id === item.id)
                            ? "active"
                            : ""
                        }
                        onClick={() => selectChangeSet(item.id)}
                      >
                        <span>{item.reason}</span>
                        <small>
                          {triggerSourceLabel(item.triggerSource)} ·{" "}
                          {new Date(item.createdAt).toLocaleString()}
                        </small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </aside>
          )}
          {projectionMode === "health" && (
            <aside
              className="kc-projection-panel kc-health-panel"
              aria-label="知识健康投影"
            >
              <div className="kc-panel-title">
                <strong>知识健康</strong>
                <button aria-label="返回关系模式" onClick={() => switchMode("relation")}>
                  ×
                </button>
              </div>
              <p className="kc-health-hint">
                健康问题与资料库/主题使用同一对象 ID；点击问题定位到画布节点。
              </p>
              {(projection?.modeData?.healthIssues ?? []).length ? (
                <div className="kc-health-list">
                  {[...(projection?.modeData?.healthIssues ?? [])]
                    .sort(
                      (a: any, b: any) =>
                        severityRank(b.severity) - severityRank(a.severity),
                    )
                    .map((issue: any) => (
                      <button
                        key={issue.id}
                        className={`severity-${issue.severity}`}
                        onClick={() => focusIssueNode(issue.matchedNodeId)}
                      >
                        <span>
                          <i />
                          <b>{issueTypeLabel(issue.issueType)}</b>
                          <em>{severityLabel(issue.severity)}</em>
                        </span>
                        <small>
                          {issue.status === 'repairing' ? '修复中' : '待处理'}
                          {issue.affectedObjectId
                            ? ` · ${issue.affectedObjectId.slice(0, 8)}`
                            : ''}
                          {!issue.matchedNodeId ? ' · 画布级' : ''}
                        </small>
                        {issue.suggestedAction && <p>{issue.suggestedAction}</p>}
                      </button>
                    ))}
                </div>
              ) : (
                <p className="kc-panel-empty">当前没有未解决的健康问题。</p>
              )}
              {(projection?.modeData?.hasMore ?? false) && (
                <small className="kc-health-more">
                  还有更多问题（仅显示前 {projection?.modeData?.limit ?? 50} 条）
                </small>
              )}
            </aside>
          )}
          {drawer === "detail" && nodeDetail && (
            <aside
              className="kc-detail-panel"
              aria-label={`${nodeDetail.node.object?.title ?? ''} 正式详情`}
            >
              <div className="kc-panel-title">
                <strong>正式详情</strong>
                <button aria-label="关闭详情侧栏" onClick={closeNodeDetail}>
                  ×
                </button>
              </div>
              <h2>{nodeDetail.node.object?.title ?? nodeDetail.node.noteTitle}</h2>
              <small className="kc-detail-type">
                {nodeDetail.node.objectType === "source"
                  ? "核心资料"
                  : nodeDetail.node.objectType === "topic"
                    ? "长期主题"
                    : nodeDetail.node.objectType === "note"
                      ? "当前判断"
                      : nodeDetail.node.objectType}
              </small>
              {detailTarget && (
                <button
                  className="kc-detail-jump"
                  onClick={() => jumpToDetail(detailTarget)}
                >
                  {detailTarget.type === "topic"
                    ? "在主题中打开"
                    : detailTarget.type === "source"
                      ? "在资料库中打开"
                      : detailTarget.type === "studio"
                        ? "在创作中打开"
                        : "打开结果"}
                </button>
              )}
              {nodeDetail.formal.wikiPage && (
                <div className="kc-detail-section">
                  <strong>Wiki 页面</strong>
                  <p>{nodeDetail.formal.wikiPage.title}</p>
                  <small>
                    {nodeDetail.formal.wikiPage.compileStatus === "current"
                      ? "当前"
                      : nodeDetail.formal.wikiPage.compileStatus === "stale"
                        ? "陈旧"
                        : nodeDetail.formal.wikiPage.compileStatus === "compiling"
                          ? "编译中"
                          : "编译失败"}
                    {nodeDetail.formal.wikiPageVersion
                      ? ` · 版本 ${nodeDetail.formal.wikiPageVersion.versionNumber}`
                      : ""}
                  </small>
                </div>
              )}
              {nodeDetail.formal.notes.length > 0 && (
                <div className="kc-detail-section">
                  <strong>知识笔记 {nodeDetail.formal.notes.length}</strong>
                  {nodeDetail.formal.notes.slice(0, 8).map((note: any) => (
                    <p key={note.id}>{note.title}</p>
                  ))}
                </div>
              )}
              {nodeDetail.formal.entities.length > 0 && (
                <div className="kc-detail-section">
                  <strong>实体 {nodeDetail.formal.entities.length}</strong>
                  {nodeDetail.formal.entities.slice(0, 8).map((entity: any) => (
                    <p key={entity.id}>{entity.canonicalName}</p>
                  ))}
                </div>
              )}
              {nodeDetail.formal.healthIssues.length > 0 && (
                <div className="kc-detail-section">
                  <strong>健康问题 {nodeDetail.formal.healthIssues.length}</strong>
                  {nodeDetail.formal.healthIssues.map((issue: any) => (
                    <p key={issue.id}>
                      {issueTypeLabel(issue.issueType)} · {severityLabel(issue.severity)}
                    </p>
                  ))}
                </div>
              )}
              {nodeDetail.formal.recentChanges.length > 0 && (
                <div className="kc-detail-section">
                  <strong>最近变化</strong>
                  {nodeDetail.formal.recentChanges.slice(0, 5).map((change: any) => (
                    <p key={change.id}>{change.reason}</p>
                  ))}
                </div>
              )}
              {!detailTarget &&
                !nodeDetail.formal.wikiPage &&
                nodeDetail.formal.notes.length === 0 &&
                nodeDetail.formal.entities.length === 0 &&
                nodeDetail.formal.healthIssues.length === 0 &&
                nodeDetail.formal.recentChanges.length === 0 && (
                  <p className="kc-panel-empty">
                    该节点还没有对应的正式知识对象；删除节点只移除画布引用，不会删除正式知识。
                  </p>
                )}
            </aside>
          )}
          {selected.length > 0 && (
            <div className="kc-selection-bar">
              <strong>{selected.length} 个节点</strong>
              <button onClick={() => setSelected([])}>取消选择</button>
              <button className="primary-button" onClick={onDiscuss}>和 Pi 讨论</button>
              <button onClick={openBriefForm}>
                {briefForm.existingBriefId ? "更新简报" : "生成简报"}
              </button>
              {manifest && (
                <span
                  className={`kc-manifest-hint${manifest.overLimit ? " over-limit" : ""}`}
                  title={manifest.items.map((item: any) => item.title).join("、")}
                >
                  仅选中 · {manifest.items.length} 个正式对象 ·{" "}
                  {manifest.estimatedCharacters}/{manifest.limitCharacters} 字符
                  {manifest.overLimit ? " · 超限" : ""}
                </span>
              )}
              {manifest && (
                <div className="kc-selection-manifest" aria-label="实际传入对象清单">
                  <strong>实际传入对象</strong>
                  {manifest.items.slice(0, 6).map((item: any) => (
                    <span key={item.nodeId}>
                      <i>
                        {item.objectType === "source"
                          ? "资"
                          : item.objectType === "topic"
                            ? "题"
                            : item.objectType === "note"
                              ? "判"
                              : "对"}
                      </i>
                      {item.title}
                    </span>
                  ))}
                  {manifest.items.length > 6 && (
                    <small>等 {manifest.items.length} 个对象</small>
                  )}
                </div>
              )}
              {briefOpen && (
                <form
                  className="kc-brief-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createOrUpdateBrief();
                  }}
                >
                  <strong>
                    {briefForm.existingBriefId ? "更新创作简报" : "生成创作简报"}
                  </strong>
                  <label>
                    标题
                    <input
                      value={briefForm.title}
                      onChange={(event) =>
                        setBriefForm({ ...briefForm, title: event.target.value })
                      }
                      placeholder="简报标题"
                    />
                  </label>
                  <label>
                    核心判断
                    <textarea
                      value={briefForm.coreJudgment}
                      onChange={(event) =>
                        setBriefForm({
                          ...briefForm,
                          coreJudgment: event.target.value,
                        })
                      }
                      placeholder="一句话核心判断"
                      rows={2}
                    />
                  </label>
                  <label>
                    为什么现在
                    <textarea
                      value={briefForm.whyNow}
                      onChange={(event) =>
                        setBriefForm({ ...briefForm, whyNow: event.target.value })
                      }
                      placeholder="为什么现在是好时机"
                      rows={2}
                    />
                  </label>
                  <label>
                    内容结构（每行一段）
                    <textarea
                      value={briefForm.structure}
                      onChange={(event) =>
                        setBriefForm({
                          ...briefForm,
                          structure: event.target.value,
                        })
                      }
                      placeholder={"钩子\n展开\n行动"}
                      rows={3}
                    />
                  </label>
                  <div className="kc-brief-actions">
                    <button type="button" onClick={closeBriefForm}>
                      取消
                    </button>
                    {briefForm.existingBriefId && (
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void confirmBriefAndCreateProject()}
                      >
                        确认简报并创建项目
                      </button>
                    )}
                    <button className="primary-button" type="submit">
                      保存简报
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
          {canvas?.suggestions?.length > 0 && (
            <aside className="kc-suggestions" aria-label="Pi 待确认建议">
              <strong>Pi 建议 · {canvas.suggestions.length} 条待确认</strong>
              {canvas.suggestions.map((item: any) => (
                <div key={item.id}>
                  <span>
                    {item.kind === "node"
                      ? `节点：${item.payload.noteTitle ?? item.payload.objectId}`
                      : `关系：${relationNames[item.payload.relationType] ?? item.payload.relationType}`}
                  </span>
                  <button onClick={() => void decideSuggestion(item, "reject")}>
                    拒绝
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => void decideSuggestion(item, "confirm")}
                  >
                    确认
                  </button>
                </div>
              ))}
            </aside>
          )}
        </div>
      </div>
      <div className="kc-aria-live" aria-live="polite">
        {refreshAnnounce}
      </div>
    </section>
  );
}
