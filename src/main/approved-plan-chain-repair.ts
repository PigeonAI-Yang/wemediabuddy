import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { EditorialDecision } from "../shared/editorial-thesis.ts";
import { validateProposalCompleteness } from "../shared/propagation.ts";
import {
  createInitialVersionForProjectFromPlanItem,
  createProjectFromPlanItem,
} from "./content.ts";
import { ensureApprovedPlanItemCarryDone } from "./ferment.ts";
import {
  validateEditorialKnowledgeRefs,
  validatePlanItemForReview,
  validateTruthGateSourceReferences,
  type ScoreReasonsInput,
} from "./planning-stage.ts";

export type ApprovedPlanItemThesisRepairInput = Readonly<{
  editorialDecision: EditorialDecision;
  scoreReasons: ScoreReasonsInput;
  approvedBy: string;
  reason: string;
}>;
export type ApprovedPlanItemChainRepairResult = Readonly<{
  planItemId: string;
  planItemRevision: number;
  projectId: string;
  projectRevision: number;
  contentVersionId: string;
  carryId: string;
  carryState: "done";
  repaired: boolean;
  actions: string[];
  thesisLockRepaired: boolean;
  rollbackBinding?: Readonly<{ referenceSha256: string; preStateHash: string }>;
}>;

export type ApprovedPlanItemRepairBinding = Readonly<{
  referenceSha256: string;
  preStateHash: string;
}>;

type ApprovedItemRow = {
  id: string;
  revision: number;
  planningStatus: string;
  title: string;
  priority: number;
  topicId: string | null;
  planDate: string;
  whyNow: string;
  timeliness: string;
  targetAudience: string;
  angle: string;
  pointOfView: string;
  titleGuidance: string;
  openingGuidance: string;
  structureGuidance: string;
  effortEstimate: string;
  platforms: string;
  formats: string;
  sourceIds: string;
  availableMaterials: string;
  missingMaterials: string;
  reviewIds: string;
  methodFindingIds: string;
  planningProvenance: string;
};

function repairError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** Full immutable pre-state used to bind a repair receipt to its reference backup. */
export function readApprovedPlanItemChainPreState(
  database: DatabaseSync,
  planItemId: string,
): Readonly<Record<string, unknown>> {
  const projects = database
    .prepare(
      "SELECT * FROM content_projects WHERE plan_item_id=? ORDER BY created_at, id",
    )
    .all(planItemId);
  const projectIds = (projects as Array<{ id: string }>).map(
    (project) => project.id,
  );
  const versions =
    projectIds.length === 0
      ? []
      : database
          .prepare(
            `SELECT cv.* FROM content_versions cv JOIN content_projects cp ON cp.id=cv.project_id
     WHERE cp.plan_item_id=? ORDER BY cv.project_id, cv.version_number, cv.id`,
          )
          .all(planItemId);
  const projectSources =
    projectIds.length === 0
      ? []
      : database
          .prepare(
            `SELECT cps.* FROM content_project_sources cps JOIN content_projects cp ON cp.id=cps.project_id
     WHERE cp.plan_item_id=? ORDER BY cps.project_id, cps.source_id`,
          )
          .all(planItemId);
  const carry = database
    .prepare(
      "SELECT * FROM work_carry_items WHERE object_type='plan_item' AND object_id=? ORDER BY id",
    )
    .all(planItemId);
  const planItem =
    database.prepare("SELECT * FROM plan_items WHERE id=?").get(planItemId) ??
    null;
  return Object.freeze({ planItem, projects, versions, projectSources, carry });
}

export function approvedPlanItemChainPreStateHash(
  database: DatabaseSync,
  planItemId: string,
): string {
  return createHash("sha256")
    .update(stableJson(readApprovedPlanItemChainPreState(database, planItemId)))
    .digest("hex")
    .toUpperCase();
}

