import type { DatabaseSync } from 'node:sqlite';
import {
  AGENT_CAPABILITIES,
  isRoleId,
  listCapabilitiesForRole,
  roleWriteCommands,
  type AgentCapabilityId,
  type RoleId
} from '../shared/agent-capabilities.ts';

export type CapabilityOverlayRow = {
  workspaceId: string;
  roleId: RoleId;
  capabilityId: AgentCapabilityId;
  enabled: boolean;
  updatedAt: string;
};

export function ensureCapabilityOverlaysTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS capability_overlays (
      workspace_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, role_id, capability_id)
    );
  `);
}

export function listCapabilityOverlays(database: DatabaseSync, workspaceId: string): CapabilityOverlayRow[] {
  // Read-only: table is created by migrations / setCapabilityOverlay under write-guard auth.
  // Never CREATE TABLE here — IPC list path is not write-authorized.
  let rows: Array<{
    workspaceId: string; roleId: string; capabilityId: string; enabled: number; updatedAt: string;
  }> = [];
  try {
    rows = database.prepare(`SELECT workspace_id AS workspaceId, role_id AS roleId, capability_id AS capabilityId,
      enabled, updated_at AS updatedAt FROM capability_overlays WHERE workspace_id = ?`).all(workspaceId) as Array<{
      workspaceId: string; roleId: string; capabilityId: string; enabled: number; updatedAt: string;
    }>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return [];
    throw error;
  }
  return rows
    .filter((row) => isRoleId(row.roleId))
    .map((row) => ({
      workspaceId: row.workspaceId,
      roleId: row.roleId as RoleId,
      capabilityId: row.capabilityId as AgentCapabilityId,
      enabled: row.enabled === 1,
      updatedAt: row.updatedAt
    }));
}

export function setCapabilityOverlay(
  database: DatabaseSync,
  input: { workspaceId: string; roleId: RoleId; capabilityId: AgentCapabilityId; enabled: boolean }
): CapabilityOverlayRow {
  const cap = AGENT_CAPABILITIES.find((item) => item.id === input.capabilityId);
  if (!cap || !cap.agentGrantable) {
    throw Object.assign(new Error('红线能力不可覆盖。'), { code: 'CAPABILITY_NOT_GRANTABLE' });
  }
  if (cap.pageScopePassThrough) {
    throw Object.assign(new Error('桌助透传能力不可覆盖。'), { code: 'CAPABILITY_NOT_OVERRIDABLE' });
  }
  ensureCapabilityOverlaysTable(database);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO capability_overlays(workspace_id, role_id, capability_id, enabled, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(workspace_id, role_id, capability_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(input.workspaceId, input.roleId, input.capabilityId, input.enabled ? 1 : 0, now);
  return { ...input, updatedAt: now };
}

/** Standing write commands after applying workspace overlays. */
export function roleWriteCommandsWithOverlays(database: DatabaseSync, workspaceId: string, roleId: RoleId): string[] {
  if (roleId === 'desk') return [];
  const overlays = listCapabilityOverlays(database, workspaceId);
  const disabled = new Set(
    overlays.filter((row) => row.roleId === roleId && !row.enabled).map((row) => row.capabilityId)
  );
  const set = new Set<string>();
  for (const cap of listCapabilitiesForRole(roleId)) {
    if (disabled.has(cap.id)) continue;
    for (const command of cap.commands) set.add(command);
  }
  // If no overlays, same as default standing set.
  if (!overlays.some((row) => row.roleId === roleId)) return [...roleWriteCommands(roleId)];
  return [...set].sort();
}
