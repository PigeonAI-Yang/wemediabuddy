import { randomUUID } from 'node:crypto';

export function newObjectFields(): { id: string; created_at: string; updated_at: string; revision: number } {
  const now = new Date().toISOString();
  return { id: randomUUID(), created_at: now, updated_at: now, revision: 1 };
}
