
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Use node:sqlite available in Node 22+
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('j:/PigeonYang/WeMediaBuddyData/wmb.db', { readOnly: true });
// Inline the SQL from content.ts to verify join
const rows = db.prepare().all();
console.log(rows);
