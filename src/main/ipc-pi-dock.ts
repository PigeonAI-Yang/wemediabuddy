import electron from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DataRoot } from './data-root.ts';
import { createForkedPiConversation, readPiConversation, writePiConversation, type PiConversationSnapshot } from './pi-conversation.ts';
const { ipcMain } = electron;
import { readPiTranscript, syncPiConversation } from './pi-persistence.ts';
import type { PiImageContent, PiRpcSupervisor } from './pi-runtime.ts';
import { broadcastPiEvent, broadcastDataChanged } from './app-window.ts';
import { appendAcceptedOrchestration, appendPendingOrchestration, updateFailedOrchestration } from './pi-orchestration-store.ts';
import { buildOrchestrationEnvelope, type OrchestrationData, type OrchestrationSafeFields } from '../shared/orchestration-envelope.ts';
import { extractVisiblePrompt } from '../shared/pi-visible-prompt.ts';
import { knowledgeQueryWritebackRequestId } from '../shared/knowledge-flywheel.ts';
import { routePiSkillPrompt } from './pi-skill-routing.ts';
import { readPiCommands } from './pi-commands.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { ensurePageAuthority, type PageAuthorityResult } from './pi-page-authority.ts';
import { pageAuthoritySpec, isPageAuthorityView } from '../shared/page-authority.ts';
import { dispatchBusinessCommand, requireCommandResultData, requireReceiptData } from './business-command.ts';
import { ownerUiActor } from './ipc-business-context.ts';
import { applyKnowledgeChangeSet, KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND, type KnowledgeChangeSetInput } from './knowledge-flywheel.ts';
import {
  extractQueryWritebackManifest,
  finalizeQueryWriteback,
  hasQueryWritebackFence,
  prepareQueryWriteback,
  QueryWritebackError,
  recordQueryWritebackSettleOutcome,
  stripQueryWritebackBlock,
  type KnowledgeQueryWritebackInput,
  type KnowledgeQueryWritebackResult
} from './query-writeback.ts';
import {
  extractWikiActionManifest,
  hasWikiActionFence,
  stripWikiActionBlock,
  type WikiActionManifest,
  type WikiActionReject
} from '../shared/wiki-operator-protocol.ts';
import { executeWikiAction, type WikiActionResult } from './pi-wiki-actions.ts';
import { saveCoreVersion, type SavedCoreVersion } from './content.ts';
import type { ContentMediaBindingDraft } from '../shared/media-bindings.ts';
import type { StagedAsset } from './assets.ts';
import {
  buildPiImageBatchResultText,
  buildPiImagePlacementPrompt,
  createPiImageBatch,
  getPiImageBatchBaseline,
  listPiImageBatches,
  markPiImageBatchAttachmentImport,
  parsePiImagePlacementManifest,
  piImageBatchInputHash,
  preparePiImageAttachments,
  readPiImageBatch,
  readPiImageBatchByRequest,
  readPiImageAssetBytes,
  recordPiImageBatchDecisions,
  registerPiImageAttachment,
  stagePiImageAttachment,
  transitionPiImageBatch,
  validatePiImagePlacement,
} from './pi-image-batch.ts';
import { isPiImageBatchChatInput, normalizePiImageBatchMessage, type PiImageAttachmentPayload, type PiImageBatchAttachmentDecision, type PiImageBatchChatInput, type PiImageBatchRecord } from '../shared/pi-image-batch.ts';

type Dependencies = {
  loadSelectedDataRoot: () => Promise<DataRoot | null>;
  ensurePi: (dataRoot: DataRoot, options?: { skipProfileIds?: Iterable<string> }) => Promise<PiRpcSupervisor>;
  getPi: () => PiRpcSupervisor | null;
  getLastPiProfileId?: () => string | null;
  getPiSessionFile: () => string | null;
  setPiSessionFile: (sessionFile: string) => void;
  getActiveRuntime?: () => ActiveWorkspaceRuntime | null;
};

let openingTurn: Promise<void> | null = null;
let finishOpeningTurn: (() => void) | null = null;
let stopAfterOpening = false;

function openTurnGate(): void {
  openingTurn = new Promise<void>((resolve) => { finishOpeningTurn = resolve; });
}

function closeTurnGate(): void {
  finishOpeningTurn?.();
  finishOpeningTurn = null;
  openingTurn = null;
}

let lastAuthorityStatus: PageAuthorityResult | null = null;

/**
 * WMB-5214：Pi 轮次完成后的显式结构化写回 hook（不依赖自由文本猜测）。
 * WMB-5231：settle 结果区分六类并全部可读可见——
 *   无知识读取/无清单（零写）、非法清单（零写）、restatement（纯复述零知识）、
 *   new_synthesis（写回 Synthesis Wiki）、user_experience（先存 FreeNote）、
 *   校验/派发失败（零写且原因可见）；失败不阻断回答（正文原样返回），
 *   每轮 settle 结果经 recordQueryWritebackSettleOutcome 记录，面板经摘要读回显示。
 * - 只认回复文本中严格 `{"wmb_query_writeback": …}` 围栏清单：无围栏 / JSON 非法 /
 *   结构非法 → 零写返回原正文，绝不从自由文本猜分类或读取版本；
 * - 冻结读取版本（manifest 声明 + 服务端存在性校验）+ 严格三分写回（restatement /
 *   new_synthesis / user_experience）全部在 query-writeback.ts 机器校验；
 * - 写回经 CommandDispatcher（owner 正式知识写路径，满足 workspace write guard，
 *   apply 事务原子 → 失败零半写）；写回失败不阻断已完成的轮次。
 * 返回剥离 manifest 围栏后的正文（用户看到的正文不含协议块）。
 */
