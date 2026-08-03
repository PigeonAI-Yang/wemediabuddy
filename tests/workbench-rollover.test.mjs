import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { upsertSource } from '../src/main/sources.ts';
import { getToday } from '../src/main/workbench.ts';

test('date rollover keeps exact plan empty and exposes the latest dated plan separately', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wmb-workbench-rollover-'));
  const database = migrateDatabase(path.join(directory, 'wmb.db'));
  try {
    const source = upsertSource(database, { title: 'Yesterday source', originalUrl: 'https://example.com/yesterday' });
    database.prepare('UPDATE source_items SET collected_at=? WHERE id=?').run('2026-08-03T01:00:00.000Z', source.id);
    saveCurrentPlan(database, { planDate: '2026-08-03', timezone: 'Asia/Shanghai', summary: 'Yesterday plan', items: [{
      title: 'Still useful', priority: 1, whyNow: 'Current', timeliness: 'This week', targetAudience: 'Creators',
      angle: 'Explain', pointOfView: 'Evidence first', platforms: ['x'], formats: ['text'], titleGuidance: 'Title',
      openingGuidance: 'Opening', structureGuidance: 'Structure', effortEstimate: '30m', sourceIds: [source.id]
    }] });

    const today = getToday(database, '2026-08-04');
    assert.equal(today.plan, null, 'exact-date plan must stay empty for task validation');
    assert.equal(today.sourcesDate, '2026-08-03');
    assert.equal(today.latestPlan?.planDate, '2026-08-03');
    assert.equal(today.latestPlan?.items[0]?.title, 'Still useful');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
