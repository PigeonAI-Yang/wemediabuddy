/**
 * WMB-5177/WMB-5189 orchestration 行纯辅助（无文件 I/O；会话快照持久化仍走既有
 * pi-conversation / pi-persistence 边界）。
 *
 * - appendPendingOrchestration：派发起点追加 pending 行；同 dispatchId 幂等（绝不重复）。
 * - appendAcceptedOrchestration：接受后追加/升级 accepted 行；同 dispatchId 幂等；
 *   已存在 pending 行 → 原地升级（raw 接受证据覆盖 stored pending）；failed 权威不回退。
 * - transitionOrchestrationState：同 dispatchId 原地迁移（pending→accepted / pending|accepted→failed），
 *   NEVER 新建行、NEVER 重排时间线；未知 dispatchId / 非法迁移为 no-op。
 * - updateFailedOrchestration：接受前/接受后失败 → 同 dispatchId 原地更新为 failed + 人类可读错误
 *   （委托 transitionOrchestrationState；空错误 no-op）。
 * - reconcileOrchestrationRows：raw 投影行与 live 行按 dispatchId 精确一次对账；
 *   状态优先级 failed > accepted > pending（raw 投影 accepted 可覆盖 stored pending；
 *   accepted/failed 行 live 权威；pending 行无 raw entry 时按 queue-ack-only 同一语义保留）；
 *   普通/kindless/system_event 内容沿用既有 preferProjectedMessages 语义。
 */

import type { PiChatMessage } from './pi-conversation.ts';
import { isValidOrchestrationData, type OrchestrationData } from '../shared/orchestration-envelope.ts';
import { extractVisiblePrompt } from '../shared/pi-visible-prompt.ts';

export function isOrchestrationMessage(message: PiChatMessage): message is PiChatMessage & { kind: 'orchestration'; orchestration: OrchestrationData } {
  return message.kind === 'orchestration' && isValidOrchestrationData(message.orchestration);
}

export function appendPendingOrchestration(messages: PiChatMessage[], orchestration: OrchestrationData, createdAt: string): PiChatMessage[] {
  if (!isValidOrchestrationData(orchestration) || orchestration.state !== 'pending') return messages;
  if (messages.some((message) => isOrchestrationMessage(message) && message.orchestration.dispatchId === orchestration.dispatchId)) return messages;
  return [...messages, { role: 'user', text: orchestration.safe.title, kind: 'orchestration', orchestration, createdAt }];
}

export function appendAcceptedOrchestration(messages: PiChatMessage[], orchestration: OrchestrationData, createdAt: string): PiChatMessage[] {
  if (!isValidOrchestrationData(orchestration) || orchestration.state !== 'accepted') return messages;
  const index = messages.findIndex((message) => isOrchestrationMessage(message) && message.orchestration.dispatchId === orchestration.dispatchId);
  if (index < 0) {
    return [...messages, { role: 'user', text: orchestration.safe.title, kind: 'orchestration', orchestration, createdAt }];
  }
  const current = messages[index];
  if (!current.orchestration || current.orchestration.state !== 'pending') return messages;
  return transitionOrchestrationState(messages, orchestration.dispatchId, { state: 'accepted' });
}

export type OrchestrationTransition = { state: 'accepted' } | { state: 'failed'; error: string };

/** 同 dispatchId 原地迁移：pending→accepted；pending|accepted→failed（error 必填人类可读）。failed 权威：accepted 迁移不再升级 failed。 */
export function transitionOrchestrationState(messages: PiChatMessage[], dispatchId: string, transition: OrchestrationTransition): PiChatMessage[] {
  const index = messages.findIndex((message) => isOrchestrationMessage(message) && message.orchestration.dispatchId === dispatchId);
  if (index < 0) return messages;
  const current = messages[index];
  if (!current.orchestration) return messages;
  const orchestration = current.orchestration;
  if (transition.state === 'accepted') {
    if (orchestration.state !== 'pending') return messages;
    const updated: PiChatMessage = { ...current, orchestration: { ...orchestration, state: 'accepted' } };
    return [...messages.slice(0, index), updated, ...messages.slice(index + 1)];
  }
  if (typeof transition.error !== 'string' || !transition.error.trim()) return messages;
  if (orchestration.state === 'failed' && orchestration.error === transition.error) return messages;
  const updated: PiChatMessage = { ...current, orchestration: { ...orchestration, state: 'failed', error: transition.error } };
  return [...messages.slice(0, index), updated, ...messages.slice(index + 1)];
}

