import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';

const executablePath = process.argv[2] ?? 'J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe';
const databasePath = process.argv[3] ?? 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const artifactDir = 'J:/PigeonYang/WeMediaBuddy/tests/e2e/.artifacts/wmb-5362-packaged-real';
fs.mkdirSync(artifactDir, { recursive: true });

const db = new DatabaseSync(databasePath, { readOnly: true });
const expected = db.prepare(`SELECT pi.id AS planItemId,pi.title,pi.planning_status AS planningStatus,pi.score_reasons_json AS scoreReasonsJson
  FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE p.is_current=1 AND p.plan_date='2026-08-28'
    AND pi.title LIKE 'GLM-5.3 Flash 免费 100T%' ORDER BY pi.created_at DESC LIMIT 1`).get();
assert.ok(expected, 'real current proposal missing');
assert.equal(expected.planningStatus, 'ready_for_review');
db.close();

const pageErrors = [];
const consoleErrors = [];
console.log('launching', executablePath);
const app = await _electron.launch({ executablePath, cwd: path.dirname(executablePath), timeout: 120_000 });
try {
  console.log('waiting:firstWindow');
  const page = await app.firstWindow({ timeout: 90_000 });
  console.log('window', page.url());
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 });
  console.log('shell:visible');
  const proposalNav = page.locator('aside.sidebar button').filter({ hasText: '选题' }).first();
  await proposalNav.click();
  console.log('nav:clicked');
  await page.getByRole('heading', { name: '选题台账' }).waitFor({ state: 'visible', timeout: 30_000 });
  console.log('ledger:visible');
  const detail = page.locator(`[data-testid="proposal-detail"][data-plan-item-id="${expected.planItemId}"]`);
  if (await detail.count() === 0) {
    const row = page.locator(`[data-plan-item-id="${expected.planItemId}"]`).first();
    const viewButton = row.getByRole('button', { name: /查看详情/ });
    if (await viewButton.count()) await viewButton.click();
  }
  await detail.waitFor({ state: 'visible', timeout: 30_000 });
  console.log('detail:visible');
  const text = await detail.innerText();
  for (const required of [
    expected.title, '为什么现在', '目标读者', '表达角度', '核心观点', '内容结构', '已有材料', '缺失材料',
    '来源证据', '六维评分', 'Ox Alpha', 'GLM-5.3-Flash', 'reader_immediacy_benefit',
    'COMPUTE_PROVIDER_UNVERIFIED', '国产算力集群', 'ready_for_review', 'r1'
  ]) assert.ok(text.includes(required), `proposal detail missing: ${required}`);
  assert.ok(await page.getByRole('button', { name: '设置 Pi 焦点' }).count(), 'Pi focus action missing');
  assert.ok(await page.getByRole('button', { name: /收起详情|查看详情/ }).count(), 'detail action missing');
  const screenshotPath = path.join(artifactDir, 'proposal-detail-real.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.waitForTimeout(500);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  const result = { ok: true, executablePath: app.process().spawnfile, pid: app.process().pid, databasePath,
    planItemId: expected.planItemId, planningStatus: expected.planningStatus, score: JSON.parse(expected.scoreReasonsJson).score,
    detailText: text, screenshotPath, pageErrors, consoleErrors };
  fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  console.log('closing');
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (!app.process().killed) app.process().kill();
}
