import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { ZHIHU_HOT_URL } = await import('../src/main/zhihu-hot-channel.ts');
const { readIntelligenceChannelsSummary, recordSourceScanReceipt } = await import('../src/main/intelligence-channels.ts');

function withTempDir(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmb-readiness-'));
  try { return work(dir); } finally { try{fs.rmSync(dir,{recursive:true,force:true});}catch{} }
}
function migrateFresh(dir){
  const db = migrateDatabase(path.join(dir,'wmb.db'));
  return {db, dir};
}

test('zhihu_hot readiness: configured source with successful 2/2 scan is runnable even when browser not ready', () => withTempDir((dir)=>{
  const {db} = migrateFresh(dir);
  try{
    db.prepare("INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES ('workspace_id','ws-readiness','2026-08-22T00:00:00Z','2026-08-22T00:00:00Z',1)").run();
    db.prepare("INSERT OR IGNORE INTO source_feeds (id, registry_id, name, url, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)").run('feed-zhihu','zhihu_hot','知乎 AI 专题', ZHIHU_HOT_URL, new Date().toISOString(), new Date().toISOString());
    const feedId = db.prepare("SELECT id FROM source_feeds WHERE registry_id='zhihu_hot'").get().id;
    const before = readIntelligenceChannelsSummary(db, false);
    const zhBefore = before.readiness.find(r=>r.module==='zhihu_hot');
    assert.ok(zhBefore);
    assert.equal(zhBefore.enabledCount, 1);
    assert.equal(zhBefore.readyCount, 0, 'before receipt, 0 runnable when browser not ready');
    assert.equal(zhBefore.blockedCount, 1);
    assert.equal(zhBefore.status, 'needs_user');
    recordSourceScanReceipt(db, { taskId:'task-readiness-1', workspaceId:'ws-readiness', module:'zhihu_hot', sourceId:'zhihu_hot', sourceFeedId:feedId, status:'succeeded', candidateCount:2, savedCount:2, checkedAt: new Date().toISOString() });
    const after = readIntelligenceChannelsSummary(db, false);
    const zhAfter = after.readiness.find(r=>r.module==='zhihu_hot');
    assert.ok(zhAfter);
    assert.equal(zhAfter.enabledCount, 1);
    assert.equal(zhAfter.readyCount, 1, 'after succeeded receipt, 1 runnable even without browser');
    assert.equal(zhAfter.blockedCount, 0);
    assert.equal(zhAfter.status, 'ready');
    const src = after.sources.find(s=>s.module==='zhihu_hot');
    assert.equal(src.status, 'ready');
    // failed receipt should make blocked
    recordSourceScanReceipt(db, { taskId:'task-readiness-2', workspaceId:'ws-readiness', module:'zhihu_hot', sourceId:'zhihu_hot', sourceFeedId:feedId, status:'failed', errorCode:'ZHIHU_HOT_DOM_DRIFT', errorMessage:'drift', candidateCount:0, savedCount:0, checkedAt: new Date(Date.now()+1000).toISOString() });
    const failed = readIntelligenceChannelsSummary(db, false);
    const zhFailed = failed.readiness.find(r=>r.module==='zhihu_hot');
    assert.equal(zhFailed.readyCount, 0);
    assert.equal(zhFailed.blockedCount, 1);
    // recovered succeeded again
    recordSourceScanReceipt(db, { taskId:'task-readiness-3', workspaceId:'ws-readiness', module:'zhihu_hot', sourceId:'zhihu_hot', sourceFeedId:feedId, status:'succeeded', candidateCount:2, savedCount:2, checkedAt: new Date(Date.now()+2000).toISOString() });
    const recovered = readIntelligenceChannelsSummary(db, false);
    assert.equal(recovered.readiness.find(r=>r.module==='zhihu_hot').readyCount, 1);
  } finally { db.close(); }
}));
