import { CanvasRelations } from './knowledge-canvas-relations';
import { relationNames } from './knowledge-canvas-types';

export function KnowledgeCanvasLayout({ c }: { c: any }) {
  const { canvases, canvas, sources, topics, selected, box, connecting, pendingRelation, selectedRelation, drawer, assetQuery, mode, undoStack, redoStack, boardRef, setCanvas, setSelected, setBox, setConnecting, setKeyboardConnectionSource, setPendingRelation, setSelectedRelation, setDrawer, setAssetQuery, setMode, loadCanvas, createCanvas, renameCanvas, updateViewport, undo, redo, addObject, addNote, createRelation, connectByKeyboard, saveRelation, hideRelation, archiveRelation, decideSuggestion, beginConnection, beginDrag, beginBox, openComposer, onDiscuss } = c;
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
          <button onClick={onDiscuss}>和 Pi 讨论</button>
          <button
            className="primary-button"
            onClick={() => void openComposer()}
          >
            形成创作简报
          </button>
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
            className={`kc-board mode-${mode}`}
            ref={boardRef}
            tabIndex={0}
            aria-label="关系画布；按 Escape 清除选择，按 Ctrl+A 选择全部节点"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSelected([]);
                setKeyboardConnectionSource(null);
                setPendingRelation(null);
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
              <CanvasRelations canvas={canvas} selectedRelation={selectedRelation} setSelectedRelation={setSelectedRelation} setPendingRelation={setPendingRelation}/>
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
            {(canvas?.nodes ?? []).map((node: any) => (
              <article
                role="button"
                tabIndex={0}
                data-kc-node-id={node.id}
                key={node.id}
                className={`kc-node type-${node.objectType}${selected.includes(node.id) ? " selected" : ""}${connecting?.targetNodeId === node.id ? " connection-target" : ""}`}
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
                    void window.wmb
                      .removeKnowledgeCanvasNode({
                        canvasId: canvas.id,
                        nodeId: node.id,
                        expectedRevision: node.revision,
                      })
                      .then(() => loadCanvas(canvas.id));
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
                </small>
                <strong>{node.object.title}</strong>
                <span>{node.object.body || "暂无摘要"}</span>
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
            ))}
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
          {selected.length > 0 && (
            <div className="kc-selection-bar">
              <strong>{selected.length} 个节点作为 Pi 上下文</strong>
              <button onClick={() => setSelected([])}>取消选择</button>
              <button onClick={onDiscuss}>和 Pi 讨论</button>
              <button
                className="primary-button"
                onClick={() => void openComposer()}
              >
                形成创作简报
              </button>
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
    </section>
  );
}