function readApprovedItem(
  database: DatabaseSync,
  planItemId: string,
  expectedRevision: number,
): ApprovedItemRow {
  const row = database
    .prepare(
      `SELECT pi.id, pi.revision, pi.planning_status AS planningStatus,
      pi.title, pi.priority, pi.topic_id AS topicId, p.plan_date AS planDate,
      pi.why_now AS whyNow, pi.timeliness, pi.target_audience AS targetAudience,
      pi.angle, pi.point_of_view AS pointOfView, pi.title_guidance AS titleGuidance,
      pi.opening_guidance AS openingGuidance, pi.structure_guidance AS structureGuidance,
      pi.effort_estimate AS effortEstimate, pi.platforms_json AS platforms, pi.formats_json AS formats,
      pi.source_ids_json AS sourceIds, pi.available_materials_json AS availableMaterials,
      pi.missing_materials_json AS missingMaterials, pi.review_ids_json AS reviewIds,
      pi.method_finding_ids_json AS methodFindingIds, pi.planning_provenance_json AS planningProvenance
    FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE pi.id=?`,
    )
    .get(planItemId) as ApprovedItemRow | undefined;
  if (!row) throw repairError("NOT_FOUND", "approved plan item not found");
  if (row.revision !== expectedRevision)
    throw repairError(
      "REVISION_CONFLICT",
      "approved plan item revision changed",
    );
  if (row.planningStatus !== "approved")
    throw repairError(
      "NOT_APPROVED",
      "only approved plan items can be repaired",
    );
  return row;
}

function requireCompleteProposal(item: ApprovedItemRow): void {
  const validation = validateProposalCompleteness(item);
  if (!validation.valid) {
    throw repairError(
      "REPAIR_INPUT_INCOMPLETE",
      `approved plan item proposal is incomplete: ${validation.errors.join("; ")}`,
    );
  }
}

function requireSourceIds(item: ApprovedItemRow): string[] {
  let parsedSourceIds: string[];
  try {
    const parsed = JSON.parse(item.sourceIds);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((value) => typeof value !== "string" || !value.trim())
    )
      throw new Error("invalid source ids");
    parsedSourceIds = [...new Set(parsed.map((value) => value.trim()))];
  } catch {
    throw repairError(
      "REPAIR_INPUT_INCOMPLETE",
      "approved plan item does not contain valid source ids",
    );
  }
  return parsedSourceIds;
}

function parseJsonArray(value: string, field: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fail below
  }
  throw repairError(
    "REPAIR_INPUT_INCOMPLETE",
    `approved plan item ${field} is invalid`,
  );
}

function parseStringArray(value: string, field: string): string[] {
  const parsed = parseJsonArray(value, field);
  if (parsed.some((entry) => typeof entry !== "string")) {
    throw repairError(
      "REPAIR_INPUT_INCOMPLETE",
      `approved plan item ${field} must contain strings`,
    );
  }
  return parsed as string[];
}

