export const ILLUSTRATION_IPC = Object.freeze({
  list: 'illustration:list',
  get: 'illustration:get',
  start: 'illustration:start',
  retry: 'illustration:retry',
  regenerate: 'illustration:regenerate',
  undo: 'illustration:undo',
  imageConfigGet: 'illustration:image-config-get',
  imageConfigSave: 'illustration:image-config-save'
});

export const ILLUSTRATION_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21'] as const);
export type IllustrationRatio = (typeof ILLUSTRATION_RATIOS)[number];
export type IllustrationItemKind = 'source' | 'generated';
export type IllustrationItemPurpose = 'direct_evidence' | 'demonstration' | 'comparison' | 'background' | 'cover' | 'decoration';
export type IllustrationRunStatus = 'pending' | 'planning' | 'running' | 'partial' | 'completed' | 'failed' | 'conflicted';
export type IllustrationItemState = 'pending' | 'generating' | 'completed' | 'failed';

export type IllustrationItem = Readonly<{
  id: string;
  ordinal: number;
  itemKey: string;
  kind: IllustrationItemKind;
  claimKey: string;
  purpose: IllustrationItemPurpose;
  ratio: IllustrationRatio;
  requestText: string;
  contextSummary: string;
  sourceRevisionKey: string | null;
  sourceBindingId: string | null;
  sourceAssetId: string | null;
  assetId: string | null;
  previousAssetId: string | null;
  state: IllustrationItemState;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  contentVersionId: string | null;
}>;

export type IllustrationRun = Readonly<{
  id: string;
  requestId: string;
  projectId: string;
  sourceVersionId: string;
  sourceRevision: number;
  sourceBodyHash: string;
  sourceTitle: string;
  sourceIds: readonly string[];
  sourceRevisionKeys: readonly string[];
  imageProfileId: string | null;
  imageModel: string | null;
  defaultRatio: IllustrationRatio;
  maxGenerated: number;
  status: IllustrationRunStatus;
  targetVersionId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  revision: number;
  items: readonly IllustrationItem[];
}>;

export type IllustrationImageConfig = Readonly<{
  profileId: string;
  model: string;
  configured: boolean;
}>;

export type IllustrationStartInput = Readonly<{
  projectId: string;
  expectedRevision?: number;
  requestId?: string;
  imageProfileId?: string;
  imageModel?: string;
  ratio?: IllustrationRatio;
  maxGenerated?: number;
}>;

export type IllustrationItemRetryInput = Readonly<{ runId: string; itemId: string; requestId?: string }>;
export type IllustrationRegenerateInput = Readonly<{
  runId: string;
  itemId: string;
  ratio: IllustrationRatio;
  request?: string;
  requestId?: string;
}>;
export type IllustrationUndoInput = Readonly<{ runId: string; itemId: string; requestId?: string }>;

export type IllustrationCommandResult<T> = Readonly<{
  ok: boolean;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
}>;
