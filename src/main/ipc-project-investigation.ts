/**
 * WMB-5290 项目专项调查 IPC（Owner UI 审批 + 主管派单编排）。
 *
 * - 九个渲染层 API（investigationGet/Initialize/SaveOutline/DecideOutline/ReviewResearch/
 *   SaveDirection/DecideDirection/StartWriter/RetryReporter），通道常量见 INVESTIGATION_IPC。
 * - 所有变更经 dispatchBusinessCommand（写守卫）落库并返回完整 ProjectInvestigation 读模型，
 *   广播 scopes=['studio','agent']。
 * - Owner-only 审批（DecideOutline/DecideDirection）只在本 IPC 面暴露（MCP 只读 + 草稿保存）。
 * - 记者/写手派单 = 「先记录工单引用 → spawner.spawn → 失败补偿回滚」：
 *   spawn 失败（如派工关闭）恢复派单前状态，审批快照保持不可变，事件说明原因。
 */

import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { broadcastDataChanged } from './data-changed.ts';
import { failure, success, type CommandResult } from './result.ts';
import {
  buildInvestigationReporterRequest,
  buildInvestigationWriterRequest,
  decideInvestigationDirection,
  decideInvestigationOutline,
  initializeProjectInvestigation,
  readProjectInvestigation,
  retryInvestigationReporter,
  reviewInvestigationResearch,
  revertInvestigationReporterDispatch,
  revertInvestigationWriterDispatch,
  saveInvestigationDirection,
  saveInvestigationOutline,
  startInvestigationWriter,
  type ProjectInvestigation
} from './project-investigation.ts';
import { ensureJobsSpawner } from './ipc-jobs.ts';
import { getActiveJobSpawner, type JobSpawner } from './job-spawner.ts';
import { dispatchBusinessCommand, requireCommandResultData } from './business-command.ts';
import { freshRequestId, ownerUiActor, readWorkspaceDatabase, requireBusinessRuntime, type BusinessIpcDependencies } from './ipc-business-context.ts';
import { continueAutomaticInvestigation } from './project-investigation-automation.ts';
import {
  INVESTIGATION_IPC,
  type InvestigationCommandResult,
  type InvestigationDecideOutlineInput,
  type InvestigationDecideDirectionInput,
  type InvestigationReviewResearchInput,
  type ProjectInvestigationStatus
} from '../shared/project-investigation.ts';
import type { CommandReceiptV1 } from './command-dispatcher.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';

function requireSpawner(runtime: ActiveWorkspaceRuntime): JobSpawner {
  return getActiveJobSpawner() ?? ensureJobsSpawner({ getActiveRuntime: () => runtime });
}

/** receipt → 渲染层 CommandResult（error.details 可缺省；ok 恒真时才带 data）。 */
function receiptResult(receipt: CommandReceiptV1<ProjectInvestigation>): InvestigationCommandResult {
  return receipt.ok
    ? { ok: true as const, data: receipt.data as ProjectInvestigation, error: null }
    : { ok: false as const, data: null, error: { code: receipt.error?.code ?? 'COMMAND_FAILED', message: receipt.error?.message ?? '命令失败。', details: receipt.error?.details } };
}


type ReporterSpawnAction = 'approve' | 'supplement' | 'retry';

/**
 * 记者派单编排（approve/supplement/retry 共用）：
 * 1. 预生成 jobId；2. DB 命令记录工单引用 + 状态转换（原子）；3. spawner.spawn（同 jobId）；
 * 4. spawn 失败 → 补偿回滚到派单前状态（审批快照不可变）。返回最新读模型。
 */
