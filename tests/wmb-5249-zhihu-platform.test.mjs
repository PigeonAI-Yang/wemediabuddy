// WMB-5249：知乎一等发布平台聚焦测试。
// 覆盖：
// 1. 迁移保护（v69 → v70 重建平台 CHECK 表：数据/索引/触发器/FK 保留）与新库 schema 收敛；
// 2. 平台域暴露（WORKSPACE_CATALOG / 平台正文编译 / Studio 批注平台接受 zhihu）；
// 3. 知乎适配器：登录态判定、未登录/验证码编辑前停止、标题/正文/单张封面精确回读、绝不点击发布、
//    不支持素材合同在浏览器副作用前 fail-closed；
// 4. 发布派发：zhihu 平台版本 → 含封面快照 → 授权 → 编辑器准备 → awaiting_confirmation；
//    非封面/多素材合同在快照创建前拒绝；
// 5. preload 接线：prepareZhihuArticlePublication 等新面真实调用 IPC 通道。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { register } from 'node:module';

// ---- 测试本地 ESM 解析钩子：electron → 捕获型桩；相对无扩展名补 .ts（wmb-5239 同款模式）----
const ELECTRON_STUB = [
  'const ipcRenderer = { invoke: async (channel, ...args) => { globalThis.__wmbInvoked.push([channel, args]); return { ok: true, data: null, error: null }; } };',
  'const contextBridge = { exposeInMainWorld: (name, api) => { globalThis.__wmbExposed = { name, api }; } };',
  'export { ipcRenderer, contextBridge };',
  'export default { ipcRenderer, contextBridge };'
].join('\n');
const HOOK_SOURCE = [
  "const { existsSync } = process.getBuiltinModule('node:fs');",
  "const path = process.getBuiltinModule('node:path');",
  "const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url');",
  'const ELECTRON_STUB = ' + JSON.stringify(ELECTRON_STUB) + ';',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(ELECTRON_STUB), shortCircuit: true };",
  "  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {",
  '    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);',
  "    for (const ext of ['.ts', '.mts', '.cts']) {",
  '      const candidate = base + ext;',
  '      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };',
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}'
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE), import.meta.url);
globalThis.__wmbExposed = null;
globalThis.__wmbInvoked = [];

