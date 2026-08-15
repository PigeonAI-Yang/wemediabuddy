import { randomUUID } from 'node:crypto';
import { broadcastPiEvent } from './app-window.ts';
import { readPiConversation, writePiConversation, type PiConversationSnapshot } from './pi-conversation.ts';
import type { ManagerTaskView } from './manager-task.ts';
import type { AgentTask } from './agent-tasks.ts';

type OpenTurn = {
  conversation: PiConversationSnapshot;
  dataRootPath: string;
  managerTaskId: string;
  businessDate: string;
  childToolIds: Map<string, string>; // roleOrStage -> toolCallId
  startedChildren: Set<string>; // roleLabel already opened
  lastProgressKey: Map<string, string>;
  rootToolId: string | null;
  rootFinished: boolean;
};

const openTurns = new Map<string, OpenTurn>(); // businessDate -> turn

function toolId(): string {
  return `mgr_${randomUUID().slice(0, 10)}`;
}

async function ensureStreamingAssistant(dataRootPath: string, userText: string): Promise<PiConversationSnapshot> {
  const current = await readPiConversation(dataRootPath);
  const createdAt = new Date().toISOString();
  const last = current.messages.at(-1);
  if (last?.role === 'assistant' && last.status === 'streaming') {
    return current;
  }
  return writePiConversation(dataRootPath, {
    id: current.id,
    title: current.title === '新会话' || current.title === 'Pi' || current.title === '这个是在说啥'
      ? '主管 · 今日情报'
      : current.title,
    sessionFile: current.sessionFile,
    sessionId: current.sessionId,
    messages: [
      ...current.messages,
      { role: 'user', text: userText, createdAt },
      { role: 'assistant', text: '', status: 'streaming', createdAt, segments: [] }
    ],
    createdAt: current.createdAt,
    makeActive: true
  });
}

function emitTool(toolName: string, toolCallId: string, toolArgs?: unknown): void {
  broadcastPiEvent({
    type: 'tool',
    scope: 'dock',
    source: 'manager',
    toolName,
    toolCallId,
    toolArgs: toolArgs ?? {}
  });
}

function emitToolResult(toolCallId: string, toolResult: unknown, isError = false): void {
  broadcastPiEvent({
    type: 'tool-result',
    scope: 'dock',
    source: 'manager',
    toolCallId,
    toolResult,
    isError
  });
}

/**
 * 开始主管回合：对话框出现 user 下单 + assistant streaming，
 * 并打出原生 tool-line（与手动 chat 同一条 onPiEvent 通道）。
 */
export async function beginManagerDockTurn(input: {
  dataRootPath: string;
  managerTask: ManagerTaskView;
}): Promise<void> {
  const { dataRootPath, managerTask } = input;
  const businessDate = managerTask.businessDate;
  broadcastPiEvent({ type: 'starting', scope: 'dock', source: 'manager', text: '主管编排中' });
  const conversation = await ensureStreamingAssistant(
    dataRootPath,
    `请执行今日情报编排（${businessDate}）。\n验收：可信渠道回执 + 本轮新增可批选题。\n先派记者扫描，完成后再派策划做增量判断并更新选题池；用工具查看进度并向我汇报。`
  );

  const rootToolId = toolId();
  openTurns.set(businessDate, {
    conversation,
    dataRootPath,
    managerTaskId: managerTask.id,
    businessDate,
    childToolIds: new Map(),
    startedChildren: new Set(),
    lastProgressKey: new Map(),
    rootToolId,
    rootFinished: false
  });

  broadcastPiEvent({ type: 'running', scope: 'dock', source: 'manager', text: '主管编排中' });
  emitTool('wmb_run_daily_child', rootToolId, {
    businessDate,
    stage: 'full',
    managerTaskId: managerTask.id,
    goal: 'daily_intelligence'
  });
}

/** 子任务已接受启动 */
export function markManagerChildStarted(input: {
  businessDate: string;
  childTaskId: string;
  roleLabel: string;
  intent: string;
}): void {
  const turn = openTurns.get(input.businessDate);
  if (!turn) return;

  if (turn.rootToolId && !turn.rootFinished) {
    emitToolResult(turn.rootToolId, {
      ok: true,
      childTaskId: input.childTaskId,
      role: input.roleLabel,
      intent: input.intent,
      message: `已启动${input.roleLabel}子任务`
    });
    turn.rootToolId = null;
    turn.rootFinished = true;
  }

  if (turn.startedChildren.has(input.roleLabel)) return;
  turn.startedChildren.add(input.roleLabel);

  const childId = toolId();
  turn.childToolIds.set(input.roleLabel, childId);
  const toolName = input.roleLabel === '策划' ? 'subagent.planner' : 'subagent.reporter';
  emitTool(toolName, childId, {
    name: input.roleLabel,
    taskId: input.childTaskId,
    intent: input.intent,
    status: 'running'
  });
}

