// Shared fixture seeding helpers for WMB-5243 Electron E2E scenarios.
//
// These helpers insert REAL rows into the isolated workspace wmb.db (schema is
// built by the app's own migrateDatabase inside seedWorkspace, so all tables and
// CHECK constraints match production exactly). No business code is touched; the
// app is the only writer after launch. Scenarios wire these into
// `launch.seedFixture` so the fixture exists BEFORE the app boots.
//
// Every helper mirrors a production write path's observable shape (verified
// against src/main sources / migrations), keeping assertions on user-visible DOM
// and real IPC, with the DB used only for dual readback.

import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const SEED_E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI_KEY_CACHE = path.join(SEED_E2E_ROOT, '.runtime', 'pi-encrypted-key.txt');

export const NOW = () => new Date().toISOString();

/** Shanghai business date (renderer main.tsx computes planDate the same way). */
export const shanghaiPlanDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

/** Open the fixture workspace DB (already migrated by seedWorkspace). */
export function openDb(dataRoot) {
  const db = new DatabaseSync(path.join(dataRoot, 'wmb.db'));
  db.exec('PRAGMA busy_timeout = 8000');
  return db;
}

/** Same normalization as src/main/ferment-read.ts normalizeTitle. */
export function normalizeTitle(value) {
  return String(value).normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
}

/** Same fingerprint contract as src/main/ferment.ts fingerprintPlanItem. */
export function fingerprintPlanItem({ title, topicId = null, sourceIds = [] }) {
  const sources = [...new Set((sourceIds || []).filter(Boolean))].sort().join(',');
  return createHash('sha256')
    .update(`plan_item|${topicId || ''}|${normalizeTitle(title)}|${sources}`)
    .digest('hex')
    .slice(0, 32);
}

/** Insert a plan + items for a business date (is_current=1 like a real saved plan). */
export function seedPlan(db, { planDate = shanghaiPlanDate(), items = [] }) {
  const planId = randomUUID();
  db.prepare(`INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision)
    VALUES (?, ?, 'Asia/Shanghai', ?, 1, ?, ?, 1)`).run(planId, planDate, 'E2E 计划', NOW(), NOW());
  const itemIds = [];
  items.forEach((item, index) => {
    const itemId = item.id ?? randomUUID();
    db.prepare(`INSERT INTO plan_items (
      id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view,
      platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate,
      source_ids_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, 1)`).run(
      itemId, planId, item.topicId ?? null, item.title, item.priority ?? 2, item.whyNow ?? 'E2E 入选理由',
      item.timeliness ?? '长青', item.targetAudience ?? 'AI 从业者', item.angle ?? 'E2E 表达角度',
      item.pointOfView ?? 'E2E 核心观点', JSON.stringify(item.platforms ?? ['x']),
      JSON.stringify(item.formats ?? ['短文']), item.titleGuidance ?? 'E2E 标题方向',
      item.openingGuidance ?? 'E2E 开头方向', item.structureGuidance ?? 'E2E 结构方向',
      item.effortEstimate ?? '1', JSON.stringify(item.sourceIds ?? []), index, NOW(), NOW());
    itemIds.push(itemId);
  });
  return { planId, itemIds };
}

/** Insert a source_item (mirrors upsertSource shape; collectedAt defaults to now = today in Shanghai). */
export function seedSource(db, { id, title, summary = null, author = null, originalUrl = null, collectedAt = NOW(), categories = [] }) {
  const sourceId = id ?? randomUUID();
  const canonicalUrl = originalUrl ?? null;
  const fingerprint = canonicalUrl
    ? null
    : createHash('sha256').update(`e2e|${title}|${author ?? ''}|${summary ?? ''}`).digest('hex');
  db.prepare(`INSERT INTO source_items (
    id, feed_id, original_url, canonical_url, content_fingerprint, title, author, published_at, collected_at, summary,
    categories_json, keywords_json, value_judgment, ip_relevance, creation_angles,
    recommended_platforms_json, recommended_formats_json, timeliness, priority, evidence, client_label,
    created_at, updated_at, revision)
    VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '[]', NULL, NULL, NULL, '[]', '[]', NULL, NULL, NULL, NULL, ?, ?, 1)`).run(
    sourceId, originalUrl ?? null, canonicalUrl, fingerprint, title, author ?? null, collectedAt, summary ?? null,
    JSON.stringify(categories), NOW(), NOW());
  return sourceId;
}