const { migrations, migrateDatabase } = await import('../src/main/db/migrations.ts');
const { createContentProject, saveCoreVersion, savePlatformVersion } = await import('../src/main/content.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { initializeWorkspaceBrowserBinding, markWorkspaceBrowserBindingVerified } = await import('../src/main/workspace-browser-binding.ts');
const { dispatchCreatePublicationSnapshot, dispatchPreparePublicationEditor } = await import('../src/main/publication-commands.ts');
const { classifyZhihuLoginState, identifyZhihuAccount, prepareZhihuArticle, ZHIHU_HOME_URL, ZHIHU_WRITE_URL } = await import('../src/main/platforms/zhihu.ts');
const { compilePlatformBody } = await import('../src/main/platform-body-compile.ts');
const { WORKSPACE_CATALOG } = await import('../src/main/workspace-proposals.ts');

const NOW = '2026-08-14T00:00:00.000Z';

async function withDatabaseDir(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5249-zhihu-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
}

/**
 * 手动应用 WMB-5249 之前的迁移（v1..v69）：把当前初始 schema 定义里的 zhihu CHECK
 * 还原成旧三平台 CHECK，精确模拟升级前数据库的阻塞约束（v70 是唯一放开点）。
 */
function applyMigrationsUpTo69(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => Number(version)));
  for (const migration of migrations) {
    if (applied.has(migration.version) || migration.version > 69) continue;
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql.replaceAll(
        "platform IN ('x', 'xiaohongshu', 'wechat', 'zhihu')",
        "platform IN ('x', 'xiaohongshu', 'wechat')"
      ));
      migration.run?.(database);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, NOW);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      database.exec('PRAGMA foreign_keys = ON');
      throw error;
    }
    database.exec('PRAGMA foreign_keys = ON');
  }
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function insertLegacyRows(database) {
  database.prepare(`INSERT INTO workspace_browser_bindings (id, profile_id, binding_revision, state, expected_account_snapshot_json, error_code, error_message, created_at, updated_at)
    VALUES ('effective', 'profile-legacy', 1, 'verified', '{}', NULL, NULL, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO content_projects (id, title, created_at, updated_at, revision) VALUES ('project-legacy', '遗留项目', ?, ?, 1)`).run(NOW, NOW);
  database.prepare(`INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES ('version-legacy', 'project-legacy', 'legacy body', 1, ?)`).run(NOW);
  for (const [index, platform] of ['x', 'wechat'].entries()) {
    database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
      VALUES (?, 'project-legacy', 'version-legacy', ?, 'text', ?, ?, '[]', ?, ?, 1)`)
      .run(`pv-${platform}`, platform, `标题${index}`, `正文${index}`, NOW, NOW);
    database.prepare(`INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision, browser_profile_id, browser_binding_revision, verified_at)
      VALUES (?, ?, ?, ?, 'authenticated', ?, ?, ?, 1, 'profile-legacy', 1, ?)`)
      .run(`acct-${platform}`, platform, `key-${platform}`, `Name ${platform}`, `https://example.com/${platform}`, NOW, NOW, NOW);
    database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status, prepared_assets_json, created_at, updated_at, revision)
      VALUES (?, ?, 1, ?, ?, ?, 'draft', '[]', ?, ?, 1)`)
      .run(`pub-${platform}`, `pv-${platform}`, platform, `acct-${platform}`, `key-${platform}`, NOW, NOW);
  }
  database.prepare(`INSERT INTO publication_snapshots (id, publication_id, workspace_id, runtime_epoch, platform_version_id, platform_version_revision, platform, account_id, account_key, account_revision, browser_binding_id, browser_profile_id, browser_binding_revision, payload_json, payload_hash, assets_json, assets_hash, input_hash, causation_json, created_at)
    VALUES ('snap-legacy', 'pub-x', 'workspace-legacy', 'epoch-legacy', 'pv-x', 1, 'x', 'acct-x', 'key-x', 1, 'effective', 'profile-legacy', 1, '{"title":"标题0","body":"正文0","format":"text"}', ?, '[]', ?, ?, '{}', ?)`)
    .run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), NOW);
  database.prepare(`INSERT INTO studio_annotations (id, project_id, document_kind, document_id, platform, start_offset, end_offset, quoted_text, prefix_context, suffix_context, body_fingerprint, note, status, created_at, updated_at, revision)
    VALUES ('anno-core', 'project-legacy', 'core', NULL, NULL, 0, 4, 'legacy', '', '', ?, NULL, 'open', ?, ?, 1)`)
    .run('f'.repeat(64), NOW, NOW);
  database.prepare(`INSERT INTO studio_annotations (id, project_id, document_kind, document_id, platform, start_offset, end_offset, quoted_text, prefix_context, suffix_context, body_fingerprint, note, status, created_at, updated_at, revision)
    VALUES ('anno-platform', 'project-legacy', 'platform', 'pv-x', 'x', 0, 4, '正文', '', '', ?, NULL, 'open', ?, ?, 1)`)
    .run('e'.repeat(64), NOW, NOW);
}

function countRows(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function insertZhihuRows(database) {
  const zhihuAccountId = 'acct-zhihu';
  database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
    VALUES ('pv-zhihu', 'project-legacy', 'version-legacy', 'zhihu', 'article', '知乎标题', '知乎正文', '[]', ?, ?, 1)`).run(NOW, NOW);
  database.prepare(`INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, evidence_url, created_at, updated_at, revision, browser_profile_id, browser_binding_revision, verified_at)
    VALUES (?, 'zhihu', 'key-zhihu', '知乎用户', 'authenticated', 'https://www.zhihu.com/people/key-zhihu', ?, ?, 1, 'profile-legacy', 1, ?)`)
    .run(zhihuAccountId, NOW, NOW, NOW);
  database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status, prepared_assets_json, created_at, updated_at, revision)
    VALUES ('pub-zhihu', 'pv-zhihu', 1, 'zhihu', ?, 'key-zhihu', 'draft', '[]', ?, ?, 1)`).run(zhihuAccountId, NOW, NOW);
  database.prepare(`INSERT INTO publication_snapshots (id, publication_id, workspace_id, runtime_epoch, platform_version_id, platform_version_revision, platform, account_id, account_key, account_revision, browser_binding_id, browser_profile_id, browser_binding_revision, payload_json, payload_hash, assets_json, assets_hash, input_hash, causation_json, created_at)
    VALUES ('snap-zhihu', 'pub-zhihu', 'workspace-legacy', 'epoch-legacy', 'pv-zhihu', 1, 'zhihu', ?, 'key-zhihu', 1, 'effective', 'profile-legacy', 1, '{"title":"知乎标题","body":"知乎正文","format":"article"}', ?, '[]', ?, ?, '{}', ?)`)
    .run(zhihuAccountId, 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64), NOW);
  database.prepare(`INSERT INTO studio_annotations (id, project_id, document_kind, document_id, platform, start_offset, end_offset, quoted_text, prefix_context, suffix_context, body_fingerprint, note, status, created_at, updated_at, revision)
    VALUES ('anno-zhihu', 'project-legacy', 'platform', 'pv-zhihu', 'zhihu', 0, 4, '知乎', '', '', ?, NULL, 'open', ?, ?, 1)`)
    .run('0'.repeat(64), NOW, NOW);
}

// ============================================================
// 1. 迁移保护 + 新库 schema 收敛
// ============================================================

test('WMB-5249 migration 70 preserves data/indexes/triggers/FK and relaxes blocking CHECKs', async () => {
  await withDatabaseDir(async (directory) => {
    const databasePath = path.join(directory, 'wmb.db');
    // v69 老库：只应用 1..69（初始定义还原为旧三平台 CHECK），插入存量数据。
    const legacy = applyMigrationsUpTo69(databasePath);
    insertLegacyRows(legacy);
    // 升级前：zhihu 平台行被旧 CHECK 拒绝（证明约束确实阻塞）。
    assert.throws(
      () => legacy.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
        VALUES ('pv-blocked', 'project-legacy', 'version-legacy', 'zhihu', 'article', 't', 'b', '[]', ?, ?, 1)`).run(NOW, NOW),
      (error) => /CHECK/i.test(String(error.message))
    );
    legacy.close();

    // 升级：应用 v70。
    const upgraded = migrateDatabase(databasePath);
    // 数据原样保留。
    assert.equal(countRows(upgraded, 'platform_versions'), 2);
    assert.equal(countRows(upgraded, 'platform_accounts'), 2);
    assert.equal(countRows(upgraded, 'publications'), 2);
    assert.equal(countRows(upgraded, 'publication_snapshots'), 1);
    assert.equal(countRows(upgraded, 'studio_annotations'), 2);
    const spot = upgraded.prepare('SELECT platform, title FROM platform_versions WHERE id = ?').get('pv-wechat');
    assert.equal(spot.platform, 'wechat');
    assert.equal(spot.title, '标题1');
    assert.equal(upgraded.prepare('SELECT status FROM publications WHERE id = ?').get('pub-x').status, 'draft');
    // 索引与触发器原样重建。
    const snapshotIndexes = upgraded.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='publication_snapshots' AND name NOT LIKE 'sqlite_autoindex_%'`).all().map((row) => row.name).sort();
    assert.deepEqual(snapshotIndexes, ['publication_snapshots_frozen_identity', 'publication_snapshots_input_hash', 'publication_snapshots_workspace_created']);
    const triggers = upgraded.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='publication_snapshots'`).all().map((row) => row.name).sort();
    assert.deepEqual(triggers, ['publication_snapshots_immutable_delete', 'publication_snapshots_immutable_update']);
    // FK 完整性：无悬空引用。
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
    // 不可变快照触发器仍生效。
    assert.throws(() => upgraded.prepare("UPDATE publication_snapshots SET payload_json = '{}' WHERE id = ?").run('snap-legacy'), /PUBLICATION_SNAPSHOT_IMMUTABLE/);
    // zhihu 行现在可以写入全部五张重建表。
    insertZhihuRows(upgraded);
    assert.equal(countRows(upgraded, 'platform_versions'), 3);
    assert.equal(countRows(upgraded, 'platform_accounts'), 3);
    assert.equal(countRows(upgraded, 'publications'), 3);
    assert.equal(countRows(upgraded, 'publication_snapshots'), 2);
    assert.equal(countRows(upgraded, 'studio_annotations'), 3);
    upgraded.close();
  });
});

