/**
 * Canvas 2D scene renderer.
 *
 * Draws the workspace background, checkerboard, composited layers (with an
 * optional live adjustment preview replacing one layer), and UI overlays.
 * Per-layer canvases are cached by PixelBuffer identity so unchanged layers
 * are only re-uploaded to the canvas when their pixels actually change.
 */
import type { EditorDocument, PixelBuffer, Rect, Viewport } from '../core/document/types';
import type { Selection } from '../core/document/selection';
import { computeOutline } from '../core/document/selection';
import { traceContours } from '../core/document/contour';

export interface SceneOptions {
  /** Replaces this layer's pixels with preview pixels (pending adjustments). */
  preview?: { layerId: string; pixels: PixelBuffer } | null;
  cropRect?: Rect | null;
  showCheckerboard?: boolean;
  /** Workspace background color. */
  background?: string;
  /** Active selection mask, drawn as marching ants. */
  selection?: Selection | null;
  /** Live marquee / shape drag previews (document coords). */
  marqueeDraft?: Rect | null;
  /** Draw the marquee draft as an ellipse instead of a rectangle. */
  marqueeEllipse?: boolean;
  lassoDraft?: Array<{ x: number; y: number }> | null;
  /** Draw anchor dots along the lasso draft (polygonal / magnetic only — a
   *  free lasso pushes a point every pixel and the dots would be noise). */
  lassoDraftAnchors?: boolean;
  shapeDraft?: Rect | null;
  gradientDraft?: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Live stroke: re-upload this buffer (only `dirty`) before compositing. */
  reupload?: { pixels: PixelBuffer; dirty?: Rect | null } | null;
  /** Live free transform: draw this layer through an affine matrix
   *  (layer-local pixels → document space) and show the handle overlay. */
  transform?: { layerId: string; matrix: [number, number, number, number, number, number] } | null;
  /** Move tool's Show Transform Controls: outline + 8 handles for the active
   *  layer at its normal (untransformed) position. */
  moveControls?: { x: number; y: number; w: number; h: number } | null;
}

const WORKSPACE_BG = '#181715';
const CHECKER_LIGHT = '#ffffff';
const CHECKER_DARK = '#c8cacd';

interface NativeEntry {
  canvas: HTMLCanvasElement;
  /** Persistent ImageData mirror so partial (dirty-rect) re-uploads are cheap. */
  image: ImageData;
}

const nativeCache = new WeakMap<PixelBuffer, NativeEntry>();

/** Sync buffer → cache → canvas. With `dirty`, only that rect is touched. */
function syncEntry(entry: NativeEntry, pixels: PixelBuffer, dirty?: Rect | null): void {
  const ctx = entry.canvas.getContext('2d');
  if (!ctx) return;
  if (!dirty) {
    entry.image.data.set(pixels.data);
    ctx.putImageData(entry.image, 0, 0);
    return;
  }
  const W = pixels.width;
  const H = pixels.height;
  const x0 = Math.max(0, Math.floor(dirty.x));
  const y0 = Math.max(0, Math.floor(dirty.y));
  const x1 = Math.min(W, Math.ceil(dirty.x + dirty.width));
  const y1 = Math.min(H, Math.ceil(dirty.y + dirty.height));
  if (x1 <= x0 || y1 <= y0) return;
  const rowBytes = (x1 - x0) * 4;
  const srcRow = y0 * W * 4;
  const dstRow = srcRow + x0 * 4;
  for (let y = y0; y < y1; y++) {
    const from = srcRow + (y - y0) * W * 4 + x0 * 4;
    const to = dstRow + (y - y0) * W * 4;
    entry.image.data.set(pixels.data.subarray(from, from + rowBytes), to);
  }
  ctx.putImageData(entry.image, 0, 0, x0, y0, x1 - x0, y1 - y0);
}

