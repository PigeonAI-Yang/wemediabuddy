/**
 * WMB-5234 隔离验收 fixture helper（WMB-5234-prep，只新增验收资产）。
 *
 * 职责：为知识飞轮最终验收构造「真实 SQLite 工作空间副本 / 隔离根」，
 * 绝不触碰 Owner 主库或任何用户真实数据根：
 * - fresh：全新临时根 + 正式 migrations 建库（空知识工作空间）；
 * - copy ：把指定真实工作空间根（默认 .ai/wmb-5207-final-root）的 wmb.db
 *          经 VACUUM INTO 复制到临时根并正式迁移 —— 只读打开源库，全程零写源；
 * - 两种模式都写入验收用 userData 三件套（onboarding.json /
 *   workspace-registry.json / pi-api-config.json），供 WMB_ACCEPTANCE_USER_DATA
 *   + WMB_ACCEPTANCE_CDP_PORT 驱动真实 Electron 使用。
 *
 * 本 helper 可被独立使用：
 *   node .ai/wmb-5234-fixture.mjs --mode copy [--source <root>] [--pi-config <path>]
 * 输出 JSON：{ root, dbPath, workspaceId, userData, cleanup }；默认输出到 stdout 并保留临时目录。
 * 配合 --cleanup 时在进程退出前删除临时根（供 CI 冒烟）。
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrateDatabase } from '../src/main/db/migrations.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_FIXTURE_SOURCE = path.join(REPO_ROOT, '.ai', 'wmb-5207-final-root');
const NOW = () => new Date().toISOString();

export function listFixtureSources() {
  const candidates = [
    DEFAULT_FIXTURE_SOURCE,
    path.join(REPO_ROOT, '.ai', 'wmb-5207-accept-root'),
    path.join(REPO_ROOT, '.ai', 'wmb-5207-final-user', '..', 'wmb-5207-final-root')
  ];
  return [...new Set(candidates)].filter((root) => existsSync(path.join(root, 'wmb.db')));
}

/** 源库只读打开并统计知识表行数（用于校验「真实工作空间副本」确实含知识数据）。 */
export function inspectSourceDatabase(dbPath) {
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = [
      'knowledge_change_sets', 'knowledge_notes', 'knowledge_note_versions',
      'knowledge_wiki_pages', 'knowledge_wiki_page_versions', 'knowledge_evidence_links',
      'knowledge_update_receipts', 'knowledge_query_artifacts', 'knowledge_health_issues',
      'knowledge_free_notes'
    ];
    const counts = {};
    for (const table of tables) {
      try {
        counts[table] = Number(source.prepare(`SELECT count(*) AS c FROM ${table}`).get().c);
      } catch {
        counts[table] = null; // 旧快照缺表（迁移前）→ 如实记录 null，不伪造
      }
    }
    const ws = source.prepare("SELECT value AS v FROM app_meta WHERE key = 'workspace_id'").get();
    const migration = source.prepare("SELECT value AS v FROM app_meta WHERE key = 'migration_version'").get();
    return { workspaceId: ws?.v ?? null, migrationVersion: migration?.v ?? null, counts };
  } finally {
    source.close();
  }
}

/**
 * 创建隔离验收 fixture。
 * @param {object} options
 * @param {'fresh'|'copy'} [options.mode] 默认 'fresh'
 * @param {string} [options.sourceRoot] copy 模式源根；缺省取 listFixtureSources()[0]
 * @param {string} [options.prefix] 临时根前缀，默认 'wmb-5234-accept-'
 * @param {string} [options.workspaceId] 默认 'ws-5234-acceptance'
 * @param {boolean} [options.seedAssets] 创建 browser-profile/logs/exports/assets/pi-agent 子目录
 */