test('WMB-5249 fresh database schema accepts zhihu platform rows', async () => {
  await withDatabaseDir(async (directory) => {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    const versions = migrations.map((migration) => migration.version);
    const maxVersion = Math.max(...versions);
    assert.ok(versions.includes(70), 'migration 70 应存在（WMB-5249 放开 zhihu）');
    assert.deepEqual([...versions].sort((a, b) => a - b), Array.from({ length: maxVersion }, (_, index) => index + 1), `迁移版本应精确连续 1..${maxVersion}`);
    assert.equal(versions.length, maxVersion, '迁移数量应与最大版本号一致（连续无空洞）');
    insertLegacyRows(database);
    insertZhihuRows(database);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    database.close();
  });
});

// ============================================================
// 2. 平台域暴露
// ============================================================

test('WMB-5249 platform domain exposes zhihu (catalog, body compile, annotations)', () => {
  assert.ok(WORKSPACE_CATALOG.platforms.includes('zhihu'));
  // 纯文本正文逐字节不变；单张显式封面可冻结，并移除对应正文 token。
  assert.deepEqual(
    compilePlatformBody({ platform: 'zhihu', body: '纯文本正文', bindings: [] }),
    { body: '纯文本正文', assetIds: [], imageTokens: 0, inlineImages: false }
  );
  const coverBinding = { assetId: 'X', ordinal: 0, isCover: true, mediaKind: 'image' };
  const compiledCover = compilePlatformBody({ platform: 'zhihu', body: '![封面](wmb-asset://X)\n\n正文', bindings: [coverBinding] });
  assert.equal(compiledCover.body, '正文');
  assert.deepEqual(compiledCover.assetIds, ['X']);
  assert.throws(() => compilePlatformBody({ platform: 'zhihu', body: '正文', bindings: [{ ...coverBinding, isCover: false }] }), /明确标记为封面/);
});

