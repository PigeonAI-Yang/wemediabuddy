import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('usage: node validate_scan_output.mjs <scan.json>');
const scan = JSON.parse(readFileSync(path, 'utf8'));
const sourceIds = new Set((scan.sources ?? []).map((source) => source.id));
const opportunities = scan.opportunities ?? [];

if (!sourceIds.size) throw new Error('scan needs at least one source');
if (opportunities.length > 3) throw new Error('scan allows at most 3 opportunities');
for (const item of opportunities) {
  if (!item.title || !item.why_now || !item.angle || !item.source_ids?.length) throw new Error('opportunity missing useful content');
  for (const id of item.source_ids) if (!sourceIds.has(id)) throw new Error(`missing source ${id}`);
}

console.log(`scan-output OK: ${sourceIds.size} sources, ${opportunities.length} opportunities`);
