// WMB-5290 创作项目「调查」工作面真实 Electron E2E（INV-001 / INV-002）。
//
// Contract: default export = scenario array; each item { id, journeyIds, launch?, run }.
// 调查工作面为创作项目内第三表面（与 core/sources 并列），无一级导航：
// - 表面切换：.studio-surface-tab[data-surface="core"|"investigation"|"sources"]
// - 容器：section.studio-investigation；状态行 .investigation-status[data-status=…]
//   + 状态药丸 .investigation-status-pill.investigation-status-data
// - 每状态唯一 violet 主动作：.investigation-primary-action[data-action=…]
//   （initialize | save-outline | approve-outline | reject-outline | retry-reporter |
//    accept-research | supplement-research | expand-research | stop-research |
//    save-direction | approve-direction | supplement-direction | stop-direction |
//    start-writer | back-to-writing）
// - 编辑面：.investigation-editor（提纲 textarea id=out-<fieldKey>；方向 id=dir-<fieldKey>）
// - 空态 .investigation-empty（主动作 initialize）；加载 .investigation-loading；
//   失败 .investigation-error（重试按钮）
//
// INV-001：UI 初始化 → 编辑提纲 → 保存 → Owner 第一次批准（记者工单引用落库）→
// 记者运行失败则显式补派 → 重载持久化（提纲版本不可变）→ 1100×800 无横向溢出 → page error 0。
// 记者结果经真实运行失败路径（Pi 配置指向本地不可达端点，工单快速失败），
// 验收「记者失败如实落 failed 并可显式补派」的真实界面语义。
//
// INV-002：预置已批准提纲 + 终态资料包（生产函数 seed，research_review）→ UI 验收 →
// 方向编辑/保存 → 第二次 Owner 批准（approve-direction）→ 显式写手启动门
// （ready_to_write 前无 start-writer；批准后唯一主动作）→ 重载持久化 → 1100×800 → page error 0。

import { seedWorkflowBase, openWriteDb, seedStudioProject } from './seed-workflow.mjs';
import { seedSource, writeLocalPiConfig } from './lib/seed.mjs';
import { buildResearchEvidencePack } from '../../src/main/research-task-state.ts';
import { initializeProjectInvestigation, readProjectInvestigation, reviewInvestigationResearch, saveInvestigationOutline, decideInvestigationOutline, recordInvestigationReporterTerminal, startInvestigationWriter, recordInvestigationWriterTerminal } from '../../src/main/project-investigation.ts';

const OUTLINE_FIXTURE = Object.freeze({
  scope: 'E2E 调查：平台机制与创作者成本',
  exclusions: ['发布环节', '历史沿革'],
  known: ['已知：机制存在'],
  hypotheses: ['假设：成本上升'],
  questions: ['E2E 调查问题一：机制由谁主导？', 'E2E 调查问题二：成本结构如何？'],
  dimensions: ['背景', '机制', '成本'],
  materialRequirements: ['一手文件', '原始数据'],
  truthRisks: ['口径歧义', '数据可能过时'],
  disconfirmingConditions: ['发现反向证据即收窄'],
  completionCriteria: ['两个问题均有来源支撑']
});

/** 种子：真实项目 + 两个资料库来源。 */
async function seedBase({ dataRoot, userDataDir, workspaceId }) {
  await seedWorkflowBase(dataRoot, workspaceId);
  writeLocalPiConfig(userDataDir);
}

/** 种子：真实项目 + 两个资料库来源。 */
async function seedProjectWithSources({ dataRoot, userDataDir, workspaceId }) {
  await seedBase({ dataRoot, userDataDir, workspaceId });
  const db = openWriteDb(dataRoot);
  try {
    const source1 = seedSource(db, { id: 'inv-src-1', title: 'E2E 调查来源一', summary: '来源一摘要', author: '@wmb_inv1', originalUrl: 'https://example.com/inv-1' });
    const source2 = seedSource(db, { id: 'inv-src-2', title: 'E2E 调查来源二', summary: '来源二摘要', author: '@wmb_inv2', originalUrl: 'https://example.com/inv-2' });
    seedStudioProject(db, { title: 'E2E 调查项目', sourceIds: [source1, source2] });
  } finally {
    db.close();
  }
}

