import { useEffect, useMemo, useState, type JSX } from 'react';

type Cap = {
  id: string;
  displayName: string;
  description: string;
  defaultRoleBindings: Record<string, boolean | undefined>;
};

type Role = { roleId: string; labelZh: string; roomZh: string; skills?: readonly string[] };
type Overlay = { roleId: string; capabilityId: string; enabled: boolean };

const EMPLOYEE_ROLE_IDS = ['reporter', 'planner', 'writer', 'librarian'] as const;
const WORKER_OPTIONS = [5, 6, 7] as const;

export function AgentsSettingsPanel(): JSX.Element {
  const [roles, setRoles] = useState<Role[]>([]);
  const [caps, setCaps] = useState<Cap[]>([]);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [maxWorkers, setMaxWorkers] = useState(5);
  const [poolRunning, setPoolRunning] = useState(0);
  const [poolQueued, setPoolQueued] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const reload = async () => {
    const [summary, rows, pool] = await Promise.all([
      window.wmb.getAgentsCapabilitySummary(),
      window.wmb.listAgentsOverlays(),
      window.wmb.jobsPoolStatus()
    ]);
    setRoles(summary.roles);
    setCaps(summary.capabilities);
    setOverlays(rows);
    setMaxWorkers(Math.max(5, Number(pool?.maxWorkers) || 5));
    setPoolRunning(Number(pool?.running) || 0);
    setPoolQueued(Number(pool?.queued) || 0);
  };

  useEffect(() => {
    void reload().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const employeeRoles = useMemo(
    () => EMPLOYEE_ROLE_IDS
      .map((roleId) => roles.find((role) => role.roleId === roleId))
      .filter((role): role is Role => Boolean(role)),
    [roles]
  );

  const enabledFor = (roleId: string, capId: string, defaultOn: boolean) => {
    const hit = overlays.find((row) => row.roleId === roleId && row.capabilityId === capId);
    return hit ? hit.enabled : defaultOn;
  };

  const toggle = async (roleId: string, capabilityId: string, enabled: boolean) => {
    const key = `${roleId}:${capabilityId}`;
    setBusy(key);
    setMessage('');
    try {
      await window.wmb.setAgentsOverlay({ roleId, capabilityId, enabled });
      await reload();
      setMessage(enabled ? '已打开该能力。' : '已关闭该能力。关闭后这个角色不能再用它自动干活。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const changeMaxWorkers = async (value: number) => {
    setBusy('maxWorkers');
    setMessage('');
    try {
      const result = await window.wmb.jobsSetMaxWorkers(value);
      await reload();
      setMessage(`同时开工人数已设为 ${result.maxWorkers}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const capsForRole = (roleId: string) => caps.filter((cap) => Boolean(cap.defaultRoleBindings[roleId]));

  return (
    <section className="agents-settings" aria-label="角色与班组设置">
      <div className="agents-settings-controls">
        <label className="agents-settings-field">
          <span className="agents-settings-field-label">同时开工的员工数</span>
          <span className="agents-settings-field-help">工作中 {poolRunning} · 排队中 {poolQueued}</span>
          <select
            aria-label="同时开工的员工数"
            value={maxWorkers}
            disabled={busy === 'maxWorkers'}
            onChange={(event) => void changeMaxWorkers(Number(event.target.value))}
          >
            {WORKER_OPTIONS.map((n) => (
              <option key={n} value={n}>{n} 人</option>
            ))}
          </select>
        </label>

        <div className="agents-settings-field agents-settings-field-static">
          <span className="agents-settings-field-label">主管（右侧 Pi）</span>
          <span className="agents-settings-field-help">主管/主编负责全站任务与内部审批，不占员工名额</span>
          <strong className="agents-settings-static-value">固定 1 个</strong>
        </div>
      </div>

      {message ? <p className="agents-settings-msg" role="status">{message}</p> : null}

      <div className="agents-settings-role-grid">
        {employeeRoles.map((role) => {
          const roleCaps = capsForRole(role.roleId);
          return (
            <article className="agents-settings-card agents-settings-role" key={role.roleId}>
              <div className="agents-settings-card-head">
                <div>
                  <h3>{role.labelZh}<small>{role.roomZh}</small></h3>
                </div>
              </div>
              {roleCaps.length ? (
                <ul className="agents-settings-cap-list">
                  {roleCaps.map((cap) => {
                    const on = enabledFor(role.roleId, cap.id, true);
                    const key = `${role.roleId}:${cap.id}`;
                    return (
                      <li key={cap.id}>
                        <div className="agents-settings-cap-copy">
                          <strong>{cap.displayName}</strong>
                          <span>{cap.description || cap.id}</span>
                        </div>
                        <label className={`agents-cap-toggle${on ? '' : ' off'}`}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={busy === key}
                            onChange={(event) => void toggle(role.roleId, cap.id, event.target.checked)}
                          />
                          <span>{on ? '开' : '关'}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="agents-settings-empty">该角色暂无可配置的能力。</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
