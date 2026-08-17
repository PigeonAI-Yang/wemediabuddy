// WMB-5237: 正文内图片的浮动工具条 + 选中框 + 拖拽手柄（ImplementInlineImageUx 所有）。
// 关键约束：
// - 所有控件都渲染在 contentEditable 之外（position:fixed 覆盖层），绝不进入正文 DOM，
//   因此不破坏 htmlToMarkdown / richMapping 线性化（figure 只回写单个 img token）。
// - 宽度/对齐只写核心媒体绑定草稿（ContentMediaBindingDraft），绝不修改正文 token；
//   拖拽 live preview 通过 figure 内联样式（htmlToMarkdown 忽略 style），pointerup 一次性提交吸附结果。
// - 平台模式（showLayout=false）隐藏尺寸/对齐与手柄（PlatformMediaBindingDraft 无布局字段）；
//   裁切两模式都显示（核心=派生换 token，平台=保存时物化）；只读历史只显示只读提示条。
// - 键盘路径：宽度/对齐由预设按钮完成（可 Tab 聚焦），拖拽手柄为指针增强（aria-hidden）。
import { useEffect, useRef, useState } from 'react';
import { MEDIA_ALIGNS, MEDIA_WIDTH_PRESETS, type MediaAlign, type MediaWidthPreset } from '../shared/media-bindings';

export type InlineImageSelection = { assetId: string; occurrence: number };
export type InlineImageDraft = { widthPreset: MediaWidthPreset; align: MediaAlign };

export const WIDTH_PRESET_LABELS: Record<MediaWidthPreset, string> = { small: '小', medium: '中', large: '大', full: '通栏' };
export const ALIGN_LABELS: Record<MediaAlign, string> = { left: '左', center: '中', right: '右' };
/** 宽度预设的显示语义（编辑器内容宽度的百分比）：
 *  small=40%，medium=65%，large=图片自然尺寸（100% 自然宽，不放大），full=编辑器允许最大宽（铺满整行）。 */
export const PRESET_HINTS: Record<MediaWidthPreset, string> = { small: '小 · 40%', medium: '中 · 65%', large: '大 · 原尺寸', full: '通栏 · 铺满整行' };
/** 小/中/通栏相对编辑器内容宽度的比例（large=自然尺寸，不入表）。 */
export const PRESET_RATIOS: Record<Exclude<MediaWidthPreset, 'large'>, number> = { small: 0.4, medium: 0.65, full: 1 };

const MIN_DRAG_WIDTH = 96;
const TOOLBAR_ABOVE_GAP = 8;
const TOOLBAR_BELOW_GAP = 10;
const FRAME_PAD = 4;

type DragState = { side: 'left' | 'right'; startX: number; startWidth: number };