/** 种子：项目调查已批准提纲并落终态资料包（research_review），来源经生产终态管线关联。 */
async function seedResearchReviewProject({ dataRoot, userDataDir, workspaceId }) {
  await seedBase({ dataRoot, userDataDir, workspaceId });
  const db = openWriteDb(dataRoot);
  try {
    seedSource(db, { id: 'inv-src-1', title: 'E2E 调查来源一', summary: '来源一摘要', author: '@wmb_inv1', originalUrl: 'https://example.com/inv-1' });
    seedSource(db, { id: 'inv-src-2', title: 'E2E 调查来源二', summary: '来源二摘要', author: '@wmb_inv2', originalUrl: 'https://example.com/inv-2' });
    const seeded = seedStudioProject(db, { title: 'E2E 调查项目（验收中）', sourceIds: [] });
    const projectId = seeded.projectId;
    const jobId = `job-e2e-rep-${projectId.slice(0, 8)}`;
    const currentRevision = () => readProjectInvestigation(db, projectId).revision;
    let result = initializeProjectInvestigation(db, projectId);
    if (!result.ok) throw new Error(`seed 初始化失败: ${JSON.stringify(result)}`);
    result = saveInvestigationOutline(db, { projectId, expectedRevision: currentRevision(), outline: OUTLINE_FIXTURE });
    if (!result.ok) throw new Error(`seed 保存提纲失败: ${JSON.stringify(result)}`);
    result = decideInvestigationOutline(db, { projectId, expectedRevision: currentRevision(), decision: 'approve', reporterJobId: jobId });
    if (!result.ok) throw new Error(`seed 批准提纲失败: ${JSON.stringify(result)}`);
    const pack = buildResearchEvidencePack({
      jobId,
      round: 1,
      claims: [
        { id: 'claim-1', key: 'q1', status: 'supported', verdictReason: null, evidenceSourceIds: ['inv-src-1'], needsTimeExcerpt: false },
        { id: 'claim-2', key: 'q2', status: 'supported', verdictReason: null, evidenceSourceIds: ['inv-src-2'], needsTimeExcerpt: false }
      ],
      sourceIds: ['inv-src-1', 'inv-src-2'],
      validSourceCount: 2,
      candidateCount: 3,
      timeSpentMinutes: 2,
      terminalReason: 'claims_resolved',
      unresolvedRequiredClaims: []
    });
    result = recordInvestigationReporterTerminal(db, { projectId, jobId, type: 'job.finished', pack });
    if (!result.ok || result.data.status !== 'research_review') {
      throw new Error(`seed 终态失败: ${JSON.stringify(result)}`);
    }
  } finally {
    db.close();
  }
}

async function seedCompletedInvestigationProject(context) {
  await seedResearchReviewProject(context);
  const db = openWriteDb(context.dataRoot);
  try {
    const project = projectRow(db, 'E2E 调查项目（验收中）');
    const accepted = reviewInvestigationResearch(db, {
      projectId: project.id,
      expectedRevision: readProjectInvestigation(db, project.id).revision,
      decision: 'accept',
      decidedBy: 'desk',
      direction: {
        keyFacts: ['E2E 已核实关键事实'], upheld: ['核心判断成立'], changed: [], discoveries: [], unknowns: [],
        recommendation: 'continue', coreQuestion: 'E2E 核心问题', audienceValue: 'E2E 受众价值', scope: 'E2E 正文范围', constraints: []
      }
    });
    if (!accepted.ok) throw new Error(`seed 验收失败: ${JSON.stringify(accepted)}`);
    const started = startInvestigationWriter(db, {
      projectId: project.id,
      expectedRevision: accepted.data.revision,
      writerJobId: 'job-e2e-completed-writer'
    });
    if (!started.ok) throw new Error(`seed 写手启动失败: ${JSON.stringify(started)}`);
    const completed = recordInvestigationWriterTerminal(db, {
      projectId: project.id,
      jobId: 'job-e2e-completed-writer',
      type: 'job.finished'
    });
    if (!completed.ok) throw new Error(`seed 写手完成失败: ${JSON.stringify(completed)}`);
  } finally {
    db.close();
  }
}