async function spawnInvestigationReporter(
  dependencies: BusinessIpcDependencies,
  input: { projectId: string; expectedRevision: number },
  action: ReporterSpawnAction,
  extra?: { direction?: unknown; decidedBy?: string }
): Promise<CommandResult<ProjectInvestigation>> {
  const runtime = await requireBusinessRuntime(dependencies);
  const spawner = requireSpawner(runtime);
  const previous = readProjectInvestigation(runtime.database, input.projectId);
  if (!previous) return failure('NOT_FOUND', '该项目尚未开展专项调查。', {});
  const previousStatus: ProjectInvestigationStatus = previous.status;
  const jobId = randomUUID();
  const command = action === 'approve' ? 'investigation.decide_outline'
    : action === 'supplement' ? 'investigation.review_research'
      : 'investigation.retry_reporter';
  const receipt = await dispatchBusinessCommand(runtime, {
    command,
    requestId: freshRequestId(),
    actor: ownerUiActor,
    input: { ...input, jobId, action, direction: extra?.direction, decidedBy: extra?.decidedBy },
    boundIdentity: { entityType: 'content_project', entityId: input.projectId },
    entityType: 'project_investigation',
    execute: (database, value) => {
      let result: CommandResult<ProjectInvestigation>;
      if (value.action === 'approve') {
        result = decideInvestigationOutline(database, {
          projectId: value.projectId,
          expectedRevision: value.expectedRevision,
          decision: 'approve',
          reporterJobId: value.jobId,
          decidedBy: value.decidedBy
        });
      } else if (value.action === 'supplement') {
        result = reviewInvestigationResearch(database, {
          projectId: value.projectId,
          expectedRevision: value.expectedRevision,
          decision: 'supplement',
          reporterJobId: value.jobId,
          decidedBy: value.decidedBy
        });
      } else {
        result = retryInvestigationReporter(database, {
          projectId: value.projectId,
          expectedRevision: value.expectedRevision,
          reporterJobId: value.jobId,
          decidedBy: value.decidedBy
        });
      }
      if (!result.ok) throw result.error;
      return { data: result.data, entityId: value.projectId, afterRevision: result.data.revision, readback: result.data };
    }
  });
  if (!receipt.ok) {
    return failure(receipt.error?.code as never, receipt.error?.message ?? '命令失败。', receipt.error?.details ?? {});
  }
  const recorded = receipt.data as ProjectInvestigation;
  const built = buildInvestigationReporterRequest(runtime.database, input.projectId, recorded.reporter?.round ?? 0);
  if (!built) {
    await dispatchBusinessCommand(runtime, {
      command: 'investigation.revert_reporter_dispatch',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { projectId: input.projectId, previousStatus, note: '记者工单请求构建失败（缺少已确认提纲），派单回滚。' },
      boundIdentity: { entityType: 'content_project', entityId: input.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(revertInvestigationReporterDispatch(database, {
          projectId: value.projectId,
          previousStatus: value.previousStatus,
          note: value.note
        }));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    return failure('INVALID_STATE', '记者工单请求构建失败（缺少已确认提纲版本）。', {});
  }
  try {
    spawner.spawn(built.request, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : 'JOB_SPAWN_FAILED';
    await dispatchBusinessCommand(runtime, {
      command: 'investigation.revert_reporter_dispatch',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { projectId: input.projectId, previousStatus, note: `记者派单失败（${code}：${message}），状态恢复为 ${previousStatus}；请重新确认后再次派单。` },
      boundIdentity: { entityType: 'content_project', entityId: input.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(revertInvestigationReporterDispatch(database, {
          projectId: value.projectId,
          previousStatus: value.previousStatus,
          note: value.note
        }));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    return failure(code as never, `记者派单失败：${message}`, {});
  }
  broadcastDataChanged({ scopes: ['studio', 'agent'], reason: `investigation.${action}` });
  return success(recorded);
}

/** 写手派单编排：记录工单引用 + writing → spawn → 失败补偿回 ready_to_write。 */
async function spawnInvestigationWriter(
  dependencies: BusinessIpcDependencies,
  input: { projectId: string; expectedRevision: number }
): Promise<CommandResult<ProjectInvestigation>> {
  const runtime = await requireBusinessRuntime(dependencies);
  const spawner = requireSpawner(runtime);
  const jobId = randomUUID();
  const receipt = await dispatchBusinessCommand(runtime, {
    command: 'investigation.start_writer',
    requestId: freshRequestId(),
    actor: ownerUiActor,
    input: { ...input, jobId },
    boundIdentity: { entityType: 'content_project', entityId: input.projectId },
    entityType: 'project_investigation',
    execute: (database, value) => {
      const data = requireCommandResultData(startInvestigationWriter(database, {
        projectId: value.projectId,
        expectedRevision: value.expectedRevision,
        writerJobId: value.jobId
      }));
      return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
    }
  });
  if (!receipt.ok) {
    return failure(receipt.error?.code as never, receipt.error?.message ?? '命令失败。', receipt.error?.details ?? {});
  }
  const recorded = receipt.data as ProjectInvestigation;
  const request = buildInvestigationWriterRequest(recorded);
  if (!request) return failure('INVALID_STATE', '写手工单请求构建失败（缺少已冻结方向）。', {});
  try {
    spawner.spawn(request, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code : 'JOB_SPAWN_FAILED';
    await dispatchBusinessCommand(runtime, {
      command: 'investigation.revert_writer_dispatch',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { projectId: input.projectId, note: `写手派单失败（${code}：${message}），状态恢复为 ready_to_write。` },
      boundIdentity: { entityType: 'content_project', entityId: input.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(revertInvestigationWriterDispatch(database, {
          projectId: value.projectId,
          note: value.note
        }));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    return failure(code as never, `写手派单失败：${message}`, {});
  }
  broadcastDataChanged({ scopes: ['studio', 'agent'], reason: 'investigation.start_writer' });
  return success(recorded);
}

export function registerProjectInvestigationIpc(dependencies: BusinessIpcDependencies): void {
  ipcMain.handle(INVESTIGATION_IPC.get, (_event, projectId: string) =>
    readWorkspaceDatabase(dependencies, () => null, database => readProjectInvestigation(database, projectId)));

  ipcMain.handle(INVESTIGATION_IPC.initialize, async (_event, projectId: string) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'investigation.initialize',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input: { projectId },
      boundIdentity: { entityType: 'content_project', entityId: projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(initializeProjectInvestigation(database, value.projectId));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio', 'agent'], reason: 'investigation.initialize' });
    return receiptResult(receipt);
  });

  ipcMain.handle(INVESTIGATION_IPC.saveOutline, async (_event, input: { projectId: string; expectedRevision: number; outline: unknown }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'investigation.outline_save',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input,
      boundIdentity: { entityType: 'content_project', entityId: input.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(saveInvestigationOutline(database, value));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio', 'agent'], reason: 'investigation.outline_save' });
    return receiptResult(receipt);
  });

  // Owner-only 审批：确认范围后立即派记者（先记录工单引用，spawn 失败回滚）。
  ipcMain.handle(INVESTIGATION_IPC.decideOutline, async (_event, input: InvestigationDecideOutlineInput) => {
    if (input.decision === 'reject') {
      const runtime = await requireBusinessRuntime(dependencies);
      const receipt = await dispatchBusinessCommand(runtime, {
        command: 'investigation.decide_outline',
        requestId: freshRequestId(),
        actor: ownerUiActor,
        input,
        boundIdentity: { entityType: 'content_project', entityId: input.projectId },
        entityType: 'project_investigation',
        execute: (database, value) => {
          const data = requireCommandResultData(decideInvestigationOutline(database, {
            projectId: value.projectId,
            expectedRevision: value.expectedRevision,
            decision: 'reject'
          }));
          return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
        }
      });
      if (receipt.ok) broadcastDataChanged({ scopes: ['studio', 'agent'], reason: 'investigation.outline_rejected' });
      return receiptResult(receipt);
    }
    return spawnInvestigationReporter(dependencies, { projectId: input.projectId, expectedRevision: input.expectedRevision }, 'approve');
  });

  ipcMain.handle(INVESTIGATION_IPC.reviewResearch, async (_event, input: InvestigationReviewResearchInput) => {
    if (input.decision === 'supplement') {
      return spawnInvestigationReporter(dependencies, { projectId: input.projectId, expectedRevision: input.expectedRevision }, 'supplement');
    }
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'investigation.review_research',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input,
      boundIdentity: { entityType: 'content_project', entityId: input.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(reviewInvestigationResearch(database, {
          projectId: value.projectId,
          expectedRevision: value.expectedRevision,
          decision: value.decision,
          direction: value.decision === 'accept' ? value.direction : undefined,
          decidedBy: 'desk'
        }));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio', 'agent'], reason: `investigation.review_research:${input.decision}` });
    return receiptResult(receipt);
  });

  ipcMain.handle(INVESTIGATION_IPC.saveDirection, async (_event, input: { projectId: string; expectedRevision: number; direction: unknown }) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'investigation.direction_save',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input,
      boundIdentity: { entityType: 'content_project', entityId: input.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(saveInvestigationDirection(database, value));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) broadcastDataChanged({ scopes: ['studio', 'agent'], reason: 'investigation.direction_save' });
    return receiptResult(receipt);
  });

  // Owner-only 第二次审批。
  ipcMain.handle(INVESTIGATION_IPC.decideDirection, async (_event, input: InvestigationDecideDirectionInput) => {
    const runtime = await requireBusinessRuntime(dependencies);
    const receipt = await dispatchBusinessCommand(runtime, {
      command: 'investigation.decide_direction',
      requestId: freshRequestId(),
      actor: ownerUiActor,
      input,
      boundIdentity: { entityType: 'content_project', entityId: input.projectId },
      entityType: 'project_investigation',
      execute: (database, value) => {
        const data = requireCommandResultData(decideInvestigationDirection(database, {
          projectId: value.projectId,
          expectedRevision: value.expectedRevision,
          decision: value.decision
        }));
        return { data, entityId: value.projectId, afterRevision: data.revision, readback: data };
      }
    });
    if (receipt.ok) {
      broadcastDataChanged({ scopes: ['studio', 'agent'], reason: `investigation.decide_direction:${input.decision}` });
      if (input.decision === 'approve') {
        await continueAutomaticInvestigation(runtime, requireSpawner(runtime), input.projectId);
      }
    }
    return receiptResult(receipt);
  });

  ipcMain.handle(INVESTIGATION_IPC.startWriter, (_event, input: { projectId: string; expectedRevision: number }) =>
    spawnInvestigationWriter(dependencies, input));

  ipcMain.handle(INVESTIGATION_IPC.retryReporter, (_event, input: { projectId: string; expectedRevision: number }) =>
    spawnInvestigationReporter(dependencies, input, 'retry'));
}