export async function settleQueryWritebackForRound(
  deps: Pick<Dependencies, 'getActiveRuntime'>,
  dataRoot: DataRoot,
  input: { conversationId: string; question: string; answerText: string }
): Promise<{ text: string; writeback: KnowledgeQueryWritebackResult | null }> {
  const requestId = knowledgeQueryWritebackRequestId(input.conversationId, input.question);
  const manifest = extractQueryWritebackManifest(input.answerText);
  const text = manifest ? stripQueryWritebackBlock(input.answerText) : input.answerText;
  if (!manifest) {
    // 无清单 / 未声明知识读取 → 零写；区分「无任何 JSON 围栏」与「有围栏但非法/非本协议」。
    const hasFence = hasQueryWritebackFence(input.answerText);
    recordQueryWritebackSettleOutcome(requestId, {
      state: 'not_written',
      classification: null,
      code: hasFence ? 'QUERY_WRITEBACK_MANIFEST_INVALID' : 'QUERY_WRITEBACK_MANIFEST_MISSING',
      reason: hasFence
        ? '回复含 JSON 围栏但无合法 wmb_query_writeback 清单（清单非法），零写。'
        : '本轮回复未携带 wmb_query_writeback 清单（未声明真实知识读取），零写。'
    });
    return { text, writeback: null };
  }
  const runtime = deps.getActiveRuntime?.() ?? null;
  if (!runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) {
    recordQueryWritebackSettleOutcome(requestId, {
      state: 'not_written',
      classification: manifest.classification,
      code: 'QUERY_WRITEBACK_RUNTIME_UNAVAILABLE',
      reason: '工作空间运行时不可用，写回被跳过（零写）。'
    });
    return { text, writeback: null };
  }
  try {
    const writebackInput: KnowledgeQueryWritebackInput = {
      requestId,
      workspaceId: runtime.identity.workspaceId,
      scope: 'global',
      conversationId: input.conversationId,
      question: input.question,
      answerSummary: text,
      classification: manifest.classification,
      readWikiVersionIds: manifest.readWikiVersionIds,
      readNoteVersionIds: manifest.readNoteVersionIds,
      readEvidenceIds: manifest.readEvidenceIds,
      ...(manifest.synthesis ? {
        synthesis: {
          canonicalKey: manifest.synthesis.canonicalKey,
          ...(manifest.synthesis.title ? { title: manifest.synthesis.title } : {}),
          statement: manifest.synthesis.statement,
          basedOnNoteVersionIds: manifest.synthesis.basedOnNoteVersionIds ?? [],
          valueRationale: manifest.synthesis.valueRationale
        }
      } : {}),
      ...(manifest.experience ? { experience: { body: manifest.experience.body } } : {})
    };
    const prepared = prepareQueryWriteback(runtime.database, writebackInput);
    if (prepared.duplicate) {
      recordQueryWritebackSettleOutcome(requestId, {
        state: 'written',
        classification: manifest.classification,
        code: null,
        reason: `同问幂等：requestId=${requestId} 已写回，本次零增量。`
      });
      return { text, writeback: prepared.result };
    }
    // 经正式知识写命令（owner 面；与 renderer change-set-apply 同一 dispatcher 路径）。
    const commandReceipt = await dispatchBusinessCommand(runtime, {
      command: KNOWLEDGE_FLYWHEEL_CHANGE_SET_COMMAND,
      requestId: prepared.meta!.requestId,
      actor: ownerUiActor,
      input: prepared.segments!,
      boundIdentity: { entityType: 'knowledge_change_set', requestId: prepared.meta!.requestId },
      entityType: 'knowledge_change_set',
      execute: (database, value) => {
        const result = applyKnowledgeChangeSet(database, prepared.meta!, value as KnowledgeChangeSetInput, false);
        return { data: result, entityId: result.changeSetId, readback: result };
      }
    });
    if (!commandReceipt.ok) {
      const error = commandReceipt.error ?? { code: 'QUERY_WRITEBACK_DISPATCH_FAILED', message: '写回命令未通过。' };
      recordQueryWritebackSettleOutcome(requestId, {
        state: 'not_written',
        classification: manifest.classification,
        code: error.code,
        reason: `写回命令未通过（${error.code}）：${error.message}`
      });
      return { text, writeback: null };
    }
    broadcastDataChanged({ scopes: ['knowledge', 'topics', 'receipt', 'library'], reason: 'query_writeback' });
    const result = finalizeQueryWriteback(runtime.database, prepared);
    recordQueryWritebackSettleOutcome(requestId, {
      state: 'written',
      classification: result.classification,
      code: null,
      reason: `本轮已按 ${result.classification} 写回（${result.writeBackDecision}）。`
    });
    return { text, writeback: result };
  } catch (error) {
    // 写回失败零写（apply 原子）；不阻断已完成的轮次，但原因必须可见
    const code = error instanceof QueryWritebackError ? error.code : 'QUERY_WRITEBACK_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    console.error('[query-writeback]', message);
    recordQueryWritebackSettleOutcome(requestId, {
      state: 'not_written',
      classification: manifest.classification,
      code,
      reason: message.length > 240 ? `${message.slice(0, 240)}…` : message
    });
    return { text, writeback: null };
  }
}

/** 用户可见的 wiki 动作结算行（成功/部分/低价值/失败；T-EL-1：不含路径/SQL/堆栈）。 */
function wikiActionOutcomeLine(result: WikiActionResult): string {
  if (!result.ok) return `${result.action} 未执行（${result.error.code}：${result.error.message}）。`;
  if (result.overall === 'partial') return `${result.action} 部分成功：${String((result.data as { failed?: number } | undefined)?.failed ?? '部分项')} 项失败，其余成功。`;
  if (result.overall === 'no_op') return `${result.action} 无变化（低价值，原始资料已保留）。`;
  return `${result.action} 成功。`;
}

/**
 * WMB-5240：Pi 轮次完成后的 Wiki 操作清单 settle hook（不依赖自由文本猜测）。
 * 只认回复文本中严格 `{"wmb_wiki_action": …}` 围栏（shared 解析器 fail-closed）：
 * - 无围栏 → 零执行，正文原样返回（wiki=null, reject=null）；
 * - 有围栏但清单非法/缺授权 → 零执行，正文保留围栏，返回 reject（调用方追加用户可见原因）；
 * - 有合法清单 → 经 executeWikiAction（写动作走 dispatcher + grant；只读直达 store）执行；
 *   失败不阻断已完成的轮次；返回剥离围栏后的正文 + 执行结果。
 */
export async function settleWikiActionForRound(
  deps: Pick<Dependencies, 'getActiveRuntime'>,
  dataRoot: DataRoot,
  input: { conversationId: string; question: string; answerText: string }
): Promise<{ text: string; wiki: WikiActionResult | null; reject: WikiActionReject | null }> {
  const parsed = extractWikiActionManifest(input.answerText);
  const text = parsed.manifest ? stripWikiActionBlock(input.answerText) : input.answerText;
  if (!parsed.manifest) {
    // 无任何围栏 = Pi 本轮未声明 Wiki 操作（常态，静默）；有围栏但清单非法/缺授权 → reject 可见。
    return hasWikiActionFence(input.answerText)
      ? { text, wiki: null, reject: parsed.reject }
      : { text, wiki: null, reject: null };
  }
  const runtime = deps.getActiveRuntime?.() ?? null;
  if (!runtime || runtime.identity.rootPath !== path.resolve(dataRoot.path)) {
    return {
      text,
      wiki: {
        ok: false,
        requestId: parsed.manifest.requestId,
        action: parsed.manifest.action,
        overall: 'failed',
        data: null,
        error: { code: 'WIKI_ACTION_RUNTIME_UNAVAILABLE', message: '工作空间运行时不可用，Wiki 操作未执行（零写）。' }
      },
      reject: null
    };
  }
  try {
    const wiki = await executeWikiAction(
      { runtime, database: runtime.database },
      parsed.manifest as WikiActionManifest,
      { actor: 'pi' }
    );
    return { text, wiki, reject: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text,
      wiki: {
        ok: false,
        requestId: parsed.manifest.requestId,
        action: parsed.manifest.action,
        overall: 'failed',
        data: null,
        error: { code: 'WIKI_ACTION_FAILED', message: message.length > 240 ? `${message.slice(0, 240)}…` : message }
      },
      reject: null
    };
  }
}


