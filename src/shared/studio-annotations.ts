// WMB-5207: Studio 正文批注共享契约（Data agent 所有）。
// 数据模型与 preload 方法名称由 local://wmb-5207-contract.md 定义；
// UI / Pi 侧只消费本文件类型，不持有数据层实现。

export type StudioDocumentKind = 'core' | 'platform';
export type StudioPlatform = 'x' | 'xiaohongshu' | 'wechat';

export type StudioDocumentScope = {
  projectId: string;
  documentKind: StudioDocumentKind;
  /** core: 当前核心内容版本锚点（未保存草稿时为 null）；platform: 平台版本 ID。 */
  documentId: string | null;
  /** core 必为 null；platform 必为具体平台。 */
  platform: StudioPlatform | null;
};

export type StudioAnnotationStatus = 'open' | 'resolved';
export type StudioAnnotationResolveReason = 'edited' | 'deleted' | 'ambiguous' | 'user_removed';

export type StudioAnnotation = StudioDocumentScope & {
  id: string;
  startOffset: number;
  endOffset: number;
  quotedText: string;
  prefixContext: string;
  suffixContext: string;
  bodyFingerprint: string;
  note: string | null;
  status: StudioAnnotationStatus;
  resolvedReason: StudioAnnotationResolveReason | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  revision: number;
};

export type StudioReconcileMode = 'incremental' | 'replacement';

/** preload 六方法的返回结构：复用现有项目的稳定 CommandResult 错误结构（code/message/details）。 */
export type StudioCommandResult<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: { code: string; message: string; details: Record<string, unknown> } };