function nativeCanvas(pixels: PixelBuffer, reupload?: SceneOptions['reupload']): HTMLCanvasElement {
  let entry = nativeCache.get(pixels);
  if (!entry) {
    const w = Math.max(1, pixels.width);
    const h = Math.max(1, pixels.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    entry = { canvas, image: new ImageData(w, h) };
    nativeCache.set(pixels, entry);
    syncEntry(entry, pixels);
  } else if (reupload && reupload.pixels === pixels && reupload.dirty) {
    syncEntry(entry, pixels, reupload.dirty);
  }
  return entry.canvas;
}

let checkerPatternFor = new WeakMap<CanvasRenderingContext2D, CanvasPattern | null>();

function getCheckerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  // Patterns are cached per context — the scene buffer and the screen canvas
  // have their own 2D contexts.
  const cached = checkerPatternFor.get(ctx);
  if (cached !== undefined) return cached;
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const cx = c.getContext('2d');
  if (!cx) return null;
  cx.fillStyle = CHECKER_LIGHT;
  cx.fillRect(0, 0, 16, 16);
  cx.fillStyle = CHECKER_DARK;
  cx.fillRect(0, 0, 8, 8);
  cx.fillRect(8, 8, 8, 8);
  const pattern = ctx.createPattern(c, 'repeat');
  checkerPatternFor.set(ctx, pattern);
  return pattern;
}

/**
 * The photo scene — workspace background, drop shadow, checkerboard and the
 * composited layer stack — is expensive: every frame used to re-resample the
 * whole document. It is therefore painted into an offscreen buffer and only
 * re-composited when one of its inputs actually changes; each frame then blits
 * the buffer and draws the cheap overlays (guides, marching ants, tool drafts,
 * crop, handles) on top.
 *
 * That split is what makes tracing a lasso smooth: dragging repaints a
 * polyline instead of the photograph.
 */
interface SceneSig {
  doc: EditorDocument;
  preview: SceneOptions['preview'];
  zoom: number;
  panX: number;
  panY: number;
  bg: string;
  checker: boolean;
  cssW: number;
  cssH: number;
  dpr: number;
  trLayerId: string | null;
  trMatrix: [number, number, number, number, number, number] | null;
}

let sceneBuf: HTMLCanvasElement | null = null;
let sceneSig: SceneSig | null = null;

function sameMatrix(
  a: [number, number, number, number, number, number] | null,
  b: [number, number, number, number, number, number] | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5]
  );
}

/** Paint background + shadow + checkerboard + layers into `ctx` (CSS-pixel
 *  space under the `dpr` transform). */
function paintPhoto(
  ctx: CanvasRenderingContext2D,
  doc: EditorDocument,
  view: Viewport,
  opts: SceneOptions,
  p: {
    cssW: number;
    cssH: number;
    dpr: number;
    bg: string;
    preview: SceneOptions['preview'];
    checker: boolean;
    dx: number;
    dy: number;
    dw: number;
    dh: number;
  },
): void {
  ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);

  // 1. Workspace background.
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, p.cssW, p.cssH);

  // 2. Drop shadow to separate the canvas from the workspace.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = '#000';
  ctx.fillRect(p.dx, p.dy, p.dw, p.dh);
  ctx.restore();

  // 3. Checkerboard under transparency.
  if (p.checker) {
    const pattern = getCheckerPattern(ctx);
    if (pattern) {
      ctx.save();
      ctx.translate(p.dx, p.dy);
      ctx.scale(view.zoom, view.zoom);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, doc.width, doc.height);
      ctx.restore();
    }
  }

  // 4. Layers, clipped to the document bounds (canvas edge).
  ctx.save();
  ctx.beginPath();
  ctx.rect(p.dx, p.dy, p.dw, p.dh);
  ctx.clip();
  ctx.imageSmoothingEnabled = view.zoom < 4;
  ctx.imageSmoothingQuality = 'high';

  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const source =
      p.preview && p.preview.layerId === layer.id ? p.preview.pixels : layer.pixels;
    if (source.width === 0 || source.height === 0) continue;
    const img = nativeCanvas(source, opts.reupload);
    // The preview buffer may be downscaled for speed — it *replaces* the
    // layer's pixels, so always draw it at the layer's own dimensions.
    const w = layer.pixels.width * view.zoom;
    const h = layer.pixels.height * view.zoom;
    const x = p.dx + layer.x * view.zoom;
    const y = p.dy + layer.y * view.zoom;

    if (layer.opacity < 1) {
      ctx.globalAlpha = layer.opacity;
    }
    if (layer.blendMode !== 'normal') {
      ctx.globalCompositeOperation = blendToCompositeOperation(layer.blendMode);
    }
    if (opts.transform && opts.transform.layerId === layer.id) {
      // Live free transform: paint through the affine matrix (doc-space),
      // scaling handled by the context so the sample stays full quality.
      const m = opts.transform.matrix;
      ctx.save();
      ctx.translate(p.dx, p.dy);
      ctx.scale(view.zoom, view.zoom);
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(img, x, y, w, h);
    }
    if (layer.blendMode !== 'normal') ctx.globalCompositeOperation = 'source-over';
    if (layer.opacity < 1) ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/** Draw the entire scene into the canvas (sizing, layers, overlays). */