type DockPromptDeps = Dependencies;
let dockPromptDeps: DockPromptDeps | null = null;

export type DockOrchestrationDelivery = 'direct' | 'steer' | 'follow_up';

export type DockOrchestrationInput = {
  dispatchId: string;
  delivery: DockOrchestrationDelivery;
  safe: OrchestrationSafeFields;
};

/** §7.1/§10.1：Dock 编排信封（canonical 单一真源）；任一安全字段缺失 → 抛错，派发前失败、该次任务不发送。authorityBlock（taskId/grantId/workerLeaseId 或 blocked）放 [USER_MESSAGE] 后正文区，保持信封 12 行结构。 */
export function buildDockOrchestrationMessage(input: { dispatchId: string; delivery: DockOrchestrationDelivery; safe: OrchestrationSafeFields; prompt: string; authorityBlock?: string }): string {
  const promptText = input.authorityBlock?.trim() ? `${input.prompt}\n\n${input.authorityBlock}` : input.prompt;
  return buildOrchestrationEnvelope({ dispatchId: input.dispatchId, target: 'dock', delivery: input.delivery, safe: input.safe, prompt: promptText });
}

export function acceptedDockOrchestration(input: { dispatchId: string; delivery: DockOrchestrationDelivery; safe: OrchestrationSafeFields }): OrchestrationData {
  return { dispatchId: input.dispatchId, target: 'dock', delivery: input.delivery, state: 'accepted', safe: input.safe };
}

export function pendingDockOrchestration(input: { dispatchId: string; delivery: DockOrchestrationDelivery; safe: OrchestrationSafeFields }): OrchestrationData {
  return { dispatchId: input.dispatchId, target: 'dock', delivery: input.delivery, state: 'pending', safe: input.safe };
}

/** 从已授权消息头提取 taskId/grantId/workerLeaseId（或 [WMB_AUTHORITY_BLOCKED]）块，正文随信封保留。 */
export function extractAuthorityBlock(raw: string): string {
  const markerIndex = raw.indexOf('[USER_MESSAGE]');
  if (markerIndex < 0) return '';
  const lines = raw.slice(0, markerIndex).replace(/\s+$/, '').split('\n');
  const block: string[] = [];
  for (let index = lines.length - 1; index >= 0 && (block.length === 0 || /^(?:taskId|grantId|workerLeaseId)=|^\[WMB_AUTHORITY_BLOCKED\]/.test(lines[index] ?? '')); index -= 1) {
    if (/^(?:taskId|grantId|workerLeaseId)=|^\[WMB_AUTHORITY_BLOCKED\]/.test(lines[index] ?? '')) block.unshift(lines[index]!);
  }
  return block.join('\n');
}

/** §7.2/§8 人类可读错误：首行、去 Error 前缀与内部码、去堆栈帧、截断；空则给兜底文案。 */
export function sanitizeHumanOrchestrationError(raw: unknown): string {
  const firstLine = String(raw ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  const cleaned = firstLine.replace(/^Error:\s*/i, '').replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, '').replace(/\s+at\s+[^\s]+.*$/g, '').trim();
  if (cleaned) return cleaned.length > 160 ? `${cleaned.slice(0, 160)}…` : cleaned;
  return '安排失败，请查看任务状态。';
}

/** 用户动作已通过本地校验：先持久化 pending 行并广播，再接触 Pi；同 dispatchId 幂等。 */
export async function appendPendingDockRow(
  dataRootPath: string,
  input: { dispatchId: string; delivery: DockOrchestrationDelivery; safe: OrchestrationSafeFields; createdAt: string; title?: string }
): Promise<PiConversationSnapshot | null> {
  const current = await readPiConversation(dataRootPath);
  const messages = appendPendingOrchestration(current.messages, pendingDockOrchestration(input), input.createdAt);
  if (messages === current.messages) return null;
  const saved = await writePiConversation(dataRootPath, {
    id: current.id,
    title: input.title ?? current.title,
    sessionFile: current.sessionFile,
    sessionId: current.sessionId,
    messages,
    makeActive: true
  });
  broadcastDataChanged({ scopes: ['agent'], reason: 'manager.orchestration' });
  return saved;
}

/** §10.3 接受门落盘：接受后先写入并广播 accepted 行（同 dispatchId 幂等），再释放 direct 新回合输出；queue-ack-only 行由 syncPiConversation 对账保留。 */
export async function appendAcceptedDockRow(
  dataRootPath: string,
  input: { dispatchId: string; delivery: DockOrchestrationDelivery; safe: OrchestrationSafeFields; createdAt: string; title?: string }
): Promise<PiConversationSnapshot | null> {
  const current = await readPiConversation(dataRootPath);
  const messages = appendAcceptedOrchestration(current.messages, acceptedDockOrchestration(input), input.createdAt);
  if (messages === current.messages) return null;
  const saved = await writePiConversation(dataRootPath, {
    id: current.id,
    title: input.title ?? current.title,
    sessionFile: current.sessionFile,
    sessionId: current.sessionId,
    messages,
    makeActive: true
  });
  broadcastDataChanged({ scopes: ['agent'], reason: 'manager.orchestration' });
  return saved;
}

/** §8/§16-3 接受后失败：同 dispatchId 原地更新为 failed + 人类可读错误，无新行、无重排；无该行（接受前失败）为 no-op。 */
export async function markDockOrchestrationFailed(dataRootPath: string, dispatchId: string, rawError: unknown): Promise<PiConversationSnapshot | null> {
  const error = sanitizeHumanOrchestrationError(rawError);
  const current = await readPiConversation(dataRootPath);
  const messages = updateFailedOrchestration(current.messages, dispatchId, error);
  if (messages === current.messages) return null;
  const saved = await writePiConversation(dataRootPath, {
    id: current.id,
    title: current.title,
    sessionFile: current.sessionFile,
    sessionId: current.sessionId,
    messages,
    makeActive: true
  });
  broadcastDataChanged({ scopes: ['agent'], reason: 'manager.orchestration' });
  return saved;
}

