import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('usage: node validate_scan_output.mjs <scan.json>');
const scan = JSON.parse(readFileSync(path, 'utf8'));
const sourceIds = new Set((scan.sources ?? []).map((source) => source.id));
const opportunities = scan.opportunities ?? [];

if (!sourceIds.size) throw new Error('scan needs at least one source');
if (!opportunities.length) throw new Error('scan needs at least one qualifying opportunity');
for (const [index, item] of opportunities.entries()) {
  if (!item.title || !item.why_now || !item.angle || !item.source_ids?.length) throw new Error('opportunity missing useful content');
  if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 7) throw new Error('opportunity priority must be an integer from 0 to 7');
  if (index > 0 && opportunities[index - 1].priority > item.priority) throw new Error('opportunities must be ordered SSS to F');
  for (const id of item.source_ids) if (!sourceIds.has(id)) throw new Error(`missing source ${id}`);
}

console.log(`scan-output OK: ${sourceIds.size} sources, ${opportunities.length} opportunities`);