export function renderScene(
  canvas: HTMLCanvasElement,
  doc: EditorDocument,
  view: Viewport,
  opts: SceneOptions = {},
): void {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Document rectangle in screen space.
  const dx = view.panX;
  const dy = view.panY;
  const dw = doc.width * view.zoom;
  const dh = doc.height * view.zoom;

  const bg = opts.background ?? WORKSPACE_BG;
  const preview = opts.preview ?? null;
  const checker = opts.showCheckerboard !== false;
  const trLayerId = opts.transform ? opts.transform.layerId : null;
  const trMatrix = opts.transform ? opts.transform.matrix : null;

  let stale =
    sceneSig === null ||
    sceneBuf === null ||
    sceneSig.doc !== doc ||
    sceneSig.preview !== preview ||
    sceneSig.zoom !== view.zoom ||
    sceneSig.panX !== view.panX ||
    sceneSig.panY !== view.panY ||
    sceneSig.bg !== bg ||
    sceneSig.checker !== checker ||
    sceneSig.cssW !== cssW ||
    sceneSig.cssH !== cssH ||
    sceneSig.dpr !== dpr ||
    sceneSig.trLayerId !== trLayerId ||
    !sameMatrix(sceneSig.trMatrix, trMatrix) ||
    // A live stroke mutates pixels in place — the dirty rect is the only
    // signal that the buffer no longer matches the document.
    opts.reupload != null;

  if (stale) {
    if (!sceneBuf) sceneBuf = document.createElement('canvas');
    if (sceneBuf.width !== bw) sceneBuf.width = bw;
    if (sceneBuf.height !== bh) sceneBuf.height = bh;
    const bctx = sceneBuf.getContext('2d');
    if (bctx) {
      paintPhoto(bctx, doc, view, opts, { cssW, cssH, dpr, bg, preview, checker, dx, dy, dw, dh });
      sceneSig = {
        doc,
        preview,
        zoom: view.zoom,
        panX: view.panX,
        panY: view.panY,
        bg,
        checker,
        cssW,
        cssH,
        dpr,
        trLayerId,
        trMatrix,
      };
      stale = false;
    }
  }

  if (!stale && sceneBuf) {
    // Blit the cached photo scene 1:1 in device pixels (no resampling).
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(sceneBuf, 0, 0);
    ctx.restore();
  } else {
    // No buffer context available — paint straight through, as before.
    paintPhoto(ctx, doc, view, opts, { cssW, cssH, dpr, bg, preview, checker, dx, dy, dw, dh });
  }

  // 5. Guides.
  ctx.save();
  ctx.strokeStyle = 'rgba(64,168,255,0.85)';
  ctx.lineWidth = 1;
  for (const g of doc.guides) {
    ctx.beginPath();
    if (g.axis === 'vertical') {
      const gx = Math.round(dx + g.position * view.zoom) + 0.5;
      ctx.moveTo(gx, dy);
      ctx.lineTo(gx, dy + dh);
    } else {
      const gy = Math.round(dy + g.position * view.zoom) + 0.5;
      ctx.moveTo(dx, gy);
      ctx.lineTo(dx + dw, gy);
    }
    ctx.stroke();
  }
  ctx.restore();

  // 6. Selection + tool previews (marching ants).
  drawSelectionAndDrafts(ctx, opts, dx, dy, view.zoom);

  // 7. Crop overlay.
  if (opts.cropRect) drawCropOverlay(ctx, opts.cropRect, dx, dy, dw, dh, view.zoom);

  // 8. Free-transform box + handles.
  if (opts.transform) {
    const tLayer = doc.layers.find((l) => l.id === opts.transform!.layerId);
    if (tLayer) {
      drawTransformOverlay(
        ctx,
        opts.transform.matrix,
        tLayer.pixels.width,
        tLayer.pixels.height,
        dx,
        dy,
        view.zoom,
      );
    }
  }

  // 9. Move tool's Show Transform Controls: outline + handles for the active
  //    layer at its normal position (identity transform look).
  if (opts.moveControls && !opts.transform) {
    const c = opts.moveControls;
    if (c.w > 0 && c.h > 0) {
      drawTransformOverlay(ctx, [1, 0, 0, 1, c.x, c.y], c.w, c.h, dx, dy, view.zoom);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Selection & tool previews                                           */
/* ------------------------------------------------------------------ */

/** Outline canvases are cached per Selection object (computed once, drawn often). */
const outlineCache = new WeakMap<Selection, HTMLCanvasElement>();

function outlineCanvas(sel: Selection): HTMLCanvasElement | null {
  const w = sel.bounds.width;
  const h = sel.bounds.height;
  if (w <= 0 || h <= 0) return null;
  let c = outlineCache.get(sel);
  if (c) return c;
  const data = computeOutline(sel);
  c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const image = new ImageData(w, h);
  image.data.set(data);
  ctx.putImageData(image, 0, 0);
  outlineCache.set(sel, c);
  return c;
}

/** Contours are cached per Selection object (traced once, drawn often). */
const contourCache = new WeakMap<Selection, Float32Array[]>();

/**
 * Marching ants for a mask-backed selection, stroked in **screen** space.
 *
 * Drawing the traced boundary as a vector instead of blitting a
 * document-resolution bitmap is the difference between a selection and a photo
 * of one. The line stays 1.6 px at every zoom, the joins stay round, and the
 * dashes follow the contour instead of being a diagonal checkerboard stamped
 * into pixels. It matters most where the old version fell apart: fit a 4000 px
 * photo into a viewport and the 1 px ring was downsampled with smoothing off,
 * so the ants broke into sparse dots; at 400% it became a chunky staircase.
 *
 * Black pass then a white pass offset by half a dash period: alternating
 * dashes that read on any background (black survives over light imagery, white
 * over dark) — the same trick `computeOutline` bakes into its bitmap.
 *
 * @returns false for a degenerate trace so the caller can fall back.
 */
function antsContours(
  ctx: CanvasRenderingContext2D,
  sel: Selection,
  dx: number,
  dy: number,
  zoom: number,
): boolean {
  const cached = contourCache.get(sel);
  const loops = cached ?? traceContours(sel.mask, sel.bounds.width, sel.bounds.height);
  if (!cached) contourCache.set(sel, loops);
  if (loops.length === 0) return false;

  const bx = dx + sel.bounds.x * zoom;
  const by = dy + sel.bounds.y * zoom;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 5]);
  const trace = (color: string, dashOffset: number) => {
    ctx.beginPath();
    for (const loop of loops) {
      ctx.moveTo(bx + loop[0] * zoom, by + loop[1] * zoom);
      for (let i = 2; i < loop.length; i += 2) {
        ctx.lineTo(bx + loop[i] * zoom, by + loop[i + 1] * zoom);
      }
      ctx.closePath();
    }
    ctx.strokeStyle = color;
    ctx.lineDashOffset = dashOffset;
    ctx.stroke();
  };
  trace('rgba(0, 0, 0, 0.95)', 0);
  trace('#fff', 5);
  ctx.restore();
  return true;
}

/** Marching-ants rectangle: solid black under-stroke + white dashes over. */
function antsRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  if (w < 1 || h < 1) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
  ctx.restore();
}