/** 主管真回合：与手动 chat 同一 ensurePi + promptUntilSettled + onPiEvent 通道。 */
export async function runDockManagerPrompt(input: {
  message: string;
  page?: string;
  pageLabel?: string;
  objectType?: string;
  objectId?: string;
  /** WMB-5178：应用代写编排（Owner 触发 + 应用写 prompt + 确实派发到 Pi）。提供后经 canonical 信封显式盖章。 */
  orchestration?: DockOrchestrationInput;
}): Promise<{ text: string; stopped: boolean; conversation: PiConversationSnapshot | null }> {
  const deps = dockPromptDeps;
  if (!deps) throw new Error('Pi dock 尚未注册。');
  const dataRoot = await deps.loadSelectedDataRoot();
  if (!dataRoot) throw new Error('请先选择数据根目录。');

  const page = input.page || 'agents';
  const pageLabel = input.pageLabel || '班组';
  const objectType = input.objectType || 'manager_task';
  const objectId = input.objectId || '';
  const orchestration = input.orchestration ?? null;
  const wrapped =
    `[WMB_CONTEXT]\npage=${page}\npageLabel=${pageLabel}\nobjectType=${objectType}\nobjectId=${objectId}\n` +
    `contextRule=你是主管。自动编排是你的工具：scan/judge/full 用 wmb_run_daily_stage；采完要续策划用 wmb_continue_after_scan；也可 wmb_spawn_job 派单项。先 readiness，再按你的判断选用工具；用 list_jobs/roster 监工并汇报。\n` +
    `[USER_MESSAGE]\n${input.message}`;
  const authorize = async (message: string): Promise<string> => {
    const active = deps.getActiveRuntime?.() ?? null;
    if (!active) return message;
    const result = await ensurePageAuthority(active, dataRoot, deps.ensurePi, message);
    lastAuthorityStatus = result.status;
    return result.message;
  };

  // 若已有真 Pi 回合，插入 steer，不另开冲突回合
  const existing = deps.getPi();
  if (existing?.isActive) {
    const authorized = await authorize(wrapped);
    if (orchestration) {
      // §10.2：steer 以队列 ack 为接受证据；实际投递 delivery 以 steer/follow_up 盖章。
      const delivery = orchestration.delivery === 'follow_up' ? 'follow_up' : 'steer';
      const envelope = buildDockOrchestrationMessage({
        dispatchId: orchestration.dispatchId,
        delivery,
        safe: orchestration.safe,
        prompt: extractVisiblePrompt(authorized),
        authorityBlock: extractAuthorityBlock(authorized)
      });
      const createdAt = new Date().toISOString();
      await appendPendingDockRow(dataRoot.path, {
        dispatchId: orchestration.dispatchId,
        delivery,
        safe: orchestration.safe,
        createdAt
      });
      try {
        await existing.steer(envelope);
        broadcastPiEvent({ type: 'queued', delivery: 'steer', scope: 'dock' });
        await appendAcceptedDockRow(dataRoot.path, {
          dispatchId: orchestration.dispatchId,
          delivery,
          safe: orchestration.safe,
          createdAt
        });
      } catch (error) {
        await markDockOrchestrationFailed(dataRoot.path, orchestration.dispatchId, error).catch(() => {});
        throw error;
      }
      return { text: '', stopped: false, conversation: null };
    }
    await existing.steer(routePiSkillPrompt(authorized));
    broadcastPiEvent({ type: 'queued', delivery: 'steer', scope: 'dock' });
    return { text: '', stopped: false, conversation: null };
  }

  openTurnGate();
  broadcastPiEvent({ type: 'starting', scope: 'dock' });
  let runtime: PiRpcSupervisor | null = null;
  let conversation: PiConversationSnapshot | null = null;
  try {
    if (orchestration) {
      // §10.3：direct 以 canonical raw user entry 已建立为接受证据；agent_start 回调 async，先持久化 accepted 行，运行时缓冲外向事件直到持久化成功再释放。
      const current = await readPiConversation(dataRoot.path);
      const createdAt = new Date().toISOString();
      const authorized = await authorize(wrapped);
      const envelope = buildDockOrchestrationMessage({
        dispatchId: orchestration.dispatchId,
        delivery: 'direct',
        safe: orchestration.safe,
        prompt: extractVisiblePrompt(authorized),
        authorityBlock: extractAuthorityBlock(authorized)
      });
      conversation = (await appendPendingDockRow(dataRoot.path, {
        dispatchId: orchestration.dispatchId,
        delivery: 'direct',
        safe: orchestration.safe,
        createdAt,
        title: current.title === '新会话' || current.title === 'Pi' ? '主管 · 今日情报' : current.title
      })) ?? current;
      runtime = await deps.ensurePi(dataRoot);
      const result = await runtime.promptUntilSettled(envelope, {
        onStreaming: async () => {
          const saved = await appendAcceptedDockRow(dataRoot.path, {
            dispatchId: orchestration.dispatchId,
            delivery: 'direct',
            safe: orchestration.safe,
            createdAt,
            title: current.title === '新会话' || current.title === 'Pi' ? '主管 · 今日情报' : current.title
          });
          if (saved) conversation = saved;
          closeTurnGate();
          if (stopAfterOpening) {
            stopAfterOpening = false;
            void runtime?.abortTurn().catch(() => {});
          }
        }
      });
      const synced = await syncPiConversation(dataRoot.path, conversation ?? current, runtime, { status: result.stopped ? 'stopped' : undefined, thinking: result.thinking, text: result.text });
      if (synced) deps.setPiSessionFile(synced.sessionFile);
      broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: result.text, thinking: result.thinking, scope: 'dock' });
      return { text: result.text, stopped: result.stopped, conversation: synced };
    }
    // 先拉起 Pi，再写入 streaming 气泡，避免 ensurePi 读会话时误 recover 中断。
    runtime = await deps.ensurePi(dataRoot);
    const current = await readPiConversation(dataRoot.path);
    const createdAt = new Date().toISOString();
    const title = current.title === '新会话' || current.title === 'Pi' ? '主管 · 今日情报' : current.title;
    conversation = await writePiConversation(dataRoot.path, {
      id: current.id,
      title,
      sessionFile: current.sessionFile,
      sessionId: current.sessionId,
      messages: [
        ...current.messages,
        { role: 'user', text: extractVisiblePrompt(wrapped), createdAt },
        { role: 'assistant', text: '', status: 'streaming', createdAt }
      ],
      createdAt: current.createdAt,
      makeActive: true
    });
    const result = await runtime.promptUntilSettled(routePiSkillPrompt(await authorize(wrapped)), {
      onStreaming: () => {
        closeTurnGate();
        if (stopAfterOpening) {
          stopAfterOpening = false;
          void runtime?.abortTurn().catch(() => {});
        }
      }
    });
    // WMB-5240：轮次完成后先结算 Wiki 操作清单（wmb_wiki_action；无清单零执行），
    // 再走 WMB-5214 查询写回（wmb_query_writeback；无清单零写）；各自剥离自己的协议围栏。
    const wikiSettled = await settleWikiActionForRound(deps, dataRoot, {
      conversationId: conversation.id,
      question: extractVisiblePrompt(wrapped),
      answerText: result.text
    });
    const settled = await settleQueryWritebackForRound(deps, dataRoot, {
      conversationId: conversation.id,
      question: extractVisiblePrompt(wrapped),
      answerText: wikiSettled.text
    });
    const settledText = wikiSettled.wiki
      ? `${settled.text}\n\n[Wiki 操作] ${wikiActionOutcomeLine(wikiSettled.wiki)}`
      : wikiSettled.reject
        ? `${settled.text}\n\n[Wiki 操作] 未执行（${wikiSettled.reject.code}：${wikiSettled.reject.reason}）。`
        : settled.text;
    const synced = await syncPiConversation(dataRoot.path, conversation, runtime, { status: result.stopped ? 'stopped' : undefined, thinking: result.thinking, text: settledText });
    if (synced) deps.setPiSessionFile(synced.sessionFile);
    broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: settledText, thinking: result.thinking, scope: 'dock' });
    return { text: settledText, stopped: result.stopped, conversation: synced };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (orchestration) {
      // §8/§16-3：接受后失败 → 同 dispatchId 原地更新为「安排失败 + 人类可读错误」；接受前失败无行则 no-op。
      await markDockOrchestrationFailed(dataRoot.path, orchestration.dispatchId, message).catch(() => {});
      if (!runtime || deps.getPi() === runtime) {
        broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
      }
      throw error;
    }
    if (conversation) {
      const messages = conversation.messages.slice();
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.status === 'streaming') {
        messages[messages.length - 1] = { ...last, text: message, status: 'failed', segments: [{ kind: 'text', text: message }] };
      }
      await writePiConversation(dataRoot.path, {
        id: conversation.id,
        title: conversation.title,
        sessionFile: conversation.sessionFile,
        sessionId: conversation.sessionId,
        messages,
        createdAt: conversation.createdAt,
        makeActive: true
      }).catch(() => {});
    }
    if (!runtime || deps.getPi() === runtime) {
      broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
    }
    throw error;
  } finally {
    closeTurnGate();
    stopAfterOpening = false;
  }
}

