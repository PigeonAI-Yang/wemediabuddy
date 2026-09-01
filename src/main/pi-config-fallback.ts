import type { ModelPolicySnapshot, ResolvedPiConfig, RoleId } from './pi-config.ts';
import { resolveRoleModelPolicySnapshot, resolveRolePiConfigChain, roleModelCandidateKey } from './pi-config.ts';
import { humanizePiProviderError, isPiProviderFallbackError, PiRpcSupervisor } from './pi-runtime.ts';

export type PiFallbackEvent = {
  type: 'fallback-try' | 'fallback';
  profileId: string;
  profileName: string;
  model?: string;
  text: string;
  error?: string;
  failures?: string[];
  roleId: RoleId;
  policyRevision: number;
  taskId?: string;
};

export type PiRuntimeFactory = (config: ResolvedPiConfig) => PiRpcSupervisor | Promise<PiRpcSupervisor>;

type ResolveChain = (
  roleId: RoleId,
  policySnapshot?: ModelPolicySnapshot,
  piConfigPath?: string,
  options?: { skipCandidateKeys?: Iterable<string> }
) => ResolvedPiConfig[];

function policyError(code: string, message: string, details: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, details });
}

function chainExhaustedError(input: {
  roleId: RoleId;
  policySnapshot: ModelPolicySnapshot;
  taskId?: string;
  failures: string[];
  lastError: unknown;
}): Error {
  const detail = input.failures.join('；') || humanizePiProviderError(input.lastError instanceof Error ? input.lastError.message : String(input.lastError));
  return Object.assign(new Error(`角色模型链已耗尽：${detail}`), {
    code: 'ROLE_MODEL_CHAIN_EXHAUSTED',
    details: { state: 'needs_user', roleId: input.roleId, policyRevision: input.policySnapshot.revision, taskId: input.taskId, failures: [...input.failures] },
    failures: [...input.failures]
  });
}

function terminalRoleModelError(input: {
  error: unknown;
  roleId: RoleId;
  policySnapshot: ModelPolicySnapshot;
  taskId?: string;
  profileId?: string;
  failures: string[];
}): Error {
  const raw = input.error instanceof Error ? input.error.message : String(input.error ?? '');
  const details = {
    state: 'needs_user',
    roleId: input.roleId,
    policyRevision: input.policySnapshot.revision,
    taskId: input.taskId,
    profileId: input.profileId,
    failures: [...input.failures]
  };
  if (/invalid.?api.?key|incorrect api key|unauthorized|\b401\b|\b403\b/i.test(raw)) {
    return policyError('ROLE_MODEL_AUTH_FAILED', humanizePiProviderError(raw), details);
  }
  if (/model.{0,24}(not found|does not exist|unsupported)|unknown model|invalid model|unsupported (api|protocol)|context.{0,24}(limit|window)|max.?tokens|configuration|config invalid|\b404\b/i.test(raw)) {
    return policyError('ROLE_MODEL_CONFIG_INVALID', humanizePiProviderError(raw), details);
  }
  return input.error instanceof Error ? input.error : new Error(raw || 'Pi 模型服务不可用。');
}

function resolvePolicySnapshot(input: { roleId: RoleId; policySnapshot?: ModelPolicySnapshot; piConfigPath?: string }): ModelPolicySnapshot {
  return input.policySnapshot ?? resolveRoleModelPolicySnapshot(input.roleId, input.piConfigPath);
}

/**
 * 按指定角色的冻结策略依次启动 Pi runtime。
 * 仅对可降级的 provider 错误尝试下一个；配置错误/业务错误直接抛出。
 */
