// WMB-5243：全局 Wiki 知识网络 —— 框选即 Pi 上下文的纯逻辑（selection + history）。
// 单一实现，供视图（WikiNetworkRenderer）在框选提交、点击/勾选变更与 Ctrl+Z/Ctrl+X/Esc
// 键盘历史处消费，保证设计 §5 的三条不变式只有一份代码：
// - 拖框命中即累加选择（无需确认按钮）；
// - 多次框选按正式知识身份（objectId）去重，首现者胜并保持既有顺序；
// - 只记录框选上下文进历史；新框选发生后前进历史作废；空框选（浏览复位）不动历史。
// 本模块无 React、无 IPC、无 DOM：任何选择/历史派生都以纯函数可测试。

/** 正式知识身份：正式对象 ID（objectId）优先，自由便签回退画布节点 id。 */
export function formalSelectionKey(node: { id: string; objectId?: string | null }): string {
  return node.objectId ?? node.id;
}

/**
 * 命中即累加：当前选择 + 新命中，按正式知识身份去重（首次出现者胜，保持既有顺序）。
 * 空命中（空白框选/浏览复位）返回当前选择原样，不清空。
 */
export function accumulateBoxSelection(
  current: readonly string[],
  hits: readonly string[],
  nodes: ReadonlyArray<{ id: string; objectId?: string | null }>,
): string[] {
  if (!hits.length) return [...current];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of [...current, ...hits]) {
    const node = byId.get(id);
    const key = node ? formalSelectionKey(node) : id;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(id);
  }
  return next;
}

export type SelectionSnapshot = readonly string[];

export type SelectionHistory = {
  /** 框选上下文快照栈（旧→新）；空栈 = 初始空选择。 */
  undoStack: readonly SelectionSnapshot[];
  /** 被 Ctrl+Z 回退的框选上下文（新→旧，栈顶最近被回退）。 */
  redoStack: readonly SelectionSnapshot[];
};

export function emptySelectionHistory(): SelectionHistory {
  return { undoStack: [], redoStack: [] };
}

function sameSelection(a: SelectionSnapshot | undefined, b: SelectionSnapshot | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 框选提交：结果快照入 undo 栈、redo 作废；与栈顶相同不再重复入栈。
 * 选择未变化（空框选）不视为一次新框选：不动历史、不毁前进栈。
 */
export function pushBoxSelection(
  history: SelectionHistory,
  current: readonly string[],
  next: readonly string[],
): SelectionHistory {
  if (sameSelection(current, next)) return history;
  const undoStack = [...history.undoStack];
  if (!sameSelection(undoStack[undoStack.length - 1], next)) undoStack.push([...next]);
  return { undoStack, redoStack: [] };
}

/**
 * Ctrl+Z：回退上一次框选上下文。历史栈保存的是每次框选后的结果快照，
 * 因此回退 = 弹出最近快照（压入 redo），返回栈顶剩余的"上一个框选上下文"；
 * 无可回退（未发生过框选或已回退到初始空选择）时返回当前选择不变。
 */
export function undoSelection(
  history: SelectionHistory,
  current: readonly string[],
): { history: SelectionHistory; next: readonly string[] } {
  const undoStack = [...history.undoStack];
  const snapshot = undoStack.pop();
  if (!snapshot) return { history, next: current };
  const previous = undoStack[undoStack.length - 1];
  return {
    history: { undoStack, redoStack: [...history.redoStack, snapshot] },
    next: previous ? [...previous] : [],
  };
}

/** Ctrl+X：前进到被回退的框选上下文；无可前进时返回当前选择不变。 */
export function redoSelection(
  history: SelectionHistory,
  current: readonly string[],
): { history: SelectionHistory; next: readonly string[] } {
  const redoStack = [...history.redoStack];
  const snapshot = redoStack.pop();
  if (!snapshot) return { history, next: current };
  return {
    history: { undoStack: [...history.undoStack, snapshot], redoStack },
    next: [...snapshot],
  };
}

/** 非框选的用户选择变更（节点点击/勾选等）使前进历史作废；不改 undo 栈。 */
export function invalidateRedo(history: SelectionHistory): SelectionHistory {
  return history.redoStack.length ? { ...history, redoStack: [] } : history;
}
