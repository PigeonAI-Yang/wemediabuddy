import type { IntelligenceChannelReadiness, IntelligenceChannelsSummary, IntelligenceModule } from '../main/intelligence-channels';

export const intelligenceModules: IntelligenceModule[] = ['official_web', 'x_lists', 'zhihu_hot'];

export const intelligenceModuleLabels: Record<IntelligenceModule, string> = {
  official_web: '官网',
  x_lists: 'X Lists',
  zhihu_hot: '知乎 AI 专题'
};
export function channelReadiness(summary: IntelligenceChannelsSummary | null | undefined, module: IntelligenceModule): IntelligenceChannelReadiness {
  return summary?.readiness.find((item) => item.module === module) ?? {
    module, configuredCount: 0, enabledCount: 0, readyCount: 0, blockedCount: 0, status: 'needs_config'
  };
}

export function dailyPreflightMessage(input: {
  summary: IntelligenceChannelsSummary | null | undefined;
  piConfigured: boolean;
}): string | null {
  if (!input.piConfigured) return '请先在设置中配置 Pi API。';
  if (input.summary?.readiness.some((item) => item.readyCount > 0)) return null;
  if (input.summary?.readiness.some((item) => item.blockedCount > 0)) return '已有来源需要浏览器登录或重新确认。';
  return '没有可运行的情报渠道，请先在“发现 → 情报渠道”添加并启用来源。';
}