/** Marching-ants polyline (gradient handle line). A dark halo under the white
 *  dashes is what makes the trace survive contact with real photos: a bare
 *  1 px hairline vanishes over mid-tone content, which read as "the line gets
 *  very thin while I trace". */
function antsPath(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  close: boolean,
  width = 1.6,
): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (close) ctx.closePath();
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.lineWidth = width + 2.4;
  trace();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = width;
  ctx.setLineDash([5, 5]);
  trace();
  ctx.restore();
}

/**
 * Solid trace polyline: dark halo under a white core — same
 * read-over-photos rationale as `antsPath`, minus the dashes.
 *
 * A path that is still being traced is a *direction*, not a selection. Dashes
 * on a live draft made it look as if the outline had already been committed
 * (and the dash phase fought the anchor dots for attention), so a trace reads
 * as a clean line and only becomes marching ants once it actually becomes a
 * selection — see `antsPath` and `computeOutline`.
 */
function solidPath(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  close: boolean,
  width = 1.6,
): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (close) ctx.closePath();
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.lineWidth = width + 2.4;
  trace();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = width;
  trace();
  ctx.restore();
}

/**
 * Anchor dots along a traced path (polygonal / magnetic). Dots closer than
 * 6 px to the previously drawn one are skipped, so a high-frequency magnetic
 * trace collapses into a clean line instead of a beaded tube, while deliberate
 * polygonal vertices always keep their handle.
 */
