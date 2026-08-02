import type { IntelligenceChannelReadiness, IntelligenceChannelsSummary, IntelligenceModule } from '../main/intelligence-channels';

export const intelligenceModules: IntelligenceModule[] = ['official_web', 'x_lists'];

export const intelligenceModuleLabels: Record<IntelligenceModule, string> = {
  official_web: '官网',
  x_lists: 'X Lists'
};

export function channelReadiness(summary: IntelligenceChannelsSummary | null | undefined, module: IntelligenceModule): IntelligenceChannelReadiness {
  return summary?.readiness.find((item) => item.module === module) ?? {
    module, configuredCount: 0, enabledCount: 0, readyCount: 0, blockedCount: 0, status: 'needs_config'
  };
}

export function dailyPreflightMessage(input: {
  summary: IntelligenceChannelsSummary | null | undefined;
  piConfigured: boolean;
  modules: IntelligenceModule[];
}): string | null {
  if (!input.piConfigured) return '请先在设置中配置 Pi API。';
  if (!input.modules.length) return '请至少选择一个情报模块。';
  const selected = input.modules.map((module) => channelReadiness(input.summary, module));
  if (selected.some((item) => item.readyCount > 0)) return null;
  if (selected.some((item) => item.blockedCount > 0)) return '已选来源需要浏览器登录或重新确认。';
  return '已选模块没有可运行的来源，请先在“发现 → 情报渠道”添加并启用来源。';
}
