/**
 * WMB 编排派发信封的唯一 canonical 契约（零依赖纯函数）。
 *
 * producer（WMB-5178 迁移面）、detector（pi-transcript-projection）、store（pi-orchestration-store）
 * 与测试四方同源消费：构建走 buildOrchestrationEnvelope，判定走 parseOrchestrationEnvelope /
 * isValidOrchestrationData，任何地方不得再手抄信封字面量。信封漂移必须使共享模块测试失败。
 *
 * 信封结构（严格顺序；[USER_MESSAGE] 之前为 canonical 机器元数据块）：
 *   [WMB_CONTEXT]
 *   page=pi
 *   pageLabel=Pi 编排
 *   objectType=orchestration
 *   dispatchId=<dispatchId>
 *   target=dock|employee
 *   delivery=direct|steer|follow_up
 *   originLabel=<安全来源名>
 *   title=<任务标题>
 *   goal=<目标>
 *   acceptance=<验收标准>
 *   [ORCHESTRATION]
 *   [USER_MESSAGE]
 *   <prompt>
 *
 * 任一安全字段缺失/为空 → builder 抛错（派发前校验失败，该次任务不发送）；parser 只接受
 * 完整 canonical 元数据块，[USER_MESSAGE] 之后出现的 lookalike 保持人类（honeypot）。
 */

export const ORCHESTRATION_TARGETS = ['dock', 'employee'] as const;
export type OrchestrationTarget = (typeof ORCHESTRATION_TARGETS)[number];

export const ORCHESTRATION_DELIVERIES = ['direct', 'steer', 'follow_up'] as const;
export type OrchestrationDelivery = (typeof ORCHESTRATION_DELIVERIES)[number];

export const ORCHESTRATION_STATES = ['pending', 'accepted', 'failed'] as const;
export type OrchestrationState = (typeof ORCHESTRATION_STATES)[number];

export const ORCHESTRATION_SAFE_FIELDS = ['originLabel', 'title', 'goal', 'acceptance'] as const;
export type OrchestrationSafeFields = {
  originLabel: string;
  title: string;
  goal: string;
  acceptance: string;
};

export type OrchestrationData = {
  dispatchId: string;
  target: OrchestrationTarget;
  delivery: OrchestrationDelivery;
  state: OrchestrationState;
  safe: OrchestrationSafeFields;
  error?: string;
};

export const ORCHESTRATION_MARKER = '[ORCHESTRATION]';
export const ORCHESTRATION_WMB_CONTEXT_LINE = '[WMB_CONTEXT]';
export const ORCHESTRATION_WMB_CONTEXT_HEADER = `${ORCHESTRATION_WMB_CONTEXT_LINE}\n`;
export const ORCHESTRATION_USER_MESSAGE_MARKER = '[USER_MESSAGE]\n';
export const ORCHESTRATION_PAGE = 'page=pi';
export const ORCHESTRATION_PAGE_LABEL = 'pageLabel=Pi 编排';
export const ORCHESTRATION_OBJECT_TYPE = 'objectType=orchestration';
export const ORCHESTRATION_DISPATCH_ID_KEY = 'dispatchId=';
export const ORCHESTRATION_TARGET_KEY = 'target=';
export const ORCHESTRATION_DELIVERY_KEY = 'delivery=';

/** 元数据行数：头部 7 行 + 4 个安全字段 + 语义标记行 = 12，另含 [USER_MESSAGE] 标记产生的尾部空串 */
const ORCHESTRATION_ENVELOPE_LINE_COUNT = 7 + ORCHESTRATION_SAFE_FIELDS.length + 2;

function assertEnvelopeValue(field: string, value: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`orchestration 信封 ${field} 不能为空（派发前校验失败，该次任务不发送）`);
  }
  if (/[\r\n]/.test(value)) throw new Error(`orchestration 信封 ${field} 不能包含换行`);
}