async function seedDeferredReviewProject(context) {
  await seedResearchReviewProject(context);
  const db = openWriteDb(context.dataRoot);
  try {
    const project = db.prepare("SELECT id FROM content_projects WHERE title = 'E2E 调查项目（验收中）' LIMIT 1").get();
    const current = readProjectInvestigation(db, project.id);
    const result = reviewInvestigationResearch(db, {
      projectId: project.id,
      expectedRevision: current.revision,
      decision: 'defer',
      summary: '关键事实仍缺少可信来源，等待 Owner 决定下一步。'
    });
    if (!result.ok || result.data.status !== 'needs_user') throw new Error(`seed 暂缓验收失败: ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}

/** 打开项目行（真实「打开」按钮）；已直接打开编辑器时跳过。 */
async function openProjectByName(page, title) {
  await page.waitForSelector('.studio-project-row:not(.head), .studio-editor-view', { timeout: 20_000 });
  const rowShown = await page.evaluate(() => Boolean(document.querySelector('.studio-project-row:not(.head)')));
  if (!rowShown) return;
  const ok = await page.evaluate((wanted) => {
    const row = [...document.querySelectorAll('.studio-project-row:not(.head)')].find((r) => r.textContent?.includes(wanted));
    const btn = row?.querySelector('button.studio-row-action');
    if (!btn) return false;
    btn.click();
    return true;
  }, title);
  if (!ok) throw new Error(`创作库未找到项目「${title}」`);
  await page.waitForSelector('.studio-editor-view', { timeout: 15_000 });
}

/** 切到「调查」工作面并等待容器出现。 */
async function openInvestigationSurface(page) {
  const ok = await page.evaluate(() => {
    const tab = document.querySelector('.studio-surface-tab[data-surface="investigation"]');
    if (!tab) return false;
    tab.click();
    return true;
  });
  if (!ok) throw new Error('未找到调查工作面切换（.studio-surface-tab[data-surface="investigation"]）');
  await page.waitForSelector('.studio-investigation', { timeout: 15_000 });
}

/** 读调查状态（机器状态 / 标签 / 主动作 / 错误面）。 */
const readInvestigationState = (page) => page.evaluate(() => ({
  status: document.querySelector('.investigation-status')?.getAttribute('data-status') ?? null,
  pill: document.querySelector('.investigation-status-pill.investigation-status-data')?.getAttribute('data-status') ?? null,
  label: document.querySelector('.investigation-status')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  primary: document.querySelector('.investigation-primary-action')?.getAttribute('data-action') ?? null,
  empty: Boolean(document.querySelector('.investigation-empty')),
  error: document.querySelector('.investigation-error')?.textContent?.replace(/\s+/g, ' ').trim() ?? null
}));

/** 等待调查状态落入允许集合（机器状态在 .investigation-status[data-status]）。 */
async function waitForInvestigationState(page, allowed, timeoutMs = 20_000) {
  await page.waitForFunction((states) => {
    const el = document.querySelector('.investigation-status');
    return el && states.includes(el.getAttribute('data-status'));
  }, allowed, { timeout: timeoutMs });
}

/** 点击唯一 violet 主动作；不存在/禁用时报错。 */
async function clickPrimaryAction(page, action) {
  const ok = await page.evaluate((wanted) => {
    const btn = document.querySelector(`.investigation-primary-action[data-action="${wanted}"]`);
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, action);
  if (!ok) throw new Error(`调查主动作不可用: ${action}`);
}

/** 断言指定 data-action 按钮全局不存在（写手门 UI 侧）。 */
async function assertNoActionButton(page, action) {
  const found = await page.evaluate((wanted) => Boolean(document.querySelector(`[data-action="${wanted}"]`)), action);
  if (found) throw new Error(`不应存在 data-action=${action} 按钮（写手门 UI 侧）`);
}

/** 编辑器通用填充：全部可写 textarea/input 写入标记值，select 选首个可用项（React 原生 setter）。 */
async function fillInvestigationEditor(page, tag) {
  const filled = await page.evaluate((prefix) => {
    const editor = document.querySelector('.investigation-editor');
    if (!editor) return 0;
    let count = 0;
    for (const el of editor.querySelectorAll('textarea, input[type="text"], input:not([type])')) {
      if (el.disabled || el.readOnly) continue;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, `${prefix}-${count}`);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      count += 1;
    }
    for (const sel of editor.querySelectorAll('select')) {
      const option = [...sel.options].find((o) => o.value && !o.disabled);
      if (!option) continue;
      sel.value = option.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      count += 1;
    }
    return count;
  }, tag);
  if (filled === 0) throw new Error(`调查编辑器无可填充字段: ${tag}`);
  return filled;
}

/** 轮询只读 DB 直至条件满足，返回该值。 */
async function waitForDbValue(openDb, probe, { timeoutMs = 12_000, label = 'DB 条件' } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const { db, close } = openDb();
    try {
      last = probe(db);
      if (last) return last;
    } finally {
      close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} 超时未满足（最后值: ${JSON.stringify(last)}）`);
}

const projectRow = (db, title) => db.prepare('SELECT id, title FROM content_projects WHERE title = ? LIMIT 1').get(title);
const investigationRow = (db, projectId) => db.prepare(
  'SELECT project_id, status, outline_version, direction_version, reporter_job_id, reporter_round, writer_job_id, revision FROM project_investigations WHERE project_id = ?'
).get(projectId);

export default [
  {
    id: 'INV-001-studio-investigation-init-approve',
    journeyIds: ['INV-001-studio-investigation-init-approve'],
    launch: { seedFixture: seedProjectWithSources },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb, app, evidence, artifactsDir } = ctx;
      await helpers.waitForAppReady(page);
      await step('打开创作项目并进入「调查」工作面（空态）', async () => {
        await helpers.navigateTo(page, 'studio');
        await openProjectByName(page, 'E2E 调查项目');
        await openInvestigationSurface(page);
        const state = await readInvestigationState(page);
        assert(state.empty && state.primary === 'initialize', `初始应显示调查空态与开始调查主动作: ${JSON.stringify(state)}`);
      });
      await step('初始化调查 → 提纲待审批', async () => {
        await clickPrimaryAction(page, 'initialize');
        await waitForInvestigationState(page, ['outline_pending_approval']);
        const state = await readInvestigationState(page);
        assert(state.primary === 'request-outline' && /提纲待生成/.test(state.label), `初始化后应如实等待主管拟定提纲: ${JSON.stringify(state)}`);
      });
      await step('编辑提纲并保存（版本落库）', async () => {
        const filled = await fillInvestigationEditor(page, 'E2E-提纲');
        assert(filled >= 3, `提纲编辑器字段不足: ${filled}`);
        await clickPrimaryAction(page, 'save-outline');
        await waitForInvestigationState(page, ['outline_pending_approval']);
        const { db, close } = openDb();
        try {
          const project = projectRow(db, 'E2E 调查项目');
          const row = investigationRow(db, project.id);
          const versions = db.prepare('SELECT COUNT(*) AS c FROM investigation_outline_versions WHERE project_id = ?').get(project.id);
          assert(row && Number(row.outline_version) === 1 && Number(versions.c) === 1,
            `保存后应有提纲 v1: ${JSON.stringify({ row, versions })}`);
        } finally { close(); }
      });
      await step('第一次 Owner 批准 → 记者工单引用落库', async () => {
        await clickPrimaryAction(page, 'approve-outline');
        await waitForInvestigationState(page, ['researching', 'failed', 'needs_user']);
        const state = await readInvestigationState(page);
        assert(state.status !== 'outline_pending_approval', `批准后不得回到待审批: ${JSON.stringify(state)}`);
        const { db, close } = openDb();
        try {
          const project = projectRow(db, 'E2E 调查项目');
          const row = investigationRow(db, project.id);
          assert(row && typeof row.reporter_job_id === 'string' && row.reporter_job_id.length > 0,
            `批准后应持久化记者工单引用: ${JSON.stringify(row)}`);
        } finally { close(); }
      });
      await step('记者运行态只保留一层流程状态和一层进度事实', async () => {
        const state = await readInvestigationState(page);
        if (state.status !== 'researching') return;
        const hierarchy = await page.evaluate(() => ({
          reporterHeadings: [...document.querySelectorAll('.studio-investigation .investigation-section-title')]
            .filter((node) => node.textContent?.includes('记者专项调查')).length,
          progressHeading: document.querySelector('[aria-label="调查进度"] .investigation-section-title')?.textContent?.trim() ?? '',
          progressText: document.querySelector('[aria-label="调查进度"] .investigation-progress-line')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          duplicateExplanation: document.body.textContent?.includes('扩大事实覆盖、核验来源并呈现冲突与未知') ?? false,
          jobDetailsClosed: document.querySelector('[aria-label="调查进度"] .investigation-job-details')?.hasAttribute('open') ?? true
        }));
        assert(hierarchy.reporterHeadings === 0, `记者区不应重复流程总状态: ${JSON.stringify(hierarchy)}`);
        assert(hierarchy.progressHeading === '调查进度' && /第 \d+ 轮/.test(hierarchy.progressText) && /调查中/.test(hierarchy.progressText),
          `进度区应展示轮次和执行状态: ${JSON.stringify(hierarchy)}`);
        assert(!hierarchy.duplicateExplanation && hierarchy.jobDetailsClosed, `重复解释应删除且工单详情默认收起: ${JSON.stringify(hierarchy)}`);
      });
      await step('记者终态如实呈现并可显式补派', async () => {
        const state = await readInvestigationState(page);
        if (state.status === 'researching') return;
        const retryAction = 'retry-reporter';
        assert(state.primary === retryAction, `记者终态应提供对应补派主动作: ${JSON.stringify(state)}`);
        const { db, close } = openDb();
        let previousJobId = null;
        try {
          const project = projectRow(db, 'E2E 调查项目');
          previousJobId = investigationRow(db, project.id).reporter_job_id;
        } finally { close(); }
        await clickPrimaryAction(page, retryAction);
        await page.waitForFunction(() => document.querySelector('.investigation-feedback.success')?.textContent?.includes('已重新派记者'));
        await page.waitForFunction(() => !document.querySelector('.investigation-feedback.success'), { timeout: 4000 });
        await waitForInvestigationState(page, ['researching', 'failed', 'needs_user']);
        await waitForDbValue(openDb, (connection) => {
          const project = projectRow(connection, 'E2E 调查项目');
          const row = investigationRow(connection, project.id);
          return row && row.reporter_job_id !== previousJobId && Number(row.reporter_round) >= 2 ? row : null;
        }, { label: '补派后记者轮次递增' });
      });
      await step('重载后调查档案与提纲版本持久保留', async () => {
        const { db, close } = openDb();
        let before = null;
        try {
          const project = projectRow(db, 'E2E 调查项目');
          before = investigationRow(db, project.id);
        } finally { close(); }
        await page.reload();
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        await openProjectByName(page, 'E2E 调查项目');
        await openInvestigationSurface(page);
        await waitForInvestigationState(page, ['researching', 'failed', 'needs_user']);
        const state = await readInvestigationState(page);
        assert(['researching', 'failed', 'needs_user'].includes(state.status), `重载后状态应一致: ${JSON.stringify(state)}`);
        const { db: db2, close: close2 } = openDb();
        try {
          const project = projectRow(db2, 'E2E 调查项目');
          const row = investigationRow(db2, project.id);
          const versions = db2.prepare('SELECT COUNT(*) AS c FROM investigation_outline_versions WHERE project_id = ?').get(project.id);
          assert(row && row.reporter_job_id === before.reporter_job_id && Number(row.outline_version) === 1 && Number(versions.c) === 1,
            `重载后记者引用与提纲版本应持久: ${JSON.stringify({ row, versions })}`);
        } finally { close2(); }
      });
      await step('1100×800 调查工作面无横向溢出，page error 0', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(300);
        const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflowX === 0, `1100px 调查工作面不应横向溢出，实际 ${overflowX}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'investigation-init-approve-1100' });
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { initialized: true };
    }
  },
  {
    id: 'INV-002-studio-investigation-writer-gate',
    journeyIds: ['INV-002-studio-investigation-writer-gate'],
    launch: { seedFixture: seedResearchReviewProject },
    run: async (ctx) => {
      const { page, helpers, assert, step, openDb, app, evidence, artifactsDir } = ctx;
      await helpers.waitForAppReady(page);
      await step('打开验收中项目并进入「调查」工作面（资料包已就绪）', async () => {
        await helpers.navigateTo(page, 'studio');
        await openProjectByName(page, 'E2E 调查项目（验收中）');
        await openInvestigationSurface(page);
        await waitForInvestigationState(page, ['research_review']);
        const state = await readInvestigationState(page);
        assert(state.primary === 'accept-research', `验收态应有接受调查主动作: ${JSON.stringify(state)}`);
      });
      await step('验收前先形成调查后写作方向草稿（方向编辑器已可见）', async () => {
        const filled = await fillInvestigationEditor(page, 'E2E-方向');
        assert(filled >= 3, `方向编辑器字段不足: ${filled}`);
      });
      await step('主管验收通过（携带当前方向草稿）→ 调查后写作方向待批', async () => {
        await clickPrimaryAction(page, 'accept-research');
        await waitForInvestigationState(page, ['direction_pending_approval']);
        const state = await readInvestigationState(page);
        assert(state.primary === 'approve-direction' && /方向/.test(state.label),
          `验收后应进入方向待批且主动作为 approve-direction: ${JSON.stringify(state)}`);
        const { db, close } = openDb();
        try {
          const project = projectRow(db, 'E2E 调查项目（验收中）');
          const row = investigationRow(db, project.id);
          const dirs = db.prepare('SELECT COUNT(*) AS c FROM investigation_direction_versions WHERE project_id = ?').get(project.id);
          assert(row && Number(row.direction_version) >= 1 && Number(dirs.c) >= 1,
            `验收应把当前方向草稿落为方向版本: ${JSON.stringify({ row, dirs })}`);
        } finally { close(); }
      });
      await step('写手门：方向批准前不存在任何写手启动入口', async () => {
        await assertNoActionButton(page, 'start-writer');
        const state = await readInvestigationState(page);
        assert(state.primary === 'approve-direction', `方向待批主动作应为 approve-direction: ${JSON.stringify(state)}`);
      });
      await step('第二次 Owner 批准 → ready_to_write，唯一主动作变为显式启动写手', async () => {
        await clickPrimaryAction(page, 'approve-direction');
        await waitForInvestigationState(page, ['ready_to_write']);
        const state = await readInvestigationState(page);
        assert(state.primary === 'start-writer', `就绪后唯一主动作应为 start-writer: ${JSON.stringify(state)}`);
      });
      await step('显式启动写手：writerJobId 落库，状态离开 ready_to_write', async () => {
        await clickPrimaryAction(page, 'start-writer');
        await page.waitForSelector('.app-confirm-dialog .primary-button');
        await page.click('.app-confirm-dialog .primary-button');
        const row = await waitForDbValue(openDb, (connection) => {
          const project = projectRow(connection, 'E2E 调查项目（验收中）');
          const investigation = investigationRow(connection, project.id);
          return investigation && typeof investigation.writer_job_id === 'string' && investigation.writer_job_id.length > 0 ? investigation : null;
        }, { label: '写手工单引用落库' });
        await waitForInvestigationState(page, ['writing', 'ready_to_write']);
        assert(row.writer_job_id.length > 0, `写手工单引用不应为空: ${JSON.stringify(row)}`);
      });
      await step('重载后：写手引用、资料包、提纲/方向版本全部持久', async () => {
        const { db, close } = openDb();
        let before = null;
        try {
          const project = projectRow(db, 'E2E 调查项目（验收中）');
          before = investigationRow(db, project.id);
        } finally { close(); }
        await page.reload();
        await helpers.waitForAppReady(page);
        await helpers.navigateTo(page, 'studio');
        await openProjectByName(page, 'E2E 调查项目（验收中）');
        await openInvestigationSurface(page);
        await waitForInvestigationState(page, ['writing', 'ready_to_write']);
        const { db: db2, close: close2 } = openDb();
        try {
          const project = projectRow(db2, 'E2E 调查项目（验收中）');
          const row = investigationRow(db2, project.id);
          const packages = db2.prepare('SELECT COUNT(*) AS c FROM investigation_packages WHERE project_id = ?').get(project.id);
          const outlines = db2.prepare('SELECT COUNT(*) AS c FROM investigation_outline_versions WHERE project_id = ?').get(project.id);
          const linked = db2.prepare('SELECT COUNT(*) AS c FROM content_project_sources WHERE project_id = ?').get(project.id);
          assert(row && row.writer_job_id === before.writer_job_id && Number(row.direction_version) === before.direction_version,
            `重载后写手引用与方向版本应持久: ${JSON.stringify({ row, before })}`);
          assert(Number(packages.c) === 1 && Number(outlines.c) === 1, `资料包与提纲版本应持久: ${JSON.stringify({ packages, outlines })}`);
          assert(Number(linked.c) === 2, `终态来源关联应持久: ${linked.c}`);
        } finally { close2(); }
      });
      await step('1100×800 调查工作面无横向溢出，page error 0', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(300);
        const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflowX === 0, `1100px 调查工作面不应横向溢出，实际 ${overflowX}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'investigation-writer-gate-1100' });
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { writerGate: true };
    }
  },
  {
    id: 'WMB-5394-creation-evidence-progressive-detail',
    journeyIds: [],
    launch: { seedFixture: seedCompletedInvestigationProject },
    run: async ({ app, page, helpers, assert, step, evidence, artifactsDir }) => {
      await helpers.waitForAppReady(page);
      await step('Studio 默认正文，依据与进度保持可展开详情且无内部生产按钮', async () => {
        await helpers.navigateTo(page, 'studio');
        await openProjectByName(page, 'E2E 调查项目（验收中）');
        assert(await page.locator('.studio-surface-tab[data-surface="core"].active').count() === 1, '打开项目应默认停在正文');
        await openInvestigationSurface(page);
        assert((await page.locator('.studio-surface-tab[data-surface="investigation"]').textContent())?.includes('依据与进度'), '工作面应命名为依据与进度');
        assert(await page.locator('.investigation-evidence-details:not([open])').count() === 1, '正常完成态完整记录应默认折叠');
        assert(await page.locator('.investigation-primary-action').count() === 0, '正常完成态不应显示内部生产审批按钮');
        await page.locator('.investigation-evidence-details > summary').click();
        assert(await page.locator('.investigation-evidence-details[open] .investigation-history').count() === 1, '用户应可展开完整历史');
      });
      await step('1100×800 依据与进度无横向溢出且 page error 0', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(300);
        const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflowX === 0, `1100px 依据与进度不应横向溢出，实际 ${overflowX}`);
        await helpers.captureEvidence({ app, page, evidence, artifactsDir, name: 'creation-evidence-progressive-detail-1100' });
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { defaultSurface: 'core', evidence: 'progressive-detail', overflowX: 0 };
    }
  },
  {
    id: 'WMB-5290-deferred-owner-decision',
    journeyIds: [],
    launch: { seedFixture: seedDeferredReviewProject },
    run: async ({ app, page, helpers, assert, step, evidence }) => {
      await helpers.waitForAppReady(page);
      await step('主管暂缓验收后，Owner 可见结论与四个决策入口', async () => {
        await helpers.navigateTo(page, 'studio');
        await openProjectByName(page, 'E2E 调查项目（验收中）');
        await openInvestigationSurface(page);
        await waitForInvestigationState(page, ['needs_user']);
        const state = await readInvestigationState(page);
        assert(state.primary === 'accept-research', `Owner 应可选择按当前证据收窄写作（accept-research）: ${JSON.stringify(state)}`);
        const primaryLabel = (await page.locator('.investigation-primary-action').textContent())?.replace(/\s+/g, ' ').trim() ?? '';
        assert(primaryLabel === '按当前证据收窄写作', `异常状态主动作应显示收窄写作: ${primaryLabel}`);
        const surface = await page.locator('.studio-investigation').textContent();
        assert(surface.includes('系统已停止自动推进') || surface.includes('当前证据不足以安全进入自动写作'), `异常停止原因未显示: ${surface}`);
        for (const label of ['按当前证据收窄写作', '补查关键事实', '调整核心方向', '停止项目']) assert(surface.includes(label), `缺少异常决策文案 ${label}`);
        assert(surface.includes('外部可验证事实') && surface.includes('证据'), `事实与证据边界说明未显示: ${surface}`);
        for (const action of ['supplement-research', 'expand-research', 'stop-research']) {
          assert(await page.locator(`[data-action="${action}"]`).count() === 1, `缺少 Owner 决策入口 ${action}`);
        }
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      await step('1100×800 观点稿决策区无横向溢出，page error 0', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(300);
        const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflowX === 0, `1100px 观点稿决策区不应横向溢出，实际 ${overflowX}`);
        assert(evidence.pageerrors.length === 0, `页面异常 ${evidence.pageerrors.length} 条: ${evidence.pageerrors[0]?.message ?? ''}`);
      });
      return { deferredOwnerDecision: true };
    }
  }
];