async function runPiImageBatch(
  dataRoot: DataRoot,
  runtime: ActiveWorkspaceRuntime,
  pi: PiRpcSupervisor,
  input: PiImageBatchChatInput
): Promise<{ text: string; thinking: string; stopped: boolean; batch: PiImageBatchRecord; versionNumber: number | null }> {
  const prepared = preparePiImageAttachments(input);
  const baseline = getPiImageBatchBaseline(runtime.database, input.projectId);
  if (!baseline.versionId || !baseline.body.trim()) throw new Error('当前项目没有可用于排图的核心正文。');
  const inputHash = piImageBatchInputHash({ projectId: input.projectId, userMessage: input.message, attachments: prepared });
  const commandData = async <T>(command: string, requestId: string, value: unknown, execute: (database: ActiveWorkspaceRuntime['database'], normalized: unknown) => { data: T; entityId?: string; beforeRevision?: number; afterRevision?: number; readback?: unknown; sideEffectState?: string }): Promise<T> => {
    const receipt = await dispatchBusinessCommand(runtime, {
      command,
      requestId,
      actor: ownerUiActor,
      input: value,
      boundIdentity: { entityType: 'pi_image_batch', projectId: input.projectId, requestId: input.requestId },
      entityType: 'pi_image_batch',
      execute: (database, normalized) => execute(database, normalized)
    });
    return requireReceiptData(receipt);
  };
  let batch = await commandData<PiImageBatchRecord>('pi_image_batch.create', `${input.requestId}:batch`, {
    requestId: input.requestId,
    projectId: input.projectId,
    userMessage: normalizePiImageBatchMessage(input.message),
    expectedRevision: baseline.expectedRevision,
    baselineVersionId: baseline.versionId,
    inputHash,
    attachments: prepared.map((attachment) => ({
      ordinal: attachment.ordinal,
      sourceFileName: attachment.sourceFileName,
      sourceMimeType: attachment.sourceMimeType,
      byteCount: attachment.byteCount,
      width: attachment.width,
      height: attachment.height,
      sourceSha256: attachment.sourceSha256
    }))
  }, (database, normalized) => {
    const value = normalized as {
      requestId: string; projectId: string; userMessage: string; expectedRevision: number; baselineVersionId: string | null; inputHash: string;
      attachments: Array<{ ordinal: number; sourceFileName: string; sourceMimeType: PiImageAttachmentPayload['mimeType']; byteCount: number; width: number | null; height: number | null; sourceSha256: string }>;
    };
    const created = createPiImageBatch(database, {
      requestId: value.requestId,
      projectId: value.projectId,
      userMessage: value.userMessage,
      expectedRevision: value.expectedRevision,
      baselineVersionId: value.baselineVersionId,
      inputHash: value.inputHash,
      attachments: value.attachments.map((attachment) => ({ ...attachment, bytes: Buffer.alloc(0) }))
    });
    return { data: created, entityId: created.id, readback: created };
  });
  if (batch.status === 'completed') {
    const detail = getPiImageBatchBaseline(runtime.database, batch.projectId).project;
    const version = batch.targetVersionId ? detail.revisions.find((item) => item.id === batch.targetVersionId) : null;
    return { text: buildPiImageBatchResultText({ batch, versionNumber: version?.number ?? null }), thinking: '', stopped: false, batch, versionNumber: version?.number ?? null };
  }
  if (batch.status === 'conflicted' || batch.status === 'canceled') return { text: buildPiImageBatchResultText({ batch }), thinking: '', stopped: false, batch, versionNumber: null };

  const transition = async (status: Parameters<typeof transitionPiImageBatch>[1]['status'], extra: Partial<Parameters<typeof transitionPiImageBatch>[1]> = {}) => {
    batch = await commandData<PiImageBatchRecord>('pi_image_batch.state', `${input.requestId}:state:${status}`, { batchId: batch.id, status, ...extra }, (database, normalized) => {
      const next = transitionPiImageBatch(database, normalized as Parameters<typeof transitionPiImageBatch>[1]);
      return { data: next, entityId: next.id, readback: next };
    });
    return batch;
  };
  if (batch.status === 'queued' || batch.status === 'failed_import') await transition('importing', { failureStage: null, failureCode: null, failureMessage: null });
  for (const attachment of batch.attachments) {
    if (attachment.state === 'imported' || attachment.state === 'used' || attachment.state === 'unused') continue;
    const original = prepared[attachment.ordinal];
    if (!original) throw new Error(`无法恢复第 ${attachment.ordinal + 1} 张图片。`);
    try {
      const staged = await stagePiImageAttachment(dataRoot.path, original);
      batch = await commandData<PiImageBatchRecord>('pi_image_batch.import', `${input.requestId}:import:${attachment.ordinal}`, {
        batchId: batch.id,
        projectId: input.projectId,
        ordinal: attachment.ordinal,
        staged
      }, (database, normalized) => {
        const value = normalized as { batchId: string; projectId: string; ordinal: number; staged: StagedAsset };
        const linked = registerPiImageAttachment(database, value.projectId, value.staged);
        const next = markPiImageBatchAttachmentImport(database, { batchId: value.batchId, ordinal: value.ordinal, state: 'imported', assetId: linked.assetId });
        return { data: next, entityId: next.id, readback: { batchId: next.id, ordinal: value.ordinal, assetId: linked.assetId, reused: linked.reused } };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      batch = await commandData<PiImageBatchRecord>('pi_image_batch.import-failed', `${input.requestId}:import-failed:${attachment.ordinal}`, {
        batchId: batch.id, ordinal: attachment.ordinal, state: 'failed', failureCode: 'IMPORT_FAILED', failureMessage: message
      }, (database, normalized) => {
        const next = markPiImageBatchAttachmentImport(database, normalized as Parameters<typeof markPiImageBatchAttachmentImport>[1]);
        return { data: next, entityId: next.id, readback: next };
      });
      batch = await transition('failed_import', { failureStage: 'import', failureCode: 'IMPORT_FAILED', failureMessage: message });
      return { text: buildPiImageBatchResultText({ batch }), thinking: '', stopped: false, batch, versionNumber: null };
    }
  }
  if (batch.status === 'failed_analysis') await transition('analyzing', { failureStage: null, failureCode: null, failureMessage: null });
  if (batch.status === 'queued' || batch.status === 'importing') await transition('analyzing');

  let thinking = '';
  let stopped = false;
  let placement: { body: string; decisions: PiImageBatchAttachmentDecision[]; mediaBindings: ContentMediaBindingDraft[] } | null = null;
  if (batch.placementJson) {
    try {
      const stored = JSON.parse(batch.placementJson) as { body: string; decisions: PiImageBatchAttachmentDecision[]; mediaBindings: ContentMediaBindingDraft[] };
      placement = validatePiImagePlacement({ requestId: batch.requestId, projectId: batch.projectId, baselineVersionId: baseline.versionId, expectedRevision: baseline.expectedRevision, body: stored.body, decisions: stored.decisions, mediaBindings: stored.mediaBindings }, { batch, baseline });
    } catch {
      placement = null;
    }
  }
  if (!placement) {
    try {
      const images: PiImageContent[] = [];
      for (const attachment of batch.attachments) {
        if (!attachment.assetId) throw new Error(`第 ${attachment.ordinal + 1} 张图片尚未导入。`);
        const loaded = await readPiImageAssetBytes(dataRoot.path, runtime.database, attachment.assetId);
        images.push({ type: 'image', data: loaded.bytes.toString('base64'), mimeType: loaded.asset.mimeType });
      }
      const result = await pi.promptUntilSettled(buildPiImagePlacementPrompt({ batch, baseline }), { images });
      thinking = result.thinking;
      stopped = result.stopped;
      if (stopped) throw new Error('Pi 在排图分析开始后被停止。');
      const manifest = parsePiImagePlacementManifest(result.text);
      placement = validatePiImagePlacement(manifest, { batch, baseline });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      batch = await transition('failed_analysis', { failureStage: 'analysis', failureCode: 'ANALYSIS_FAILED', failureMessage: message });
      return { text: buildPiImageBatchResultText({ batch }), thinking, stopped, batch, versionNumber: null };
    }
    batch = await commandData<PiImageBatchRecord>('pi_image_batch.decisions', `${input.requestId}:decisions`, {
      batchId: batch.id, body: placement.body, decisions: placement.decisions, mediaBindings: placement.mediaBindings
    }, (database, normalized) => {
      const next = recordPiImageBatchDecisions(database, normalized as Parameters<typeof recordPiImageBatchDecisions>[1]);
      return { data: next, entityId: next.id, readback: next };
    });
  }
  if (!placement) throw new Error('排图结果缺失。');
  if (placement.decisions.every((decision) => decision.decision === 'unused')) {
    batch = await transition('completed', { usedCount: 0, unusedCount: placement.decisions.length });
    return { text: buildPiImageBatchResultText({ batch }), thinking, stopped, batch, versionNumber: null };
  }
  if (batch.status === 'failed_save' || batch.status === 'analyzing') await transition('saving', { failureStage: null, failureCode: null, failureMessage: null });
  const saveInput = { projectId: batch.projectId, body: placement.body, expectedRevision: batch.expectedRevision, author: 'ai' as const, mediaBindings: placement.mediaBindings };
  let saved: SavedCoreVersion;
  try {
    saved = await commandData<SavedCoreVersion>('wmb_save_core_version', `${input.requestId}:save`, saveInput, (database, normalized) => {
      const result = saveCoreVersion(database, normalized as typeof saveInput, false);
      const data = requireCommandResultData(result);
      return { data, entityId: data.id, beforeRevision: batch.expectedRevision, afterRevision: data.projectRevision, readback: data };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'REVISION_CONFLICT') batch = await transition('conflicted', { failureStage: 'conflict', failureCode: code, failureMessage: message });
    else batch = await transition('failed_save', { failureStage: 'save', failureCode: code ?? 'SAVE_FAILED', failureMessage: message });
    return { text: buildPiImageBatchResultText({ batch }), thinking, stopped, batch, versionNumber: null };
  }
  const readback = getPiImageBatchBaseline(runtime.database, batch.projectId).project.revisions.find((version) => version.id === saved.id);
  if (!readback || readback.body !== placement.body || readback.bindings.length !== placement.mediaBindings.length) {
    batch = await transition('failed_save', { failureStage: 'readback', failureCode: 'SAVE_READBACK_FAILED', failureMessage: '核心版本保存回读未通过。' });
    return { text: buildPiImageBatchResultText({ batch }), thinking, stopped, batch, versionNumber: null };
  }
  batch = await commandData<PiImageBatchRecord>('pi_image_batch.decisions-readback', `${input.requestId}:decisions-readback`, {
    batchId: batch.id, decisions: placement.decisions, coreVersionId: saved.id
  }, (database, normalized) => {
    const next = recordPiImageBatchDecisions(database, normalized as Parameters<typeof recordPiImageBatchDecisions>[1]);
    return { data: next, entityId: next.id, readback: next };
  });
  batch = await transition('completed', { targetVersionId: saved.id, usedCount: placement.decisions.filter((decision) => decision.decision === 'used').length, unusedCount: placement.decisions.filter((decision) => decision.decision === 'unused').length });
  broadcastDataChanged({ scopes: ['studio'], reason: 'pi_image_batch.completed' });
  return { text: buildPiImageBatchResultText({ batch, versionNumber: saved.versionNumber }), thinking, stopped, batch, versionNumber: saved.versionNumber };
}

export function registerPiDockIpc({ loadSelectedDataRoot, ensurePi, getPi, getPiSessionFile, setPiSessionFile, getActiveRuntime }: Dependencies): void {
  dockPromptDeps = { loadSelectedDataRoot, ensurePi, getPi, getPiSessionFile, setPiSessionFile, getActiveRuntime };
  ipcMain.handle('pi:commands', async () => {
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    return readPiCommands(await (await ensurePi(dataRoot)).getCommands());
  });

  ipcMain.handle('pi:chat', async (_event, input: string | PiImageBatchChatInput | { message: string; orchestration: { originLabel: string; title: string; goal: string; acceptance: string }; delivery?: 'steer' | 'followUp' }) => {
    const batchInput = typeof input === 'object' && isPiImageBatchChatInput(input) ? input : null;
    const raw = (typeof input === 'string' ? input : input.message).trim();
    if (!raw && !batchInput) throw new Error('请输入内容。');
    // WMB-5178：renderer 仅传安全字段，dispatchId 由主进程按实际派发生成（稳定唯一，对账锚点）。
    const orchestration: DockOrchestrationInput | null = typeof input === 'object' && 'orchestration' in input && input.orchestration
      ? {
          dispatchId: randomUUID(),
          delivery: input.delivery === 'followUp' ? 'follow_up' : input.delivery === 'steer' ? 'steer' : 'direct',
          safe: input.orchestration
        }
      : null;
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const pendingOpening = openingTurn;
    const continuesTurn = getPi()?.isActive === true || pendingOpening !== null;
    const authorize = async (message: string): Promise<string> => {
      const active = getActiveRuntime?.() ?? null;
      if (!active) {
        lastAuthorityStatus = { ok: false, reason: 'runtime_unavailable' };
        return message;
      }
      const result = await ensurePageAuthority(active, dataRoot, ensurePi, message);
      lastAuthorityStatus = result.status;
      return result.message;
    };
    if (batchInput) {
      if (continuesTurn) throw new Error('Pi 正在回复，图片批次不会改变当前队列；请等待本轮结束后再发送。');
      const activeRuntime = getActiveRuntime?.() ?? null;
      if (!activeRuntime || path.resolve(activeRuntime.identity.rootPath) !== path.resolve(dataRoot.path)) throw new Error('当前创作项目运行时不可用。');
      openTurnGate();
      broadcastPiEvent({ type: 'starting', scope: 'dock' });
      let batchConversation: PiConversationSnapshot | null = null;
      let batchPi: PiRpcSupervisor | null = null;
      try {
        const current = await readPiConversation(dataRoot.path);
        const createdAt = new Date().toISOString();
        batchConversation = await writePiConversation(dataRoot.path, {
          id: current.id,
          title: current.title,
          sessionFile: current.sessionFile,
          sessionId: current.sessionId,
          messages: [...current.messages, { role: 'user', text: extractVisiblePrompt(normalizePiImageBatchMessage(raw)), createdAt }, { role: 'assistant', text: '', status: 'streaming', createdAt }],
          createdAt: current.createdAt,
          makeActive: true
        });
        batchPi = await ensurePi(dataRoot);
        const outcome = await runPiImageBatch(dataRoot, activeRuntime, batchPi, { ...batchInput, message: batchInput.message });
        const messages = batchConversation.messages.slice();
        const last = messages.at(-1);
        if (last?.role === 'assistant') messages[messages.length - 1] = { ...last, text: outcome.text, thinking: outcome.thinking || undefined, status: outcome.stopped ? 'stopped' : undefined };
        batchConversation = await writePiConversation(dataRoot.path, {
          id: batchConversation.id,
          title: batchConversation.title,
          sessionFile: batchConversation.sessionFile,
          sessionId: batchConversation.sessionId,
          messages,
          createdAt: batchConversation.createdAt,
          makeActive: true
        });
        setPiSessionFile(batchConversation.sessionFile);
        broadcastPiEvent({ type: outcome.stopped ? 'stopped' : 'idle', text: outcome.text, thinking: outcome.thinking, scope: 'dock' });
        return { text: outcome.text, thinking: outcome.thinking, stopped: outcome.stopped, queued: false, batchStatus: outcome.batch.status, conversation: batchConversation };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (batchConversation) {
          const messages = batchConversation.messages.slice();
          const last = messages.at(-1);
          if (last?.role === 'assistant') messages[messages.length - 1] = { ...last, text: message, status: 'failed', segments: [{ kind: 'text', text: message }] };
          await writePiConversation(dataRoot.path, { id: batchConversation.id, title: batchConversation.title, sessionFile: batchConversation.sessionFile, sessionId: batchConversation.sessionId, messages, createdAt: batchConversation.createdAt, makeActive: true }).catch(() => {});
        }
        broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
        throw error;
      } finally {
        closeTurnGate();
        stopAfterOpening = false;
      }
    }
    if (continuesTurn) {
      await pendingOpening;
      const runtime = await ensurePi(dataRoot);
      if (!runtime.isActive) throw new Error('Pi 未接受当前对话。');
      const delivery = typeof input === 'string' ? 'steer' : (input.delivery ?? 'steer');
      if (orchestration) {
        // §10.2：steer/follow-up 以队列 ack 返回为接受证据；ack 后先写 accepted 行（queue-ack-only 行由 syncPiConversation 对账保留）。
        const authorized = await authorize(raw);
        const envelope = buildDockOrchestrationMessage({
          dispatchId: orchestration.dispatchId,
          delivery: delivery === 'followUp' ? 'follow_up' : 'steer',
          safe: orchestration.safe,
          prompt: extractVisiblePrompt(authorized),
          authorityBlock: extractAuthorityBlock(authorized)
        });
        const createdAt = new Date().toISOString();
        await appendPendingDockRow(dataRoot.path, {
          dispatchId: orchestration.dispatchId,
          delivery: delivery === 'followUp' ? 'follow_up' : 'steer',
          safe: orchestration.safe,
          createdAt
        });
        try {
          await (delivery === 'followUp' ? runtime.followUp(envelope) : runtime.steer(envelope));
          broadcastPiEvent({ type: 'queued', delivery, scope: 'dock' });
          await appendAcceptedDockRow(dataRoot.path, {
            dispatchId: orchestration.dispatchId,
            delivery: delivery === 'followUp' ? 'follow_up' : 'steer',
            safe: orchestration.safe,
            createdAt
          });
        } catch (error) {
          await markDockOrchestrationFailed(dataRoot.path, orchestration.dispatchId, error).catch(() => {});
          throw error;
        }
        return { text: '', stopped: false, queued: true, conversation: null };
      }
      const routed = routePiSkillPrompt(await authorize(raw));
      await (delivery === 'followUp' ? runtime.followUp(routed) : runtime.steer(routed));
      broadcastPiEvent({ type: 'queued', delivery, scope: 'dock' });
      return { text: '', stopped: false, queued: true, conversation: null };
    }
    openTurnGate();
    broadcastPiEvent({ type: 'starting', scope: 'dock' });
    let runtime: PiRpcSupervisor | null = null;
    let conversation: PiConversationSnapshot | null = null;
    try {
      if (orchestration) {
        // §10.3 direct：raw user entry 已建立 = 接受证据；接受前不写编排行。agent_start 回调 async 持久化 accepted 行，运行时缓冲外向事件直到持久化成功才释放。
        const current = await readPiConversation(dataRoot.path);
        const createdAt = new Date().toISOString();
        const authorized = await authorize(raw);
        const envelope = buildDockOrchestrationMessage({
          dispatchId: orchestration.dispatchId,
          delivery: 'direct',
          safe: orchestration.safe,
          prompt: extractVisiblePrompt(authorized),
          authorityBlock: extractAuthorityBlock(authorized)
        });
        conversation = (await appendPendingDockRow(dataRoot.path, {
          dispatchId: orchestration.dispatchId,
          delivery: 'direct',
          safe: orchestration.safe,
          createdAt
        })) ?? current;
        runtime = await ensurePi(dataRoot);
        const result = await runtime.promptUntilSettled(envelope, {
          onStreaming: async () => {
            const saved = await appendAcceptedDockRow(dataRoot.path, {
              dispatchId: orchestration.dispatchId,
              delivery: 'direct',
              safe: orchestration.safe,
              createdAt
            });
            if (saved) conversation = saved;
            closeTurnGate();
            if (stopAfterOpening) {
              stopAfterOpening = false;
              void runtime?.abortTurn().catch(() => {});
            }
          }
        });
        const synced = await syncPiConversation(dataRoot.path, conversation ?? current, runtime, { status: result.stopped ? 'stopped' : undefined, thinking: result.thinking, text: result.text });
        if (synced) setPiSessionFile(synced.sessionFile);
        broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: result.text, thinking: result.thinking, scope: 'dock' });
        return { ...result, queued: false, conversation: synced };
      }
      const current = await readPiConversation(dataRoot.path);
      const createdAt = new Date().toISOString();
      conversation = await writePiConversation(dataRoot.path, {
        id: current.id,
        title: current.title,
        sessionFile: current.sessionFile,
        sessionId: current.sessionId,
        messages: [...current.messages, { role: 'user', text: extractVisiblePrompt(raw), createdAt }, { role: 'assistant', text: '', status: 'streaming', createdAt }],
        createdAt: current.createdAt,
        makeActive: true
      });
      runtime = await ensurePi(dataRoot);
      const result = await runtime.promptUntilSettled(routePiSkillPrompt(await authorize(raw)), {
        onStreaming: () => {
          closeTurnGate();
          if (stopAfterOpening) {
            stopAfterOpening = false;
            void runtime?.abortTurn().catch(() => {});
          }
        }
      });
      // WMB-5240：轮次完成后先结算 Wiki 操作清单（wmb_wiki_action；无清单零执行），
      // 再走 WMB-5214 查询写回（wmb_query_writeback；无清单零写）；各自剥离自己的协议围栏。
      const wikiSettled = await settleWikiActionForRound({ getActiveRuntime }, dataRoot, {
        conversationId: conversation.id,
        question: extractVisiblePrompt(raw),
        answerText: result.text
      });
      const settled = await settleQueryWritebackForRound({ getActiveRuntime }, dataRoot, {
        conversationId: conversation.id,
        question: extractVisiblePrompt(raw),
        answerText: wikiSettled.text
      });
      const settledText = wikiSettled.wiki
        ? `${settled.text}\n\n[Wiki 操作] ${wikiActionOutcomeLine(wikiSettled.wiki)}`
        : wikiSettled.reject
          ? `${settled.text}\n\n[Wiki 操作] 未执行（${wikiSettled.reject.code}：${wikiSettled.reject.reason}）。`
          : settled.text;
      const synced = await syncPiConversation(dataRoot.path, conversation, runtime, { status: result.stopped ? 'stopped' : undefined, thinking: result.thinking, text: settledText });
      if (synced) setPiSessionFile(synced.sessionFile);
      broadcastPiEvent({ type: result.stopped ? 'stopped' : 'idle', text: settledText, thinking: result.thinking, scope: 'dock' });
      return { ...result, queued: false, conversation: synced, text: settledText };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (orchestration) {
        // §8/§16-3：接受后失败 → 同 dispatchId 原地更新为 failed + 人类可读错误；接受前失败无行则 no-op。
        await markDockOrchestrationFailed(dataRoot.path, orchestration.dispatchId, message).catch(() => {});
        if (!runtime || getPi() === runtime) {
          broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
        }
        throw error;
      }
      if (conversation) {
        const messages = conversation.messages.slice();
        const last = messages.at(-1);
        if (last?.role === 'assistant' && last.status === 'streaming') messages[messages.length - 1] = { ...last, text: message, status: 'failed', segments: [{ kind: 'text', text: message }] };
        await writePiConversation(dataRoot.path, { id: conversation.id, title: conversation.title, sessionFile: conversation.sessionFile, sessionId: conversation.sessionId, messages, createdAt: conversation.createdAt, makeActive: true }).catch(() => {});
      }
      if (!runtime || getPi() === runtime) {
        broadcastPiEvent({ type: 'failed', error: message, scope: 'dock' });
      }
      throw error;
    } finally {
      closeTurnGate();
      stopAfterOpening = false;
    }
  });

  ipcMain.handle('pi:image-batch:get', async (_event, input: { projectId: string; batchId?: string; requestId?: string }) => {
    const runtime = getActiveRuntime?.();
    if (!runtime || runtime.identity.rootPath !== path.resolve((await loadSelectedDataRoot())?.path ?? '')) return null;
    if (input.batchId) return readPiImageBatch(runtime.database, input.batchId);
    if (input.requestId) return readPiImageBatchByRequest(runtime.database, input.projectId, input.requestId);
    return null;
  });
  ipcMain.handle('pi:image-batch:list', async (_event, input: { projectId: string; limit?: number }) => {
    const runtime = getActiveRuntime?.();
    if (!runtime || runtime.identity.rootPath !== path.resolve((await loadSelectedDataRoot())?.path ?? '')) return [];
    return listPiImageBatches(runtime.database, input.projectId, input.limit);
  });

  ipcMain.handle('pi:authority-status', async () => {
    const page = lastAuthorityStatus && 'page' in lastAuthorityStatus ? lastAuthorityStatus.page : null;
    const spec = typeof page === 'string' && isPageAuthorityView(page) ? pageAuthoritySpec(page) : null;
    return {
      status: lastAuthorityStatus,
      chipLabel: lastAuthorityStatus && 'chipLabel' in lastAuthorityStatus
        ? lastAuthorityStatus.chipLabel
        : (spec?.chipLabel ?? '—'),
      chipTone: lastAuthorityStatus && lastAuthorityStatus.ok && lastAuthorityStatus.mode === 'granted'
        ? 'write'
        : (spec?.chipTone ?? 'readonly')
    };
  });

  ipcMain.handle('pi:stop', async () => {
    if (openingTurn) {
      stopAfterOpening = true;
      return { stopped: true };
    }
    const runtime = getPi();
    if (!runtime?.isActive) return { stopped: false };
    await runtime.abortTurn();
    return { stopped: true };
  });

  ipcMain.handle('pi:fork', async (_event, entryId: string) => {
    if (!entryId) throw new Error('缺少 Pi 会话条目。');
    const dataRoot = await loadSelectedDataRoot();
    if (!dataRoot) throw new Error('请先选择数据根目录。');
    const runtime = await ensurePi(dataRoot);
    if (runtime.isActive) throw new Error('Pi 正在回复，完成或停止后再回退。');
    const current = await readPiConversation(dataRoot.path);
    const response = await runtime.fork(entryId);
    const data = response.data && typeof response.data === 'object' ? response.data as { text?: unknown; cancelled?: unknown } : {};
    const text = typeof data.text === 'string' ? extractVisiblePrompt(data.text) : '';
    if (data.cancelled === true) return { cancelled: true, text, conversation: current };
    const transcript = await readPiTranscript(runtime);
    const conversation = await createForkedPiConversation(dataRoot.path, {
      sessionFile: transcript.sessionFile ?? getPiSessionFile() ?? current.sessionFile,
      sessionId: transcript.sessionId,
      messages: transcript.messages
    });
    setPiSessionFile(conversation.sessionFile);
    return { cancelled: false, text, conversation };
  });
}
