import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildAdaptiveFormatDecision, parseFormatDecisionJson, isValidFormatDecision } from '../shared/daily-content-loop.ts';
import { transitionTargetInternal } from './daily-content-cycle.ts';

function nowIso(): string { return new Date().toISOString(); }

function requireProject(database: DatabaseSync, projectId: string): Record<string, unknown> {
  const proj = database.prepare('SELECT * FROM content_projects WHERE id=?').get(projectId) as Record<string, unknown> | undefined;
  if (!proj) throw Object.assign(new Error('内容项目不存在'), { code: 'NOT_FOUND' });
  return proj;
}

function validateDerivativeInput(database: DatabaseSync, input: { projectId: string; sourceContentVersionId: string; title: string; body: string; formatDecisionJson?: string }): { formatJson: string } {
  const title = (input.title ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!title) throw Object.assign(new Error('标题不能为空'), { code: 'VALIDATION_ERROR' });
  if (!body) throw Object.assign(new Error('脚本正文不能为空'), { code: 'VALIDATION_ERROR' });
  const sid = (input.sourceContentVersionId ?? '').trim();
  if (!sid) throw Object.assign(new Error('sourceContentVersionId 必填'), { code: 'VALIDATION_ERROR' });
  const ver = database.prepare('SELECT id, project_id FROM content_versions WHERE id=?').get(sid) as { id: string; project_id: string } | undefined;
  if (!ver) throw Object.assign(new Error('引用的文章版本不存在'), { code: 'NOT_FOUND' });
  if (ver.project_id !== input.projectId) throw Object.assign(new Error('引用的文章版本不属于该项目'), { code: 'VALIDATION_ERROR' });
  let formatJson = input.formatDecisionJson;
  if (!formatJson || !formatJson.trim()) {
    const article = database.prepare(`SELECT cv.body, cp.title
      FROM content_versions cv
      JOIN content_projects cp ON cp.id = cv.project_id
      WHERE cv.id = ?`).get(sid) as { body: string; title: string } | undefined;
    const fd = buildAdaptiveFormatDecision({ title: article?.title ?? title, body: article?.body ?? body });
    formatJson = JSON.stringify(fd);
  } else {
    // Validate provided json is auditable and not generic hardcoded stub
    const parsed = parseFormatDecisionJson(formatJson);
    // Additional adaptiveness check: reason must reference content characteristics, at least length or form
    const reason = (parsed.reason ?? '').toLowerCase();
    const suitable = (parsed.suitableForm ?? '').trim();
    if (!suitable) throw Object.assign(new Error('formatDecision suitableForm 不能为空'), { code: 'VALIDATION_ERROR' });
    // Ensure reason length > 12 and not the exact hardcoded generic string
    if (reason.length < 12) throw Object.assign(new Error('formatDecision reason 过短，需说明内容依据'), { code: 'VALIDATION_ERROR' });
    if (reason === 'generic' || reason === 'template') throw Object.assign(new Error('formatDecision 不能为硬编码模板'), { code: 'VALIDATION_ERROR' });
    formatJson = JSON.stringify(parsed);
  }
  return { formatJson };
}