/** 将 legacy child 进度投影为 subagent tool 更新（完成时收尾）。 */
export async function projectManagerChildProgress(input: {
  businessDate: string;
  child: AgentTask;
}): Promise<void> {
  const turn = openTurns.get(input.businessDate);
  if (!turn) return;
  const child = input.child;
  const roleLabel =
    child.intent === 'daily_judge' ? '策划'
      : child.intent === 'daily_scan' || child.intent === 'daily_intelligence' ? '记者'
        : '员工';
  const toolName = roleLabel === '策划' ? 'subagent.planner' : 'subagent.reporter';

  let childToolId = turn.childToolIds.get(roleLabel);
  if (!childToolId && child.status === 'running') {
    childToolId = toolId();
    turn.childToolIds.set(roleLabel, childToolId);
    emitTool(toolName, childToolId, {
      name: roleLabel,
      taskId: child.id,
      intent: child.intent,
      status: 'running'
    });
  }
  if (!childToolId) return;

  const planned = Number(child.progress?.planned ?? 0);
  const processed = Number(child.progress?.processed ?? 0);
  const message = typeof child.progress?.message === 'string'
    ? child.progress.message
    : (child.events?.at(-1)?.message ?? child.phase);

  // 进行中：再打一条同 id 的 tool 事件，刷新摘要（dock appendPiStream 会更新/追加 segment）
  if (child.status === 'running') {
    const key = `${child.phase}|${processed}|${planned}|${message || ''}`;
    if (turn.lastProgressKey.get(roleLabel) === key) return;
    turn.lastProgressKey.set(roleLabel, key);
    emitTool(toolName, childToolId, {
      name: roleLabel,
      taskId: child.id,
      intent: child.intent,
      status: 'running',
      planned: planned || undefined,
      processed: processed || undefined,
      phase: child.phase,
      message
    });
    return;
  }

  const ok = child.status === 'succeeded' || child.status === 'partial';
  emitToolResult(childToolId, {
    ok,
    status: child.status,
    phase: child.phase,
    planned: planned || undefined,
    processed: processed || undefined,
    message,
    error: child.errorMessage
  }, !ok);
  turn.childToolIds.delete(roleLabel);

  // 记者完成后，打开策划 subagent tool 行
  if (roleLabel === '记者' && ok && !turn.startedChildren.has('策划')) {
    turn.startedChildren.add('策划');
    const plannerId = toolId();
    turn.childToolIds.set('策划', plannerId);
    emitTool('subagent.planner', plannerId, {
      name: '策划',
      status: 'starting',
      message: '准备生成今日方案'
    });
  }

  if (roleLabel === '策划' && (child.status === 'succeeded' || child.status === 'partial' || child.status === 'failed' || child.status === 'cancelled')) {
    await finishManagerDockTurn(input.businessDate, {
      text: ok
        ? `今日情报编排完成（${child.status === 'partial' ? '部分成功' : '成功'}）。请回今日页查看并批准方案。`
        : `今日情报编排未完成：${child.errorMessage || child.status}`,
      stopped: !ok
    });
  }
}

export async function finishManagerDockTurn(
  businessDate: string,
  result: { text: string; stopped?: boolean }
): Promise<void> {
  const turn = openTurns.get(businessDate);
  if (!turn) {
    broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: result.text, scope: 'dock', source: 'manager' });
    return;
  }
  try {
    const current = await readPiConversation(turn.dataRootPath);
    const messages = current.messages.slice();
    const last = messages.at(-1);
    if (last?.role === 'assistant') {
      messages[messages.length - 1] = {
        ...last,
        text: result.text,
        status: result.stopped ? 'stopped' : undefined,
        segments: [
          ...(last.segments || []).filter((segment) => segment.kind === 'tool'),
          { kind: 'text', text: result.text }
        ]
      };
    } else {
      messages.push({
        role: 'assistant',
        text: result.text,
        createdAt: new Date().toISOString(),
        segments: [{ kind: 'text', text: result.text }]
      });
    }
    await writePiConversation(turn.dataRootPath, {
      id: current.id,
      title: current.title,
      sessionFile: current.sessionFile,
      sessionId: current.sessionId,
      messages,
      createdAt: current.createdAt,
      makeActive: true
    });
  } catch (error) {
    console.error('[manager-dock-turn] finish failed', error);
  }
  openTurns.delete(businessDate);
  broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: result.text, scope: 'dock', source: 'manager' });
  broadcastPiEvent({ type: 'manager_task', action: 'dock_turn_finished', businessDate });
}