test('WMB-5249 studio annotations accept zhihu platform scope', async () => {
  await withDatabaseDir(async (directory) => {
    const database = migrateDatabase(path.join(directory, 'wmb.db'));
    database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run('workspace-anno', NOW, NOW);
    const project = createContentProject(database, { title: '批注项目' });
    const core = saveCoreVersion(database, { projectId: project.id, body: '核心正文', expectedRevision: 1 });
    assert.equal(core.ok, true);
    const version = savePlatformVersion(database, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'zhihu', format: 'article',
      title: '知乎版本', body: '知乎正文', assetIds: []
    });
    assert.equal(version.ok, true);
    const { createStudioAnnotation } = await import('../src/main/studio-annotations.ts');
    const created = createStudioAnnotation(database, {
      projectId: project.id, documentKind: 'platform', documentId: version.data.id, platform: 'zhihu',
      body: '批注', startOffset: 0, endOffset: 2
    });
    assert.equal(created.ok, true);
    assert.equal(created.data.platform, 'zhihu');
    database.close();
  });
});

// ============================================================
// 3. 知乎适配器（fake CDP 浏览器，DI connect 接缝）
// ============================================================

test('WMB-5249 zhihu login classification distinguishes all four states', () => {
  assert.equal(classifyZhihuLoginState({ url: 'https://www.zhihu.com/', hasLoginEntry: false, hasUserAvatar: true, hasCaptcha: false }), 'authenticated');
  assert.equal(classifyZhihuLoginState({ url: 'https://www.zhihu.com/', hasLoginEntry: true, hasUserAvatar: false, hasCaptcha: false }), 'unauthenticated');
  assert.equal(classifyZhihuLoginState({ url: 'https://www.zhihu.com/signin?next=/write', hasLoginEntry: false, hasUserAvatar: false, hasCaptcha: false }), 'unauthenticated');
  assert.equal(classifyZhihuLoginState({ url: 'https://www.zhihu.com/', hasLoginEntry: false, hasUserAvatar: false, hasCaptcha: true }), 'challenge');
  assert.equal(classifyZhihuLoginState({ url: 'https://www.zhihu.com/', hasLoginEntry: false, hasUserAvatar: false, hasCaptcha: false }), 'unknown');
});

