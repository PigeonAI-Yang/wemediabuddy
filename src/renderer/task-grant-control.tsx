import { useEffect, useState } from 'react';

type Grant = {
  id: string;
  status: 'active' | 'expired' | 'revoked' | 'stale';
  revision: number;
  expiresAt: string;
};

const DEFAULT_ALLOWED_COMMANDS = [
  'agent_tasks.report_progress',
  'content.create',
  'content.save_version',
  'intelligence_channels.proposal_apply',
  'knowledge.creative_brief_create',
  'knowledge.creative_brief_create_project',
  'knowledge.creative_brief_update',
  'knowledge.domain_create',
  'knowledge.domain_update',
  'knowledge.record_batch',
  'knowledge.suggestion_create',
  'plans.save',
  'reviews.save',
  'sources.upsert_batch',
  'x_lists.operation_execute'
] as const;

export function TaskGrantControl({ taskId, planDate }: { taskId: string; planDate: string }): React.JSX.Element {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    const grants = await window.wmb.listTaskGrants(taskId);
    setGrant(grants.filter(isGrant).find((value) => value.status === 'active') ?? null);
  };

  useEffect(() => { void refresh(); }, [taskId]);

  const issue = async () => {
    setBusy(true);
    setMessage('');
    try {
      const expiresAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
      const receipt = await window.wmb.issueTaskGrant({
        taskId,
        ownerGoal: `完成 ${planDate} 情报任务并沉淀可读回的业务事实`,
        allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
        workers: [{ type: 'pi', id: 'pi' }, { type: 'external_agent', id: 'mcp' }],
        relevantContext: { planDate },
        expiresAt
      });
      if (!receipt.ok) throw new Error(receipt.error?.message ?? '授权签发失败');
      setMessage('已授权 Pi 和协作助手保存本任务资料');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!grant) return;
    setBusy(true);
    setMessage('');
    try {
      const receipt = await window.wmb.revokeTaskGrant({ grantId: grant.id, expectedRevision: grant.revision });
      if (!receipt.ok) throw new Error(receipt.error?.message ?? '授权撤销失败');
      setMessage('协作授权已撤销');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  return <>
    {grant?.status === 'active'
      ? <button className="secondary-button" disabled={busy} onClick={() => void revoke()}>撤销 AI 协作授权</button>
      : <button className="secondary-button" disabled={busy} onClick={() => void issue()}>授权 AI 协作</button>}
    {message ? <span role="status">{message}</span> : null}
  </>;
}

function isGrant(value: unknown): value is Grant {
  return Boolean(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    && 'status' in value && (value.status === 'active' || value.status === 'expired' || value.status === 'revoked' || value.status === 'stale')
    && 'revision' in value && typeof value.revision === 'number'
    && 'expiresAt' in value && typeof value.expiresAt === 'string');
}