export function buildOrchestrationEnvelope(input: {
  dispatchId: string;
  target: OrchestrationTarget;
  delivery: OrchestrationDelivery;
  safe: OrchestrationSafeFields;
  prompt: string;
}): string {
  const { dispatchId, target, delivery, safe, prompt } = input;
  assertEnvelopeValue('dispatchId', dispatchId);
  if (!ORCHESTRATION_TARGETS.includes(target)) throw new Error('orchestration target 必须是 dock|employee');
  if (!ORCHESTRATION_DELIVERIES.includes(delivery)) throw new Error('orchestration delivery 必须是 direct|steer|follow_up');
  for (const field of ORCHESTRATION_SAFE_FIELDS) assertEnvelopeValue(field, safe[field]);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('orchestration prompt 不能为空');
  const lines = [
    ORCHESTRATION_WMB_CONTEXT_LINE,
    ORCHESTRATION_PAGE,
    ORCHESTRATION_PAGE_LABEL,
    ORCHESTRATION_OBJECT_TYPE,
    `${ORCHESTRATION_DISPATCH_ID_KEY}${dispatchId}`,
    `${ORCHESTRATION_TARGET_KEY}${target}`,
    `${ORCHESTRATION_DELIVERY_KEY}${delivery}`,
    ...ORCHESTRATION_SAFE_FIELDS.map((field) => `${field}=${safe[field]}`),
    ORCHESTRATION_MARKER
  ];
  return `${lines.join('\n')}\n${ORCHESTRATION_USER_MESSAGE_MARKER}${prompt}`;
}

function valueOf(line: string, key: string): string | null {
  if (!line.startsWith(key)) return null;
  const value = line.slice(key.length);
  return value.trim() ? value : null;
}

export function parseOrchestrationEnvelope(text: string): OrchestrationData | null {
  if (typeof text !== 'string') return null;
  const markerIndex = text.indexOf(ORCHESTRATION_USER_MESSAGE_MARKER);
  if (markerIndex < 0 || !text.startsWith(ORCHESTRATION_WMB_CONTEXT_HEADER)) return null;
  const lines = text.slice(0, markerIndex).split('\n');
  if (lines.length !== ORCHESTRATION_ENVELOPE_LINE_COUNT || lines.at(-1) !== '') return null;
  if (lines[0] !== ORCHESTRATION_WMB_CONTEXT_LINE) return null;
  if (lines[1] !== ORCHESTRATION_PAGE) return null;
  if (lines[2] !== ORCHESTRATION_PAGE_LABEL) return null;
  if (lines[3] !== ORCHESTRATION_OBJECT_TYPE) return null;
  const dispatchId = valueOf(lines[4], ORCHESTRATION_DISPATCH_ID_KEY);
  if (dispatchId === null) return null;
  const target = valueOf(lines[5], ORCHESTRATION_TARGET_KEY);
  if (target === null || !ORCHESTRATION_TARGETS.includes(target as OrchestrationTarget)) return null;
  const delivery = valueOf(lines[6], ORCHESTRATION_DELIVERY_KEY);
  if (delivery === null || !ORCHESTRATION_DELIVERIES.includes(delivery as OrchestrationDelivery)) return null;
  const safe = {} as OrchestrationSafeFields;
  for (let i = 0; i < ORCHESTRATION_SAFE_FIELDS.length; i += 1) {
    const field = ORCHESTRATION_SAFE_FIELDS[i];
    const value = valueOf(lines[7 + i], `${field}=`);
    if (value === null) return null;
    safe[field] = value;
  }
  if (lines[7 + ORCHESTRATION_SAFE_FIELDS.length] !== ORCHESTRATION_MARKER) return null;
  return {
    dispatchId,
    target: target as OrchestrationTarget,
    delivery: delivery as OrchestrationDelivery,
    state: 'accepted',
    safe
  };
}

export function isOrchestrationEnvelope(text: string): boolean {
  return parseOrchestrationEnvelope(text) !== null;
}

export function isValidOrchestrationData(value: unknown): value is OrchestrationData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<OrchestrationData>;
  if (typeof data.dispatchId !== 'string' || !data.dispatchId.trim()) return false;
  if (!ORCHESTRATION_TARGETS.includes(data.target as OrchestrationTarget)) return false;
  if (!ORCHESTRATION_DELIVERIES.includes(data.delivery as OrchestrationDelivery)) return false;
  if (!ORCHESTRATION_STATES.includes(data.state as OrchestrationState)) return false;
  if (!data.safe || typeof data.safe !== 'object') return false;
  for (const field of ORCHESTRATION_SAFE_FIELDS) {
    const value = (data.safe as Partial<OrchestrationSafeFields>)[field];
    if (typeof value !== 'string' || !value.trim()) return false;
  }
  if (data.error !== undefined) {
    if (typeof data.error !== 'string' || !data.error.trim()) return false;
    if (data.state !== 'failed') return false;
  }
  return true;
}
