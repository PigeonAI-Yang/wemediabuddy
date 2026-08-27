import { DatabaseSync } from 'node:sqlite';

const databasePath = process.argv[2] ?? 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const ids = ['c0ee77c3-173d-4ad3-83e9-cfa15ddfffb7', '8844ca91-8b38-4c6f-ac9c-09537d20fb3e'];
const db = new DatabaseSync(databasePath, { readOnly: true });
const all = (sql, ...args) => db.prepare(sql).all(...args);
const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
try {
  console.log(JSON.stringify({
    sources: all('SELECT id,title,canonical_url,summary,verification_status,management_status,revision,collected_at FROM source_items WHERE id IN (?,?)', ...ids),
    links: all('SELECT * FROM topic_source_links WHERE source_id IN (?,?)', ...ids),
    jobs: all("SELECT id,kind,status,dedupe_key,payload_json,last_error,created_at,finished_at FROM jobs WHERE kind IN ('knowledge_route','knowledge_reactivate_sources','knowledge_compile') AND (payload_json LIKE ? OR payload_json LIKE ?) ORDER BY created_at DESC LIMIT 30", `%${ids[0]}%`, `%${ids[1]}%`),
    entities: all("SELECT id,canonical_key,canonical_name,aliases_json,external_identity_json,revision FROM knowledge_entities WHERE lower(canonical_name) LIKE '%ox alpha%' OR lower(canonical_name) LIKE '%glm-5.3%' OR lower(aliases_json) LIKE '%ox alpha%' OR lower(aliases_json) LIKE '%glm-5.3%' LIMIT 20"),
    receipts: all('SELECT id,request_id,summary,impact_json,created_at FROM knowledge_update_receipts WHERE impact_json LIKE ? OR impact_json LIKE ? ORDER BY created_at DESC LIMIT 20', `%${ids[0]}%`, `%${ids[1]}%`),
    decisions: hasTable('plan_source_decisions') ? all('SELECT * FROM plan_source_decisions WHERE source_id IN (?,?) ORDER BY created_at DESC', ...ids) : null
  }, null, 2));
} finally { db.close(); }