function createFakePage({ url, facts, attributes = {}, readback = {}, failWriteWait = false }) {
  const actions = [];
  const locators = new Map();
  const makeLocator = (selector) => {
    let existing = locators.get(selector);
    if (existing) return existing;
    const attrs = attributes[selector] ?? {};
    const locator = {
      selector,
      waitFor: async () => { actions.push(`waitFor:${selector}`); if (failWriteWait) throw new Error('editor unavailable'); },
      fill: async (value) => {
        actions.push(`fill:${selector}:${value}`);
        if (selector.includes('textarea')) readback.title = value;
        else readback.body = value;
      },
      setInputFiles: async (assetPath) => { actions.push(`setInputFiles:${selector}:${assetPath}`); },
      innerText: async () => readback.body ?? '',
      inputValue: async () => readback.title ?? '',
      getAttribute: async (name) => attrs[name] ?? null,
      first: () => locator,
      locator: (child) => makeLocator(`${selector} ${child}`),
      click: async () => { actions.push(`click:${selector}`); },
      count: async () => 1,
      evaluate: async (_callback, value) => {
        if (value && typeof value === 'object' && typeof value.text === 'string') {
          actions.push(`paste:${selector}:${value.text}:${value.html}`);
          readback.body = value.text;
          return null;
        }
        return readback.body ?? '';
      }
    };
    locators.set(selector, locator);
    return locator;
  };
  return {
    actions,
    url: () => url,
    waitForTimeout: async () => {},
    goto: async (target) => { actions.push(`goto:${target}`); },
    waitForURL: async (predicate) => {
      // 模拟真实 Playwright：predicate 为函数时立即求值；命中即返回，否则超时。
      if (typeof predicate === 'function' && predicate({ toString: () => url })) return;
      throw Object.assign(new Error('login timeout'), { name: 'TimeoutError' });
    },
    waitForLoadState: async () => { actions.push('waitForLoadState'); },
    evaluate: async () => facts,
    locator: (selector) => makeLocator(selector)
  };
}

function createFakeBrowser(page) {
  return { contexts: () => [{ pages: () => [page], newPage: async () => page }], close: async () => { page.actions.push('browser.close'); } };
}

test('WMB-5249 prepareZhihuArticle rejects unsupported cover contracts before any browser side effect', async () => {
  let connected = false;
  await assert.rejects(
    () => prepareZhihuArticle('fake://zhihu', '标题', '正文', [
      { assetId: 'asset-a', assetPath: 'a.png', mimeType: 'image/png' },
      { assetId: 'asset-b', assetPath: 'b.png', mimeType: 'image/png' }
    ], { connect: async () => { connected = true; throw new Error('connect must not run'); } }),
    (error) => error.code === 'ZHIHU_COVER_UNSUPPORTED'
  );
  assert.equal(connected, false, '素材校验必须发生在连接浏览器之前');
});

test('WMB-5249 prepareZhihuArticle uploads and reads back one JPEG/PNG cover', async () => {
  const page = createFakePage({
    url: ZHIHU_WRITE_URL,
    facts: { url: ZHIHU_WRITE_URL, hasLoginEntry: false, hasUserAvatar: true, hasCaptcha: false },
    attributes: { 'img[alt="封面图"]': { src: 'https://picx.zhimg.com/cover.png' } },
    readback: { title: '', body: '' }
  });
  const cover = { assetId: 'asset-cover', assetPath: 'C:/data/cover.png', mimeType: 'image/png' };
  const result = await prepareZhihuArticle('fake://zhihu', '封面文章', '正文', [cover], { connect: async () => createFakeBrowser(page) });
  assert.deepEqual(result.assetIds, ['asset-cover']);
  assert.ok(page.actions.includes('setInputFiles:input[type="file"].UploadPicture-input:C:/data/cover.png'));
  assert.equal(page.actions.some((action) => action.startsWith('click:')), false);
});

test('WMB-5249 prepareZhihuArticle stops on unauthenticated before editing', async () => {
  const page = createFakePage({
    url: 'https://www.zhihu.com/signin?next=%2Fwrite',
    facts: { url: 'https://www.zhihu.com/signin?next=%2Fwrite', hasLoginEntry: true, hasUserAvatar: false, hasCaptcha: false }
  });
  await assert.rejects(
    () => prepareZhihuArticle('fake://zhihu', '标题', '正文', [], { connect: async () => createFakeBrowser(page) }),
    (error) => error.code === 'BROWSER_NEEDS_USER'
  );
  assert.equal(page.actions.some((action) => action.startsWith('fill:')), false, '未登录时不得触碰编辑器');
});