export async function createIsolatedFixture(options = {}) {
  const { mode = 'fresh', sourceRoot, prefix = 'wmb-5234-accept-', workspaceId = 'ws-5234-acceptance', seedAssets = true } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(root, 'wmb.db');
  // 真实数据根必需目录（产品侧 validateDataRoot 校验 wmb.db + assets/browser-profile/logs/exports；
  // 缺失会让 loadSelectedDataRoot 失败 → 工作空间无法加载，UI 层必挂）。
  await Promise.all(['assets', 'browser-profile', 'logs', 'exports', 'pi-agent'].map(
    (name) => mkdir(path.join(root, name), { recursive: true }).catch(() => {})
  ));

  if (mode === 'copy') {
    const candidates = sourceRoot ? [sourceRoot] : listFixtureSources();
    const chosen = candidates.find((c) => existsSync(path.join(c, 'wmb.db')));
    if (!chosen) {
      throw Object.assign(
        new Error(`copy 模式需要真实工作空间源根（含 wmb.db），未找到：${JSON.stringify({ sourceRoot, candidates })}`),
        { code: 'FIXTURE_SOURCE_UNAVAILABLE' }
      );
    }
    const sourcePath = path.join(chosen, 'wmb.db');
    const sourceInfo = inspectSourceDatabase(sourcePath);
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${dbPath.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    if (!existsSync(dbPath)) throw new Error(`VACUUM INTO 未产出副本：${dbPath}`);
    // 真实工作空间副本 + 正式迁移：把旧快照升级到当前 schema（源库保持只读零写）
    const migrated = migrateDatabase(dbPath);
    try {
      if (!migrated.prepare("SELECT value AS v FROM app_meta WHERE key = 'workspace_id'").get()) {
        migrated.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)").run(workspaceId, NOW(), NOW());
      }
    } finally {
      migrated.close();
    }
    if (seedAssets) {
      // 复制源根非 DB 资产（真实工作空间形态），但不复制 logs/browser-profile 锁目录内容
      for (const name of ['assets']) {
        const src = path.join(chosen, name);
        if (existsSync(src)) {
          try {
            await rm(path.join(root, name), { recursive: true, force: true });
            await mkdir(path.join(root, name));
            const { cp } = await import('node:fs/promises');
            await cp(src, path.join(root, name), { recursive: true }).catch(() => { /* 资产缺失不阻断 DB 验收 */ });
          } catch { /* 同上 */ }
        }
      }
    }
    return { root, dbPath, workspaceId: sourceInfo.workspaceId ?? workspaceId, source: chosen, sourceInfo, mode, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
  }

  // fresh：正式 migrations 建库 + 绑定 workspace_id
  const db = migrateDatabase(dbPath);
  try {
    db.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)").run(workspaceId, NOW(), NOW());
  } finally {
    db.close();
  }
  return { root, dbPath, workspaceId, source: null, sourceInfo: null, mode, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

/**
 * 写入验收 userData 三件套（WMB_ACCEPTANCE_USER_DATA 指向该目录）。
 * onboarding 完成态 + workspace-registry 激活本 fixture 根 + pi-api-config
 * （提供 --pi-config 则逐字复制真实配置；否则写入指向 127.0.0.1:9 的显式 stub，
 * 使 Pi 不可用被如实呈现为「未配置」，绝不伪造 Pi 可用）。
 */
export async function writeAcceptanceUserData(userData, { workspaceId, rootPath, piConfigPath = null }) {
  await mkdir(userData, { recursive: true });
  const timestamp = new Date().toISOString();
  await (await import('node:fs/promises')).writeFile(
    path.join(userData, 'onboarding.json'),
    JSON.stringify({
      version: 1,
      state: {
        currentStep: 'complete',
        workspace: { workspaceId, rootPath, createdAt: timestamp },
        ai: { testedAt: timestamp, completedAt: timestamp },
        platforms: {},
        startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp
      }
    }, null, 2),
    'utf8'
  );
  await (await import('node:fs/promises')).writeFile(
    path.join(userData, 'workspace-registry.json'),
    JSON.stringify({
      version: 1,
      activeWorkspaceId: workspaceId,
      workspaces: [{ id: workspaceId, displayName: 'WMB-5234 验收', rootPath, createdAt: timestamp }],
      switchJournal: null
    }, null, 2),
    'utf8'
  );
  if (piConfigPath && existsSync(piConfigPath)) {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(piConfigPath, path.join(userData, 'pi-api-config.json'));
    // safeStorage 在 Windows 上把加密密钥绑定在 userData 的 Local State（OSCrypt v10）：
    // 只复制配置不解密 API Key 会抛 safeStorage.decryptString 错误。随配置一并复制
    // 真实 userData 的 Local State（同一 OS 用户，DPAPI 保护原样可读），使 Key 可解密。
    const realUserData = path.dirname(piConfigPath);
    const localState = path.join(realUserData, 'Local State');
    if (existsSync(localState)) {
      await copyFile(localState, path.join(userData, 'Local State')).catch(() => {});
    }
    return { piConfig: 'copied', piConfigSource: piConfigPath };
  }
  await (await import('node:fs/promises')).writeFile(
    path.join(userData, 'pi-api-config.json'),
    JSON.stringify({
      version: 1,
      state: {
        activeId: 'acceptance-profile',
        profiles: [{ id: 'acceptance-profile', name: 'WMB-5234 验收', baseUrl: 'http://127.0.0.1:9', model: 'acceptance-model', api: 'openai-responses', encryptedApiKey: 'dW51c2VkLWFjY2VwdGFuY2Uta2V5' }],
        fallbackOrder: []
      }
    }, null, 2),
    'utf8'
  );
  return { piConfig: 'stub-unreachable', piConfigSource: null };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a === '--mode') ? args[args.indexOf('--mode') + 1] : 'fresh';
  const sourceArg = args.find((a) => a === '--source') ? args[args.indexOf('--source') + 1] : null;
  const piArg = args.find((a) => a === '--pi-config') ? args[args.indexOf('--pi-config') + 1] : null;
  const cleanup = args.includes('--cleanup');
  const fixture = await createIsolatedFixture({ mode, sourceRoot: sourceArg ?? undefined });
  const userData = path.join(fixture.root, '..', `${path.basename(fixture.root)}-user`);
  await writeAcceptanceUserData(userData, { workspaceId: fixture.workspaceId, rootPath: fixture.root, piConfigPath: piArg });
  const report = { root: fixture.root, dbPath: fixture.dbPath, workspaceId: fixture.workspaceId, userData, mode: fixture.mode, source: fixture.source, sourceInfo: fixture.sourceInfo };
  if (cleanup) {
    console.log(JSON.stringify(report, null, 2));
    await fixture.cleanup();
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[wmb-5234-fixture] ${error?.code ?? 'ERROR'}: ${error.message}`);
    process.exit(1);
  });
}