function repairMissingThesisLock(
  database: DatabaseSync,
  item: ApprovedItemRow,
  thesisRepair: ApprovedPlanItemThesisRepairInput | undefined,
  actions: string[],
): void {
  if (!thesisRepair) return;
  const approvedBy = thesisRepair.approvedBy.trim();
  const reason = thesisRepair.reason.trim();
  if (!approvedBy || !reason)
    throw repairError(
      "THESIS_REPAIR_AUTH_REQUIRED",
      "thesis repair requires approvedBy and reason",
    );

  let provenance: Record<string, unknown>;
  try {
    provenance = JSON.parse(item.planningProvenance || "{}") as Record<
      string,
      unknown
    >;
  } catch {
    throw repairError(
      "THESIS_REPAIR_PROVENANCE_INVALID",
      "approved plan item provenance is invalid",
    );
  }
  if (provenance.thesis_lock)
    throw repairError(
      "THESIS_LOCK_ALREADY_EXISTS",
      "approved plan item already has a thesis lock",
    );
  if (
    provenance.editorial_decision &&
    stableJson(provenance.editorial_decision) !==
      stableJson(thesisRepair.editorialDecision)
  ) {
    throw repairError(
      "EDITORIAL_DECISION_CONFLICT",
      "existing editorial decision differs from the authorized thesis repair",
    );
  }

  const sourceIds = requireSourceIds(item);
  const reviewInput = {
    title: item.title,
    priority: item.priority,
    whyNow: item.whyNow,
    timeliness: item.timeliness,
    targetAudience: item.targetAudience,
    angle: item.angle,
    pointOfView: item.pointOfView,
    platforms: parseStringArray(item.platforms, "platforms"),
    formats: parseStringArray(item.formats, "formats"),
    titleGuidance: item.titleGuidance,
    openingGuidance: item.openingGuidance,
    structureGuidance: item.structureGuidance,
    effortEstimate: item.effortEstimate,
    sourceIds,
    availableMaterials: parseStringArray(
      item.availableMaterials,
      "available materials",
    ),
    missingMaterials: parseStringArray(
      item.missingMaterials,
      "missing materials",
    ),
    reviewIds: parseStringArray(item.reviewIds, "review ids"),
    methodFindingIds: parseStringArray(
      item.methodFindingIds,
      "method finding ids",
    ),
    topicId: item.topicId,
    editorialDecision: thesisRepair.editorialDecision,
    scoreReasons: thesisRepair.scoreReasons,
  };
  const validation = validatePlanItemForReview(reviewInput);
  if (!validation.valid) {
    throw Object.assign(
      repairError(
        "THESIS_REPAIR_VALIDATION_FAILED",
        `thesis repair validation failed: ${validation.errors.join("; ")}`,
      ),
      { errors: validation.errors },
    );
  }
  validateEditorialKnowledgeRefs(
    database,
    thesisRepair.editorialDecision,
    item.pointOfView,
  );
  validateTruthGateSourceReferences(
    database,
    thesisRepair.scoreReasons,
    sourceIds,
  );

  const now = new Date().toISOString();
  provenance.editorial_decision = thesisRepair.editorialDecision;
  provenance.thesis_lock = {
    version: "thesis_lock_v1",
    winnerThesis: thesisRepair.editorialDecision.winnerThesis,
    winnerLevel: thesisRepair.editorialDecision.winnerLevel,
    propagationPromise: {
      title: item.title,
      openingGuidance: item.openingGuidance,
    },
    claimBoundaries: (
      thesisRepair.scoreReasons.truthGate as Record<string, unknown>
    ).claims,
    approvedAt: now,
    approvedBy,
    repair: {
      version: "approved_thesis_repair_v1",
      reason,
      priorRevision: item.revision,
    },
  };
  const changed = database
    .prepare(
      `UPDATE plan_items
    SET score_reasons_json=?, planning_provenance_json=?, updated_at=?, revision=revision+1
    WHERE id=? AND revision=? AND planning_status='approved' AND json_type(planning_provenance_json, '$.thesis_lock') IS NULL`,
    )
    .run(
      JSON.stringify(thesisRepair.scoreReasons),
      JSON.stringify(provenance),
      now,
      item.id,
      item.revision,
    ).changes;
  if (changed !== 1)
    throw repairError(
      "REVISION_CONFLICT",
      "approved plan item changed during thesis repair",
    );
  item.revision += 1;
  item.planningProvenance = JSON.stringify(provenance);
  actions.push("thesis_lock_repaired");
}