test('WMB-5249 prepareZhihuArticle stops on challenge before editing', async () => {
  const page = createFakePage({
    url: ZHIHU_WRITE_URL,
    facts: { url: ZHIHU_WRITE_URL, hasLoginEntry: false, hasUserAvatar: false, hasCaptcha: true }
  });
  await assert.rejects(
    () => prepareZhihuArticle('fake://zhihu', '标题', '正文', [], { connect: async () => createFakeBrowser(page) }),
    (error) => error.code === 'BROWSER_NEEDS_USER'
  );
  assert.equal(page.actions.some((action) => action.startsWith('fill:')), false, '验证码状态不得触碰编辑器');
});

test('WMB-5249 prepareZhihuArticle returns exact readback and never clicks publish', async () => {
  const page = createFakePage({
    url: ZHIHU_WRITE_URL,
    facts: { url: ZHIHU_WRITE_URL, hasLoginEntry: false, hasUserAvatar: true, hasCaptcha: false },
    readback: { title: '', body: '' }
  });
  const title = '知乎文章标题';
  const body = '第一段 & <测试>\n\n第二段正文';
  const result = await prepareZhihuArticle('fake://zhihu', title, body, [], { connect: async () => createFakeBrowser(page) });
  assert.deepEqual(result, { title, body, assetIds: [], evidenceUrl: ZHIHU_WRITE_URL });
  assert.ok(page.actions.some((action) => action === `fill:textarea[placeholder="请输入标题（最多 100 个字）"]:${title}`));
  assert.ok(page.actions.some((action) => action === `paste:[contenteditable="true"]:has(div[data-contents="true"]), [contenteditable="true"][role="textbox"]:${body}:<p>第一段 &amp; &lt;测试&gt;</p><p><br></p><p>第二段正文</p>`));
  assert.ok(page.actions.some((action) => action === `goto:${ZHIHU_WRITE_URL}`), '必须导航到隔离的新写作页');
  assert.equal(page.actions.some((action) => action.startsWith('click:')), false, '适配器绝不点击发布/提交按钮');
});

test('WMB-5249 prepareZhihuArticle rejects internal media tokens', async () => {
  await assert.rejects(
    () => prepareZhihuArticle('fake://zhihu', '标题', '![a](wmb-asset://X)\n', []),
    /内部图片标记|wmb-asset/
  );
});

test('WMB-5249 identifyZhihuAccount requires authenticated identity with evidence', async () => {
  const page = createFakePage({
    url: ZHIHU_HOME_URL,
    facts: { url: ZHIHU_HOME_URL, hasLoginEntry: false, hasUserAvatar: true, hasCaptcha: false },
    attributes: {
      'a.AppHeader-profileAvatar[href*="/people/"]': { href: 'https://www.zhihu.com/people/url-token-abc' },
      '.AppHeader-profileEntry img.Avatar[alt]': { alt: '点击打开知乎用户的主页' }
    }
  });
  const identity = await identifyZhihuAccount('fake://zhihu', {}, { connect: async () => createFakeBrowser(page) });
  assert.deepEqual(identity, {
    platform: 'zhihu', accountKey: 'url-token-abc', displayName: '知乎用户',
    loginState: 'authenticated', evidenceUrl: ZHIHU_HOME_URL
  });
});

test('WMB-5249 identifyZhihuAccount stops when the browser is not logged in', async () => {
  const page = createFakePage({
    url: ZHIHU_HOME_URL,
    facts: { url: ZHIHU_HOME_URL, hasLoginEntry: true, hasUserAvatar: false, hasCaptcha: false }
  });
  await assert.rejects(
    () => identifyZhihuAccount('fake://zhihu', {}, { connect: async () => createFakeBrowser(page) }),
    (error) => error.code === 'BROWSER_NEEDS_USER'
  );
});

// ============================================================
// 4. 发布派发：真实 dispatch 流程 → awaiting_confirmation
// ============================================================