function anchorDots(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>): void {
  if (pts.length < 2) return;
  ctx.save();
  let lastX = Number.POSITIVE_INFINITY;
  let lastY = Number.POSITIVE_INFINITY;
  for (const p of pts) {
    if (Math.hypot(p.x - lastX, p.y - lastY) < 6) continue;
    lastX = p.x;
    lastY = p.y;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.stroke();
  }
  ctx.restore();
}

/** Marching-ants ellipse (elliptical marquee draft). */
function antsEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.lineWidth = 1;
  const trace = () => {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  };
  ctx.strokeStyle = '#000';
  trace();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  trace();
  ctx.restore();
}

function drawSelectionAndDrafts(
  ctx: CanvasRenderingContext2D,
  opts: SceneOptions,
  dx: number,
  dy: number,
  zoom: number,
): void {
  const sel = opts.selection;
  if (sel && sel.bounds.width > 0 && sel.bounds.height > 0) {
    const b = sel.bounds;
    if (sel.rect) {
      antsRect(ctx, dx + b.x * zoom, dy + b.y * zoom, b.width * zoom, b.height * zoom);
    } else if (!antsContours(ctx, sel, dx, dy, zoom)) {
      // Degenerate trace — fall back to the stamped bitmap outline.
      const c = outlineCanvas(sel);
      if (c) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(c, dx + b.x * zoom, dy + b.y * zoom, b.width * zoom, b.height * zoom);
        ctx.restore();
      }
    }
  }

  if (opts.marqueeDraft) {
    const r = opts.marqueeDraft;
    if (opts.marqueeEllipse) {
      antsEllipse(ctx, dx + r.x * zoom, dy + r.y * zoom, r.width * zoom, r.height * zoom);
    } else {
      antsRect(ctx, dx + r.x * zoom, dy + r.y * zoom, r.width * zoom, r.height * zoom);
    }
  }
  if (opts.shapeDraft) {
    const r = opts.shapeDraft;
    antsRect(ctx, dx + r.x * zoom, dy + r.y * zoom, r.width * zoom, r.height * zoom);
  }
  if (opts.lassoDraft && opts.lassoDraft.length > 1) {
    const pts = opts.lassoDraft.map((p) => ({ x: dx + p.x * zoom, y: dy + p.y * zoom }));
    solidPath(ctx, pts, true);
    if (opts.lassoDraftAnchors) anchorDots(ctx, pts);
  }
  if (opts.gradientDraft) {
    const g = opts.gradientDraft;
    const ends: Array<{ x: number; y: number }> = [
      { x: dx + g.x1 * zoom, y: dy + g.y1 * zoom },
      { x: dx + g.x2 * zoom, y: dy + g.y2 * zoom },
    ];
    antsPath(ctx, ends, false);
    ctx.save();
    for (const p of ends) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}