export async function startPiRuntimeWithFallback(input: {
  roleId: RoleId;
  policySnapshot?: ModelPolicySnapshot;
  taskId?: string;
  piConfigPath?: string;
  skipCandidateKeys?: Iterable<string>;
  createRuntime: PiRuntimeFactory;
  onEvent?: (event: PiFallbackEvent) => void;
  resolveChain?: ResolveChain;
}): Promise<{ runtime: PiRpcSupervisor; config: ResolvedPiConfig; failures: string[] }> {
  const snapshot = resolvePolicySnapshot(input);
  const resolve: ResolveChain = input.resolveChain ?? ((roleId, policy, configPath) => resolveRolePiConfigChain(roleId, policy, configPath));
  const skipCandidateKeys = new Set(input.skipCandidateKeys ?? []);
  const chain = resolve(input.roleId, snapshot, input.piConfigPath, { skipCandidateKeys }).filter((config, index, all) => {
    const candidateKey = roleModelCandidateKey(config.id, config.model);
    return !skipCandidateKeys.has(candidateKey) && all.findIndex((item) => roleModelCandidateKey(item.id, item.model) === candidateKey) === index;
  });
  if (!chain.length) throw policyError('ROLE_MODEL_POLICY_REQUIRED', '当前角色没有可用的模型策略。', {
    state: 'needs_user', roleId: input.roleId, policyRevision: snapshot.revision, taskId: input.taskId
  });

  const failures: string[] = [];
  let lastError: unknown;

  for (let index = 0; index < chain.length; index += 1) {
    const config = chain[index]!;
    let runtime: PiRpcSupervisor | null = null;
    try {
      runtime = await input.createRuntime(config);
      await runtime.start();
      if (failures.length) {
        input.onEvent?.({
          type: 'fallback',
          profileId: config.id,
          profileName: config.name,
          model: config.model,
          text: `主服务不可用，已降级到 ${config.name}（${config.model}）`,
          failures: [...failures],
          roleId: input.roleId,
          policyRevision: snapshot.revision,
          taskId: input.taskId
        });
      }
      return { runtime, config, failures: [...failures] };
    } catch (error) {
      lastError = error;
      const message = humanizePiProviderError(error instanceof Error ? error.message : String(error));
      failures.push(`${config.name}: ${message}`);
      await runtime?.stop().catch(() => {});
      const hasNext = index < chain.length - 1 && isPiProviderFallbackError(error);
      if (!hasNext) break;
      input.onEvent?.({
        type: 'fallback-try',
        profileId: config.id,
        profileName: config.name,
        model: config.model,
        text: `${config.name}（${config.model}）失败，正在尝试下一个模型候选…`,
        error: message,
        roleId: input.roleId,
        policyRevision: snapshot.revision,
        taskId: input.taskId
      });
    }
  }

  if (lastError && isPiProviderFallbackError(lastError) && failures.length > 0) {
    throw chainExhaustedError({ roleId: input.roleId, policySnapshot: snapshot, taskId: input.taskId, failures, lastError });
  }
  throw terminalRoleModelError({
    error: lastError,
    roleId: input.roleId,
    policySnapshot: snapshot,
    taskId: input.taskId,
    profileId: chain.at(-1)?.id,
    failures
  });
}

/**
 * 已启动 runtime 在 prompt 阶段遇到可降级 provider 错误时，按同一角色冻结策略的剩余顺序换服务重试。
 * `run` 收到新 runtime/config 后应完整重跑本轮 prompt（会话文件可复用）。
 */
export async function runPiPromptWithFallback<T>(input: {
  roleId: RoleId;
  policySnapshot?: ModelPolicySnapshot;
  taskId?: string;
  piConfigPath?: string;
  initial: { runtime: PiRpcSupervisor; config: ResolvedPiConfig };
  createRuntime: PiRuntimeFactory;
  run: (runtime: PiRpcSupervisor, config: ResolvedPiConfig) => Promise<T>;
  onEvent?: (event: PiFallbackEvent) => void;
  onRuntimeChanged?: (runtime: PiRpcSupervisor, config: ResolvedPiConfig) => void;
  resolveChain?: ResolveChain;
}): Promise<{ result: T; runtime: PiRpcSupervisor; config: ResolvedPiConfig }> {
  const snapshot = resolvePolicySnapshot(input);
  const triedCandidateKeys = new Set<string>([roleModelCandidateKey(input.initial.config.id, input.initial.config.model)]);
  const resolve: ResolveChain = input.resolveChain ?? ((roleId, policy, configPath) => resolveRolePiConfigChain(roleId, policy, configPath));
  const connectionSnapshot = Object.freeze(resolve(input.roleId, snapshot, input.piConfigPath).map((candidate) => Object.freeze({ ...candidate })));
  let runtime = input.initial.runtime;
  let config = input.initial.config;

  for (;;) {
    try {
      const result = await input.run(runtime, config);
      return { result, runtime, config };
    } catch (error) {
      if (!isPiProviderFallbackError(error)) {
        throw terminalRoleModelError({
          error,
          roleId: input.roleId,
          policySnapshot: snapshot,
          taskId: input.taskId,
          profileId: config.id,
          failures: [`${config.name}: ${humanizePiProviderError(error instanceof Error ? error.message : String(error))}`]
        });
      }
      const message = humanizePiProviderError(error instanceof Error ? error.message : String(error));
      input.onEvent?.({
        type: 'fallback-try',
        profileId: config.id,
        profileName: config.name,
        model: config.model,
        text: `${config.name}（${config.model}）失败，正在按设置顺序降级…`,
        error: message,
        roleId: input.roleId,
        policyRevision: snapshot.revision,
        taskId: input.taskId
      });
      await runtime.stop().catch(() => {});
      const next = await startPiRuntimeWithFallback({
        roleId: input.roleId,
        policySnapshot: snapshot,
        taskId: input.taskId,
        piConfigPath: input.piConfigPath,
        skipCandidateKeys: triedCandidateKeys,
        createRuntime: input.createRuntime,
        onEvent: input.onEvent,
        resolveChain: () => [...connectionSnapshot]
      });
      triedCandidateKeys.add(roleModelCandidateKey(next.config.id, next.config.model));
      runtime = next.runtime;
      config = next.config;
      input.onEvent?.({
        type: 'fallback',
        profileId: config.id,
        profileName: config.name,
        model: config.model,
        text: `主服务不可用，已降级到 ${config.name}（${config.model}）`,
        failures: next.failures.length ? [...next.failures] : undefined,
        roleId: input.roleId,
        policyRevision: snapshot.revision,
        taskId: input.taskId
      });
      input.onRuntimeChanged?.(runtime, config);
    }
  }
}