test('WMB-5249 zhihu publication dispatch ends at awaiting_confirmation with exact readback', async () => {
  await withDatabaseDir(async (directory) => {
    const databasePath = path.join(directory, 'wmb.db');
    const workspaceId = 'workspace-zhihu';
    const runtimeEpoch = 'epoch-zhihu';
    const profileId = 'profile-zhihu';
    const accountKey = 'zhihu-url-token';
    const setup = migrateDatabase(databasePath);
    setup.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, NOW, NOW);
    initializeWorkspaceBrowserBinding(setup, profileId);
    const binding = markWorkspaceBrowserBindingVerified(setup, {
      profileId,
      expectedBindingRevision: 1,
      account: { platform: 'zhihu', accountKey, displayName: '知乎用户', loginState: 'authenticated', evidenceUrl: 'https://www.zhihu.com/people/zhihu-url-token' }
    });
    const project = createContentProject(setup, { title: 'zhihu 项目' });
    const core = saveCoreVersion(setup, { projectId: project.id, body: '核心正文', expectedRevision: 1 });
    assert.equal(core.ok, true);
    const version = savePlatformVersion(setup, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'zhihu', format: 'article',
      title: '知乎文章标题', body: '知乎文章正文', assetIds: []
    });
    assert.equal(version.ok, true);
    setup.close();

    const runtime = ActiveWorkspaceRuntime.open(directory, {
      expectedWorkspaceId: workspaceId, createEpoch: () => runtimeEpoch, openDatabase: migrateDatabase
    });
    try {
      const fakeBrowserRuntime = Object.freeze({ cdpUrl: 'fake://zhihu', stop: async () => {} });
      const fakeBrowser = Object.freeze({
        profile: Object.freeze({ id: profileId, label: 'zhihu profile' }),
        binding: Object.freeze({ profileId, bindingRevision: binding.bindingRevision }),
        identity: Object.freeze({ platform: 'zhihu', accountKey, displayName: '知乎用户', loginState: 'authenticated', evidenceUrl: 'https://www.zhihu.com/people/zhihu-url-token' }),
        runtime: fakeBrowserRuntime
      });
      let browserStarts = 0;
      let adapterInvoked = 0;
      const startBrowser = async () => { browserStarts += 1; return fakeBrowser; };
      const invokeEditor = async () => {
        adapterInvoked += 1;
        return { title: '知乎文章标题', body: '知乎文章正文', assetIds: [], evidenceUrl: ZHIHU_WRITE_URL };
      };
      const setBrowser = (browser) => runtime.bindBrowser(browser);

      const snapshotReceipt = await dispatchCreatePublicationSnapshot(runtime, { platformVersionId: version.data.id, requestId: 'zhihu-snapshot' });
      assert.equal(snapshotReceipt.ok, true);
      const prepared = snapshotReceipt.data;
      assert.equal(prepared.operation.state, 'prepared');
      assert.equal(prepared.snapshot.platform, 'zhihu');
      assert.equal(prepared.snapshot.payload.title, '知乎文章标题');
      assert.equal(prepared.snapshot.payload.body, '知乎文章正文');
      assert.deepEqual(prepared.snapshot.assets, []);

      const prepareReceipt = await dispatchPreparePublicationEditor(runtime, {
        publicationId: prepared.publication.id, expectedRevision: prepared.publication.revision, requestId: 'zhihu-prepare'
      }, setBrowser, { startBrowser, invokeEditor });
      assert.equal(prepareReceipt.ok, true);
      assert.equal(browserStarts, 1, 'zhihu 发布必须启动一次绑定浏览器');
      assert.equal(adapterInvoked, 1, 'zhihu 编辑器适配器必须被调用一次');

      const operation = runtime.database.prepare('SELECT state, readback_json AS readback FROM publication_browser_operations WHERE id=?').get(prepared.operation.id);
      assert.equal(operation.state, 'succeeded');
      assert.equal(JSON.parse(operation.readback).title, '知乎文章标题');
      assert.equal(JSON.parse(operation.readback).body, '知乎文章正文');
      const publication = runtime.database.prepare('SELECT status, platform, prepared_title AS title, prepared_body AS body, prepared_evidence_url AS evidenceUrl FROM publications WHERE id=?').get(prepared.publication.id);
      assert.equal(publication.status, 'awaiting_confirmation', '发布派发必须停在等待人工发布状态');
      assert.equal(publication.platform, 'zhihu');
      assert.equal(publication.title, '知乎文章标题');
      assert.equal(publication.body, '知乎文章正文');
      assert.equal(publication.evidenceUrl, ZHIHU_WRITE_URL);
      // 绝不自动发布：无 publishing 尝试、无确认、无外部 URL。
      assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_attempts WHERE publication_id=?').get(prepared.publication.id).count, 0);
      assert.equal(runtime.database.prepare('SELECT COUNT(*) AS count FROM publication_confirmations WHERE publication_id=?').get(prepared.publication.id).count, 0);
      assert.equal(runtime.database.prepare('SELECT external_url FROM publications WHERE id=?').get(prepared.publication.id).external_url, null);
    } finally {
      await runtime.stop({ drain: true });
    }
  });
});