function blendToCompositeOperation(mode: string): GlobalCompositeOperation {
  // Canvas supports the same separable modes; nonseparable modes fall back
  // to normal on screen (they are still correct on export via the compositor).
  const supported: Record<string, GlobalCompositeOperation> = {
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    'color-dodge': 'color-dodge',
    'color-burn': 'color-burn',
    darken: 'darken',
    lighten: 'lighten',
    'hard-light': 'hard-light',
    'soft-light': 'soft-light',
    difference: 'difference',
    exclusion: 'exclusion',
  };
  return supported[mode] ?? 'source-over';
}

function drawCropOverlay(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  zoom: number,
): void {
  const x = dx + rect.x * zoom;
  const y = dy + rect.y * zoom;
  const w = rect.width * zoom;
  const h = rect.height * zoom;

  // Dim everything outside the crop rect (clipped to the document bounds).
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(dx, dy, x - dx, dh);
  ctx.fillRect(x + w, dy, dw - (x + w - dx), dh);
  ctx.fillRect(x, dy, w, y - dy);
  ctx.fillRect(x, y + h, w, dh - (y + h - dy));
  ctx.restore();

  // Border + rule-of-thirds.
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  for (let i = 1; i <= 2; i++) {
    ctx.moveTo(x + (w * i) / 3, y);
    ctx.lineTo(x + (w * i) / 3, y + h);
    ctx.moveTo(x, y + (h * i) / 3);
    ctx.lineTo(x + w, y + (h * i) / 3);
  }
  ctx.stroke();

  // Corner handles.
  const s = Math.min(14, Math.max(6, Math.min(w, h) * 0.08));
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  const corners: Array<[number, number, number, number]> = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ];
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of corners) {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + s * sx, cy);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + s * sy);
  }
  ctx.stroke();
  ctx.restore();
}

/** Free-transform outline + 8 square handles (corner + edge midpoints).
 *  Handles stay a constant 8 px on screen regardless of zoom, and the whole
 *  box follows the live affine matrix (layer-local → document → screen). */
function drawTransformOverlay(
  ctx: CanvasRenderingContext2D,
  m: [number, number, number, number, number, number],
  w: number,
  h: number,
  dx: number,
  dy: number,
  zoom: number,
): void {
  const ap = (x: number, y: number) => ({
    x: dx + (m[0] * x + m[2] * y + m[4]) * zoom,
    y: dy + (m[1] * x + m[3] * y + m[5]) * zoom,
  });
  const c0 = ap(0, 0);
  const c1 = ap(w, 0);
  const c2 = ap(w, h);
  const c3 = ap(0, h);
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  ctx.save();
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();
    ctx.stroke();
  };
  ctx.strokeStyle = '#000';
  trace();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  trace();
  ctx.setLineDash([]);

  const handles = [
    c0,
    c1,
    c2,
    c3,
    mid(c0, c1),
    mid(c1, c2),
    mid(c2, c3),
    mid(c3, c0),
  ];
  for (const p of handles) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
  }
  ctx.restore();
}
