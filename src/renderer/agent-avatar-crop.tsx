import { useEffect, useRef, useState, type JSX } from 'react';

type Props = {
  roleId: string;
  roleLabel: string;
  onClose: () => void;
  onSaved: (url: string) => void;
};

const OUT = 256;

/** 圆形头像：选图 → 拖移缩放 → 裁切正方形 PNG → 保存 */
export function AgentAvatarCropDialog({ roleId, roleLabel, onClose, onSaved }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hasImage, setHasImage] = useState(false);

  const paint = () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = OUT;
    canvas.width = size;
    canvas.height = size;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#1a1a1f';
    ctx.fillRect(0, 0, size, size);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const base = Math.max(size / iw, size / ih) * scale;
    const dw = iw * base;
    const dh = ih * base;
    const dx = (size - dw) / 2 + offset.x;
    const dy = (size - dh) / 2 + offset.y;
    ctx.drawImage(img, dx, dy, dw, dh);
    // circle mask preview
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // ring
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
  };

  useEffect(() => {
    paint();
  }, [scale, offset, hasImage]);

  const onFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件');
      return;
    }
    setError('');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setHasImage(true);
      URL.revokeObjectURL(url);
      requestAnimationFrame(paint);
    };
    img.onerror = () => setError('图片读取失败');
    img.src = url;
  };

  const save = async () => {
    if (!hasImage || !canvasRef.current) return;
    setBusy(true);
    setError('');
    try {
      // export unmasked square then server stores; display uses circle CSS
      const src = canvasRef.current;
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = OUT;
      exportCanvas.height = OUT;
      const ex = exportCanvas.getContext('2d');
      if (!ex || !imgRef.current) throw new Error('画布不可用');
      const img = imgRef.current;
      const size = OUT;
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const base = Math.max(size / iw, size / ih) * scale;
      const dw = iw * base;
      const dh = ih * base;
      const dx = (size - dw) / 2 + offset.x;
      const dy = (size - dh) / 2 + offset.y;
      ex.fillStyle = '#111';
      ex.fillRect(0, 0, size, size);
      ex.drawImage(img, dx, dy, dw, dh);
      const dataUrl = exportCanvas.toDataURL('image/png');
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const result = await window.wmb.setAgentAvatar?.({
        roleId,
        base64,
        mimeType: 'image/png',
        width: OUT,
        height: OUT
      });
      if (!result?.url) throw new Error('保存失败');
      onSaved(result.url);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-avatar-modal" role="dialog" aria-modal="true" aria-label={`${roleLabel}头像`}>
      <div className="agent-avatar-dialog">
        <header>
          <h3>{roleLabel} · 设置头像</h3>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>
        <p className="muted">选择图片后拖动调整，滚轮/滑条缩放；保存为圆形席位头像。</p>
        <div className="agent-avatar-stage">
          <canvas
            ref={canvasRef}
            width={OUT}
            height={OUT}
            className="agent-avatar-canvas"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              setOffset({
                x: drag.current.ox + (e.clientX - drag.current.x),
                y: drag.current.oy + (e.clientY - drag.current.y)
              });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onWheel={(e) => {
              e.preventDefault();
              setScale((s) => Math.min(4, Math.max(0.5, s + (e.deltaY > 0 ? -0.08 : 0.08))));
            }}
          />
        </div>
        <label className="agent-avatar-file">
          选择图片
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="agent-avatar-zoom">
          缩放
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.01}
            value={scale}
            disabled={!hasImage}
            onChange={(e) => setScale(Number(e.target.value))}
          />
        </label>
        {error ? (
          <div className="agents-callout danger" role="alert">
            {error}
          </div>
        ) : null}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary-button" disabled={!hasImage || busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存头像'}
          </button>
        </footer>
      </div>
    </div>
  );
}