test('WMB-5249 zhihu snapshot freezes one explicit cover asset', async () => {
  await withDatabaseDir(async (directory) => {
    const databasePath = path.join(directory, 'wmb.db');
    const workspaceId = 'workspace-zhihu-assets';
    const runtimeEpoch = 'epoch-zhihu-assets';
    const profileId = 'profile-zhihu-assets';
    const accountKey = 'zhihu-assets-token';
    const setup = migrateDatabase(databasePath);
    setup.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId, NOW, NOW);
    setup.prepare(`INSERT INTO assets(id,relative_path,mime_type,byte_count,sha256,origin,created_at,updated_at,revision)
      VALUES (?,?,?,?,?,'user',?,?,1)`).run('asset-zhihu', 'assets/zhihu.png', 'image/png', 13, 'c'.repeat(64), NOW, NOW);
    initializeWorkspaceBrowserBinding(setup, profileId);
    markWorkspaceBrowserBindingVerified(setup, {
      profileId,
      expectedBindingRevision: 1,
      account: { platform: 'zhihu', accountKey, displayName: '知乎用户', loginState: 'authenticated', evidenceUrl: 'https://www.zhihu.com/people/zhihu-assets-token' }
    });
    const project = createContentProject(setup, { title: 'zhihu 带封面项目' });
    const core = saveCoreVersion(setup, { projectId: project.id, body: '核心正文', expectedRevision: 1 });
    assert.equal(core.ok, true);
    const version = savePlatformVersion(setup, {
      projectId: project.id, contentVersionId: core.data.id, platform: 'zhihu', format: 'article',
      title: '带封面文章', body: '![封面](wmb-asset://asset-zhihu)\n\n正文',
      mediaBindings: [{ assetId: 'asset-zhihu', ordinal: 0, isCover: true }]
    });
    assert.equal(version.ok, true);
    setup.close();

    const runtime = ActiveWorkspaceRuntime.open(directory, {
      expectedWorkspaceId: workspaceId, createEpoch: () => runtimeEpoch, openDatabase: migrateDatabase
    });
    try {
      const receipt = await dispatchCreatePublicationSnapshot(runtime, { platformVersionId: version.data.id });
      assert.equal(receipt.ok, true);
      assert.equal(receipt.data.snapshot.payload.body, '正文');
      assert.deepEqual(receipt.data.snapshot.assets.map((asset) => [asset.id, asset.relativePath, asset.mimeType]), [
        ['asset-zhihu', 'assets/zhihu.png', 'image/png']
      ]);
    } finally {
      await runtime.stop({ drain: true });
    }
  });
});

// ============================================================
// 5. preload 接线
// ============================================================

test('WMB-5249 preload exposes zhihu platform API wired to publish snapshot channel', async () => {
  globalThis.__wmbInvoked = [];
  await import('../src/preload/preload.ts');
  assert.equal(globalThis.__wmbExposed.name, 'wmb');
  const api = globalThis.__wmbExposed.api;
  assert.equal(typeof api.prepareZhihuArticlePublication, 'function');
  assert.equal(typeof api.prepareXPublication, 'function');
  assert.equal(typeof api.prepareWechatArticlePublication, 'function');
  assert.equal(typeof api.saveStudioPlatform, 'function');
  assert.equal(typeof api.verifyBrowserAccount, 'function');
  const result = await api.prepareZhihuArticlePublication('pv-zhihu-1');
  assert.equal(result.ok, true);
  // 方法族复用同一通用快照通道（无第二套发布入口）；zhihu 面与既有平台同一通道契约。
  assert.deepEqual(globalThis.__wmbInvoked, [['publish:snapshot-create', [{ platformVersionId: 'pv-zhihu-1' }]]]);
});
