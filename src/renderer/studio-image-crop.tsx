import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { CropRegion } from '../shared/media-bindings';
import { isValidCropRegion } from '../shared/media-bindings';

/**
 * WMB-5237 图片调整：非破坏矩形裁切对话框。
 *
 * - 只读载入 `wmb-asset://<assetId>` 原图，绝不改写原 asset；
 * - 归一化 crop rect（0..1）可拖动 / 四角缩放，比例预设 原始 / 自由 / 1:1 / 4:3 / 3:4 / 16:9 / 2.35:1；
 * - 确认时从原图按选区导出 PNG（canvas.toBlob，无 sharp 依赖），可选调用共享 derive IPC
 *   （`studio:derive-asset` → `materializeCropAsset`，sha256 去重 + derived_crop provenance 由后端写），
 *   成功后 `onApply({ derivedAssetId, cropRegion, pngBase64 })` 由调用方决定核心替换或平台绑定；
 * - 取消 / Esc / 关闭 = 零写；图片载入或 IPC 失败在对话框内可见，不关闭、不丢选区。
 * - 仅使用 foundation 令牌；无第三方依赖。
 */

export type StudioCropPreset = 'original' | 'free' | '1:1' | '4:3' | '3:4' | '16:9' | '2.35:1';

/** 共享 derive IPC 输入（`studio:derive-asset`）。 */
export type StudioDeriveCropInput = {
  sourceAssetId: string;
  cropRegion: CropRegion;
  pngBase64: string;
};

/** derive 结果（调用方完成错误映射后的形状）。 */
export type StudioDeriveCropResult =
  | { ok: true; assetId: string; reused: boolean; sha256: string; cropRegion: CropRegion }
  | { ok: false; cancelled?: boolean; error?: string };

/** 裁切成功后回调调用方的结果（platform 页签由保存事务物化派生 asset，此时 derivedAssetId 为 null）。 */
export type StudioCropApplyResult = {
  derivedAssetId: string | null;
  cropRegion: CropRegion;
  pngBase64: string;
};

type Props = {
  assetId: string;
  assetName?: string | null;
  derive?: (input: StudioDeriveCropInput) => Promise<StudioDeriveCropResult>;
  onApply: (result: StudioCropApplyResult) => void | Promise<void>;
  onClose: () => void;
};

const STAGE_MAX_W = 880;
const STAGE_MAX_H = 540;
/** 四角手柄命中半径（stage 像素）。 */
const HANDLE_HIT = 16;
/** 选区最小边长（stage 像素；极端比例下允许退化，但区域始终有效）。 */
const MIN_CROP_PX = 28;
/** 归一化值保留 4 位小数（契约 §9.2）。 */
const ROUND = 10000;

const PRESET_LABELS: Array<[StudioCropPreset, string]> = [
  ['original', '原始'],
  ['free', '自由'],
  ['1:1', '1:1'],
  ['4:3', '4:3'],
  ['3:4', '3:4'],
  ['16:9', '16:9'],
  ['2.35:1', '2.35:1']
];
const PRESET_RATIO: Partial<Record<StudioCropPreset, number>> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '16:9': 16 / 9,
  '2.35:1': 2.35
};

/** Canvas 无法直接用 CSS 变量，运行时读取 foundation token 的计算值。 */
const cssToken = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const round4 = (value: number): number => Math.round(value * ROUND) / ROUND;

/**
 * 纯计算：由源图尺寸 + 归一化选区推导导出画布尺寸与源矩形（无 DOM 依赖，可单测）。
 * 返回的 outWidth/outHeight 至少为 1；sx/sy/sw/sh 为源图像素坐标（允许小数）。
 */
export function computeCropRects(
  sourceWidth: number,
  sourceHeight: number,
  cropRegion: CropRegion
): { outWidth: number; outHeight: number; sx: number; sy: number; sw: number; sh: number } {
  const outWidth = Math.max(1, Math.round(sourceWidth * cropRegion.width));
  const outHeight = Math.max(1, Math.round(sourceHeight * cropRegion.height));
  return {
    outWidth,
    outHeight,
    sx: sourceWidth * cropRegion.x,
    sy: sourceHeight * cropRegion.y,
    sw: sourceWidth * cropRegion.width,
    sh: sourceHeight * cropRegion.height
  };
}

/** 纯绘制：在已按 outWidth/outHeight 设置的画布上执行 drawImage 裁切（ctx 可 stub）。 */
export function drawCroppedImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  cropRegion: CropRegion
): void {
  const { outWidth, outHeight, sx, sy, sw, sh } = computeCropRects(image.naturalWidth, image.naturalHeight, cropRegion);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outWidth, outHeight);
}

