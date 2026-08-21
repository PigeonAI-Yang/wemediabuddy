// extracted from studio-view.tsx (structural split)
import { useCallback } from 'react';
import { bodyWithoutLeadingTitle, htmlToMarkdown, insertTextAtCursor, looksLikeMarkdown, renderMarkdown, wrapTextareaSelection, type StudioAssetImageRef } from './studio-view-helpers';
import { contentBindingKey, type ContentMediaBindingDraft, type MediaAlign, type MediaWidthPreset } from '../shared/media-bindings';
import type { ContentProjectDetail } from '../main/content';
import type { StudioTab } from './studio-platform-tabs';
import { createStudioPlatformDraft, studioPlatformDraftKey, type StudioPlatformDraft } from './studio-platform-tabs';
import { parseAssetImages } from './studio-view-helpers';
import { buildAssetIdsFromPlatformBindings } from '../shared/media-bindings';
import { platformBindingsToDrafts, readPlatformVersionBindings, syncPlatformBindingsToRefs } from './studio-platform-tabs';

export type StudioEditorDeps = {
  selected: ContentProjectDetail | null;
  busy: boolean;
  readOnlyVersion: unknown;
  editorMode: 'rich' | 'source';
  editorBody: string;
  activePlatform: string | undefined | null;
  activePlatformDraftKey: string | null;
  activePlatformVersion: unknown;
  platformDrafts: Record<string, StudioPlatformDraft>;
  setPlatformDrafts: React.Dispatch<React.SetStateAction<Record<string, StudioPlatformDraft>>>;
  setBody: (v: string) => void;
  setTitle: (v: string) => void;
  title: string;
  body: string;
  bodyInput: React.RefObject<HTMLDivElement | null>;
  sourceInput: React.RefObject<HTMLTextAreaElement | null>;
  richDomSyncedRef: React.MutableRefObject<boolean>;
  bodyHistory: React.MutableRefObject<string[]>;
  bodyHistoryIndex: React.MutableRefObject<number>;
  setMessage: (msg: string) => void;
  insertImageFile: (file?: File) => Promise<void>;
};

export function useStudioEditor(deps: StudioEditorDeps & {
  // additional to avoid circular: syncPlatformBindingsForBody is defined externally
  syncPlatformBindingsForBody: (nextBody: string) => void;
  updateActivePlatformDraft: (change: Partial<{ title: string; body: string; assetIds: string[]; mediaBindings: unknown[] }>) => void;
}) {
  // placeholder: actual helpers will be inlined in studio-view.tsx for now; this file holds pure helpers
  return {};
}

// Pure helper extracted: updateActivePlatformDraft factory (kept here for reuse)
export function createUpdateActivePlatformDraft(
  activePlatformDraftKey: string | null,
  activePlatformVersion: unknown,
  setPlatformDrafts: React.Dispatch<React.SetStateAction<Record<string, StudioPlatformDraft>>>
) {
  return (change: Partial<{ title: string; body: string; assetIds: string[]; mediaBindings: unknown[] }>) => {
    if (!activePlatformDraftKey) return;
    setPlatformDrafts((current) => {
      const previous = current[activePlatformDraftKey] ?? createStudioPlatformDraft(activePlatformVersion as never);
      return { ...current, [activePlatformDraftKey]: { ...previous, ...change } as StudioPlatformDraft };
    });
  };
}
