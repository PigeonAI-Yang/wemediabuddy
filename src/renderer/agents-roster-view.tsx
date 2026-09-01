import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';
import { AgentAvatarCropDialog } from './agent-avatar-crop';
import { AgentsDetailModal } from './agents-detail-modal';
import { resolveDeskConflict } from './agents-roster-conflict';
import {
  EMPLOYEE_ORDER,
  activeRoleSections,
  redispatchInput,
  sortInstancesForDisplay,
  statusWord,
  type CrewInstance,
  type CrewProjection,
  type EmployeeRole
} from './agents-instance-logic';
import { ActiveRoleInstances, ActiveRosterTask, RoleHistoryList } from './agents-roster-instances';
import { RoleOverviewRow } from './agents-roster-overview';
import { roleLabel, type RosterRow } from './agents-roster-parts';

const ORDER: RoleId[] = ['desk', 'reporter', 'planner', 'writer', 'librarian'];

export function AgentsRosterView({
  onOpenSettings
}: {
  onOpenSettings?: () => void;
}): JSX.Element {
  const [projection, setProjection] = useState<CrewProjection | null>(null);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [pool, setPool] = useState<{ maxWorkers: number; deskSnapshot: { leaseId?: string; taskId?: string | null; roleId?: string | null } | null }>({
    maxWorkers: 5,
    deskSnapshot: null
  });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const [avatarByRole, setAvatarByRole] = useState<Partial<Record<RoleId, string>>>({});
  const [cropRole, setCropRole] = useState<RoleId | null>(null);
  const [modalRole, setModalRole] = useState<RoleId | null>(null);
  const [modalJobId, setModalJobId] = useState<string | null>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  // 头像裁切期间暂存详情弹窗状态：裁切弹窗是独立模态层，关闭详情弹窗避免嵌套，
  // 裁切关闭后按原 role/job 恢复详情弹窗。
  const cropReturn = useRef<{ role: RoleId; jobId: string | null } | null>(null);

  useEffect(() => {
    let active = true;
    let latestSeq = 0;
    const load = () => {
      const requestSeq = ++latestSeq;
      void Promise.all([
        window.wmb.getCrewInstanceProjection?.().catch(() => null),
        window.wmb.getAgentsRoster?.({}).catch(() => null),
        window.wmb.jobsPoolStatus?.().catch(() => null),
        window.wmb.listAgentAvatars?.().catch(() => null)
      ]).then(([proj, rows, status, avatars]) => {
        if (!active || requestSeq !== latestSeq) return;
        if (proj) setProjection(proj as CrewProjection);
        if (Array.isArray(rows)) setRoster(rows as RosterRow[]);
        if (status) {
          setPool({
            maxWorkers: Number(status.maxWorkers) || 5,
            deskSnapshot: (status.deskSnapshot as typeof pool.deskSnapshot) ?? null
          });
        }
        if (Array.isArray(avatars)) {
          const next: Partial<Record<RoleId, string>> = {};
          for (const row of avatars as Array<{ roleId: RoleId; url: string }>) {
            if (row?.roleId && row?.url) next[row.roleId] = row.url;
          }
          setAvatarByRole(next);
        }
        setStale(!proj);
      }).catch(() => {
        if (active && requestSeq === latestSeq) setStale(true);
      });
    };
    load();
    const timer = window.setInterval(load, 3000);
    const tickTimer = window.setInterval(() => setTick((n) => n + 1), 1000);
    const off = window.wmb.onDataChanged?.((event) => {
      if (event.scopes?.includes('agent') || event.scopes?.includes('today')) load();
    });
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearInterval(tickTimer);
      off?.();
    };
  }, []);

  const refresh = async () => {
    const [proj, rows, status] = await Promise.all([
      window.wmb.getCrewInstanceProjection?.().catch(() => null),
      window.wmb.getAgentsRoster?.({}).catch(() => null),
      window.wmb.jobsPoolStatus?.().catch(() => null)
    ]);
    if (proj) setProjection(proj as CrewProjection);
    if (Array.isArray(rows)) setRoster(rows as RosterRow[]);
    if (status) setPool((prev) => ({ ...prev, maxWorkers: Number(status.maxWorkers) || prev.maxWorkers }));
  };

  const deskRow = useMemo(() => roster.find((r) => r.roleId === 'desk') ?? null, [roster]);
  const deskOccupied =
    Boolean(pool.deskSnapshot?.leaseId) ||
    ((deskRow?.status === 'running' || deskRow?.status === 'blocked') &&
      deskRow?.roleId === 'desk' &&
      deskRow?.intent !== 'daily_judge' &&
      deskRow?.intent !== 'daily_scan');
  const activeInstances = projection?.active ?? [];
  const deskConflict = resolveDeskConflict({
    deskOccupied,
    deskStatus: deskRow?.status ?? null,
    jobs: activeInstances
  });

  const sections = useMemo(() => (projection ? activeRoleSections(projection, 'all') : []), [projection]);
  const historyRoles = useMemo(
    () => (projection ? EMPLOYEE_ORDER.filter((r) => projection.byRole[r].history.length > 0) : []),
    [projection]
  );
  const rosterActive = useMemo(() => ORDER.flatMap<{ roleId: RoleId; row: RosterRow | null; status: 'running' | 'blocked' }>((roleId) => {
    const row = roster.find((candidate) => candidate.roleId === roleId) ?? null;
    if (roleId === 'desk') {
      if (!deskOccupied) return [];
      return [{ roleId, row, status: deskConflict ? 'blocked' as const : 'running' as const }];
    }
    const role = roleId as EmployeeRole;
    if ((projection?.byRole[role].active.length ?? 0) > 0) return [];
    if (row?.status !== 'running' && row?.status !== 'blocked') return [];
    return [{ roleId, row, status: row.status }];
  }), [deskConflict, deskOccupied, projection, roster]);
  const hasCurrentTasks = sections.length > 0 || rosterActive.length > 0;
  void tick;

  const openRoleModal = (roleId: RoleId) => {
    if (document.activeElement instanceof HTMLElement) focusReturn.current = document.activeElement;
    const roleKey: EmployeeRole | null = roleId === 'desk' ? null : (roleId as EmployeeRole);
    const ordered = roleKey ? sortInstancesForDisplay(projection?.byRole[roleKey]?.active ?? []) : [];
    setModalRole(roleId);
    setModalJobId(ordered[0]?.jobId ?? null);
  };

  const closeModal = () => {
    // 仅清 UI 状态；运行中任务继续执行，订阅由详情弹窗卸载清理。
    setModalRole(null);
    setModalJobId(null);
  };

  const openAvatarCrop = (roleId: RoleId) => {
    cropReturn.current = { role: roleId, jobId: modalJobId };
    setCropRole(roleId);
    setModalRole(null);
    setModalJobId(null);
  };

  const closeAvatarCrop = () => {
    setCropRole(null);
    const pending = cropReturn.current;
    cropReturn.current = null;
    if (pending) {
      setModalRole(pending.role);
      setModalJobId(pending.jobId);
    }
  };

  const cancel = async (instance: CrewInstance) => {
    setBusy(true);
    setMessage('');
    try {
      const job = await window.wmb.jobsCancel(instance.jobId);
      if (job) {
        setMessage(`已取消 ${job.id.slice(0, 8)}…（${statusWord(job.status)}）`);
      } else if (instance.taskId) {
        const task = await window.wmb.cancelAgentTask(instance.taskId);
        if (!task.ok) throw new Error(task.error?.message ?? '取消任务失败');
        setMessage(`已取消任务 ${instance.taskId.slice(0, 8)}…`);
      } else {
        throw new Error('工单已不在运行池，且没有可取消的任务引用。');
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const cancelTask = async (taskId: string) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await window.wmb.cancelAgentTask(taskId);
      if (!result.ok) throw new Error(result.error?.message ?? '取消任务失败');
      setMessage(`已取消任务 ${taskId.slice(0, 8)}…`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const redispatch = async (instance: CrewInstance) => {
    setBusy(true);
    setMessage('');
    try {
      const job = await window.wmb.jobsSpawn(redispatchInput(instance));
      setMessage(`已续派 ${job.id.slice(0, 8)}… → ${roleLabel(job.roleId)}（${statusWord(job.status)}）`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const copyJobId = async (jobId: string) => {
    try {
      await navigator.clipboard.writeText(jobId);
      setMessage(`已复制任务编号 ${jobId}`);
    } catch {
      setMessage(`任务编号 ${jobId}`);
    }
  };

  return (
    <section className="agents-roster" aria-label="智能体班组">
      <section className="agents-overview" aria-label="班组概览">
        <div className="agents-overview-head">
          <span className="agents-overview-note">点击卡片查看运行明细</span>
          {onOpenSettings ? (
            <button type="button" className="agents-config-entry" onClick={() => onOpenSettings()}>角色与能力配置</button>
          ) : null}
        </div>
        <div className="agents-overview-grid">
          {projection === null ? (
            <p className="agents-overview-loading" role="status">正在读取班组状态…</p>
          ) : ORDER.map((roleId) => (
            <RoleOverviewRow
              key={roleId}
              roleId={roleId}
              row={roster.find((r) => r.roleId === roleId) ?? null}
              deskOccupied={deskOccupied}
              deskConflict={deskConflict}
              projection={projection}
              avatarByRole={avatarByRole}
              expanded={modalRole === roleId}
              onOpenRole={openRoleModal}
            />
          ))}
        </div>
      </section>

      {message ? <p className="agents-jobs-msg" role="status">{message}</p> : null}

      {stale ? (
        <div className="agents-stale-banner" role="status">
          连接中断 · 数据停止更新
          <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
            重试
          </button>
        </div>
      ) : null}

      {deskConflict ? (
        <div className="agents-callout danger seat-conflict" role="alert">
          主管受阻，或员工任务正被资源占用 — 到主管对话查看原因后可继续派工
        </div>
      ) : null}

      {projection === null && !stale ? (
        <div className="agents-loading" role="status">正在读取班组状态…</div>
      ) : (
        <div className="agents-main">
          <section className="agents-work-ledger" aria-label="进行中的任务与历史任务">
            <section className="agents-active" aria-label="进行中的任务">
              <h2 className="agents-zone-title">进行中的任务</h2>
              {rosterActive.map((item) => (
                <ActiveRosterTask
                  key={`roster-${item.roleId}`}
                  roleId={item.roleId}
                  row={item.row}
                  status={item.status}
                  onOpenRole={openRoleModal}
                  onCancelTask={cancelTask}
                  busy={busy}
                />
              ))}
              {sections.map((s) => (
                <ActiveRoleInstances
                  key={s.roleId}
                  section={s}
                  busy={busy}
                  onCopyJobId={copyJobId}
                  onRedispatch={redispatch}
                  onCancel={cancel}
                />
              ))}
              {!hasCurrentTasks ? <p className="agents-filter-empty" role="status">当前无进行中的任务</p> : null}
            </section>
            {historyRoles.length > 0 ? <section className="agents-history-area" aria-label="历史任务">
              <h2 className="agents-zone-title">历史任务</h2>
              {historyRoles.map((roleId) => (
                <RoleHistoryList
                  key={roleId}
                  roleId={roleId}
                  history={projection?.byRole[roleId].history ?? []}
                  busy={busy}
                  onCopyJobId={copyJobId}
                  onRedispatch={redispatch}
                />
              ))}
            </section> : null}
          </section>
        </div>
      )}

      {modalRole !== null && projection ? (
        <AgentsDetailModal
          roleId={modalRole}
          projection={projection}
          selectedJobId={modalJobId}
          deskRow={deskRow}
          roleRow={modalRole === 'desk' ? null : roster.find((r) => r.roleId === modalRole) ?? null}
          deskOccupied={deskOccupied}
          deskConflict={deskConflict}
          avatarUrl={avatarByRole[modalRole]}
          onSelectJobId={setModalJobId}
          onClose={closeModal}
          onCopyJobId={copyJobId}
          onPickAvatar={openAvatarCrop}
          returnFocusRef={focusReturn}
        />
      ) : null}

      {cropRole ? (
        <AgentAvatarCropDialog
          roleId={cropRole}
          roleLabel={cropRole === 'desk' ? (deskRow?.labelZh ?? ROLE_CATALOG.desk.labelZh) : ROLE_CATALOG[cropRole].labelZh}
          initialImage={avatarByRole[cropRole]}
          onClose={closeAvatarCrop}
          onSaved={(url) => {
            setAvatarByRole((prev) => ({ ...prev, [cropRole]: url }));
          }}
        />
      ) : null}
    </section>
  );
}