export function ensureContentDerivativeInternal(database: DatabaseSync, projectId: string): unknown {
  requireProject(database, projectId);
  const existing = database.prepare("SELECT * FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(projectId) as Record<string, unknown> | undefined;
  if (existing) return existing;
  const id = randomUUID();
  const ts = nowIso();
  database.prepare("INSERT INTO content_derivatives (id, project_id, kind, created_at, updated_at, revision) VALUES (?,?,?,?,?,1)").run(id, projectId, 'video_script', ts, ts);
  return database.prepare('SELECT * FROM content_derivatives WHERE id=?').get(id);
}

export function saveDerivativeVersionInternal(database: DatabaseSync, input: { projectId: string; sourceContentVersionId: string; title: string; body: string; formatDecisionJson?: string; author?: string }): unknown {
  requireProject(database, input.projectId);
  const { formatJson } = validateDerivativeInput(database, input);
  const der = database.prepare("SELECT * FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(input.projectId) as { id: string } | undefined;
  let derivativeId: string;
  if (!der) {
    const ensured = ensureContentDerivativeInternal(database, input.projectId) as { id: string };
    derivativeId = ensured.id;
  } else derivativeId = der.id;
  const max = database.prepare('SELECT COALESCE(MAX(version_number),0) as m FROM content_derivative_versions WHERE derivative_id=?').get(derivativeId) as { m: number };
  const next = Number(max.m) + 1;
  const id = randomUUID();
  const ts = nowIso();
  database.prepare(`INSERT INTO content_derivative_versions (id, derivative_id, source_content_version_id, version_number, format_decision_json, title, body, status, author, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, derivativeId, input.sourceContentVersionId, next, formatJson, input.title.trim(), input.body.trim(), 'draft', input.author ?? 'ai', ts);
  database.prepare('UPDATE content_derivatives SET updated_at=?, revision=revision+1 WHERE id=?').run(ts, derivativeId);
  // Note: stale propagation for article->script is handled on article side; script draft does not regress target — only stale state is projection. But we ensure target not auto-completed.
  return database.prepare('SELECT * FROM content_derivative_versions WHERE id=?').get(id);
}

export function finalizeDerivativeVersionInternal(database: DatabaseSync, input: { projectId: string; expectedLatestVersionNumber?: number | null }): unknown {
  requireProject(database, input.projectId);
  const der = database.prepare("SELECT * FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(input.projectId) as { id: string } | undefined;
  if (!der) throw Object.assign(new Error('衍生不存在'), { code: 'NOT_FOUND' });
  const latest = database.prepare('SELECT * FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number DESC LIMIT 1').get(der.id) as { version_number: number; body: string; title: string; source_content_version_id: string; format_decision_json: string; author: string } | undefined;
  if (!latest) throw Object.assign(new Error('无版本可定稿'), { code: 'NOT_FOUND' });
  if (typeof input.expectedLatestVersionNumber === 'number' && Number(latest.version_number) !== Number(input.expectedLatestVersionNumber)) {
    throw Object.assign(new Error('revision 冲突'), { code: 'REVISION_CONFLICT' });
  }
  const sourceVersion = database.prepare('SELECT id FROM content_versions WHERE id=?').get(latest.source_content_version_id) as { id: string } | undefined;
  if (!sourceVersion) throw Object.assign(new Error('引用的文章版本不存在'), { code: 'NOT_FOUND' });
  let formatDecision: unknown;
  try {
    formatDecision = JSON.parse(latest.format_decision_json);
  } catch {
    throw Object.assign(new Error('formatDecision 非法 JSON'), { code: 'VALIDATION_ERROR' });
  }
  if (!isValidFormatDecision(formatDecision)) {
    throw Object.assign(new Error('formatDecision 非法'), { code: 'VALIDATION_ERROR' });
  }
  const next = Number(latest.version_number) + 1;
  const id = randomUUID();
  const ts = nowIso();
  database.prepare(`INSERT INTO content_derivative_versions (id, derivative_id, source_content_version_id, version_number, format_decision_json, title, body, status, author, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, der.id, latest.source_content_version_id, next, latest.format_decision_json, latest.title, latest.body, 'ready', latest.author, ts);
  database.prepare('UPDATE content_derivatives SET updated_at=?, revision=revision+1 WHERE id=?').run(ts, der.id);
  const saved = database.prepare('SELECT * FROM content_derivative_versions WHERE id=?').get(id) as Record<string, unknown>;
  const latestContent = database.prepare('SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1').get(input.projectId) as { id: string } | undefined;
  const project = database.prepare('SELECT status FROM content_projects WHERE id=?').get(input.projectId) as { status: string } | undefined;
  if (latestContent?.id === latest.source_content_version_id && project && ['ready', 'completed'].includes(project.status)) {
    const targets = database.prepare("SELECT id, status, revision FROM daily_content_targets WHERE project_id=? AND status IN ('article_ready','scripting')").all(input.projectId) as Array<{ id: string; status: 'article_ready' | 'scripting'; revision: number }>;
    for (const target of targets) {
      let revision = target.revision;
      if (target.status === 'article_ready') {
        const scripting = transitionTargetInternal(database, { targetId: target.id, expectedRevision: revision, toStatus: 'scripting' }) as { revision: number };
        revision = Number(scripting.revision);
      }
      transitionTargetInternal(database, { targetId: target.id, expectedRevision: revision, toStatus: 'completed' });
    }
  }
  return saved;
}

export function getDerivativeProjectionInternal(database: DatabaseSync, projectId: string): { derivative: Record<string, unknown> | null; versions: Record<string, unknown>[]; latest: Record<string, unknown> | null; isStale: boolean; readiness: string } {
  const der = database.prepare("SELECT * FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(projectId) as Record<string, unknown> | undefined;
  if (!der) return { derivative: null, versions: [], latest: null, isStale: false, readiness: 'no_script' };
  const versions = database.prepare('SELECT * FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number ASC').all((der as { id: string }).id) as Record<string, unknown>[];
  const latest = versions.length ? versions[versions.length - 1] as Record<string, unknown> : null;
  const latestContent = database.prepare('SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1').get(projectId) as { id: string } | undefined;
  const readyScript = latest && (latest as { status: string }).status === 'ready';
  const aligned = latest && latestContent && (latest as { source_content_version_id: string }).source_content_version_id === latestContent.id;
  const isStale = Boolean(readyScript && latestContent && !aligned);
  let readiness = 'no_article';
  if (!latestContent) readiness = 'no_article';
  else if (!latest) readiness = 'no_script';
  else if (isStale) readiness = 'stale';
  else if ((latest as { status: string }).status === 'ready' && aligned) readiness = 'script_ready';
  else readiness = 'script_draft';
  return { derivative: der, versions, latest, isStale, readiness };
}

export function getStudioDualProjectionInternal(database: DatabaseSync, projectId: string): Record<string, unknown> {
  const project = database.prepare('SELECT * FROM content_projects WHERE id=?').get(projectId) as Record<string, unknown> | undefined;
  if (!project) throw Object.assign(new Error('内容项目不存在'), { code: 'NOT_FOUND' });
  const contentVersions = database.prepare('SELECT id, version_number, created_at, author FROM content_versions WHERE project_id=? ORDER BY version_number ASC').all(projectId) as Record<string, unknown>[];
  const latestContent = database.prepare('SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1').get(projectId) as { id: string } | undefined;
  const projStatus = (project as { status: string }).status;
  const article = {
    latestVersionId: latestContent?.id ?? null,
    status: projStatus ?? null,
    versionCount: contentVersions.length,
    versions: contentVersions,
  };
  const derivProj = getDerivativeProjectionInternal(database, projectId);
  const latestDerivative = derivProj.latest as { source_content_version_id?: string; status?: string; format_decision_json?: string } | null;
  const formatDecision = latestDerivative?.format_decision_json ? (() => { try { return JSON.parse(latestDerivative.format_decision_json as string); } catch { return null; } })() : null;
  const compare = {
    articleVersionId: latestContent?.id ?? null,
    scriptSourceVersionId: (latestDerivative?.source_content_version_id as string) ?? null,
    isAligned: latestContent && latestDerivative ? latestContent.id === latestDerivative.source_content_version_id : false,
  };
  return {
    projectId,
    article,
    derivative: {
      id: (derivProj.derivative as { id?: string } | null)?.id ?? null,
      latestVersion: derivProj.latest,
      versions: derivProj.versions,
      isStale: derivProj.isStale,
      readiness: derivProj.readiness,
      formatDecision,
    },
    compare,
    readiness: derivProj.readiness,
    isStale: derivProj.isStale,
  };
}

// Helper for article side to regress stale targets
export function regressStaleTargetsForProject(database: DatabaseSync, projectId: string): void {
  const latestContent = database.prepare('SELECT id FROM content_versions WHERE project_id=? ORDER BY version_number DESC LIMIT 1').get(projectId) as { id: string } | undefined;
  if (!latestContent) return;
  // Find derivative latest ready script's source version
  const der = database.prepare("SELECT id FROM content_derivatives WHERE project_id=? AND kind='video_script'").get(projectId) as { id: string } | undefined;
  let isStale = false;
  if (der) {
    const v = database.prepare('SELECT status, source_content_version_id FROM content_derivative_versions WHERE derivative_id=? ORDER BY version_number DESC LIMIT 1').get(der.id) as { status: string; source_content_version_id: string } | undefined;
    if (v && v.status === 'ready' && v.source_content_version_id !== latestContent.id) isStale = true;
  }
  if (!isStale) return;
  // Regress any completed targets for this project
  const targets = database.prepare("SELECT id, status, cycle_id, revision FROM daily_content_targets WHERE project_id=? AND status='completed'").all(projectId) as Array<{ id: string; status: string; cycle_id: string; revision: number }>;
  for (const t of targets) {
    const ts = nowIso();
    database.prepare("UPDATE daily_content_targets SET status='scripting', updated_at=?, revision=revision+1 WHERE id=?").run(ts, t.id);
    // Recompute cycle settlement
    const cycleId = t.cycle_id;
    const cycle = database.prepare('SELECT status, target_count FROM daily_content_cycles WHERE id=?').get(cycleId) as { status: string; target_count: number } | undefined;
    if (!cycle) continue;
    if (cycle.status === 'completed') {
      database.prepare("UPDATE daily_content_cycles SET status='running', completed_at=NULL, updated_at=?, revision=revision+1 WHERE id=?").run(ts, cycleId);
    } else if (cycle.status === 'partial' || cycle.status === 'running') {
      // keep as is but ensure not completed
    }
  }
}
