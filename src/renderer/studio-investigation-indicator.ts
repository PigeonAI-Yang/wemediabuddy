import type { StudioInvestigationModel } from './studio-investigation';

export type StudioInvestigationIndicator = Readonly<{
  state: 'active' | 'error' | 'idle';
  label: string;
}>;

export function studioInvestigationIndicator(
  model: StudioInvestigationModel | null | undefined
): StudioInvestigationIndicator {
  if (!model) return { state: 'idle', label: '当前无记者调查' };

  if (model.status === 'outline_rejected') {
    return { state: 'error', label: '调查提纲已驳回' };
  }

  if (model.status === 'failed' || model.reporter?.status === 'failed' || model.reporter?.errorMessage) {
    return { state: 'error', label: '记者调查报错' };
  }

  if (model.status === 'researching' && model.reporter?.status === 'running') {
    return { state: 'active', label: '记者正在调查' };
  }

  return { state: 'idle', label: '当前无记者调查' };
}
