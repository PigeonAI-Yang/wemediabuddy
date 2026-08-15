"use strict";
import { jsx, jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { isValidCropRegion } from "../shared/media-bindings";
const STAGE_MAX_W = 880;
const STAGE_MAX_H = 540;
const HANDLE_HIT = 16;
const MIN_CROP_PX = 28;
const ROUND = 1e4;
const PRESET_LABELS = [
  ["original", "\u539F\u59CB"],
  ["free", "\u81EA\u7531"],
  ["1:1", "1:1"],
  ["4:3", "4:3"],
  ["3:4", "3:4"],
  ["16:9", "16:9"],
  ["2.35:1", "2.35:1"]
];
const PRESET_RATIO = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "16:9": 16 / 9,
  "2.35:1": 2.35
};
const cssToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round4 = (value) => Math.round(value * ROUND) / ROUND;
export function computeCropRects(sourceWidth, sourceHeight, cropRegion) {
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
export function drawCroppedImage(ctx, image, cropRegion) {
  const { outWidth, outHeight, sx, sy, sw, sh } = computeCropRects(image.naturalWidth, image.naturalHeight, cropRegion);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outWidth, outHeight);
}
export function cropImageToPng(image, cropRegion) {
  const { outWidth, outHeight } = computeCropRects(image.naturalWidth, image.naturalHeight, cropRegion);
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("\u753B\u5E03\u4E0D\u53EF\u7528"));
  drawCroppedImage(ctx, image, cropRegion);
  const { promise, resolve, reject } = Promise.withResolvers();
  canvas.toBlob((blob) => {
    if (!blob) {
      reject(new Error("\u56FE\u7247\u5BFC\u51FA\u5931\u8D25"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.startsWith("data:") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("\u56FE\u7247\u5BFC\u51FA\u5931\u8D25"));
    reader.readAsDataURL(blob);
  }, "image/png");
  return promise;
}
export function StudioImageCropDialog({ assetId, assetName, derive, onApply, onClose }) {
  const canvasRef = useRef(null);
  const dialogRef = useRef(null);
  const imageRef = useRef(null);
  const stageRef = useRef(null);
  const rectRef = useRef({ x: 0, y: 0, width: 1, height: 1 });
  const aspectRef = useRef("original");
  const dragRef = useRef(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [aspect, setAspect] = useState("original");
  const [rect, setRect] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const [loadKey, setLoadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setAspect("original");
    aspectRef.current = "original";
    const full = { x: 0, y: 0, width: 1, height: 1 };
    rectRef.current = full;
    setRect(full);
    stageRef.current = null;
    const img2 = new Image();
    imageRef.current = img2;
    img2.onload = () => {
      if (cancelled) return;
      const iw = img2.naturalWidth;
      const ih = img2.naturalHeight;
      if (!(iw > 0 && ih > 0)) {
        setError("\u56FE\u7247\u5C3A\u5BF8\u65E0\u6548\u3002");
        return;
      }
      const scale = Math.min(1, STAGE_MAX_W / iw, STAGE_MAX_H / ih);
      stageRef.current = {
        width: Math.max(1, Math.round(iw * scale)),
        height: Math.max(1, Math.round(ih * scale))
      };
      setStatus("ready");
    };
    img2.onerror = () => {
      if (cancelled) return;
      setError(`\u56FE\u7247\u8F7D\u5165\u5931\u8D25\uFF1A\u65E0\u6CD5\u8BFB\u53D6\u539F\u56FE ${assetId}\u3002`);
    };
    img2.src = `wmb-asset://${encodeURIComponent(assetId)}`;
    return () => {
      cancelled = true;
    };
  }, [assetId, loadKey]);
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const img2 = imageRef.current;
    const stage = stageRef.current;
    if (!canvas || !img2 || !stage) return;
    canvas.width = stage.width;
    canvas.height = stage.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, stage.width, stage.height);
    ctx.drawImage(img2, 0, 0, stage.width, stage.height);
    const r = rectRef.current;
    const px = {
      x: r.x * stage.width,
      y: r.y * stage.height,
      width: r.width * stage.width,
      height: r.height * stage.height
    };
    const dim = cssToken("--overlay") || "rgba(0, 0, 0, 0.55)";
    ctx.fillStyle = dim;
    ctx.fillRect(0, 0, stage.width, px.y);
    ctx.fillRect(0, px.y + px.height, stage.width, stage.height - px.y - px.height);
    ctx.fillRect(0, px.y, px.x, px.height);
    ctx.fillRect(px.x + px.width, px.y, stage.width - px.x - px.width, px.height);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i += 1) {
      const gx = px.x + px.width * i / 3;
      ctx.beginPath();
      ctx.moveTo(gx, px.y);
      ctx.lineTo(gx, px.y + px.height);
      ctx.stroke();
      const gy = px.y + px.height * i / 3;
      ctx.beginPath();
      ctx.moveTo(px.x, gy);
      ctx.lineTo(px.x + px.width, gy);
      ctx.stroke();
    }
    ctx.strokeStyle = cssToken("--ink") || "#f1f1f1";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px.x + 0.75, px.y + 0.75, Math.max(0, px.width - 1.5), Math.max(0, px.height - 1.5));
    const accent = cssToken("--accent") || "#8b7cff";
    const surface = cssToken("--surface") || "#171717";
    const handle = 5;
    const corners = [
      [px.x, px.y],
      [px.x + px.width, px.y],
      [px.x, px.y + px.height],
      [px.x + px.width, px.y + px.height]
    ];
    ctx.fillStyle = accent;
    for (const [hx, hy] of corners) ctx.fillRect(hx - handle, hy - handle, handle * 2, handle * 2);
    ctx.strokeStyle = surface;
    ctx.lineWidth = 1;
    for (const [hx, hy] of corners) ctx.strokeRect(hx - handle, hy - handle, handle * 2, handle * 2);
  }, []);
  useEffect(() => {
    paint();
  });
  const updateRect = (next) => {
    rectRef.current = next;
    setRect(next);
  };
  const clampRect = (r, stage) => {
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
  const activeRatio = () => {
    const preset = aspectRef.current;
    if (preset === "original") {
      const img2 = imageRef.current;
      if (!img2 || !(img2.naturalHeight > 0)) return null;
      return img2.naturalWidth / img2.naturalHeight;
    }
    return PRESET_RATIO[preset] ?? null;
  };
  const applyPreset = (preset) => {
    if (busy || status !== "ready") return;
    setAspect(preset);
    aspectRef.current = preset;
    const stage = stageRef.current;
    if (!stage) return;
    const current = rectRef.current;
    if (preset === "free") return;
    if (preset === "original") {
      updateRect({ x: 0, y: 0, width: 1, height: 1 });
      return;
    }
    const ratio = PRESET_RATIO[preset];
    if (!ratio) return;
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
  const stagePoint = (event) => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return { x: 0, y: 0 };
    const css = canvas.getBoundingClientRect();
    if (css.width <= 0 || css.height <= 0) return { x: 0, y: 0 };
    return {
      x: (event.clientX - css.left) / css.width * stage.width,
      y: (event.clientY - css.top) / css.height * stage.height
    };
  };
  const hitCorner = (point, r) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const px = {
      x: r.x * stage.width,
      y: r.y * stage.height,
      width: r.width * stage.width,
      height: r.height * stage.height
    };
    const candidates = [
      ["nw", px.x, px.y],
      ["ne", px.x + px.width, px.y],
      ["sw", px.x, px.y + px.height],
      ["se", px.x + px.width, px.y + px.height]
    ];
    for (const [name, hx, hy] of candidates) {
      if (Math.abs(point.x - hx) <= HANDLE_HIT && Math.abs(point.y - hy) <= HANDLE_HIT) return name;
    }
    return null;
  };
  const onPointerDown = (event) => {
    if (busy || status !== "ready") return;
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
    const mode = corner ? "resize" : inside ? "move" : null;
    if (!mode) return;
    const css = canvas.getBoundingClientRect();
    dragRef.current = {
      mode,
      corner: corner ?? "se",
      startX: event.clientX,
      startY: event.clientY,
      fx: css.width > 0 ? stage.width / css.width : 1,
      fy: css.height > 0 ? stage.height / css.height : 1,
      rect: { ...r }
    };
    canvas.style.cursor = mode === "move" ? "grabbing" : "nwse-resize";
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const dx = (event.clientX - drag.startX) * drag.fx / stage.width;
    const dy = (event.clientY - drag.startY) * drag.fy / stage.height;
    const start = drag.rect;
    const minW = MIN_CROP_PX / stage.width;
    const minH = MIN_CROP_PX / stage.height;
    const ratio = activeRatio();
    let next;
    if (drag.mode === "move") {
      next = {
        ...start,
        x: clamp(start.x + dx, 0, 1 - start.width),
        y: clamp(start.y + dy, 0, 1 - start.height)
      };
    } else {
      const corner = drag.corner;
      const x1 = corner.includes("w") ? clamp(start.x + dx, 0, start.x + start.width - minW) : start.x;
      const y1 = corner.includes("n") ? clamp(start.y + dy, 0, start.y + start.height - minH) : start.y;
      const x2 = corner.includes("e") ? clamp(start.x + start.width + dx, start.x + minW, 1) : start.x + start.width;
      const y2 = corner.includes("s") ? clamp(start.y + start.height + dy, start.y + minH, 1) : start.y + start.height;
      next = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      if (ratio) {
        const anchorX = corner.includes("w") ? x2 : x1;
        const anchorY = corner.includes("n") ? y2 : y1;
        const maxW = corner.includes("w") ? anchorX : 1 - anchorX;
        const maxH = corner.includes("n") ? anchorY : 1 - anchorY;
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
        if (w > maxW) w = maxW;
        if (h > maxH) h = maxH;
        next = {
          x: corner.includes("w") ? anchorX - w : anchorX,
          y: corner.includes("n") ? anchorY - h : anchorY,
          width: w,
          height: h
        };
      }
    }
    updateRect(clampRect(next, stage));
  };
  const endDrag = (event) => {
    dragRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = "grab";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const confirmCrop = async () => {
    if (busy || status !== "ready") return;
    const img2 = imageRef.current;
    if (!img2) return;
    const region = {
      x: round4(rectRef.current.x),
      y: round4(rectRef.current.y),
      width: round4(rectRef.current.width),
      height: round4(rectRef.current.height)
    };
    if (!isValidCropRegion(region)) {
      setError("\u88C1\u5207\u533A\u57DF\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u8C03\u6574\u3002");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const pngBase64 = await cropImageToPng(img2, region);
      let derivedAssetId = null;
      if (derive) {
        const result = await derive({ sourceAssetId: assetId, cropRegion: region, pngBase64 });
        if (!result.ok) {
          setError(result.error || (result.cancelled ? "\u5DF2\u53D6\u6D88" : "\u56FE\u7247\u5904\u7406\u5931\u8D25"));
          return;
        }
        derivedAssetId = result.assetId;
      }
      await onApply({ derivedAssetId, cropRegion: region, pngBase64 });
      setBusy(false);
      onClose();
    } catch (error2) {
      setError(error2 instanceof Error ? error2.message : String(error2));
      setBusy(false);
    }
  };
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  const img = imageRef.current;
  const sizeText = img && status === "ready" ? `${Math.max(1, Math.round(img.naturalWidth * rectRef.current.width))} \xD7 ${Math.max(1, Math.round(img.naturalHeight * rectRef.current.height))} \u50CF\u7D20` : "";
  return /* @__PURE__ */ jsx("div", { className: "studio-image-crop-modal", role: "dialog", "aria-modal": "true", "aria-label": "\u88C1\u526A\u56FE\u7247", children: /* @__PURE__ */ jsxs("div", { className: "studio-image-crop-dialog", ref: dialogRef, tabIndex: -1, children: [
    /* @__PURE__ */ jsxs("header", { className: "studio-crop-header", children: [
      /* @__PURE__ */ jsxs("h3", { children: [
        "\u88C1\u526A\u56FE\u7247",
        assetName ? ` \xB7 ${assetName}` : ""
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "studio-crop-close secondary-button", onClick: onClose, disabled: busy, children: "\u5173\u95ED" })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "studio-crop-hint", children: "\u62D6\u52A8\u9009\u6846\u79FB\u52A8\u4F4D\u7F6E\uFF0C\u62D6\u56DB\u89D2\u8C03\u6574\u5927\u5C0F\uFF1B\u786E\u8BA4\u540E\u751F\u6210\u65B0\u56FE\u7247\uFF0C\u539F\u56FE\u4FDD\u6301\u4E0D\u53D8\u3002" }),
    /* @__PURE__ */ jsxs("div", { className: "studio-crop-stage", children: [
      status === "loading" && !error ? /* @__PURE__ */ jsx("div", { className: "studio-crop-loading", role: "status", children: "\u6B63\u5728\u8F7D\u5165\u56FE\u7247\u2026" }) : null,
      /* @__PURE__ */ jsx(
        "canvas",
        {
          ref: canvasRef,
          className: "studio-crop-canvas",
          style: status === "ready" ? void 0 : { display: "none" },
          "aria-label": "\u88C1\u5207\u9884\u89C8\uFF0C\u62D6\u52A8\u9009\u6846\u6216\u56DB\u89D2\u8C03\u6574\u533A\u57DF",
          onPointerDown,
          onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag
        }
      ),
      error ? /* @__PURE__ */ jsxs("div", { className: "studio-crop-error", role: "alert", children: [
        /* @__PURE__ */ jsx("span", { children: error }),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "studio-crop-retry",
            disabled: busy,
            onClick: () => {
              setError("");
              if (status === "ready") void confirmCrop();
              else setLoadKey((key) => key + 1);
            },
            children: "\u91CD\u8BD5"
          }
        )
      ] }) : null
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "studio-crop-controls", children: [
      /* @__PURE__ */ jsx("div", { className: "studio-crop-presets", role: "group", "aria-label": "\u88C1\u5207\u6BD4\u4F8B", children: PRESET_LABELS.map(([key, label]) => /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "studio-crop-preset",
          "data-preset": key,
          "aria-pressed": aspect === key,
          disabled: busy || status !== "ready",
          onClick: () => applyPreset(key),
          children: label
        },
        key
      )) }),
      /* @__PURE__ */ jsx("div", { className: "studio-crop-size", "aria-live": "polite", children: sizeText })
    ] }),
    /* @__PURE__ */ jsxs("footer", { className: "studio-crop-footer", children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "studio-crop-cancel secondary-button", onClick: onClose, disabled: busy, children: "\u53D6\u6D88" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "studio-crop-confirm primary-button",
          onClick: () => void confirmCrop(),
          disabled: busy || status !== "ready",
          children: busy ? "\u88C1\u526A\u4E2D\u2026" : "\u5E94\u7528\u88C1\u526A"
        }
      )
    ] })
  ] }) });
}
