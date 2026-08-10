import { useEffect, useMemo, useState, type JSX } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';
import { AgentAvatarCropDialog } from './agent-avatar-crop';
import { resolveDeskConflict } from './agents-roster-conflict';
import {
  EMPLOYEE_ORDER,
  activeRoleSections,
  headerCounts,
  redispatchInput,
  statusWord,
  type CrewInstance,
  type CrewProjection,
  type StatusFilter
} from './agents-instance-logic';
import { ActiveRoleInstances, RoleHistoryList } from './agents-roster-instances';
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
    maxWorkers: 2,
    deskSnapshot: null
  });
  const [spawnRole, setSpawnRole] = useState<Exclude<RoleId, 'desk'>>('reporter');
  const [spawnBrief, setSpawnBrief] = useState('执行一次例行检查并回报');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const [avatarByRole, setAvatarByRole] = useState<Partial<Record<RoleId, string>>>({});
  const [cropRole, setCropRole] = useState<RoleId | null>(null);

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
            maxWorkers: Number(status.maxWorkers) || 2,
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

  const counts = headerCounts(projection?.summary ?? null);
  const totalActive = projection?.summary?.active ?? 0;
  const sections = useMemo(() => (projection ? activeRoleSections(projection, filter) : []), [projection, filter]);
  const historyRoles = useMemo(
    () => (projection ? EMPLOYEE_ORDER.filter((r) => projection.byRole[r].history.length > 0) : []),
    [projection]
  );
  void tick;

  const scrollToRole = (roleId: string) => {
    const target = document.querySelector<HTMLElement>(`.agents-active [data-role="${roleId}"]`);
    if (!target) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };

  const spawn = async () => {
    setBusy(true);
    setMessage('');
    try {
      const job = await window.wmb.jobsSpawn({ roleId: spawnRole, brief: spawnBrief });
      setMessage(`已派单 ${job.id.slice(0, 8)}… → ${roleLabel(job.roleId)}（${statusWord(job.status)}）`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (jobId: string) => {
    setBusy(true);
    setMessage('');
    try {
      const job = await window.wmb.jobsCancel(jobId);
      setMessage(job ? `已取消 ${job.id.slice(0, 8)}…（${statusWord(job.status)}）` : `已处理 ${jobId}`);
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
      setMessage(`已复制 jobId ${jobId}`);
    } catch {
      setMessage(`jobId ${jobId}`);
    }
  };

  return (
    <section className="agents-roster" aria-label="智能体班组">
      <section className="agents-overview" aria-label="班组概览">
        <h1 className="agents-overview-title">班组概览</h1>
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
              filter={filter}
              avatarByRole={avatarByRole}
              onJump={scrollToRole}
              onPickAvatar={setCropRole}
            />
          ))}
        </div>
      </section>

      <section className="agents-team-card">
        <header className="agents-control-strip">
          <p className="agents-summary-line" role="group" aria-label="按实例状态筛选">
            <button type="button" className={filter === 'running' ? 'active' : ''} aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>工作中 {counts.running}</button>
            <span className="agents-summary-sep">·</span>
            <button type="button" className={filter === 'queued' ? 'active' : ''} aria-pressed={filter === 'queued'} onClick={() => setFilter('queued')}>排队 {counts.queued}</button>
            <span className="agents-summary-sep">·</span>
            <button type="button" className={filter === 'needs_user' ? 'active' : ''} aria-pressed={filter === 'needs_user'} onClick={() => setFilter('needs_user')}>等你批 {counts.needsUser}</button>
            {filter !== 'all' ? <button type="button" className="agents-summary-reset" onClick={() => setFilter('all')}>显示全部 {totalActive}</button> : null}
            <span className="agents-capacity">容量 {pool.maxWorkers}</span>
          </p>
          {onOpenSettings ? <button type="button" className="secondary-button" onClick={() => onOpenSettings()}>角色与 Skill 配置</button> : null}
        </header>

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
            桌助受阻或员工工单正被资源占用 — 到桌助对话查看原因后可继续派工
          </div>
        ) : null}

        <div className="agents-spawn-bar">
          <label>
            角色
            <select value={spawnRole} onChange={(e) => setSpawnRole(e.target.value as Exclude<RoleId, 'desk'>)} disabled={busy}>
              {EMPLOYEE_ORDER.map((r) => (
                <option key={r} value={r}>{ROLE_CATALOG[r].labelZh}</option>
              ))}
            </select>
          </label>
          <label className="agents-spawn-brief">
            简报
            <input value={spawnBrief} onChange={(e) => setSpawnBrief(e.target.value)} disabled={busy} />
          </label>
          <button type="button" className="primary-button" disabled={busy || !spawnBrief.trim()} onClick={() => void spawn()}>
            派单
          </button>
          {message ? <p className="agents-jobs-msg" role="status">{message}</p> : null}
        </div>
      </section>

      {projection === null && !stale ? (
        <div className="agents-loading" role="status">正在读取班组状态…</div>
      ) : (
        <div className="agents-main">
          <section className="agents-work-ledger" aria-label="活动实例与历史工单">
            <section className="agents-active" aria-label="活动实例">
              <h2 className="agents-zone-title">活动实例</h2>
              {sections.length > 0 ? sections.map((s) => (
                <ActiveRoleInstances
                  key={s.roleId}
                  section={s}
                  busy={busy}
                  onCopyJobId={copyJobId}
                  onRedispatch={redispatch}
                  onCancel={cancel}
                />
              )) : <p className="agents-filter-empty" role="status">{filter === 'all' ? '当前无活动实例' : '当前筛选无匹配实例'}</p>}
            </section>
            {historyRoles.length > 0 ? <section className="agents-history-area" aria-label="历史工单">
              <h2 className="agents-zone-title">历史工单</h2>
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

      {cropRole ? (
        <AgentAvatarCropDialog
          roleId={cropRole}
          roleLabel={cropRole === 'desk' ? (deskRow?.labelZh ?? '桌助') : ROLE_CATALOG[cropRole].labelZh}
          onClose={() => setCropRole(null)}
          onSaved={(url) => {
            setAvatarByRole((prev) => ({ ...prev, [cropRole]: url }));
          }}
        />
      ) : null}
    </section>
  );
}
