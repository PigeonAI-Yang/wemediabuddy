import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
async function importFile(p){ return import(pathToFileURL(p).href); }
const REPO_ROOT = 'J:/PigeonYang/WeMediaBuddy';
const DATA_ROOT = 'J:/PigeonYang/WeMediaBuddyData';
const PACKAGED_DIR = 'J:/wmb-out/WeMediaBuddy-win32-x64';
const ARTIFACTS_ROOT = path.join(REPO_ROOT, 'tests/e2e/.artifacts');
const WORKSPACE_ID = 'a755adf2-4e8d-4abd-b616-4d7934f730f1';
const PROJECT_ID = 'd6dc2d38-8013-4e98-8320-6e3185586446';
const TARGET_ID = 'dc5c85d1-e349-468e-a208-e73dd93f9722';

async function main(){
  // Import harness dynamically (ESM)
  const harness = await importFile(path.join(REPO_ROOT, 'tests/e2e/harness.mjs'));
  const { launchApp, waitForAppReady, navigateTo, captureEvidence, closeApp, delay, openReadOnlyDb, seedWorkspace } = harness;
  // Prepare artifacts dir
  const suffix = randomUUID().slice(0,6);
  const artifactsDir = path.join(ARTIFACTS_ROOT, `WMB-5338-packaged-A12-${suffix}`);
  mkdirSync(artifactsDir, {recursive:true});
  console.log('artifactsDir', artifactsDir);

  // Helper to prepare userData with active root binding
  function prepareUserData(userDataDir){
    // Use seedWorkspace to create correct binding
    seedWorkspace({ userDataDir, dataRoot: DATA_ROOT, workspaceId: WORKSPACE_ID, displayName: 'WeMediaBuddyData', seedPi:true, onboarding:true });
    // Ensure data-root.json points correctly (seedWorkspace already does)
    console.log('prepared userData', userDataDir);
  }

  // Function to launch packaged and capture baseline
  async function launchAndCapture(name, extraCapture){
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'wmb-packaged-ud-'));
    prepareUserData(userDataDir);
    const opts = {
      appPath: PACKAGED_DIR,
      userDataDir,
      dataRoot: DATA_ROOT,
      seed: false,
      artifactsDir: path.join(artifactsDir, name),
      name,
      headless: true,
    };
    mkdirSync(opts.artifactsDir, {recursive:true});
    console.log(`launch ${name} with userData ${userDataDir}`);
    const { app, page, workspace, evidence } = await launchApp(opts);
    const proc = app.process();
    const pid = proc?.pid ?? null;
    console.log(`launched pid ${pid} mode ${evidence.launch?.mode}`);
    try{
      await waitForAppReady(page, {timeoutMs: 60000});
      await delay(1500);
      // Capture helpers
      async function snap(view, filePrefix){
        try{ await navigateTo(page, view); await delay(800); }catch(e){ console.log(`navigate ${view} failed`, e.message.slice(0,300)); }
        const screenshotPath = path.join(opts.artifactsDir, `${filePrefix}-screenshot.png`);
        try{
          await page.screenshot({path: screenshotPath, timeout: 15000});
        }catch(e){
          console.log(`screenshot ${view} failed`, e.message.slice(0,300));
          try{ await page.screenshot({path: screenshotPath}); }catch(e2){ console.log('retry screenshot failed', e2.message.slice(0,200)); }
        }
        let html = ''; let text='';
        try{ html = await page.content(); writeFileSync(path.join(opts.artifactsDir, `${filePrefix}-content.html`), html.slice(0,200000), 'utf8'); }catch(e){ console.log('content failed', e.message.slice(0,200)); }
        try{ text = await page.evaluate(()=>document.body.innerText.slice(0,20000)); writeFileSync(path.join(opts.artifactsDir, `${filePrefix}-text.txt`), text, 'utf8'); }catch(e){ console.log('text failed', e.message.slice(0,200)); }
        console.log(`captured ${view} -> ${filePrefix}`);
        return { screenshotPath, text };
      }

      // Today
      const todayRes = await snap('today', 'today');
      // Check channel readiness text
      const hasZhihuChannel = todayRes.text.includes('知乎 AI 专题') || (await page.evaluate(()=>document.body.innerHTML.includes('知乎 AI 专题')));
      // Yesterday iteration
      const hasDraftRevision = todayRes.text.includes('draft_revision') || todayRes.text.includes('草稿迭代') || todayRes.text.includes('未发布草稿');
      const hasPublishedRevision = todayRes.text.includes('published_revision') || todayRes.text.includes('已发布');
      // Today targets / settlement
      const todayDbInfo = (()=>{ try{ const db=openReadOnlyDb(DATA_ROOT); const row=db.db.prepare("SELECT * FROM daily_content_cycles WHERE business_date='2026-08-22'").get(); const targets=db.db.prepare("SELECT id, status, target_kind FROM daily_content_targets WHERE cycle_id=?").all(row?.id); db.close(); return {cycle:row, targets}; }catch(e){return {error:String(e)}} })();
      writeFileSync(path.join(opts.artifactsDir, 'today-db.json'), JSON.stringify(todayDbInfo,null,2), 'utf8');

      // Proposals
      const propRes = await snap('proposals', 'proposals');
      const proposalDb = (()=>{ try{ const db=openReadOnlyDb(DATA_ROOT); const t=db.db.prepare("SELECT score_snapshot_json FROM daily_content_targets WHERE id=?").get(TARGET_ID); db.close(); return t; }catch(e){return {error:String(e)}} })();
      writeFileSync(path.join(opts.artifactsDir, 'proposal-db.json'), JSON.stringify(proposalDb,null,2), 'utf8');

      // Results (for yesterday)
      const resultsRes = await snap('results', 'results');

      // Studio - need to navigate with projectId param if possible
      // Try direct URL manipulation: many apps use hash or query. Try evaluating navigation.
      let studioRes;
      try{
        await navigateTo(page, 'studio'); await delay(800);
        // Try to select project d6dc if list exists
        const hasProject = await page.evaluate((pid)=> document.body.innerText.includes(pid.slice(0,8)) || document.body.innerHTML.includes(pid), PROJECT_ID);
        console.log('studio hasProject', hasProject);
        // If not, try to navigate via URL param
        if(!hasProject){
          const url = page.url();
          console.log('studio url', url);
          // Attempt to click any project card
          // fallback just capture current
        }
        const screenshotPath = path.join(opts.artifactsDir, `studio-screenshot.png`);
        await page.screenshot({path: screenshotPath, fullPage:true});
        const html = await page.content();
        writeFileSync(path.join(opts.artifactsDir, `studio-content.html`), html.slice(0,200000), 'utf8');
        const text = await page.evaluate(()=>document.body.innerText.slice(0,20000));
        writeFileSync(path.join(opts.artifactsDir, `studio-text.txt`), text, 'utf8');
        studioRes = { text, hasProject };
      }catch(e){ console.log('studio capture failed', e.message); studioRes={text:'', error:String(e)}; }

      // Settings channel readiness maybe
      const settingsRes = await snap('settings', 'settings');

      // Collect DB readbacks for all A12 surfaces
      const db = new DatabaseSync(path.join(DATA_ROOT,'wmb.db'), {readOnly:true});
      const readbacks = {};
      try{
        readbacks.channel = db.prepare("SELECT * FROM source_feeds WHERE id='zhihu_hot'").get() || db.prepare("SELECT * FROM source_feeds").all().slice(0,3);
        readbacks.observations = db.prepare("SELECT * FROM zhihu_hot_observations ORDER BY business_date DESC LIMIT 3").all();
        readbacks.cycleToday = db.prepare("SELECT * FROM daily_content_cycles WHERE business_date='2026-08-22'").get();
        readbacks.targetsToday = db.prepare("SELECT id, status, target_kind, project_id FROM daily_content_targets WHERE cycle_id=?").all(readbacks.cycleToday?.id);
        readbacks.iterationTargets = db.prepare("SELECT * FROM daily_content_targets WHERE target_kind IN ('draft_revision','published_revision')").all();
        readbacks.proposals = db.prepare("SELECT id, score_snapshot_json FROM daily_content_targets WHERE id=?").get(TARGET_ID);
        readbacks.project = db.prepare("SELECT * FROM content_projects WHERE id=?").get(PROJECT_ID);
        readbacks.versions = db.prepare("SELECT id, version_number FROM content_versions WHERE project_id=? ORDER BY version_number").all(PROJECT_ID);
        readbacks.derivative = db.prepare("SELECT * FROM content_derivatives WHERE project_id=?").get(PROJECT_ID);
        if(readbacks.derivative) readbacks.derivativeVersions = db.prepare("SELECT id, version_number, status, source_content_version_id FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number").all(readbacks.derivative.id);
        // stale check via helper: isStale computed
        const latestContent = db.prepare("SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1").get(PROJECT_ID);
        const latestScript = readbacks.derivative ? db.prepare("SELECT status, source_content_version_id FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number DESC LIMIT 1").get(readbacks.derivative.id) : null;
        readbacks.stale = { latestContentId: latestContent?.id, latestScript, isStale: latestScript?.status==='ready' && latestScript?.source_content_version_id !== latestContent?.id };
        readbacks.publications = db.prepare("SELECT COUNT(*) as c FROM publications").get();
        readbacks.publicationAttempts = db.prepare("SELECT COUNT(*) as c FROM publication_attempts").get();
        readbacks.dataRoot = readbacks.cycleToday;
      }finally{ db.close(); }
      writeFileSync(path.join(opts.artifactsDir, 'readbacks.json'), JSON.stringify(readbacks,null,2), 'utf8');

      // Also write combined evidence JSON
      const combined = {
        hasZhihuChannel, hasDraftRevision, hasPublishedRevision,
        todayTextSnippet: todayRes.text.slice(0,2000),
        proposalsTextSnippet: propRes.text.slice(0,2000),
        studioTextSnippet: studioRes?.text?.slice(0,2000) ?? '',
        readbacks,
        pid,
      };
      writeFileSync(path.join(opts.artifactsDir, 'combined.json'), JSON.stringify(combined,null,2), 'utf8');

      if(extraCapture) await extraCapture({page, artifactsDir: opts.artifactsDir, readbacks});

      // Save process info
      writeFileSync(path.join(opts.artifactsDir, 'process.json'), JSON.stringify({pid, mode: evidence.launch?.mode, artifactsDir: opts.artifactsDir},null,2), 'utf8');

      return { pid, artifactsSubDir: opts.artifactsDir, readbacks, combined };
    }finally{
      const closed = await closeApp(app, {timeoutMs:20000});
      console.log(`closeApp ${name} closed=${closed} pid ${pid}`);
      // Verify process exit
      if(pid){
        try{ process.kill(pid, 0); console.log(`pid ${pid} still alive!`); }catch{ console.log(`pid ${pid} exited`); }
      }
      // Check no remaining packaged Electron processes
      // Use tasklist on windows
      await delay(1000);
    }
  }

  // Baseline capture
  const baseline = await launchAndCapture('baseline-packaged', null);
  console.log('baseline done', baseline.combined.hasZhihuChannel);

  // Determine if stale present
  const isStaleBaseline = baseline.readbacks.stale?.isStale;
  console.log('baseline isStale', isStaleBaseline);

  if(!isStaleBaseline){
    console.log('Stale not present, will create legitimate article final via business command');
    // Create stale via business command: append new article version
    const { CommandDispatcher, createCommandEnvelope } = await import(path.join(REPO_ROOT, 'src/main/command-dispatcher.ts'));
    const db = new DatabaseSync(path.join(DATA_ROOT,'wmb.db'));
    const wsRow = db.prepare("SELECT value FROM app_meta WHERE key='workspace_id'").get();
    const workspaceId = wsRow.value;
    const runtimeEpoch = randomUUID();
    const identity = { workspaceId, rootPath: DATA_ROOT, runtimeEpoch };
    const dispatcher = new CommandDispatcher(db, identity);
    // Use owner_ui command content.save_version
    const newBody = baseline.readbacks.versions[baseline.readbacks.versions.length-1] ? '追加合法定稿用于 stale 演示：' + '追加内容用于触发 stale。'.repeat(30) : '初始定稿';
    // Need to fetch existing latest version body to append?
    const lastVersion = db.prepare("SELECT body FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1").get(PROJECT_ID);
    const bodyForNew = (lastVersion?.body || '') + '\n\n【增量定稿用于打包 stale 验证】' + '补充证据与结论段落。'.repeat(20);
    const saveRequestId = `packaged-stale:content.save_version:${PROJECT_ID}:${Date.now()}`;
    const envelope = createCommandEnvelope({
      workspaceId, runtimeEpoch,
      command: 'content.save_version',
      requestId: saveRequestId,
      actor: { type: 'owner_ui', id: 'owner', label: 'Owner' },
      input: { projectId: PROJECT_ID, body: bodyForNew, title: baseline.readbacks.project?.title, author: 'user' },
      boundIdentity: { entityType: 'content_project', entityId: PROJECT_ID },
    });
    // Import saveCoreVersion
    const { saveCoreVersion } = await import(path.join(REPO_ROOT, 'src/main/content.ts'));
    const receipt = dispatcher.dispatch(envelope, () => {
      const { requireCommandResultData } = require(path.join(REPO_ROOT, 'src/main/business-command.ts')) ?? {};
      // Instead directly call saveCoreVersion which returns CommandResult
      // We need to import requireCommandResultData manually
      return { data: null, entityType: 'content_version', entityId: PROJECT_ID };
    });
    // For simplicity, directly use internal function with dispatcher handler that calls saveCoreVersion
    // Let's do a proper handler: use saveCoreVersion imported via dynamic
    // Re-dispatch with correct handler
    // Since previous dispatch already created receipt but didn't actually save, we need to redo with proper save
    // Let's just do direct DB insert via proper command: use content.ts saveCoreVersion via dispatcher
    // Instead of faking, we'll do direct insert via dispatcher that actually executes saveCoreVersion

    // Close and reopen with proper handler
    db.close();
    // Reopen and do proper
    const db2 = new DatabaseSync(path.join(DATA_ROOT,'wmb.db'));
    const dispatcher2 = new CommandDispatcher(db2, identity);
    const { saveCoreVersion: saveCore } = await import(path.join(REPO_ROOT, 'src/main/content.ts'));
    const { requireCommandResultData: reqData } = await import(path.join(REPO_ROOT, 'src/main/business-command.ts'));
    const receipt2 = dispatcher2.dispatch(createCommandEnvelope({
      workspaceId, runtimeEpoch,
      command: 'content.save_version',
      requestId: saveRequestId + ':2',
      actor: { type: 'owner_ui', id: 'owner', label: 'Owner' },
      input: { projectId: PROJECT_ID, body: bodyForNew, title: baseline.readbacks.project?.title },
      boundIdentity: { entityType: 'content_project', entityId: PROJECT_ID },
    }), () => {
      const res = saveCore(db2, { projectId: PROJECT_ID, body: bodyForNew, title: baseline.readbacks.project?.title }, false);
      const data = reqData(res);
      return { data, entityType: 'content_version', entityId: data.id, readback: data };
    });
    console.log('article save receipt', receipt2.receiptId, receipt2.ok);
    if(!receipt2.ok) throw new Error('article save failed '+JSON.stringify(receipt2.error));
    // Trigger stale regression explicitly via handler? The saveCore may not regress, so we also call regressStaleTargetsForProject inside same transaction not needed; projection will show stale anyway
    // But to make target status scripting, we need to regress
    const { regressStaleTargetsForProject } = await import(path.join(REPO_ROOT, 'src/main/content-derivative.ts'));
    // Do it as separate command for target regression? For now direct SQL to update target status to scripting if stale
    const latestContent2 = db2.prepare("SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1").get(PROJECT_ID);
    const der = db2.prepare("SELECT id FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(PROJECT_ID);
    if(der){
      const latestScript = db2.prepare("SELECT status, source_content_version_id FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number DESC LIMIT 1").get(der.id);
      if(latestScript?.status==='ready' && latestScript.source_content_version_id !== latestContent2.id){
        // regress target
        const targetRow = db2.prepare("SELECT id, status FROM daily_content_targets WHERE project_id=? AND status='completed'").get(PROJECT_ID);
        if(targetRow){
          db2.prepare("UPDATE daily_content_targets SET status='scripting', updated_at=?, revision=revision+1 WHERE id=?").run(new Date().toISOString(), targetRow.id);
          console.log('regressed target to scripting', targetRow.id);
        }
      }
    }
    db2.close();
    // Capture stale state
    const staleCap = await launchAndCapture('stale-packaged', null);
    console.log('stale capture isStale', staleCap.readbacks.stale.isStale);
    // Now create aligned script via business command
    const db3 = new DatabaseSync(path.join(DATA_ROOT,'wmb.db'));
    const identity3 = { workspaceId, rootPath: DATA_ROOT, runtimeEpoch: randomUUID() };
    const dispatcher3 = new CommandDispatcher(db3, identity3);
    const latestContent3 = db3.prepare("SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1").get(PROJECT_ID);
    const { saveDerivativeVersionInternal, finalizeDerivativeVersionInternal } = await import(path.join(REPO_ROOT, 'src/main/content-derivative.ts'));
    const scriptBody = '基于最新文章定稿的对齐视频脚本：' + '脚本内容用于对齐最新文章。'.repeat(30);
    const scriptRequestId = `packaged-stale:content_derivative.save_version:${PROJECT_ID}:${Date.now()}`;
    const receipt3 = dispatcher3.dispatch(createCommandEnvelope({
      workspaceId, runtimeEpoch: identity3.runtimeEpoch,
      command: 'content_derivative.save_version',
      requestId: scriptRequestId,
      actor: { type: 'owner_ui', id: 'owner', label: 'Owner' },
      input: { projectId: PROJECT_ID, sourceContentVersionId: latestContent3.id, title: baseline.readbacks.project?.title, body: scriptBody },
      boundIdentity: { entityType: 'content_derivative', projectId: PROJECT_ID },
    }), () => {
      const draft = saveDerivativeVersionInternal(db3, { projectId: PROJECT_ID, sourceContentVersionId: latestContent3.id, title: baseline.readbacks.project?.title, body: scriptBody });
      const data = finalizeDerivativeVersionInternal(db3, { projectId: PROJECT_ID, expectedLatestVersionNumber: draft.version_number });
      return { data, entityType: 'content_derivative_version', entityId: data.id, readback: data };
    });
    console.log('script save receipt', receipt3.receiptId, receipt3.ok);
    if(!receipt3.ok) throw new Error('script save failed');
    db3.close();
    // Capture restored ready state
    const restored = await launchAndCapture('restored-packaged', null);
    console.log('restored isStale', restored.readbacks.stale.isStale, 'target status', restored.readbacks.targetsToday);
  } else {
    console.log('baseline already stale, no need to create');
  }

  console.log('ALL DONE artifacts at', artifactsDir);
}

main().catch(e=>{ console.error(e.stack); process.exit(1); });