function assertProjectMetadataMatches(
  database: DatabaseSync,
  projectId: string,
  item: ApprovedItemRow,
  sourceIds: string[],
): void {
  const project = database
    .prepare(
      "SELECT title, topic_id AS topicId FROM content_projects WHERE id=?",
    )
    .get(projectId) as { title: string; topicId: string | null } | undefined;
  const projectSourceIds = (
    database
      .prepare(
        "SELECT source_id AS sourceId FROM content_project_sources WHERE project_id=? ORDER BY source_id",
      )
      .all(projectId) as Array<{ sourceId: string }>
  ).map((row) => row.sourceId);
  const expectedSources = [...sourceIds].sort();
  const actualSources = [...new Set(projectSourceIds)].sort();
  if (
    !project ||
    project.title !== item.title ||
    project.topicId !== item.topicId ||
    JSON.stringify(actualSources) !== JSON.stringify(expectedSources)
  ) {
    throw repairError(
      "PROJECT_METADATA_MISMATCH",
      "existing project title, topic, or source lineage does not match the approved plan item",
    );
  }
}

function reconcileLegacyRepairProjectRevision(
  database: DatabaseSync,
  project: { id: string; revision: number },
  contentVersionId: string,
): boolean {
  if (project.revision !== 1) return false;
  const receipts = database
    .prepare(
      `SELECT result_json AS resultJson FROM command_receipts
    WHERE command='plan_item.repair_approved_chain' AND status='ok' AND result_json IS NOT NULL AND result_json LIKE ?`,
    )
    .all(`%${contentVersionId}%`) as Array<{ resultJson: string }>;
  const provenOldRepair = receipts.some(({ resultJson }) => {
    try {
      const result = JSON.parse(resultJson) as {
        contentVersionId?: string;
        actions?: unknown;
      };
      return (
        result.contentVersionId === contentVersionId &&
        Array.isArray(result.actions) &&
        result.actions.includes("initial_version_created")
      );
    } catch {
      return false;
    }
  });
  if (!provenOldRepair) return false;
  const changed = database
    .prepare("UPDATE content_projects SET revision=2 WHERE id=? AND revision=1")
    .run(project.id).changes;
  if (changed !== 1)
    throw repairError(
      "REVISION_CONFLICT",
      "content project revision changed during legacy repair reconciliation",
    );
  project.revision = 2;
  return true;
}

