/**
 * WMB 生成式工单终态通知信封的唯一 canonical 契约（零依赖纯函数）。
 *
 * producer（manager-job-notify）、detector（pi-transcript-projection）与测试三方
 * 同源消费：构建走 buildJobEventEnvelope，判定走 isJobEventEnvelope，任何地方不得
 * 再手抄信封字面量。信封漂移必须使共享模块测试失败。
 *
 * 信封结构（严格顺序）：
 *   [WMB_CONTEXT]
 *   page=agents
 *   pageLabel=班组 · 工单通知
 *   objectType=job
 *   objectId=<job id>
 *   contextRule=这是系统推送的员工工单终态通知，…（JOB_EVENT_CONTEXT_RULE 全文）
 *   [USER_MESSAGE]
 *   [JOB_EVENT] …
 */
export const JOB_EVENT_CONTEXT_RULE =
  'contextRule=这是系统推送的员工工单终态通知，不是用户闲聊。根据 JOB_EVENT 向用户汇报并做验收/下一步，不要 sleep 轮询。';

export function buildJobEventEnvelope(input: { objectId: string; text: string }): string {
  return [
    '[WMB_CONTEXT]',
    'page=agents',
    'pageLabel=班组 · 工单通知',
    'objectType=job',
    `objectId=${input.objectId}`,
    JOB_EVENT_CONTEXT_RULE,
    '[USER_MESSAGE]',
    input.text
  ].join('\n');
}

/**
 * 完整信封判定：仅当 user 条目是 WMB 生成的完整工单终态信封才判为系统事件。
 * 头部必须是 [WMB_CONTEXT] 起的 6 行 canonical 序列（字段值、顺序、objectId 非空），
 * 且首个 [USER_MESSAGE]\n 标记后的可见正文以 [JOB_EVENT] 开头。人类正文即使粘贴了
 * 这些元数据 token 也不能满足信封判定，绝不依据裸前缀启发式。
 */
export function isJobEventEnvelope(text: string): boolean {
  const marker = '[USER_MESSAGE]\n';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0 || !text.startsWith('[WMB_CONTEXT]\n')) return false;
  const header = text.slice(0, markerIndex).split('\n');
  if (header.pop() !== '' || header.length !== 6) return false;
  if (header[1] !== 'page=agents') return false;
  if (header[2] !== 'pageLabel=班组 · 工单通知') return false;
  if (header[3] !== 'objectType=job') return false;
  const objectId = header[4];
  if (!objectId.startsWith('objectId=') || objectId.length <= 'objectId='.length) return false;
  if (header[5] !== JOB_EVENT_CONTEXT_RULE) return false;
  return text.slice(markerIndex + marker.length).trim().startsWith('[JOB_EVENT]');
}
