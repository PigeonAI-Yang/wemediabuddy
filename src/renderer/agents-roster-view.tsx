import { useEffect, useMemo, useState, type JSX } from 'react';
import { ROLE_CATALOG, type RoleId } from '../shared/agent-capabilities';
import { AgentAvatarCropDialog } from './agent-avatar-crop';

const ORDER: RoleId[] = ['desk', 'reporter', 'planner', 'writer', 'librarian'];
const EMPLOYEE_ORDER: Exclude<RoleId, 'desk'>[] = ['reporter', 'planner', 'writer', 'librarian'];

export type AgentRosterRow = {
  roleId: RoleId;
  labelZh?: string;
  roomZh?: string;
  status: 'idle' | 'running' | 'blocked' | 'unknown';
  summary: string;
  taskId?: string | null;
  intent?: string | null;
  phase?: string | null;
  progressLabel?: string | null;
  progressRatio?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
  writeCommandCount?: number;
};

type JobRow = {
  id: string;
  roleId: string;
  intent: string | null;
  brief: string;
  status: string;
  error: string | null;
  waitReason?: string | null;
  report?: {
    code?: string | null;
    message?: string | null;
    readback?: unknown;
    taskId?: string | null;
  } | null;
  planDate: string | null;
  projectId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  handle?: { taskId: string | null; leaseId: string | null; grantId: string | null; sessionFile: string | null } | null;
};

type TypeFilter = 'all' | 'scan' | 'job';

function fallbackRows(): AgentRosterRow[] {
  return ORDER.map((roleId) => ({
    roleId,
    status: 'unknown' as const,
    summary: '待命（等待运行时投影）',
    taskId: null,
    progressLabel: null
  }));
}

function roleLabel(roleId: string): string {
  if (roleId in ROLE_CATALOG) return ROLE_CATALOG[roleId as RoleId].labelZh;
  return roleId;
}

function isScanJob(job: JobRow): boolean {
  const intent = job.intent || '';
  return intent.startsWith('daily_') || intent === 'daily_intelligence' || job.roleId === 'desk';
}

/** 后台 daily_scan/judge 等角色任务镜像到工单板（只读投影，不是 JobPool 实体）。 */
function rosterTaskAsBoardJob(row: AgentRosterRow): JobRow | null {
  if (!row.taskId || row.roleId === 'desk') return null;
  if (row.status !== 'running' && row.status !== 'blocked') return null;
  const intent = row.intent || null;
  const brief = row.summary || row.progressLabel || '后台任务执行中';
  const startedAt = row.createdAt || row.updatedAt || new Date().toISOString();
  return {
    id: `task:${row.taskId}`,
    roleId: row.roleId,
    intent,
    brief,
    status: row.status === 'blocked' ? 'blocked' : 'running',
    error: row.status === 'blocked' ? (row.summary || null) : null,
    planDate: null,
    projectId: null,
    queuedAt: startedAt,
    startedAt,
    finishedAt: row.finishedAt || null,
    handle: { taskId: row.taskId, leaseId: null, grantId: null, sessionFile: null }
  };
}

function elapsedLabel(startedAt: string | null, finishedAt?: string | null): string {
  if (!startedAt) return '—';
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

function clock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '—';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (sameDay) return time;
  const day = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  return `${day} ${time}`;
}

function stampLine(label: string, iso: string | null): string {
  return `${label} ${clock(iso)}`;
}

function readbackLabel(readback: unknown): string | null {
  if (!readback || typeof readback !== 'object') return null;
  const rb = readback as {
    kind?: string;
    phase?: string;
    revision?: number;
    versionId?: string;
    count?: number;
    scope?: string;
    planDate?: string;
    projectId?: string;
  };
  switch (rb.kind) {
    case 'plans_revision': return `读回 方案 r${rb.revision ?? '?'} · ${rb.planDate ?? ''}`;
    case 'content_version': return `读回 正文版本 ${rb.versionId ?? '?'}`;
    case 'sources_mutated': return `读回 资料变更 ${rb.count ?? 0}`;
    case 'scan_phase_reached': return `读回 扫描至 ${rb.phase ?? '?'}`;
    case 'noop_confirmed': return `读回 no-op · ${rb.scope ?? 'workspace'}`;
    default: return rb.kind ? `读回 ${rb.kind}` : null;
  }
}