export function updateFailedOrchestration(messages: PiChatMessage[], dispatchId: string, error: string): PiChatMessage[] {
  return transitionOrchestrationState(messages, dispatchId, { state: 'failed', error });
}

export function reconcileOrchestrationRows(stored: PiChatMessage[], projected: PiChatMessage[]): PiChatMessage[] {
  if (!projected.length) return stored;
  const base = preferProjectedMessages(stored, projected) ? projected : stored;
  const result = [...base];
  const storedOrchestrations = stored.filter(isOrchestrationMessage);
  const projectedOrchestrations = projected.filter(isOrchestrationMessage);
  const projectedIds = new Set(projectedOrchestrations.map((message) => message.orchestration.dispatchId));
  for (const storedRow of storedOrchestrations) {
    const existingIndex = result.findIndex((message) => isOrchestrationMessage(message) && message.orchestration.dispatchId === storedRow.orchestration.dispatchId);
    if (existingIndex >= 0) {
      const existing = result[existingIndex];
      if (!existing.orchestration) continue;
      const storedState = storedRow.orchestration.state;
      const existingState = existing.orchestration.state;
      const projectedMatch = projectedOrchestrations.find((message) => message.orchestration.dispatchId === storedRow.orchestration.dispatchId);
      if (storedState === 'pending' && projectedMatch?.orchestration.state === 'accepted') {
        result[existingIndex] = projectedMatch;
        continue;
      }
      // 状态优先级 failed > accepted > pending：failed 行 live 权威；raw 投影 accepted 可覆盖 stored pending。
      if (storedState === 'failed') result[existingIndex] = storedRow;
      else if (existingState === 'failed') { /* keep failed */ }
      else if (storedState === 'accepted') result[existingIndex] = storedRow;
      else if (existingState === 'accepted') { /* keep raw accepted evidence */ }
      else result[existingIndex] = storedRow;
    } else if (!projectedIds.has(storedRow.orchestration.dispatchId)) {
      insertChronological(result, storedRow);
    }
  }
  for (const projectedRow of projectedOrchestrations) {
    if (!storedOrchestrations.some((message) => message.orchestration.dispatchId === projectedRow.orchestration.dispatchId)
      && !result.some((message) => isOrchestrationMessage(message) && message.orchestration.dispatchId === projectedRow.orchestration.dispatchId)) {
      insertChronological(result, projectedRow);
    }
  }
  return result;
}

function insertChronological(messages: PiChatMessage[], message: PiChatMessage): void {
  const createdAt = message.createdAt ?? '';
  const index = messages.findIndex((existing) => (existing.createdAt ?? '') > createdAt);
  if (index < 0) messages.push(message);
  else messages.splice(index, 0, message);
}

function visibleMessageSize(messages: PiChatMessage[]): number {
  return messages.reduce((total, message) => total
    + (message.role === 'user' ? extractVisiblePrompt(message.text).length : message.text.length)
    + (message.thinking?.length ?? 0)
    + (message.segments ?? []).reduce((sum, segment) => sum + segment.text.length, 0), 0);
}

function preferProjectedMessages(stored: PiChatMessage[], projected: PiChatMessage[]): boolean {
  const storedPlain = stored.filter((message) => !isOrchestrationMessage(message));
  const projectedPlain = projected.filter((message) => !isOrchestrationMessage(message));
  const storedUsers = storedPlain.filter((message) => message.role === 'user');
  const projectedUsers = projectedPlain.filter((message) => message.role === 'user');
  if (projectedUsers.length !== storedUsers.length) return projectedUsers.length > storedUsers.length;
  for (let index = 0; index < projectedUsers.length; index += 1) {
    if (extractVisiblePrompt(projectedUsers[index]!.text) !== extractVisiblePrompt(storedUsers[index]!.text)) return false;
  }
  const storedSize = visibleMessageSize(storedPlain);
  const projectedSize = visibleMessageSize(projectedPlain);
  if (projectedSize !== storedSize) return projectedSize > storedSize;
  return !storedPlain.some((message) => message.segments?.length) && projectedPlain.some((message) => message.segments?.length);
}
