import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Operation = {
  actorType: 'ui' | 'mcp' | 'scheduler'; clientLabel?: string; command: string; entityType: string; entityId?: string;
  beforeRevision?: number; afterRevision?: number; result: 'ok' | 'error'; errorCode?: string;
};

export function recordOperation(database: DatabaseSync, operation: Operation): void {
  const values = [randomUUID(), operation.actorType, operation.clientLabel ?? null, operation.command, operation.entityType, operation.entityId ?? null,
    operation.beforeRevision ?? null, operation.afterRevision ?? null, operation.result, operation.errorCode ?? null, new Date().toISOString()]
    .map(sqlValue).join(', ');
  database.exec(`INSERT INTO operation_log (id, actor_type, client_label, command, entity_type, entity_id, before_revision, after_revision, result, error_code, created_at) VALUES (${values})`);
}

function sqlValue(value: string | number | null): string {
  if (value === null) return 'NULL';
  return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}