/** Insert an active theme topic (status active, unique canonical_key). */
export function seedTopic(db, { id, title, summary = null }) {
  const topicId = id ?? randomUUID();
  db.prepare(`INSERT INTO topics (id, title, canonical_key, kind, summary, status, first_seen_at, last_seen_at, created_at, updated_at, revision)
    VALUES (?, ?, ?, 'theme', ?, 'active', ?, ?, ?, ?, 1)`).run(
    topicId, title, title.trim().toLowerCase(), summary, NOW(), NOW(), NOW(), NOW());
  return topicId;
}

/** Link a source to a topic (fermenting rail signal). */
export function seedTopicSourceLink(db, { topicId, sourceId, relation = 'primary' }) {
  db.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(topicId, sourceId, relation, NOW(), NOW());
}

/**
 * Insert an agent_tasks row with a job contract in context_refs_json
 * (readJobContractFromRefs: jobId + roleId + brief; mirrors buildJobContextRefs).
 */
export function seedAgentTask(db, {
  id, intent = 'research', status = 'succeeded', phase = 'done', businessDate = null,
  roleId = 'reporter', brief = 'E2E 任务', jobId = null, progress = {},
  events = [], errorCode = null, errorMessage = null, finishedAt = null
}) {
  const taskId = id ?? randomUUID();
  const refs = JSON.stringify({ jobId, roleId, brief, businessDate: businessDate ?? shanghaiPlanDate() });
  db.prepare(`INSERT INTO agent_tasks (
    id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
    progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message,
    created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', ?, '{}', ?, NULL, ?, ?, ?, ?, ?, ?)`).run(
    taskId, intent, businessDate ?? shanghaiPlanDate(), status, phase, refs, JSON.stringify(progress),
    JSON.stringify(events), NOW(), errorCode, errorMessage, NOW(), NOW(), finishedAt ?? NOW());
  return taskId;
}

/** Insert a content project bound to a plan item (adopted proposal). */
export function seedContentProject(db, { id, planItemId = null, title = 'E2E 项目' }) {
  const projectId = id ?? randomUUID();
  db.prepare(`INSERT INTO content_projects (id, topic_id, plan_item_id, title, created_at, updated_at, revision, status, archived_at)
    VALUES (?, NULL, ?, ?, ?, ?, 1, 'drafting', NULL)`).run(projectId, planItemId, title, NOW(), NOW());
  return projectId;
}

/** Seed the ranking cache (DiscoverView reads it via rankings:get-cached, zero network). */
export function seedRankingCache(db, { fetchedAt = NOW(), boards }) {
  db.prepare(`INSERT INTO ranking_cache (id, payload_json, fetched_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`)
    .run(JSON.stringify({ fetchedAt, boards }), fetchedAt);
}

/** Seed the X List index cache (XListsView renders groups from it, zero network). */
export function seedXListIndex(db, { accountKey = 'e2e-account', lists = [], capturedAt = NOW() }) {
  const value = {
    accountKey,
    lists,
    observation: { capturedAt, pageUrl: 'https://x.com/e2e/lists', fingerprint: 'e2e-index', visibleText: 'E2E' }
  };
  db.prepare(`INSERT INTO x_list_index_cache (id, account_key, payload_json, fetched_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account_key = excluded.account_key, payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`)
    .run(accountKey, JSON.stringify(value), capturedAt);
}

/** Seed the X List timeline cache (browse preview renders posts, zero network). */
export function seedXListTimeline(db, { accountKey = 'e2e-account', listId, posts = [], fetchedAt = NOW() }) {
  const payload = { accountKey, listId, detail: null, posts };
  db.prepare(`INSERT INTO x_list_timeline_cache (
    account_key, list_id, payload_json, posts_count, payload_bytes, fetched_at, last_accessed_at, source, schema_version, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'live', 2, '')`).run(
    accountKey, listId, JSON.stringify(payload), posts.length,
    Buffer.byteLength(JSON.stringify(payload), 'utf8'), fetchedAt, fetchedAt);
}