function statusWord(status: string): string {
  if (status === 'running') return '执行中';
  if (status === 'blocked') return '受阻';
  if (status === 'waiting_resource') return '等资源';
  if (status === 'queued') return '排队中';
  if (status === 'failed') return '失败';
  if (status === 'succeeded') return '完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'partial') return '部分完成';
  if (status === 'needs_user') return '需主管';
  if (status === 'idle') return '待命';
  return '未知';
}

function StatusDot({ status }: { status: string }): JSX.Element {
  return <span className={`agents-status-dot status-${status}`} aria-hidden="true" />;
}

export function AgentsRosterView({
  onOpenSettings
}: {
  onOpenSettings?: () => void;
}): JSX.Element {
  const [rows, setRows] = useState<AgentRosterRow[]>(fallbackRows);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [pool, setPool] = useState<{
    running: number;
    queued: number;
    waitingResource: number;
    maxWorkers: number;
    deskSnapshot: { leaseId?: string; taskId?: string | null; roleId?: string | null } | null;
    employeeSnapshots: Array<{ leaseId?: string; taskId?: string | null; roleId?: string | null }>;
  }>({ running: 0, queued: 0, waitingResource: 0, maxWorkers: 2, deskSnapshot: null, employeeSnapshots: [] });
  const [spawnRole, setSpawnRole] = useState<Exclude<RoleId, 'desk'>>('reporter');
  const [spawnBrief, setSpawnBrief] = useState('执行一次例行检查并回报');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const [avatarByRole, setAvatarByRole] = useState<Partial<Record<RoleId, string>>>({});
  const [cropRole, setCropRole] = useState<RoleId | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      void Promise.all([
        window.wmb.getAgentsRoster?.({}).catch(() => null),
        window.wmb.jobsList?.().catch(() => null),
        window.wmb.jobsPoolStatus?.().catch(() => null),
        window.wmb.listAgentAvatars?.().catch(() => null)
      ]).then(([roster, list, status, avatars]) => {
        if (!active) return;
        if (roster?.length) setRows(roster as AgentRosterRow[]);
        if (Array.isArray(list)) setJobs(list as JobRow[]);
        if (status) {
          setPool({
            running: Number(status.running) || 0,
            queued: Number(status.queued) || 0,
            waitingResource: Number(status.waitingResource) || 0,
            maxWorkers: Number(status.maxWorkers) || 2,
            deskSnapshot: (status.deskSnapshot as typeof pool.deskSnapshot) ?? null,
            employeeSnapshots: Array.isArray(status.employeeSnapshots)
              ? (status.employeeSnapshots as typeof pool.employeeSnapshots)
              : []
          });
        }
        if (Array.isArray(avatars)) {
          const next: Partial<Record<RoleId, string>> = {};
          for (const row of avatars as Array<{ roleId: RoleId; url: string }>) {
            if (row?.roleId && row?.url) next[row.roleId] = row.url;
          }
          setAvatarByRole(next);
        }
        setStale(false);
      }).catch(() => {
        if (active) setStale(true);
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

  const byId = useMemo(() => new Map(rows.map((row) => [row.roleId, row])), [rows]);

  // 工单板 = JobPool 派单 + 角色卡上的后台扫描/判断任务（文案承诺的「扫描类也会出现」）。
  const boardJobs = useMemo(() => {
    const mirrored = rows
      .map(rosterTaskAsBoardJob)
      .filter((j): j is JobRow => Boolean(j));
    // 同一 taskId 若已有真实工单则不再镜像（running 时取自 handle，终态 handle 清空后取自 report）
    const jobTaskIds = new Set(
      jobs
        .flatMap((j) => [j.handle?.taskId, j.report?.taskId])
        .filter((id): id is string => Boolean(id))
    );
    const extra = mirrored.filter((j) => {
      const tid = j.handle?.taskId;
      return !tid || !jobTaskIds.has(tid);
    });
    return [...jobs, ...extra];
  }, [jobs, rows]);

  const filteredJobs = useMemo(() => {
    if (typeFilter === 'all') return boardJobs;
    return boardJobs.filter((j) => (typeFilter === 'scan' ? isScanJob(j) : !isScanJob(j)));
  }, [boardJobs, typeFilter]);

  const runningJobs = filteredJobs.filter((j) => j.status === 'running' || j.status === 'blocked');
  const queuedJobs = filteredJobs.filter((j) => j.status === 'queued' || j.status === 'waiting_resource');
  const terminalJobs = filteredJobs
    .filter((j) => j.status !== 'queued' && j.status !== 'waiting_resource' && j.status !== 'running' && j.status !== 'blocked')
    .slice(-8)
    .reverse();

  const deskRow = byId.get('desk');
  const deskOccupied = Boolean(pool.deskSnapshot?.leaseId) || ((deskRow?.status === 'running' || deskRow?.status === 'blocked') && deskRow?.roleId === 'desk' && deskRow?.intent !== 'daily_judge' && deskRow?.intent !== 'daily_scan');
  const deskConflict = deskOccupied && (deskRow?.status === 'blocked' || pool.running > 0);

  // 顶部席位必须与左侧角色卡同源：工单 + 后台 daily_scan/judge 角色行 + employee lease。
  const runningByRole = useMemo(() => {
    const map = new Map<string, number>();
    const bump = (roleId: string | null | undefined, n = 1) => {
      if (!roleId || roleId === 'desk') return;
      map.set(roleId, (map.get(roleId) || 0) + n);
    };
    for (const job of jobs) {
      if (job.status === 'running') bump(job.roleId);
    }
    for (const row of rows) {
      if (row.roleId === 'desk') continue;
      if (row.status === 'running' || row.status === 'blocked') {
        // 角色卡已 running 时席位至少显示 1（后台扫描/判断无 JobPool 工单也会占角色）
        if ((map.get(row.roleId) || 0) < 1) bump(row.roleId, 1);
      }
    }
    for (const snap of pool.employeeSnapshots || []) {
      if (snap.roleId && (map.get(snap.roleId) || 0) < 1) bump(snap.roleId, 1);
    }
    return map;
  }, [jobs, rows, pool.employeeSnapshots]);

  // tick keeps elapsed labels fresh
  void tick;

  const deskSeatLabel = !deskOccupied
    ? '空闲'
    : deskRow?.status === 'blocked'
      ? '受阻'
      : pool.deskSnapshot?.taskId
        ? '被任务占用'
        : '占用中';

  const employeeActive = EMPLOYEE_ORDER.reduce((sum, roleId) => sum + ((runningByRole.get(roleId) || 0) > 0 ? 1 : 0), 0);
  const headerSummary = `主编席编排 · 主管 ${deskOccupied ? '占用' : '空闲'} · 角色执行 ${employeeActive} · 工单槽 ${pool.running}/${pool.maxWorkers} · 排队 ${pool.queued} · 等资源 ${pool.waitingResource}`;

  const spawn = async () => {
    setBusy(true);
    setMessage('');
    try {
      const job = await window.wmb.jobsSpawn({ roleId: spawnRole, brief: spawnBrief });
      setMessage(`已派单 ${job.id.slice(0, 8)}… → ${roleLabel(job.roleId)}（${statusWord(job.status)}）`);
      const list = await window.wmb.jobsList();
      setJobs(list as JobRow[]);
      const status = await window.wmb.jobsPoolStatus();
      if (status) {
        setPool((prev) => ({
          ...prev,
          running: Number(status.running) || 0,
          queued: Number(status.queued) || 0,
          waitingResource: Number(status.waitingResource) || 0,
          maxWorkers: Number(status.maxWorkers) || prev.maxWorkers
        }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (jobId: string) => {
    setBusy(true);
    try {
      await window.wmb.jobsCancel(jobId);
      const list = await window.wmb.jobsList();
      setJobs(list as JobRow[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const renderJobCard = (job: JobRow, lane: 'running' | 'queued') => {
    const scan = isScanJob(job);
    const bg = job.id.startsWith('task:');
    return (
      <li key={job.id} className={`agents-job-row status-${job.status} lane-${lane} ${scan ? 'type-scan' : 'type-job'}`}>
        <div className="agents-term-main">
          <span className="agents-term-mark" aria-hidden="true">
            {lane === 'queued' ? '·' : <StatusDot status={job.status === 'blocked' ? 'blocked' : 'running'} />}
          </span>
          <strong>{roleLabel(job.roleId)}</strong>
          <span className={`agents-job-status-word status-${job.status}`}>{statusWord(job.status)}</span>
          <span className="muted agents-term-brief" title={job.brief}>{job.brief}</span>
          {!bg && (lane !== 'queued' || job.status === 'waiting_resource') ? (
            <button type="button" className="agents-row-action" disabled={busy} onClick={() => void cancel(job.id)}>
              取消
            </button>
          ) : null}
          {bg ? <span className="agents-row-tag">后台</span> : null}
          {scan && !bg ? <span className="agents-row-tag">扫描</span> : null}
        </div>
        <div className="agents-term-stamps">
          {lane === 'running' ? (
            <>
              <span className="agents-job-stamp">{stampLine('入队', job.queuedAt)}</span>
              <span className="agents-job-stamp">{stampLine('开始', job.startedAt)}</span>
              <span className="agents-job-stamp">已跑 {elapsedLabel(job.startedAt)}</span>
            </>
          ) : (
            <>
              <span className="agents-job-stamp">{stampLine('入队', job.queuedAt)}</span>
              <span className="agents-job-stamp">已等 {elapsedLabel(job.queuedAt)}</span>
            </>
          )}
          {job.intent ? <span className="agents-job-intent">{job.intent}</span> : null}
          {job.waitReason ? <span className="agents-job-intent">{job.waitReason}</span> : null}
          {job.error ? <span className="agents-job-error">{job.error}</span> : null}
        </div>
      </li>
    );
  };

  return (
    <section className="agents-roster" aria-label="智能体班组">
      <section className="agents-team-card" aria-label="智能体班组与派单">
      <section className="page-command" aria-label="智能体班组概览">
        <div className="page-command-main">
          <div className="page-command-copy">
            <div className="page-command-title-row">
              <h1>智能体班组</h1>
              <p>{headerSummary}</p>
            </div>
          </div>
          {onOpenSettings ? (
            <div className="page-command-actions">
              <button type="button" className="secondary-button" onClick={() => onOpenSettings()}>
                角色与 Skill 配置
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {stale ? (
        <div className="agents-stale-banner" role="status">
          连接中断 · 数据停止更新
          <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
            重试
          </button>
        </div>
      ) : null}

      <div className="agents-seat-strip" aria-label="主管席占用">
        <article className={`agents-seat-cell desk ${deskOccupied ? 'occupied' : 'free'} ${deskConflict ? 'conflict' : ''}`} data-seat="desk">
          <div className="agents-seat-top">
            <button
              type="button"
              className="agents-seat-avatar"
              title="设置桌助头像"
              onClick={() => setCropRole('desk')}
            >
              {avatarByRole.desk ? (
                <img src={avatarByRole.desk} alt="" />
              ) : (
                <span>{ROLE_CATALOG.desk.labelZh.slice(0, 1)}</span>
              )}
            </button>
            <div className="agents-seat-copy">
              <header>
                <strong>主管</strong>
                <span className="agents-room">主编席</span>
              </header>
              <p className="agents-seat-state">
                <StatusDot status={deskOccupied ? (deskConflict ? 'blocked' : 'running') : 'idle'} />
                {deskSeatLabel}
              </p>
            </div>
          </div>
          <div className="agents-seat-bars">
            <div className="agents-bar-row" title="当前任务完成进度">
              <span className="agents-bar-label">进度</span>
              <div
                className={`agents-work-progress ${deskOccupied ? 'active' : ''}`}
                style={{ ['--progress' as string]: deskOccupied ? (deskRow?.progressRatio ?? 0.45) : 0 }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={deskOccupied ? Math.round((deskRow?.progressRatio ?? 0.45) * 100) : 0}
              >
                <i />
              </div>
            </div>
            <div className="agents-bar-row" title="主编席槽位是否被占用（仅 1 格）">
              <span className="agents-bar-label">槽位</span>
              <div className="agents-seat-meter" style={{ ['--seat-slots' as string]: 1 }} aria-hidden="true">
                <i className={deskOccupied ? 'on' : undefined} />
              </div>
            </div>
          </div>
          {pool.deskSnapshot?.taskId ? (
            <p className="agents-seat-meta">任务 {pool.deskSnapshot.taskId.slice(0, 8)}…</p>
          ) : (
            <p className="agents-seat-meta">{deskOccupied ? '主 Pi 占用' : '空闲 — 主 Pi 可对话'}</p>
          )}
        </article>
        {EMPLOYEE_ORDER.map((roleId) => {
          const n = runningByRole.get(roleId) || 0;
          const meta = ROLE_CATALOG[roleId];
          return (
            <article key={roleId} className={`agents-seat-cell employee ${n > 0 ? 'occupied' : 'free'}`} data-seat={roleId}>
              <div className="agents-seat-top">
                <button
                  type="button"
                  className="agents-seat-avatar"
                  title={`设置${meta.labelZh}头像`}
                  onClick={() => setCropRole(roleId)}
                >
                  {avatarByRole[roleId] ? (
                    <img src={avatarByRole[roleId]} alt="" />
                  ) : (
                    <span>{meta.labelZh.slice(0, 1)}</span>
                  )}
                </button>
                <div className="agents-seat-copy">
                  <header>
                    <strong>{meta.labelZh}</strong>
                    <span className="agents-room">{meta.roomZh}</span>
                  </header>
                  <p className="agents-seat-state">
                    <StatusDot status={n > 0 ? 'running' : 'idle'} />
                    {n > 0 ? `执行中 ${n}` : '待命'}
                  </p>
                </div>
              </div>
              <div className="agents-seat-bars">
                <div className="agents-bar-row" title={n > 0 ? (byId.get(roleId)?.progressLabel || '任务进度') : '无进行中任务'}>
                  <span className="agents-bar-label">进度</span>
                  <div
                    className={`agents-work-progress ${n > 0 ? 'active' : ''}`}
                    style={{
                      ['--progress' as string]: n > 0 ? (byId.get(roleId)?.progressRatio ?? 0.35) : 0
                    }}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={n > 0 ? Math.round((byId.get(roleId)?.progressRatio ?? 0.35) * 100) : 0}
                  >
                    <i />
                  </div>
                </div>
                <div
                  className="agents-bar-row"
                  title={`共享员工槽占用 ${Math.min(n, pool.maxWorkers)}/${pool.maxWorkers}`}
                >
                  <span className="agents-bar-label">槽位</span>
                  <div
                    className="agents-seat-meter"
                    style={{ ['--seat-slots' as string]: Math.max(pool.maxWorkers, 1) }}
                    aria-hidden="true"
                  >
                    {Array.from({ length: Math.max(pool.maxWorkers, 1) }, (_, i) => (
                      <i key={i} className={i < Math.min(n, pool.maxWorkers) ? 'on' : undefined} />
                    ))}
                  </div>
                </div>
              </div>
              <p className="agents-seat-meta">
                {n > 0
                  ? (byId.get(roleId)?.progressLabel || byId.get(roleId)?.intent || `执行中 ${n}`)
                  : `共享员工槽 ${pool.running}/${pool.maxWorkers}`}
              </p>
            </article>
          );
        })}
      </div>

      {deskConflict ? (
        <div className="agents-callout danger seat-conflict" role="alert">
          主管席冲突：主 Pi 被占用或受阻，员工槽仍可并行派单
          {deskRow?.summary ? ` — ${deskRow.summary}` : ''}
        </div>
      ) : null}

      <div className="agents-spawn-bar">
        <label>
          角色
          <select value={spawnRole} onChange={(e) => setSpawnRole(e.target.value as Exclude<RoleId, 'desk'>)} disabled={busy}>
            <option value="reporter">记者</option>
            <option value="planner">策划</option>
            <option value="writer">写手</option>
            <option value="librarian">资料员</option>
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

      <div className="agents-workspace">
        <section className="agents-job-board" aria-label="工单板">
          <header className="agents-board-head">
            <h3>工单板</h3>
            <div className="agents-type-filter" role="group" aria-label="类型过滤">
              {([
                ['all', '全部'],
                ['scan', '扫描'],
                ['job', '工单']
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={typeFilter === id ? 'active' : ''}
                  onClick={() => setTypeFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="agents-slot-pill">
              槽位 {pool.running}/{pool.maxWorkers}
            </span>
          </header>

          {runningJobs.length + queuedJobs.length + terminalJobs.length === 0 ? (
            <div className="agents-board-empty">
              <p>暂无执行中任务</p>
              <ol>
                <li>今日页自动扫/判会以「扫描」卡片出现在此</li>
                <li>或上方选角色写简报后点「派单」</li>
              </ol>
              <p className="muted">扫描类后台任务与员工工单都会出现在此板；主管（主 Pi）对话不占员工槽。</p>
            </div>
          ) : (
            <div className="agents-lanes">
              <div className="agents-lane">
                <h4>
                  执行中 <span className="agents-lane-count">{runningJobs.length}</span>
                </h4>
                {runningJobs.length === 0 ? (
                  <p className="agents-lane-empty">执行中为空 — 排队中的工单会自动上岗</p>
                ) : (
                  <ul className="agents-job-list compact">{runningJobs.map((j) => renderJobCard(j, 'running'))}</ul>
                )}
              </div>
              <div className="agents-lane">
                <h4>
                  排队中 <span className="agents-lane-count">{queuedJobs.filter((j) => j.status === 'queued').length}</span>
                  {queuedJobs.some((j) => j.status === 'waiting_resource') ? (
                    <span className="agents-lane-count"> · 等资源 {queuedJobs.filter((j) => j.status === 'waiting_resource').length}</span>
                  ) : null}
                </h4>
                {queuedJobs.length === 0 ? (
                  <p className="agents-lane-empty">排队中为空</p>
                ) : (
                  <ul className="agents-job-list compact">{queuedJobs.map((j) => renderJobCard(j, 'queued'))}</ul>
                )}
              </div>
              <div className="agents-lane">
                <h4>
                  终态 <span className="agents-lane-count">{terminalJobs.length}</span>
                </h4>
                {terminalJobs.length === 0 ? (
                  <p className="agents-lane-empty">终态暂无记录</p>
                ) : (
                  <ul className="agents-job-list compact">
                    {terminalJobs.map((job) => (
                      <li key={job.id} className={`agents-job-row status-${job.status}`}>
                        <div className="agents-term-main">
                          <span className="agents-term-mark" aria-hidden="true">
                            {job.status === 'succeeded' ? '✓' : job.status === 'failed' || job.status === 'cancelled' ? '✕' : job.status === 'partial' ? '◐' : '·'}
                          </span>
                          <strong>{roleLabel(job.roleId)}</strong>
                          <span className={`agents-job-status-word status-${job.status}`}>{statusWord(job.status)}</span>
                          <span className="muted agents-term-brief">{job.brief}</span>
                        </div>
                        <div className="agents-term-stamps">
                          <span className="agents-job-stamp">{stampLine('开始', job.startedAt)}</span>
                          <span className="agents-job-stamp">{stampLine('结束', job.finishedAt)}</span>
                          <span className="agents-job-stamp">耗时 {elapsedLabel(job.startedAt, job.finishedAt)}</span>
                          {job.report?.code ? <span className="agents-job-intent">{job.report.code}</span> : null}
                          {readbackLabel(job.report?.readback) ? <span className="agents-job-intent">{readbackLabel(job.report?.readback)}</span> : null}
                          {job.error || job.report?.message ? <span className="agents-job-error">{job.error || job.report?.message}</span> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
      {cropRole ? (
        <AgentAvatarCropDialog
          roleId={cropRole}
          roleLabel={ROLE_CATALOG[cropRole].labelZh}
          onClose={() => setCropRole(null)}
          onSaved={(url) => {
            setAvatarByRole((prev) => ({ ...prev, [cropRole]: url }));
          }}
        />
      ) : null}
    </section>
  );
}
