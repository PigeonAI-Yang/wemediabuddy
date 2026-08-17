import type { ContentMediaBindingDraft, MediaAlign, MediaWidthPreset } from './media-bindings.ts';

export const PI_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type PiImageMimeType = typeof PI_IMAGE_MIME_TYPES[number];
export const MAX_PI_IMAGE_ATTACHMENTS = 10;
export const MAX_PI_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PI_IMAGE_TOTAL_BYTES = 80 * 1024 * 1024;
export const PI_IMAGE_BATCH_MANIFEST_KEY = 'wmb_pi_image_placement' as const;

export type PiImageAttachmentPayload = Readonly<{
  fileName: string;
  mimeType: PiImageMimeType;
  bytesBase64: string;
  byteCount: number;
  width?: number | null;
  height?: number | null;
}>;
export type PiImageBatchStatus = 'queued' | 'importing' | 'analyzing' | 'saving' | 'completed' | 'failed_import' | 'failed_analysis' | 'conflicted' | 'failed_save' | 'canceled';
export type PiImageBatchAttachmentState = 'pending' | 'importing' | 'imported' | 'used' | 'unused' | 'failed';
export type PiImageBatchFailureStage = 'validation' | 'import' | 'analysis' | 'save' | 'readback' | 'conflict';

export type PiImageBatchAttachmentRecord = Readonly<{
  id: string; batchId: string; ordinal: number; sourceFileName: string; sourceMimeType: string; byteCount: number;
  width: number | null; height: number | null; sourceSha256: string; assetId: string | null; state: PiImageBatchAttachmentState;
  decisionReason: string | null; alt: string | null; caption: string | null; widthPreset: MediaWidthPreset | null; align: MediaAlign | null;
  coreVersionId: string | null; failureCode: string | null; failureMessage: string | null; createdAt: string; updatedAt: string; revision: number;
}>;
export type PiImageBatchRecord = Readonly<{
  id: string; requestId: string; projectId: string; baselineVersionId: string | null; expectedRevision: number; inputHash: string;
  userMessage: string; status: PiImageBatchStatus; failureStage: PiImageBatchFailureStage | null; failureCode: string | null;
  failureMessage: string | null; placementJson: string | null; targetVersionId: string | null; usedCount: number; unusedCount: number;
  createdAt: string; updatedAt: string; completedAt: string | null; revision: number; attachments: readonly PiImageBatchAttachmentRecord[];
}>;

export type PiImageBatchChatInput = Readonly<{
  message: string;
  delivery?: 'steer' | 'followUp';
  requestId: string;
  projectId: string;
  attachments: readonly PiImageAttachmentPayload[];
}>;

export type PiImageBatchAttachmentDecision = Readonly<{
  order: number;
  assetId: string;
  decision: 'used' | 'unused';
  reason?: string;
  alt?: string;
  caption?: string | null;
  widthPreset?: MediaWidthPreset;
  align?: MediaAlign;
}>;

export type PiImagePlacementManifest = Readonly<{
  [PI_IMAGE_BATCH_MANIFEST_KEY]: Readonly<{
    requestId: string;
    projectId: string;
    baselineVersionId: string | null;
    expectedRevision: number;
    body: string;
    decisions: readonly PiImageBatchAttachmentDecision[];
    mediaBindings: readonly ContentMediaBindingDraft[];
  }>;
}>;

export function isPiImageMimeType(value: unknown): value is PiImageMimeType {
  return typeof value === 'string' && (PI_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function isPiImageAttachmentPayload(value: unknown): value is PiImageAttachmentPayload {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.fileName === 'string'
    && isPiImageMimeType(item.mimeType)
    && typeof item.bytesBase64 === 'string'
    && typeof item.byteCount === 'number'
    && Number.isSafeInteger(item.byteCount)
    && item.byteCount > 0;
}

export function isPiImageBatchChatInput(value: unknown): value is PiImageBatchChatInput {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.message === 'string'
    && typeof item.requestId === 'string' && item.requestId.trim().length > 0
    && typeof item.projectId === 'string' && item.projectId.trim().length > 0
    && Array.isArray(item.attachments)
    && item.attachments.length > 0
    && item.attachments.every(isPiImageAttachmentPayload);
}

export function normalizePiImageBatchMessage(value: string): string {
  return value.trim() || '请根据当前正文的语义，为这些图片选择合理的插入位置；不合适的图片不要硬塞。';
}

export function piImageBatchManifestFence(text: string): string | null {
  const fences = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fences.length !== 1) return null;
  return fences[0][1].trim();
}