/** Seed a source_feeds row (referenced by x_list_bindings). */
export function seedSourceFeed(db, { id, name, url = null }) {
  db.prepare(`INSERT INTO source_feeds (id, name, url, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, 1)`).run(id, name, url, NOW(), NOW());
  return id;
}

/** Seed an X List binding (required for timeline cache reads). */
export function seedXListBinding(db, { id, accountKey, listId, canonicalUrl, ownerHandle, name, kind, sourceFeedId, enabled = 1 }) {
  db.prepare(`INSERT INTO x_list_bindings (
    id, account_key, list_id, canonical_url, owner_handle, name, list_kind, source_feed_id,
    enabled, last_observed_at, last_observation_json, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 1)`).run(
    id, accountKey, listId, canonicalUrl, ownerHandle, name, kind, sourceFeedId,
    enabled, NOW(), NOW(), NOW());
  return id;
}

/**
 * Rewrite the Pi config to a LOCAL unreachable endpoint (127.0.0.1:9) so any
 * incidental job execution fails instantly with ECONNREFUSED — zero external
 * network side effects, while the config shape still satisfies onboarding
 * aiReady (active profile + encrypted key). The harness default points at
 * api.openai.com, which scenarios must never actually call.
 */
/**
 * 真实可解的 Pi key：主进程 safeStorage 是 DPAPI 加密，测试进程无法直接生成，
 * 这里一次性借道真实 Electron 主进程加密，结果缓存到 .runtime（gitignored，随机器用户变化自动重生成）。
 * 用途：需要 Pi 配置在应用内真正可解密（如 AG-004 取消运行中实例）的夹具。
 */
let cachedEncryptedPiKey = null;
export async function encryptedPiKey() {
  if (cachedEncryptedPiKey) return cachedEncryptedPiKey;
  if (existsSync(PI_KEY_CACHE)) {
    const cached = readFileSync(PI_KEY_CACHE, 'utf8').trim();
    if (cached) { cachedEncryptedPiKey = cached; return cached; }
  }
  const helper = path.join(SEED_E2E_ROOT, '.runtime', 'pi-key-helper.js');
  writeFileSync(helper, `const { app, safeStorage } = require('electron');
app.whenReady().then(() => {
  try {
    process.stdout.write('WMB_PI_KEY=' + safeStorage.encryptString('e2e-placeholder-key-do-not-use').toString('base64') + '\\n');
  } catch (error) {
    process.stdout.write('WMB_PI_KEY_ERR=' + (error && error.message ? error.message : String(error)) + '\\n');
  }
  app.exit(0);
});
`);
  const result = spawnSync(require('electron'), [helper], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    windowsHide: true
  });
  const match = /WMB_PI_KEY=(\S+)/.exec(result.stdout ?? '');
  if (!match) {
    throw new Error(`无法生成真实加密 Pi key: ${(result.stdout ?? '').slice(0, 300)} ${(result.stderr ?? '').slice(0, 300)}`);
  }
  cachedEncryptedPiKey = match[1];
  try { writeFileSync(PI_KEY_CACHE, cachedEncryptedPiKey); } catch { /* 缓存尽力而为 */ }
  return cachedEncryptedPiKey;
}

/** 通用 Pi 配置文件写入（真实加密 key + 自定义 baseUrl，供运行中实例/取消等场景）。 */
export function writePiConfigFile(userDataDir, { baseUrl, encryptedApiKey }) {
  const config = {
    version: 1,
    state: {
      activeId: 'e2e',
      profiles: [{
        id: 'e2e',
        name: 'E2E 占位配置',
        baseUrl,
        model: 'gpt-5.4',
        api: 'openai-responses',
        thinking: 'medium',
        nativeSearch: false,
        contextWindow: 400000,
        maxTokens: 65536,
        encryptedApiKey
      }],
      fallbackOrder: ['e2e']
    }
  };
  writeFileSync(path.join(userDataDir, 'pi-api-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function writeLocalPiConfig(userDataDir) {
  return writePiConfigFile(userDataDir, {
    baseUrl: 'http://127.0.0.1:9',
    encryptedApiKey: Buffer.from('e2e-placeholder-key-do-not-use').toString('base64')
  });
}