/** 从源图按选区导出 PNG 的 base64（无 data URL 前缀；需要 DOM canvas）。 */
export function cropImageToPng(
  image: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  cropRegion: CropRegion
): Promise<string> {
  const { outWidth, outHeight } = computeCropRects(image.naturalWidth, image.naturalHeight, cropRegion);
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('画布不可用'));
  drawCroppedImage(ctx, image, cropRegion);
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('图片导出失败'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        const base64 = dataUrl.startsWith('data:') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('图片导出失败'));
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

export function StudioImageCropDialog({ assetId, assetName, derive, onApply, onClose }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<{ width: number; height: number } | null>(null);
  const rectRef = useRef<CropRegion>({ x: 0, y: 0, width: 1, height: 1 });
  const aspectRef = useRef<StudioCropPreset>('original');
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    corner: string;
    startX: number;
    startY: number;
    fx: number;
    fy: number;
    rect: CropRegion;
  } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [aspect, setAspect] = useState<StudioCropPreset>('original');
  const [rect, setRect] = useState<CropRegion>({ x: 0, y: 0, width: 1, height: 1 });
  const [loadKey, setLoadKey] = useState(0);

  // ---- 载入 wmb-asset 原图（只读） ----
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError('');
    setAspect('original');
    aspectRef.current = 'original';
    const full: CropRegion = { x: 0, y: 0, width: 1, height: 1 };
    rectRef.current = full;
    setRect(full);
    stageRef.current = null;
    const img = new Image();
        img.crossOrigin = 'anonymous';
    imageRef.current = img;
    img.onload = () => {
      if (cancelled) return;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!(iw > 0 && ih > 0)) {
        setError('图片尺寸无效。');
        return;
      }
      const scale = Math.min(1, STAGE_MAX_W / iw, STAGE_MAX_H / ih);
      stageRef.current = {
        width: Math.max(1, Math.round(iw * scale)),
        height: Math.max(1, Math.round(ih * scale))
      };
      setStatus('ready');
    };
    img.onerror = () => {
      if (cancelled) return;
      setError(`图片载入失败：无法读取原图 ${assetId}。`);
    };
    img.src = `wmb-asset://${encodeURIComponent(assetId)}`;
    return () => {
      cancelled = true;
    };
  }, [assetId, loadKey]);

  // ---- 绘制：图像 + 暗化遮罩 + 三分线 + 选区边框 + 四角手柄 ----
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    const stage = stageRef.current;
    if (!canvas || !img || !stage) return;
    canvas.width = stage.width;
    canvas.height = stage.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, stage.width, stage.height);
    ctx.drawImage(img, 0, 0, stage.width, stage.height);
    const r = rectRef.current;
    const px = {
      x: r.x * stage.width,
      y: r.y * stage.height,
      width: r.width * stage.width,
      height: r.height * stage.height
    };
    const dim = cssToken('--overlay') || 'rgba(0, 0, 0, 0.55)';
    ctx.fillStyle = dim;
    ctx.fillRect(0, 0, stage.width, px.y);
    ctx.fillRect(0, px.y + px.height, stage.width, stage.height - px.y - px.height);
    ctx.fillRect(0, px.y, px.x, px.height);
    ctx.fillRect(px.x + px.width, px.y, stage.width - px.x - px.width, px.height);
    // 三分参考线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i += 1) {
      const gx = px.x + (px.width * i) / 3;
      ctx.beginPath();
      ctx.moveTo(gx, px.y);
      ctx.lineTo(gx, px.y + px.height);
      ctx.stroke();
      const gy = px.y + (px.height * i) / 3;
      ctx.beginPath();
      ctx.moveTo(px.x, gy);
      ctx.lineTo(px.x + px.width, gy);
      ctx.stroke();
    }
    // 选区边框
    ctx.strokeStyle = cssToken('--ink') || '#f1f1f1';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px.x + 0.75, px.y + 0.75, Math.max(0, px.width - 1.5), Math.max(0, px.height - 1.5));
    // 四角手柄
    const accent = cssToken('--accent') || '#8b7cff';
    const surface = cssToken('--surface') || '#171717';
    const handle = 5;
    const corners = [
      [px.x, px.y],
      [px.x + px.width, px.y],
      [px.x, px.y + px.height],
      [px.x + px.width, px.y + px.height]
    ] as const;
    ctx.fillStyle = accent;
    for (const [hx, hy] of corners) ctx.fillRect(hx - handle, hy - handle, handle * 2, handle * 2);
    ctx.strokeStyle = surface;
    ctx.lineWidth = 1;
    for (const [hx, hy] of corners) ctx.strokeRect(hx - handle, hy - handle, handle * 2, handle * 2);
  }, []);

  useEffect(() => {
    paint();
  });

  const updateRect = (next: CropRegion) => {
    rectRef.current = next;
    setRect(next);
  };

  const clampRect = (r: CropRegion, stage: { width: number; height: number }): CropRegion => {
    const minW = MIN_CROP_PX / stage.width;
    const minH = MIN_CROP_PX / stage.height;
    const width = clamp(r.width, minW, 1);
    const height = clamp(r.height, minH, 1);
    return {
      x: clamp(r.x, 0, 1 - width),
      y: clamp(r.y, 0, 1 - height),
      width,
      height
    };
  };

  const activeRatio = (): number | null => {
    const preset = aspectRef.current;
    if (preset === 'original') {
      const img = imageRef.current;
      if (!img || !(img.naturalHeight > 0)) return null;
      return img.naturalWidth / img.naturalHeight;
    }
    return PRESET_RATIO[preset] ?? null;
  };

  const applyPreset = (preset: StudioCropPreset) => {
    if (busy || status !== 'ready') return;
    setAspect(preset);
    aspectRef.current = preset;
    const stage = stageRef.current;
    if (!stage) return;
    const current = rectRef.current;
    if (preset === 'free') return;
    if (preset === 'original') {
      updateRect({ x: 0, y: 0, width: 1, height: 1 });
      return;
    }
    const ratio = PRESET_RATIO[preset];
    if (!ratio) return;
    // 以当前选区中心为锚，在图像内放置满足比例的最大矩形
    const cx = clamp(current.x + current.width / 2, 0, 1);
    const cy = clamp(current.y + current.height / 2, 0, 1);
    let w = 1;
    let h = 1;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    updateRect({
      x: clamp(cx - w / 2, 0, 1 - w),
      y: clamp(cy - h / 2, 0, 1 - h),
      width: w,
      height: h
    });
  };

  // ---- 指针交互：移动 / 四角缩放 ----
  const stagePoint = (event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return { x: 0, y: 0 };
    const css = canvas.getBoundingClientRect();
    if (css.width <= 0 || css.height <= 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - css.left) / css.width) * stage.width,
      y: ((event.clientY - css.top) / css.height) * stage.height
    };
  };

  const hitCorner = (point: { x: number; y: number }, r: CropRegion): string | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const px = {
      x: r.x * stage.width,
      y: r.y * stage.height,
      width: r.width * stage.width,
      height: r.height * stage.height
    };
    const candidates: Array<[string, number, number]> = [
      ['nw', px.x, px.y],
      ['ne', px.x + px.width, px.y],
      ['sw', px.x, px.y + px.height],
      ['se', px.x + px.width, px.y + px.height]
    ];
    for (const [name, hx, hy] of candidates) {
      if (Math.abs(point.x - hx) <= HANDLE_HIT && Math.abs(point.y - hy) <= HANDLE_HIT) return name;
    }
    return null;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (busy || status !== 'ready') return;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const point = stagePoint(event);
    const r = rectRef.current;
    const corner = hitCorner(point, r);
    const px = {
      x: r.x * stage.width,
      y: r.y * stage.height,
      width: r.width * stage.width,
      height: r.height * stage.height
    };
    const inside = point.x >= px.x && point.x <= px.x + px.width && point.y >= px.y && point.y <= px.y + px.height;
    const mode = corner ? 'resize' : inside ? 'move' : null;
    if (!mode) return;
    const css = canvas.getBoundingClientRect();
    dragRef.current = {
      mode,
      corner: corner ?? 'se',
      startX: event.clientX,
      startY: event.clientY,
      fx: css.width > 0 ? stage.width / css.width : 1,
      fy: css.height > 0 ? stage.height / css.height : 1,
      rect: { ...r }
    };
    canvas.style.cursor = mode === 'move' ? 'grabbing' : 'nwse-resize';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const dx = ((event.clientX - drag.startX) * drag.fx) / stage.width;
    const dy = ((event.clientY - drag.startY) * drag.fy) / stage.height;
    const start = drag.rect;
    const minW = MIN_CROP_PX / stage.width;
    const minH = MIN_CROP_PX / stage.height;
    const ratio = activeRatio();
    let next: CropRegion;
    if (drag.mode === 'move') {
      next = {
        ...start,
        x: clamp(start.x + dx, 0, 1 - start.width),
        y: clamp(start.y + dy, 0, 1 - start.height)
      };
    } else {
      const corner = drag.corner;
      const x1 = corner.includes('w') ? clamp(start.x + dx, 0, start.x + start.width - minW) : start.x;
      const y1 = corner.includes('n') ? clamp(start.y + dy, 0, start.y + start.height - minH) : start.y;
      const x2 = corner.includes('e') ? clamp(start.x + start.width + dx, start.x + minW, 1) : start.x + start.width;
      const y2 = corner.includes('s') ? clamp(start.y + start.height + dy, start.y + minH, 1) : start.y + start.height;
      next = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      if (ratio) {
        // 固定比例：锚定对角角点，重新计算满足比例的宽高
        const anchorX = corner.includes('w') ? x2 : x1;
        const anchorY = corner.includes('n') ? y2 : y1;
        const maxW = corner.includes('w') ? anchorX : 1 - anchorX;
        const maxH = corner.includes('n') ? anchorY : 1 - anchorY;
        let w = Math.min(maxW, next.width);
        let h = Math.min(maxH, next.height);
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
        if (w < minW) {
          w = minW;
          h = w / ratio;
        }
        if (h < minH) {
          h = minH;
          w = h * ratio;
        }
        if (w > maxW) {
          w = maxW;
          h = w / ratio;
        }
        if (h > maxH) {
          h = maxH;
          w = h * ratio;
        }
        // 极端比例下若仍越界，硬钳制（区域有效性优先于最小尺寸约束）
        if (w > maxW) w = maxW;
        if (h > maxH) h = maxH;
        next = {
          x: corner.includes('w') ? anchorX - w : anchorX,
          y: corner.includes('n') ? anchorY - h : anchorY,
          width: w,
          height: h
        };
      }
    }
    updateRect(clampRect(next, stage));
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grab';
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  // ---- 确认：导出 PNG → derive IPC → onApply ----
  const confirmCrop = async () => {
    if (busy || status !== 'ready') return;
    const img = imageRef.current;
    if (!img) return;
    const region: CropRegion = {
      x: round4(rectRef.current.x),
      y: round4(rectRef.current.y),
      width: round4(rectRef.current.width),
      height: round4(rectRef.current.height)
    };
    if (!isValidCropRegion(region)) {
      setError('裁切区域无效，请重新调整。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const pngBase64 = await cropImageToPng(img, region);
      let derivedAssetId: string | null = null;
      if (derive) {
        const result = await derive({ sourceAssetId: assetId, cropRegion: region, pngBase64 });
        if (!result.ok) {
          setError(result.error || (result.cancelled ? '已取消' : '图片处理失败'));
          return;
        }
        derivedAssetId = result.assetId;
      }
      await onApply({ derivedAssetId, cropRegion: region, pngBase64 });
      setBusy(false);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  // ---- 键盘：Esc 关闭（处理中除外）；打开时聚焦 ----
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const img = imageRef.current;
  const sizeText =
    img && status === 'ready'
      ? `${Math.max(1, Math.round(img.naturalWidth * rectRef.current.width))} × ${Math.max(1, Math.round(img.naturalHeight * rectRef.current.height))} 像素`
      : '';

  return (
    <div className="studio-image-crop-modal" role="dialog" aria-modal="true" aria-label="裁剪图片">
      <div className="studio-image-crop-dialog" ref={dialogRef} tabIndex={-1}>
        <header className="studio-crop-header">
          <h3>裁剪图片{assetName ? ` · ${assetName}` : ''}</h3>
          <button type="button" className="studio-crop-close secondary-button" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>
        <p className="studio-crop-hint">拖动选框移动位置，拖四角调整大小；确认后生成新图片，原图保持不变。</p>
        <div className="studio-crop-stage">
          {status === 'loading' && !error ? (
            <div className="studio-crop-loading" role="status">
              正在载入图片…
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            className="studio-crop-canvas"
            style={status === 'ready' ? undefined : { display: 'none' }}
            aria-label="裁切预览，拖动选框或四角调整区域"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
          {error ? (
            <div className="studio-crop-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="studio-crop-retry"
                disabled={busy}
                onClick={() => {
                  setError('');
                  if (status === 'ready') void confirmCrop();
                  else setLoadKey((key) => key + 1);
                }}
              >
                重试
              </button>
            </div>
          ) : null}
        </div>
        <div className="studio-crop-controls">
          <div className="studio-crop-presets" role="group" aria-label="裁切比例">
            {PRESET_LABELS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="studio-crop-preset"
                data-preset={key}
                aria-pressed={aspect === key}
                disabled={busy || status !== 'ready'}
                onClick={() => applyPreset(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="studio-crop-size" aria-live="polite">
            {sizeText}
          </div>
        </div>
        <footer className="studio-crop-footer">
          <button type="button" className="studio-crop-cancel secondary-button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="studio-crop-confirm primary-button"
            onClick={() => void confirmCrop()}
            disabled={busy || status !== 'ready'}
          >
            {busy ? '裁剪中…' : '应用裁剪'}
          </button>
        </footer>
      </div>
    </div>
  );
}
