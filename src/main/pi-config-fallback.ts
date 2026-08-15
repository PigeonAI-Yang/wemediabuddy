import type { ResolvedPiConfig } from './pi-config.ts';
import { resolvePiConfigChain } from './pi-config.ts';
import { humanizePiProviderError, isPiProviderFallbackError, PiRpcSupervisor } from './pi-runtime.ts';

export type PiFallbackEvent = {
  type: 'fallback-try' | 'fallback';
  profileId: string;
  profileName: string;
  model?: string;
  text: string;
  error?: string;
  failures?: string[];
};

export type PiRuntimeFactory = (config: ResolvedPiConfig) => PiRpcSupervisor | Promise<PiRpcSupervisor>;

type ResolveChain = (
  piConfigPath?: string,
  options?: { skipProfileIds?: Iterable<string> }
) => ResolvedPiConfig[];

/**
 * 按「当前预设 → 故障降级顺序」依次启动 Pi runtime。
 * 仅对可降级的 provider 错误尝试下一个；配置错误/业务错误直接抛出。
 */
export async function startPiRuntimeWithFallback(input: {
  piConfigPath?: string;
  skipProfileIds?: Iterable<string>;
  createRuntime: PiRuntimeFactory;
  onEvent?: (event: PiFallbackEvent) => void;
  resolveChain?: ResolveChain;
}): Promise<{ runtime: PiRpcSupervisor; config: ResolvedPiConfig; failures: string[] }> {
  const resolve = input.resolveChain ?? ((configPath, options) => resolvePiConfigChain(configPath, options));
  const chain = resolve(input.piConfigPath, { skipProfileIds: input.skipProfileIds });
  if (!chain.length) throw new Error('请先在设置中配置 Pi API。');

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
          failures: [...failures]
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
        text: `${config.name} 失败，正在尝试下一个 AI 服务…`,
        error: message
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(failures.at(-1) || 'Pi 模型服务不可用。');
}

/**
 * 已启动 runtime 在 prompt 阶段遇到可降级 provider 错误时，按剩余顺序换服务重试。
 * `run` 收到新 runtime/config 后应完整重跑本轮 prompt（会话文件可复用）。
 */
export async function runPiPromptWithFallback<T>(input: {
  piConfigPath?: string;
  initial: { runtime: PiRpcSupervisor; config: ResolvedPiConfig };
  createRuntime: PiRuntimeFactory;
  run: (runtime: PiRpcSupervisor, config: ResolvedPiConfig) => Promise<T>;
  onEvent?: (event: PiFallbackEvent) => void;
  onRuntimeChanged?: (runtime: PiRpcSupervisor, config: ResolvedPiConfig) => void;
  resolveChain?: ResolveChain;
}): Promise<{ result: T; runtime: PiRpcSupervisor; config: ResolvedPiConfig }> {
  const tried = new Set<string>([input.initial.config.id]);
  let runtime = input.initial.runtime;
  let config = input.initial.config;

  for (;;) {
    try {
      const result = await input.run(runtime, config);
      return { result, runtime, config };
    } catch (error) {
      if (!isPiProviderFallbackError(error)) throw error;
      const message = humanizePiProviderError(error instanceof Error ? error.message : String(error));
      input.onEvent?.({
        type: 'fallback-try',
        profileId: config.id,
        profileName: config.name,
        model: config.model,
        text: `${config.name} 失败，正在按设置顺序降级…`,
        error: message
      });
      await runtime.stop().catch(() => {});
      const next = await startPiRuntimeWithFallback({
        piConfigPath: input.piConfigPath,
        skipProfileIds: tried,
        createRuntime: input.createRuntime,
        onEvent: input.onEvent,
        resolveChain: input.resolveChain
      });
      tried.add(next.config.id);
      runtime = next.runtime;
      config = next.config;
      input.onEvent?.({
        type: 'fallback',
        profileId: config.id,
        profileName: config.name,
        model: config.model,
        text: `主服务不可用，已降级到 ${config.name}（${config.model}）`
      });
      input.onRuntimeChanged?.(runtime, config);
    }
  }
}