export type StudioInlineImageOverlayProps = {
  selection: InlineImageSelection;
  /** 按 (assetId, occurrence) 在正文 DOM 中查找 figure；找不到 → 自动关闭。 */
  findFigure: (selection: InlineImageSelection) => HTMLElement | null;
  /** 当前布局（未绑定则为 null）。 */
  draft: InlineImageDraft | null;
  alt: string;
  /** 可编辑；false = 只读历史，仅显示只读提示条。 */
  editable: boolean;
  /** 核心正文模式：显示尺寸/对齐与拖拽手柄（平台模式无布局字段）。 */
  showLayout: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onWidthPreset: (preset: MediaWidthPreset) => void;
  onAlign: (align: MediaAlign) => void;
  onReplace: () => void;
  onEditCaption: (alt: string) => void;
  onCrop: () => void;
  onRemove: () => void;
  onClose: () => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function StudioInlineImageOverlay(props: StudioInlineImageOverlayProps): React.JSX.Element | null {
  const { selection, findFigure, draft, alt, editable, showLayout, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onWidthPreset, onAlign, onReplace, onEditCaption, onCrop, onRemove, onClose } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [toolbarWidth, setToolbarWidth] = useState(0);
  const [captionEditing, setCaptionEditing] = useState(false);
  const [captionDraft, setCaptionDraft] = useState('');
  const closedRef = useRef(false);

  const closeOnce = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  };

  // 每帧跟随选中 figure：重查（编辑器 blur 重渲染后元素会被替换）+ 测量 + 拖拽 live preview。
  useEffect(() => {
    let raf = 0;
    let lastToolbarWidth = 0;
    let lastRect = '';
    let marked: HTMLElement | null = null;
    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      const figure = findFigure(selection);
      if (!figure) { closeOnce(); return; }
      if (marked !== figure) {
        marked?.classList.remove('studio-inline-image-selected');
        marked?.removeAttribute('data-wmb-selected');
        marked = figure;
        figure.classList.add('studio-inline-image-selected');
        figure.setAttribute('data-wmb-selected', 'true');
      }
      const box = figure.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        const key = `${box.left}|${box.top}|${box.width}|${box.height}`;
        if (key !== lastRect) { lastRect = key; setRect({ left: box.left, top: box.top, width: box.width, height: box.height }); }
      }
      const tw = toolbarRef.current?.clientWidth ?? 0;
      if (tw !== lastToolbarWidth) { lastToolbarWidth = tw; setToolbarWidth(tw); }
      const drag = dragRef.current;
      const width = dragWidthRef.current;
      if (drag && width !== null) {
        // live preview：只改内联样式，不触碰正文 token；htmlToMarkdown/richMapping 忽略 style。
        figure.style.width = `${width}px`;
        const img = figure.querySelector(':scope > img') as HTMLImageElement | null;
        if (img) img.style.width = '100%';
      } else {
        // 无拖拽时清除可能残留的内联宽度，交回 data-wmb-width 类投影。
        if (figure.style.width) figure.style.width = '';
        const img = figure.querySelector(':scope > img') as HTMLImageElement | null;
        if (img && img.style.width === '100%') img.style.width = '';
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      if (marked) {
        marked.classList.remove('studio-inline-image-selected');
        marked.removeAttribute('data-wmb-selected');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.assetId, selection.occurrence]);

  // Escape 关闭 / 外点关闭（figure 点击由父级选择处理器接管，不关闭）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (captionEditing) { setCaptionEditing(false); return; }
      event.preventDefault();
      closeOnce();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('figure.studio-figure')) return;
      closeOnce();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionEditing]);

  if (!editable) {
    const hint = `历史版本只读 · ${WIDTH_PRESET_LABELS[draft?.widthPreset ?? 'large']} · ${ALIGN_LABELS[draft?.align ?? 'center']}`;
    return (
      <div ref={rootRef} className="studio-inline-image-overlay" role="status" aria-label="图片只读信息">
        {rect && <div className="studio-inline-image-frame readonly" style={{ left: rect.left - FRAME_PAD, top: rect.top - FRAME_PAD, width: rect.width + FRAME_PAD * 2, height: rect.height + FRAME_PAD * 2 }} />}
        {rect && <div className="studio-inline-readonly" style={{ left: clamp(rect.left, 8, Math.max(8, window.innerWidth - 320)), top: Math.max(8, rect.top + rect.height + TOOLBAR_BELOW_GAP) }}>{hint}</div>}
      </div>
    );
  }

  // 工具条定位：优先紧贴图片上方，空间不足则下方；保持在 Studio 文档列内，避免遮挡 Pi dock。
  let toolbarTop: number | null = null;
  let toolbarLeft = 8;
  if (rect) {
    const tw = toolbarWidth || 320;
    const figure = findFigure(selection);
    const documentRect = figure?.closest('.studio-document')?.getBoundingClientRect();
    const minLeft = Math.max(8, (documentRect?.left ?? 0) + 8);
    const maxLeft = Math.max(minLeft, Math.min(window.innerWidth - tw - 8, (documentRect?.right ?? window.innerWidth) - tw - 8));
    toolbarLeft = clamp(rect.left, minLeft, maxLeft);
    const above = rect.top - 40 - TOOLBAR_ABOVE_GAP;
    toolbarTop = above >= 8 ? above : rect.top + rect.height + TOOLBAR_BELOW_GAP;
  }

  const startDrag = (event: React.PointerEvent, side: 'left' | 'right') => {
    const figure = findFigure(selection);
    if (!figure) return;
    event.preventDefault();
    event.stopPropagation();
    const startWidth = Math.max(figure.clientWidth, MIN_DRAG_WIDTH);
    dragRef.current = { side, startX: event.clientX, startWidth };
    dragWidthRef.current = startWidth;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const figure = findFigure(selection);
    if (!drag || !figure) return;
    const editorWidth = figure.parentElement?.clientWidth || window.innerWidth;
    const delta = drag.side === 'right' ? event.clientX - drag.startX : drag.startX - event.clientX;
    dragWidthRef.current = clamp(drag.startWidth + delta, MIN_DRAG_WIDTH, Math.max(MIN_DRAG_WIDTH, editorWidth));
  };
  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const figure = findFigure(selection);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    if (!drag || !figure) { dragWidthRef.current = null; return; }
    const editorWidth = figure.parentElement?.clientWidth || window.innerWidth;
    const img = figure.querySelector(':scope > img') as HTMLImageElement | null;
    const natural = (img?.naturalWidth ?? 0) > 0 ? img!.naturalWidth : editorWidth;
    const width = dragWidthRef.current ?? drag.startWidth;
    // 吸附最近预设：small=40% 行宽 / medium=65% / large=自然尺寸（上限行宽）/ full=行宽。
    const targets: Array<{ preset: MediaWidthPreset; px: number }> = [
      { preset: 'small', px: editorWidth * PRESET_RATIOS.small },
      { preset: 'medium', px: editorWidth * PRESET_RATIOS.medium },
      { preset: 'large', px: Math.min(natural, editorWidth) },
      { preset: 'full', px: editorWidth }
    ];
    let best = targets[0];
    let bestDist = Math.abs(width - best.px);
    for (const target of targets) {
      const dist = Math.abs(width - target.px);
      if (dist < bestDist) { best = target; bestDist = dist; }
    }
    dragWidthRef.current = null;
    // 只提交一次绑定草稿（pointerup 吸附结果）；不写正文历史。
    if (!draft || best.preset !== draft.widthPreset) onWidthPreset(best.preset);
  };

  const confirmCaption = () => {
    const value = captionDraft.trim();
    setCaptionEditing(false);
    if (value !== alt) onEditCaption(value);
  };

  return (
    <div ref={rootRef} className="studio-inline-image-overlay">
      {rect && (
        <div
          className={`studio-inline-image-frame${draft ? '' : ' unbound'}`}
          style={{ left: rect.left - FRAME_PAD, top: rect.top - FRAME_PAD, width: rect.width + FRAME_PAD * 2, height: rect.height + FRAME_PAD * 2 }}
        >
          {showLayout && (
            <>
              <div className="studio-inline-handle" data-side="left" aria-hidden="true"
                onPointerDown={(event) => startDrag(event, 'left')} onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
              <div className="studio-inline-handle" data-side="right" aria-hidden="true"
                onPointerDown={(event) => startDrag(event, 'right')} onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
            </>
          )}
        </div>
      )}
      {rect && toolbarTop !== null && (
        <div ref={toolbarRef} className="studio-inline-image-toolbar" role="toolbar" aria-label="图片工具条" style={{ left: toolbarLeft, top: toolbarTop }}>
          {showLayout && (
            <>
              <div className="studio-inline-group" role="group" aria-label="图片宽度">
                {MEDIA_WIDTH_PRESETS.map((preset) => (
                  <button key={preset} type="button" className="studio-inline-width" data-preset={preset}
                    aria-label={`宽度：${WIDTH_PRESET_LABELS[preset]}`} aria-pressed={Boolean(draft && draft.widthPreset === preset)} title={PRESET_HINTS[preset]}
                    onClick={() => onWidthPreset(preset)}>{WIDTH_PRESET_LABELS[preset]}</button>
                ))}
              </div>
              <div className="studio-inline-group" role="group" aria-label="图片对齐">
                {MEDIA_ALIGNS.map((align) => (
                  <button key={align} type="button" className="studio-inline-align" data-align={align}
                    aria-label={`对齐：${ALIGN_LABELS[align]}`} aria-pressed={Boolean(draft && draft.align === align)}
                    onClick={() => onAlign(align)}>{ALIGN_LABELS[align]}</button>
                ))}
              </div>
              <span className="studio-inline-sep" aria-hidden="true" />
            </>
          )}
          <div className="studio-inline-group" role="group" aria-label="移动图片">
            <button type="button" className="studio-inline-action" data-action="move-up" aria-label="向上移动图片" disabled={!canMoveUp} onClick={onMoveUp}>上移</button>
            <button type="button" className="studio-inline-action" data-action="move-down" aria-label="向下移动图片" disabled={!canMoveDown} onClick={onMoveDown}>下移</button>
          </div>
          <span className="studio-inline-sep" aria-hidden="true" />
          <button type="button" className="studio-inline-action" data-action="replace" aria-label="替换图片" onClick={onReplace}>替换</button>
          {captionEditing ? (
            <span className="studio-inline-caption-edit">
              <input className="studio-inline-caption-input" autoFocus value={captionDraft} aria-label="图注"
                placeholder="填写图注（alt 文本）" onChange={(event) => setCaptionDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); confirmCaption(); }
                  if (event.key === 'Escape') { event.stopPropagation(); setCaptionEditing(false); }
                }} />
              <button type="button" className="studio-inline-action primary" data-action="caption-save" onClick={confirmCaption}>保存</button>
            </span>
          ) : (
            <button type="button" className="studio-inline-action" data-action="caption" aria-label="编辑图注"
              onClick={() => { setCaptionEditing(true); setCaptionDraft(alt); }}>图注</button>
          )}
          <button type="button" className="studio-inline-action" data-action="crop" aria-label="裁切图片" onClick={onCrop}>裁切</button>
          <button type="button" className="studio-inline-action danger" data-action="remove" aria-label="移出本文" onClick={onRemove}>移出</button>
        </div>
      )}
    </div>
  );
}