/** Caller must run this inside CommandDispatcher's transaction. */
export function repairApprovedPlanItemChain(
  database: DatabaseSync,
  input: {
    planItemId: string;
    expectedRevision: number;
    rollbackBinding?: ApprovedPlanItemRepairBinding;
    thesisRepair?: ApprovedPlanItemThesisRepairInput;
  },
): ApprovedPlanItemChainRepairResult {
  const preStateHash = approvedPlanItemChainPreStateHash(
    database,
    input.planItemId,
  );
  if (
    input.rollbackBinding &&
    input.rollbackBinding.preStateHash !== preStateHash
  ) {
    throw repairError(
      "REPAIR_PRESTATE_MISMATCH",
      "repair reference backup does not match the current pre-repair state",
    );
  }
  const item = readApprovedItem(
    database,
    input.planItemId,
    input.expectedRevision,
  );
  const actions: string[] = [];
  repairMissingThesisLock(database, item, input.thesisRepair, actions);
  let projects = database
    .prepare(
      `SELECT id, revision FROM content_projects WHERE plan_item_id=? ORDER BY created_at, id`,
    )
    .all(input.planItemId) as Array<{ id: string; revision: number }>;
  if (projects.length > 1)
    throw repairError(
      "AMBIGUOUS_PROJECTS",
      "multiple content projects point at the approved plan item",
    );

  if (projects.length === 0) {
    requireCompleteProposal(item);
    requireSourceIds(item);
    const created = createProjectFromPlanItem(
      database,
      input.planItemId,
      false,
    );
    if (!created.created)
      throw repairError(
        "PROJECT_CREATE_CONFLICT",
        "project creation was not unique",
      );
    projects = [{ id: created.id, revision: created.revision }];
    actions.push("project_and_initial_version_created");
  }
  const project = projects[0];
  let versions = database
    .prepare(
      `SELECT id, body, version_number AS versionNumber FROM content_versions
    WHERE project_id=? ORDER BY version_number, id`,
    )
    .all(project.id) as Array<{
    id: string;
    body: string;
    versionNumber: number;
  }>;
  if (versions.some((version) => !version.body.trim()))
    throw repairError(
      "EMPTY_CONTENT_VERSION",
      "existing content version body is empty",
    );
  if (versions.length === 0) {
    requireCompleteProposal(item);
    const sourceIds = requireSourceIds(item);
    assertProjectMetadataMatches(database, project.id, item, sourceIds);
    const created = createInitialVersionForProjectFromPlanItem(
      database,
      project.id,
      input.planItemId,
    );
    versions = [
      {
        id: created.id,
        body: created.body,
        versionNumber: created.versionNumber,
      },
    ];
    actions.push("initial_version_created");
  }

  const initialVersions = versions.filter(
    (version) => version.versionNumber === 1,
  );
  if (initialVersions.length !== 1)
    throw repairError(
      "MISSING_INITIAL_VERSION",
      "approved project must have exactly one non-empty version 1",
    );
  if (
    reconcileLegacyRepairProjectRevision(
      database,
      project,
      initialVersions[0].id,
    )
  ) {
    actions.push("project_revision_reconciled");
  }

  const parsedSourceIds = requireSourceIds(item);

  const carry = ensureApprovedPlanItemCarryDone(database, {
    planItemId: input.planItemId,
    title: item.title,
    priority: item.priority,
    topicId: item.topicId,
    sourceIds: parsedSourceIds,
    originPlanDate: item.planDate,
  });
  if (carry.created) actions.push("carry_created_done");
  else if (carry.completed) actions.push("carry_completed");

  const projectReadback = database
    .prepare(`SELECT id, revision FROM content_projects WHERE plan_item_id=?`)
    .all(input.planItemId) as Array<{ id: string; revision: number }>;
  const versionReadback = database
    .prepare(
      `SELECT id, body, version_number AS versionNumber FROM content_versions WHERE project_id=? ORDER BY version_number, id`,
    )
    .all(project.id) as Array<{
    id: string;
    body: string;
    versionNumber: number;
  }>;
  const carryReadback = database
    .prepare(`SELECT id, state FROM work_carry_items WHERE id=?`)
    .get(carry.id) as { id: string; state: string } | undefined;
  const initialVersionReadback = versionReadback.filter(
    (version) => version.versionNumber === 1,
  );
  if (
    projectReadback.length !== 1 ||
    initialVersionReadback.length !== 1 ||
    versionReadback.some((version) => !version.body.trim()) ||
    !carryReadback ||
    carryReadback.state !== "done"
  ) {
    throw repairError(
      "REPAIR_READBACK_FAILED",
      "approved plan item chain did not pass exact readback",
    );
  }
  const finalItem = database
    .prepare(
      `SELECT revision, planning_status AS planningStatus,
      json_extract(planning_provenance_json, '$.thesis_lock.version') AS thesisLockVersion
    FROM plan_items WHERE id=?`,
    )
    .get(input.planItemId) as
    | {
        revision: number;
        planningStatus: string;
        thesisLockVersion: string | null;
      }
    | undefined;
  const thesisLockRepaired = actions.includes("thesis_lock_repaired");
  if (
    !finalItem ||
    finalItem.revision !== item.revision ||
    finalItem.planningStatus !== "approved" ||
    (thesisLockRepaired && finalItem.thesisLockVersion !== "thesis_lock_v1")
  ) {
    throw repairError(
      "REPAIR_READBACK_FAILED",
      "approved plan item repair did not pass exact readback",
    );
  }
  return Object.freeze({
    planItemId: input.planItemId,
    planItemRevision: item.revision,
    projectId: project.id,
    projectRevision: projectReadback[0].revision,
    contentVersionId: initialVersionReadback[0].id,
    carryId: carryReadback.id,
    carryState: "done",
    repaired: actions.length > 0,
    actions,
    thesisLockRepaired,
    ...(input.rollbackBinding
      ? { rollbackBinding: input.rollbackBinding }
      : {}),
  });
}
