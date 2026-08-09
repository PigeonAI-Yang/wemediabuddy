import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const section = process.argv[3] ?? 'all';
if (section === 'all' || section === 'tables') {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  console.log('TABLES:', tables.join(','));
}
if (section === 'all' || section === 'fixtures') {
  console.log('--- plans ---');
  console.log(JSON.stringify(db.prepare('SELECT id,plan_date,summary,is_current,revision FROM plans').all(), null, 1));
  console.log('--- workspace_profiles ---');
  console.log(JSON.stringify(db.prepare('SELECT id,profile_id,official_template_id,intelligence_pack_id,creation_pack_id,platforms_json FROM workspace_profiles').all(), null, 1));
  console.log('--- content_projects ---');
  console.log(JSON.stringify(db.prepare('SELECT id,title,status FROM content_projects LIMIT 10').all(), null, 1));
  console.log('--- content_versions ---');
  console.log(JSON.stringify(db.prepare('SELECT id,project_id,version_status FROM content_versions LIMIT 10').all(), null, 1));
}
if (section === 'all' || section === 'sources') {
  const st = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%source%' OR name LIKE '%channel%' OR name LIKE '%binding%' OR name LIKE '%receipt%' OR name LIKE '%website%' OR name LIKE '%x_list%') ORDER BY name").all().map(r => r.name);
  console.log('SOURCE TABLES:', st.join(','));
  for (const t of st) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).join(',');
      const rows = db.prepare(`SELECT * FROM ${t} LIMIT 8`).all();
      console.log(`--- ${t} (${cols}) ---`);
      console.log(JSON.stringify(rows, null, 1).slice(0, 3000));
    } catch (e) { console.log(t, 'ERR', String(e)); }
  }
}
if (section === 'all' || section === 'tasks') {
  console.log('--- agent_tasks ---');
  console.log(JSON.stringify(db.prepare('SELECT id,intent,business_date,status,phase,control_action,created_at FROM agent_tasks ORDER BY created_at DESC LIMIT 20').all(), null, 1));
}
if (section === 'all' || section === 'grants') {
  console.log('--- task_grants ---');
  try { console.log(JSON.stringify(db.prepare('SELECT id,task_id,status,revoked_at FROM task_grants ORDER BY issued_at DESC LIMIT 20').all(), null, 1)); } catch (e) { console.log('ERR', String(e)); }
}
db.close();
