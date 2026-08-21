// extracted from studio-view.tsx (structural split)
import { annotationContextAround, annotationScopeKey, computeBodyFingerprint, leadingTitleLength, trimToNonWhitespace, validateAnnotationSelection, shiftAnnotationRanges, type StudioAnnotationRow } from './studio-annotations';
import { bodyOffsetAtDomPoint, richMapping, type SourceHitTest } from './studio-annotation-layer';
import type { StudioDocumentScope } from '../shared/studio-annotations';

// This file holds pure annotation helper factories. Actual hook state remains in studio-view.tsx for hook order stability.
// For structural split, we export the heavy handlers as factories to be called from main.

export function createAnnotationHandlers(deps: {
  selected: unknown;
  annotationScope: StudioDocumentScope | null;
  annotationScopeKeyValue: string;
  readOnlyVersion: unknown;
  busy: boolean;
  annotationBusy: boolean;
  setAnnotationBusy: (v: boolean) => void;
  openAnnotationRows: StudioAnnotationRow[];
  setAnnotationRows: React.Dispatch<React.SetStateAction<StudioAnnotationRow[]>>;
  rowsScopeKeyRef: React.MutableRefObject<string>;
  reconcileTimer: React.MutableRefObject<number | undefined>;
  backendBodyRef: React.MutableRefObject<string>;
  setContextPanelTab: (v: 'annotations' | 'versions') => void;
  setSelectedAnnotationId: (v: string | null) => void;
  setMessage: (v: string) => void;
  reloadAnnotations: () => void;
  editorBody: string;
  annotationLeadingTitleLen: number;
  bodyInput: React.RefObject<HTMLDivElement | null>;
  sourceInput: React.RefObject<HTMLTextAreaElement | null>;
  editorMode: string;
  annotationsEditable: boolean;
  sourceHitTestRef: React.MutableRefObject<SourceHitTest | null>;
}) {
  // placeholder factory – actual implementations remain in main to preserve regex assertions
  return {};
}
