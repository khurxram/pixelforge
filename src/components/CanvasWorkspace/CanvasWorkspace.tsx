import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { FolderOpen, ImagePlus } from 'lucide-react';
import styles from './CanvasWorkspace.module.css';
import { renderScene } from '../../rendering/renderer';
import { clampZoom, screenToDoc } from '../../rendering/viewport';
import { clampRectToDocument, getLayer } from '../../core/document/ops';
import {
  combineSelection,
  ellipseSelection,
  expandQuickSelection,
  featherSelection,
  pathSelection,
  rectSelection,
  rowSelection,
  columnSelection,
  selectionAlpha,
  type Selection,
} from '../../core/document/selection';
import type { EditorDocument, Rect, PixelBuffer, ToolId } from '../../core/document/types';
import {
  applyAdjustments,
  isIdentityAdjustment,
  type AdjustParams,
} from '../../imaging/adjustments';
import { downscaleToMax } from '../../imaging/scale';
import { compositeDocument, sampleComposite } from '../../imaging/composite';
import { gradientMagnitude, snapToEdge } from '../../imaging/edges';
import { rgbToHex } from '../../imaging/color';
import {
  applyGradient,
  applyLineShape,
  applyShape,
  beginFreeTransform,
  beginPixelEdit,
  cancelFreeTransform,
  commitFreeTransform,
  finishPixelEdit,
  magicEraseAt,
  openImageFile,
  openProjectFromFile,
  panBy,
  placeImageAsLayer,
  placeTextLayer,
  setActiveLayer,
  setCloneOffset,
  setCropRect,
  setCursor,
  setForeground,
  setGradientDraft,
  setLassoDraft,
  setLayerOffsetLive,
  setMarqueeDraft,
  setSelection,
  setShapeDraft,
  setTransformLive,
  setWorkspaceSize,
  setZoomAt,
  toast,
  transformMatrix,
  touchDoc,
  wandSelectAt,
  objectSelectAt,
  type PixelEditSession,
} from '../../app/actions';
import {
  bgEraseStroke,
  blurStroke,
  cloneStroke,
  dodgeBurnStroke,
  eraseStroke,
  floodFill,
  healStroke,
  hexToRgba,
  paintStroke,
  patchFill,
  pencilStroke,
  redEyeStroke,
  replaceColorStroke,
  sharpenStroke,
  smudgeStroke,
  spongeStroke,
  spotHealStroke,
  type PaintContext,
  type StampOptions,
  type StrokeState,
} from '../../imaging/paint';
import { getState, setState, useEditorStore, type CropAspect, type FreeTransform } from '../../app/editorStore';
import { isTypingTarget } from '../../app/shortcuts';
import { pickFile } from '../../utils/filePicker';

/* ------------------------- adjustment preview ------------------------- */

const previewCache = new WeakMap<PixelBuffer, Map<string, PixelBuffer>>();
const PREVIEW_MAX_DIM = 1200;

function computePreview(pixels: PixelBuffer, layerId: string, params: AdjustParams) {
  const key = JSON.stringify(params);
  let byKey = previewCache.get(pixels);
  if (byKey?.has(key)) return { layerId, pixels: byKey.get(key)! };
  const small = downscaleToMax(pixels, PREVIEW_MAX_DIM);
  const scale = small.width / pixels.width;
  const scaledParams: AdjustParams = { ...params, blurRadius: params.blurRadius * scale };
  const result = applyAdjustments(small, scaledParams);
  if (!byKey) {
    byKey = new Map();
    previewCache.set(pixels, byKey);
  }
  if (byKey.size > 24) byKey.clear(); // bound the cache
  byKey.set(key, result);
  return { layerId, pixels: result };
}

function resolveAspect(aspect: CropAspect, docW: number, docH: number): number | null {
  switch (aspect) {
    case 'free':
      return null;
    case 'original':
      return docW / docH;
    case '1:1':
      return 1;
    case '4:3':
      return 4 / 3;
    case '3:2':
      return 3 / 2;
    case '16:9':
      return 16 / 9;
  }
}

/* ------------------------------ strokes ------------------------------ */

/** Tools that paint through the live-stroke pipeline. */
const STROKE_TOOLS: readonly ToolId[] = [
  'brush',
  'pencil',
  'brush-replace',
  'eraser',
  'eraser-bg',
  'clone',
  'healing',
  'healing-spot',
  'redeye',
  'blur',
  'sharpen',
  'smudge',
  'dodge',
  'burn',
  'sponge',
];

const STROKE_LABEL: Partial<Record<ToolId, string>> = {
  brush: 'Brush Stroke',
  pencil: 'Pencil Stroke',
  'brush-replace': 'Color Replacement',
  eraser: 'Erase',
  'eraser-bg': 'Background Eraser',
  clone: 'Clone Stamp',
  healing: 'Healing Brush',
  'healing-spot': 'Spot Healing',
  redeye: 'Red Eye',
  blur: 'Blur Stroke',
  sharpen: 'Sharpen Stroke',
  smudge: 'Smudge Stroke',
  dodge: 'Dodge',
  burn: 'Burn',
  sponge: 'Sponge',
};

/** Tools that show the brush-size ring under the cursor. */
const RING_TOOLS: readonly ToolId[] = [...STROKE_TOOLS, 'quickselect'];

/** One in-progress stroke: session, cloned-source info, dirty accumulation. */
interface StrokeRuntime {
  session: PixelEditSession;
  tool: ToolId;
  /** Last stamped point in BUFFER coordinates. */
  last: { x: number; y: number };
  /** Pre-stroke pixel snapshot (clone/healing sample source), buffer coords. */
  src: PixelBuffer | null;
  /** Stroke-start snapshot for uniform effects (blur/sharpen/dodge/burn/
   *  sponge): every dab computes from this base so overlaps can't stack. */
  snapshot: PixelBuffer | null;
  /** Stamp spacing state shared across per-event segment calls. */
  state: StrokeState;
  /** Sample offset: brush start − source point (buffer coords). */
  offset: { x: number; y: number };
  /** Stroke-start color sample (background eraser, "once" mode). */
  sample: { r: number; g: number; b: number; a: number } | null;
  changed: boolean;
}

/** Effect tools that read their stroke-start snapshot instead of the live
 *  buffer (prevents slow-stroke blow-outs). */
const SNAPSHOT_TOOLS: readonly ToolId[] = ['blur', 'sharpen', 'dodge', 'burn', 'sponge'];

/**
 * Commit a freshly created selection through the shared pipeline:
 * feather the new shape, then combine it with the existing selection using
 * the active selection mode (new / add / subtract / intersect).
 */
function commitNewSelection(next: Selection | null, label: string): void {
  if (!next) return;
  const s = getState();
  let sel = next;
  if (s.featherPx > 0) sel = featherSelection(sel, s.featherPx);
  const combined = combineSelection(s.selection, sel, s.selectionMode);
  setSelection(combined, label);
}

/** Marquee-family drag tools produce rect or ellipse shapes. */
function marqueeShapeOf(tool: ToolId): 'rect' | 'ellipse' {
  return tool === 'marquee-ellipse' ? 'ellipse' : 'rect';
}

/** Apply the marquee style (normal / fixed ratio / fixed size) to a drag. */
function styledMarqueeRect(
  s: { marqueeStyle: 'normal' | 'ratio' | 'fixed'; ratioW: number; ratioH: number; fixedW: number; fixedH: number },
  startX: number,
  startY: number,
  docPt: { x: number; y: number },
): Rect {
  if (s.marqueeStyle === 'fixed') {
    const w = s.fixedW;
    const h = s.fixedH;
    return {
      x: Math.min(startX, docPt.x < startX ? startX - w : startX),
      y: Math.min(startY, docPt.y < startY ? startY - h : startY),
      width: w,
      height: h,
    };
  }
  let w = Math.abs(docPt.x - startX);
  let h = Math.abs(docPt.y - startY);
  if (s.marqueeStyle === 'ratio') {
    const ratio = s.ratioW / Math.max(0.001, s.ratioH);
    if (w / ratio > h) h = w / ratio;
    else w = h * ratio;
  }
  return {
    x: docPt.x < startX ? startX - w : startX,
    y: docPt.y < startY ? startY - h : startY,
    width: w,
    height: h,
  };
}

/** Average an n×n composite sample around a document point (null when the
 *  whole area is transparent). Shared by the eyedropper click and its live
 *  loupe readout. */
function sampleAtDoc(
  doc: EditorDocument,
  x: number,
  y: number,
  k: number,
): { r: number; g: number; b: number } | null {
  const half = (k - 1) >> 1;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = 0; dy < k; dy++) {
    for (let dx = 0; dx < k; dx++) {
      const c = sampleComposite(doc, Math.floor(x) - half + dx, Math.floor(y) - half + dy);
      if (c.a > 0) {
        r += c.r;
        g += c.g;
        b += c.b;
        n++;
      }
    }
  }
  if (n === 0) return null;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** Pending re-upload of the buffer being stroked (consumed by the renderer). */
interface StrokeUpload {
  pixels: PixelBuffer;
  dirty: Rect | null;
}

/** Tools that aim at the canvas: crosshair cursor. */
const CROSS_TOOLS: readonly ToolId[] = [
  'crop',
  'eyedropper',
  'marquee',
  'marquee-ellipse',
  'marquee-row',
  'marquee-col',
  'lasso',
  'lasso-poly',
  'lasso-magnetic',
  'wand',
  'quickselect',
  'objectselect',
  'bucket',
  'eraser-magic',
  'patch',
  'gradient',
  'shape',
  'shape-round',
  'shape-ellipse',
  'shape-poly',
  'shape-line',
  'text',
  ...STROKE_TOOLS,
];

function unionDirty(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Apply one quick-selection dab at a document point and commit the preview. */
function applyQuickSelDab(
  drag: Extract<DragState, { kind: 'quicksel' }>,
  docPt: { x: number; y: number },
): void {
  const s = getState();
  const lx = Math.round(docPt.x - drag.origin.x);
  const ly = Math.round(docPt.y - drag.origin.y);
  drag.union = expandQuickSelection(
    drag.source,
    lx,
    ly,
    Math.max(2, s.brushSize / 2),
    s.wandTolerance,
    drag.union,
    { visited: drag.visited },
  );
  if (drag.union) {
    const preview = combineSelection(drag.base, drag.union, s.selectionMode);
    if (preview) {
      setSelection(
        preview,
        `Quick Selection — ${preview.bounds.width} × ${preview.bounds.height} px`,
      );
    }
  }
}

/** Apply one segment of a stroke to the live buffer; returns the dirty rect. */
function runStroke(stroke: StrokeRuntime, points: Array<{ x: number; y: number }>): Rect | null {
  const s = getState();
  const pixels = stroke.session.pixels;
  const ctx: PaintContext = {
    selection: s.selection,
    origin: stroke.session.origin,
    strokeState: stroke.state,
  };
  const opts: StampOptions = {
    size: s.brushSize,
    opacity: s.brushOpacity / 100,
    hardness: s.brushHardness / 100,
    flow: s.brushFlow / 100,
  };
  switch (stroke.tool) {
    case 'brush':
      paintStroke(pixels, points, opts, hexToRgba(s.foreground), ctx);
      break;
    case 'pencil':
      pencilStroke(pixels, points, opts, hexToRgba(s.foreground), ctx);
      break;
    case 'brush-replace':
      replaceColorStroke(pixels, points, opts, s.wandTolerance, hexToRgba(s.foreground), ctx);
      break;
    case 'eraser':
      eraseStroke(pixels, points, opts, ctx);
      break;
    case 'eraser-bg':
      bgEraseStroke(pixels, points, opts, stroke.sample, s.bgSampleMode, s.wandTolerance, ctx, s.contiguous);
      break;
    case 'blur':
      blurStroke(pixels, stroke.snapshot ?? pixels, points, opts, ctx);
      break;
    case 'sharpen':
      sharpenStroke(pixels, stroke.snapshot ?? pixels, points, opts, ctx);
      break;
    case 'smudge':
      smudgeStroke(pixels, points, opts, ctx);
      break;
    case 'sponge':
      spongeStroke(pixels, stroke.snapshot ?? pixels, points, opts, s.spongeMode, ctx);
      break;
    case 'dodge':
      dodgeBurnStroke(pixels, stroke.snapshot ?? pixels, points, opts, 'dodge', ctx, s.toneRange);
      break;
    case 'burn':
      dodgeBurnStroke(pixels, stroke.snapshot ?? pixels, points, opts, 'burn', ctx, s.toneRange);
      break;
    case 'clone':
    case 'healing':
      if (!stroke.src) return null;
      if (stroke.tool === 'clone') cloneStroke(pixels, stroke.src, points, opts, stroke.offset, ctx);
      else healStroke(pixels, stroke.src, points, opts, stroke.offset, ctx);
      break;
    case 'healing-spot':
      spotHealStroke(pixels, points, opts, ctx);
      break;
    case 'redeye':
      redEyeStroke(pixels, points, opts, ctx);
      break;
    default:
      return null;
  }

  // Union of stamped circle bounds, clamped to the buffer.
  const pad = opts.size / 2 + 2;
  let dirty: Rect | null = null;
  for (const p of points) {
    dirty = unionDirty(dirty, {
      x: Math.floor(p.x - pad),
      y: Math.floor(p.y - pad),
      width: Math.ceil(pad * 2),
      height: Math.ceil(pad * 2),
    });
  }
  if (!dirty) return null;
  const x0 = Math.max(0, dirty.x);
  const y0 = Math.max(0, dirty.y);
  const x1 = Math.min(pixels.width, dirty.x + dirty.width);
  const y1 = Math.min(pixels.height, dirty.y + dirty.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* ------------------------------ component ------------------------------ */

type DragState =
  | { kind: 'pan'; lastX: number; lastY: number }
  /** Two-finger pinch/pan: live pointers, plus the zoom/pan at gesture start so
   *  the transform is derived from the finger geometry (no drift, no drift
   *  compounding). Only reachable on touch pointers. */
  | {
      kind: 'gesture';
      startDist: number;
      startZoom: number;
      startPanX: number;
      startPanY: number;
      startMid: { x: number; y: number };
    }
  | { kind: 'crop-new'; startX: number; startY: number }
  | { kind: 'crop-move'; startX: number; startY: number; orig: Rect }
  | { kind: 'crop-resize'; corner: number; orig: Rect }
  | { kind: 'marquee'; startX: number; startY: number; tool: ToolId }
  | { kind: 'lasso'; points: Array<{ x: number; y: number }>; label?: string }
  | { kind: 'poly' }
  | {
      kind: 'magnetic';
      points: Array<{ x: number; y: number }>;
      /** Sobel magnitude map of the sampled source (buffer coords). */
      map: Float32Array;
      mw: number;
      mh: number;
      /** Source buffer → document offset. */
      origin: { x: number; y: number };
      lastDab: { x: number; y: number };
      /** Last raw pointer position pushed into the preview (0.75 px filter so
       *  sub-pixel pointer jitter does not churn the store every event). */
      preview?: { x: number; y: number };
    }
  | {
      kind: 'quicksel';
      base: Selection | null;
      source: PixelBuffer;
      origin: { x: number; y: number };
      union: Selection | null;
      lastDab: { x: number; y: number };
      /** W*H visited scratch reused by every dab of this stroke. */
      visited: Uint8Array;
    }
  | { kind: 'shape'; startX: number; startY: number }
  | { kind: 'line'; startX: number; startY: number }
  | { kind: 'gradient'; startX: number; startY: number }
  | { kind: 'patch'; startX: number; startY: number; sel: Selection }
  | {
      kind: 'move';
      startX: number;
      startY: number;
      origX: number;
      origY: number;
      layerId: string;
      before: EditorDocument;
    }
  /** Show-transform-controls handle press: becomes a transform drag once the
   *  pointer actually moves, so a stray click never traps the pointer. */
  | { kind: 'move-handle'; startX: number; startY: number; layerId: string }
  | {
      kind: 'transform-move';
      startX: number;
      startY: number;
      base: FreeTransform;
    }
  | {
      kind: 'transform-rotate';
      base: FreeTransform;
      startAngle: number;
      centerX: number;
      centerY: number;
    }
  | {
      kind: 'transform-scale';
      base: FreeTransform;
      /** Handle position in local layer space (0, 0.5 or 1 per axis). */
      hx: number;
      hy: number;
      /** Anchor that stays pinned, in local space… */
      anchorLocalX: number;
      anchorLocalY: number;
      /** …and in document space. */
      anchorX: number;
      anchorY: number;
      bw: number;
      bh: number;
      fromCenter: boolean;
    }
  | { kind: 'stroke'; stroke: StrokeRuntime };

export function CanvasWorkspace() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Cached screen rect of the canvas. The stage never scrolls (the editor
   *  shell clips overflow), so it only changes when the workspace resizes or a
   *  gesture starts — reading it per pointer event would force a layout flush
   *  on every mouse move. */
  const rectRef = useRef<DOMRect | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** Touch pointers currently on the canvas, for pinch gestures. */
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const strokeRef = useRef<StrokeUpload | null>(null);
  /** Polygonal-lasso vertices placed so far (document coords). */
  const polyRef = useRef<Array<{ x: number; y: number }>>([]);
  /** Smoothed pointer position for stroke smoothing (buffer coords). */
  const smoothRef = useRef<{ x: number; y: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  /** Brush-cursor ring: pointer position inside the stage (CSS px). */
  const [ring, setRing] = useState<{ x: number; y: number } | null>(null);
  const [loupe, setLoupe] = useState<{
    x: number;
    y: number;
    r: number;
    g: number;
    b: number;
    hex: string;
  } | null>(null);
  /** Brief size/opacity readout shown next to the ring while resizing. */
  const [ringHud, setRingHud] = useState(false);
  const hudTimer = useRef<number | null>(null);
  const hudFirstRun = useRef(true);

  const doc = useEditorStore((s) => s.doc);
  const viewport = useEditorStore((s) => s.viewport);
  const tool = useEditorStore((s) => s.tool);
  const foreground = useEditorStore((s) => s.foreground);
  const background = useEditorStore((s) => s.background);
  const brushSize = useEditorStore((s) => s.brushSize);
  const brushOpacity = useEditorStore((s) => s.brushOpacity);
  const brushHardness = useEditorStore((s) => s.brushHardness);
  const cropRect = useEditorStore((s) => s.cropRect);
  const transform = useEditorStore((s) => s.transform);
  const adjustments = useEditorStore((s) => s.adjustments);
  const adjustmentsLayerId = useEditorStore((s) => s.adjustmentsLayerId);
  const showCheckerboard = useEditorStore((s) => s.showCheckerboard);
  const selection = useEditorStore((s) => s.selection);
  const marqueeDraft = useEditorStore((s) => s.marqueeDraft);
  const lassoDraft = useEditorStore((s) => s.lassoDraft);
  const shapeDraft = useEditorStore((s) => s.shapeDraft);
  const gradientDraft = useEditorStore((s) => s.gradientDraft);
  const moveShowControls = useEditorStore((s) => s.moveShowControls);

  /* Live adjustment preview for the targeted layer. */
  const previewLayer = doc && adjustmentsLayerId ? getLayer(doc, adjustmentsLayerId) : null;
  const preview = useMemo(() => {
    if (!previewLayer || isIdentityAdjustment(adjustments)) return null;
    return computePreview(previewLayer.pixels, previewLayer.id, adjustments);
  }, [previewLayer, adjustments]);

  /* Flash the size HUD next to the cursor whenever the bracket keys or the
     options bar change the brush. */
  useEffect(() => {
    if (hudFirstRun.current) {
      hudFirstRun.current = false;
      return;
    }
    setRingHud(true);
    if (hudTimer.current !== null) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setRingHud(false), 1100);
    return () => {
      if (hudTimer.current !== null) window.clearTimeout(hudTimer.current);
    };
  }, [brushSize, brushOpacity, brushHardness]);

  /* The stage colour only changes when the theme flips — reading it once per
     theme instead of once per frame keeps renderScene free of the forced
     style recalc that getComputedStyle() triggers on every pointer move. */
  const bgCacheRef = useRef<{ tick: number; value: string }>({ tick: -1, value: '' });

  /* Render loop (rAF-throttled). The stage color comes from the theme token so
     the painted background always matches --bg-canvas in light and dark. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc) return;
    let bg = '';
    if (bgCacheRef.current.tick === themeTick) {
      bg = bgCacheRef.current.value;
    } else if (containerRef.current) {
      bg = getComputedStyle(containerRef.current).getPropertyValue('--bg-canvas').trim();
      bgCacheRef.current = { tick: themeTick, value: bg };
    }
    const upload = strokeRef.current;
    // Show Transform Controls: outline + 8 handles around the active layer
    // while the Move tool is idle (they become interactive on press).
    const ctrlLayer =
      tool === 'move' && moveShowControls && !transform ? getLayer(doc, doc.activeLayerId ?? '') : null;
    renderScene(canvas, doc, viewport, {
      preview,
      cropRect: tool === 'crop' ? cropRect : null,
      showCheckerboard,
      background: bg || undefined,
      selection,
      marqueeDraft,
      marqueeEllipse: tool === 'marquee-ellipse',
      lassoDraft,
      lassoDraftAnchors: tool === 'lasso-poly' || tool === 'lasso-magnetic',
      shapeDraft,
      gradientDraft,
      moveControls: ctrlLayer
        ? { x: ctrlLayer.x, y: ctrlLayer.y, w: ctrlLayer.pixels.width, h: ctrlLayer.pixels.height }
        : null,
      reupload: upload && upload.dirty ? { pixels: upload.pixels, dirty: upload.dirty } : null,
      transform: transform
        ? { layerId: transform.layerId, matrix: transformMatrix(transform) }
        : null,
    });
    // The dirty rect was flushed this frame; keep the ref for later strokes.
    if (upload) upload.dirty = null;
  }, [
    doc,
    viewport,
    preview,
    cropRect,
    transform,
    tool,
    moveShowControls,
    showCheckerboard,
    selection,
    marqueeDraft,
    lassoDraft,
    shapeDraft,
    gradientDraft,
    themeTick,
  ]);

  useEffect(() => {
    const raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  /* Re-render when the theme flips so the stage repaints immediately. */
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  /* Workspace sizing → fit mode. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      rectRef.current = null;
      if (rect) setWorkspaceSize(rect.width, rect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Space = temporary hand tool. */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* Wheel: ctrl/⌘ = zoom at cursor (trackpad pinch), otherwise pan. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const s = getState();
      if (!s.doc) return;
      e.preventDefault();
      const rect = (rectRef.current ??= canvas.getBoundingClientRect());
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-dy * 0.0028);
        setZoomAt(clampZoom(s.viewport.zoom * factor), anchor);
      } else if (e.shiftKey) {
        panBy(-(dx || dy), 0);
      } else {
        panBy(-dx, -dy);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  /* Two-finger pinch to zoom and pan (touch). Runs on the container because the
   * gesture is a function of several pointers, not one drag. Zoom/pan are
   * derived from the *initial* geometry each frame — recomputing from the start
   * state rather than accumulating deltas — so a jittery finger can never make
   * the view drift or compound an error. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const pts = pointersRef.current;

    const update = () => {
      const g = dragRef.current;
      if (!g || g.kind !== 'gesture' || pts.size < 2) return;
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = getState();
      if (g.startDist > 1) setZoomAt(clampZoom(g.startZoom * (dist / g.startDist)), g.startMid);
      panBy(
        g.startPanX + (mid.x - g.startMid.x) - s.viewport.panX,
        g.startPanY + (mid.y - g.startMid.y) - s.viewport.panY,
      );
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const c = canvasRef.current;
      if (!c || !el.contains(e.target as Node)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        // Second finger down: abandon any one-finger drag (a stroke that was
        // mid-flight is cancelled, matching how every touch editor behaves)
        // and switch wholesale to navigation.
        dragRef.current = null;
        const [a, b] = [...pts.values()];
        const s = getState();
        dragRef.current = {
          kind: 'gesture',
          startDist: Math.hypot(a.x - b.x, a.y - b.y),
          startZoom: s.viewport.zoom,
          startPanX: s.viewport.panX,
          startPanY: s.viewport.panY,
          startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
      }
    };

    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (dragRef.current?.kind === 'gesture') update();
    };

    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2 && dragRef.current?.kind === 'gesture') {
        dragRef.current = null;
        // The remaining finger becomes a fresh pan so lifting the first one
        // does not leave the view stuck.
        if (pts.size === 1) {
          const [a] = [...pts.values()];
          const canvas = canvasRef.current;
          const rect = (rectRef.current ??= canvas!.getBoundingClientRect());
          dragRef.current = {
            kind: 'pan',
            lastX: a.x - rect.left,
            lastY: a.y - rect.top,
          };
        }
      }
    };

    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerup', up, true);
    el.addEventListener('pointercancel', up, true);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointermove', move, true);
      el.removeEventListener('pointerup', up, true);
      el.removeEventListener('pointercancel', up, true);
    };
  }, [setZoomAt, panBy]);

  /* Pointer helpers. */
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = (rectRef.current ??= el.getBoundingClientRect());
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /* --------------------------- pointer helpers --------------------------- */

  /** Hit-test a pending Free Transform: handles win first, then the box
   *  interior (move), then the near-edge band (rotate). Null when far
   *  outside — the caller then ignores the click. */
  const transformDragFor = (
    s: ReturnType<typeof getState>,
    t: NonNullable<ReturnType<typeof getState>['transform']>,
    local: { x: number; y: number },
    docPt: { x: number; y: number },
    e: ReactPointerEvent<HTMLCanvasElement>,
  ): DragState | null => {
    if (!s.doc) return null;
    const tLayer = getLayer(s.doc, t.layerId);
    if (!tLayer) return null;
    const m = transformMatrix(t);
    const bw = tLayer.pixels.width;
    const bh = tLayer.pixels.height;
    const toScreen = (px: number, py: number) => ({
      x: (m[0] * px + m[2] * py + m[4]) * s.viewport.zoom + s.viewport.panX,
      y: (m[1] * px + m[3] * py + m[5]) * s.viewport.zoom + s.viewport.panY,
    });
    // 1. Handles (corners + edge midpoints) win first — 8 px grab radius.
    const handleDefs: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.5, 0],
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
    ];
    for (const [hx, hy] of handleDefs) {
      const p = toScreen(hx * bw, hy * bh);
      if (Math.abs(p.x - local.x) <= 7 && Math.abs(p.y - local.y) <= 7) {
        // Alt scales from the centre; the anchor flips to the box centre.
        const fromCenter = e.altKey;
        const alx = fromCenter || hx === 0.5 ? bw / 2 : (1 - hx) * bw;
        const aly = fromCenter || hy === 0.5 ? bh / 2 : (1 - hy) * bh;
        return {
          kind: 'transform-scale',
          base: t,
          hx,
          hy,
          anchorLocalX: alx,
          anchorLocalY: aly,
          anchorX: m[0] * alx + m[2] * aly + m[4],
          anchorY: m[1] * alx + m[3] * aly + m[5],
          bw,
          bh,
          fromCenter,
        };
      }
    }
    // 2. Inside the quad → move; within 24 px outside an edge → rotate.
    const quad = [toScreen(0, 0), toScreen(bw, 0), toScreen(bw, bh), toScreen(0, bh)];
    let sign = 0;
    let insideQuad = true;
    let nearest = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const cr = (b.x - a.x) * (local.y - a.y) - (b.y - a.y) * (local.x - a.x);
      if (cr !== 0) {
        const sgn = Math.sign(cr);
        if (sign === 0) sign = sgn;
        else if (sgn !== sign) insideQuad = false;
      }
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      const tt = len2
        ? Math.max(0, Math.min(1, ((local.x - a.x) * vx + (local.y - a.y) * vy) / len2))
        : 0;
      const ex = a.x + vx * tt - local.x;
      const ey = a.y + vy * tt - local.y;
      nearest = Math.min(nearest, Math.sqrt(ex * ex + ey * ey));
    }
    if (insideQuad) {
      return { kind: 'transform-move', startX: docPt.x, startY: docPt.y, base: t };
    }
    if (nearest <= 24) {
      const cdX = m[0] * (bw / 2) + m[2] * (bh / 2) + m[4];
      const cdY = m[1] * (bw / 2) + m[3] * (bh / 2) + m[5];
      return {
        kind: 'transform-rotate',
        base: t,
        startAngle: Math.atan2(docPt.y - cdY, docPt.x - cdX),
        centerX: cdX,
        centerY: cdY,
      };
    }
    return null; // far outside: ignore (so stray clicks can't reach the tools)
  };

  /** Screen position of a layer corner/edge handle (Show Transform Controls);
   *  returns the handle when the pointer is on one (7 px grab radius). */
  const layerHandleAt = (
    s: ReturnType<typeof getState>,
    layer: { x: number; y: number; pixels: PixelBuffer },
    local: { x: number; y: number },
  ): [number, number] | null => {
    const bw = layer.pixels.width;
    const bh = layer.pixels.height;
    const z = s.viewport.zoom;
    const toScreen = (px: number, py: number) => ({
      x: (px + layer.x) * z + s.viewport.panX,
      y: (py + layer.y) * z + s.viewport.panY,
    });
    const handles: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.5, 0],
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
    ];
    for (const [hx, hy] of handles) {
      const p = toScreen(hx * bw, hy * bh);
      if (Math.abs(p.x - local.x) <= 7 && Math.abs(p.y - local.y) <= 7) return [hx, hy];
    }
    return null;
  };

  /** Topmost visible layer with opaque content under a document point. */
  const autoSelectLayerId = (doc: EditorDocument, docPt: { x: number; y: number }): string | null => {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!l.visible) continue;
      const bx = Math.floor(docPt.x - l.x);
      const by = Math.floor(docPt.y - l.y);
      if (bx < 0 || by < 0 || bx >= l.pixels.width || by >= l.pixels.height) continue;
      if (l.pixels.data[(by * l.pixels.width + bx) * 4 + 3] > 12) return l.id;
    }
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = getState();
    if (!s.doc) return;
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    // Re-read the rect once per gesture: a stale cache can only ever be wrong
    // by an amount that shows up here, never mid-drag.
    rectRef.current = canvas.getBoundingClientRect();
    const local = localPoint(e);
    const docPt = screenToDoc(local, s.viewport);
    const effectiveTool = e.button === 1 || spaceHeld ? 'hand' : s.tool;

    // Right-drag always pans (never paints or edits).
    if (e.button === 2) {
      dragRef.current = { kind: 'pan', lastX: local.x, lastY: local.y };
      return;
    }
    // Space-drag and the middle button always pan (universal navigation).
    // The Hand tool pans too — except while a Free Transform is pending,
    // which takes over the pointer so its handles stay draggable from any
    // tool (classic-editor parity).
    if ((effectiveTool === 'hand' && !s.transform) || e.button === 1 || spaceHeld) {
      dragRef.current = { kind: 'pan', lastX: local.x, lastY: local.y };
      return;
    }
    // A pending Free Transform swallows the pointer: handles scale, the box
    // moves, and hovering just outside an edge rotates (classic-editor feel).
    if (s.transform) {
      dragRef.current = transformDragFor(s, s.transform, local, docPt, e);
      return;
    }
    // Show Transform Controls: press a handle to start a transform drag
    // (deferred until the pointer actually moves, so a stray click that
    // merely grazes an edge never traps the pointer).
    if (effectiveTool === 'move' && s.moveShowControls) {
      const ctrlLayer = getLayer(s.doc, s.doc.activeLayerId ?? '');
      if (ctrlLayer && layerHandleAt(s, ctrlLayer, local)) {
        dragRef.current = {
          kind: 'move-handle',
          startX: local.x,
          startY: local.y,
          layerId: ctrlLayer.id,
        };
        return;
      }
    }
    if (effectiveTool === 'zoom') {
      const factor = e.altKey ? 0.5 : 2;
      setZoomAt(clampZoom(s.viewport.zoom * factor), local);
      return;
    }
    if (effectiveTool === 'eyedropper') {
      // Sample an n×n average around the click point (1 = point sample).
      const c = sampleAtDoc(s.doc, docPt.x, docPt.y, s.eyedropperSize);
      if (c) setForeground(rgbToHex(c.r, c.g, c.b));
      return;
    }
    if (effectiveTool === 'crop') {
      startCropDrag(docPt, local, s.cropRect);
      return;
    }
    if (effectiveTool === 'marquee' || effectiveTool === 'marquee-ellipse') {
      dragRef.current = { kind: 'marquee', startX: docPt.x, startY: docPt.y, tool: effectiveTool };
      setMarqueeDraft(null);
      return;
    }
    if (effectiveTool === 'marquee-row' || effectiveTool === 'marquee-col') {
      const sel =
        effectiveTool === 'marquee-row'
          ? rowSelection(s.doc.width, s.doc.height, docPt.y)
          : columnSelection(s.doc.width, s.doc.height, docPt.x);
      if (sel) {
        commitNewSelection(
          sel,
          `Marquee — ${sel.bounds.width} × ${sel.bounds.height} px`,
        );
      }
      return;
    }
    if (effectiveTool === 'lasso') {
      dragRef.current = { kind: 'lasso', points: [docPt] };
      setLassoDraft([docPt]);
      return;
    }
    if (effectiveTool === 'lasso-poly') {
      const pts = polyRef.current;
      // Closing back on the first vertex completes the polygon.
      if (pts.length >= 3) {
        const first = pts[0];
        const zoom = s.viewport.zoom;
        if (Math.hypot((docPt.x - first.x) * zoom, (docPt.y - first.y) * zoom) < 8) {
          finishPolyLasso(pts);
          return;
        }
      }
      polyRef.current = [...pts, docPt];
      setLassoDraft([...polyRef.current, docPt]);
      dragRef.current = { kind: 'poly' };
      return;
    }
    if (effectiveTool === 'wand') {
      wandSelectAt(docPt.x, docPt.y);
      return;
    }
    if (effectiveTool === 'objectselect') {
      objectSelectAt(docPt.x, docPt.y);
      return;
    }
    if (effectiveTool === 'quickselect') {
      // Paint-to-select: source sampled at stroke start (active layer or the
      // flattened image), live union of brush-bounded wand dabs.
      const layer = getLayer(s.doc, s.doc.activeLayerId ?? '');
      const source = s.sampleAll ? compositeDocument(s.doc) : layer?.pixels;
      if (!source || !layer) return;
      const drag: DragState = {
        kind: 'quicksel',
        base: s.selection,
        source,
        origin: s.sampleAll ? { x: 0, y: 0 } : { x: layer.x, y: layer.y },
        union: null,
        lastDab: docPt,
        visited: new Uint8Array(source.width * source.height),
      };
      dragRef.current = drag;
      // Apply a dab immediately: a plain click already selects (matching
      // how the tool feels when you press without dragging).
      applyQuickSelDab(drag, docPt);
      return;
    }
    if (effectiveTool === 'lasso-magnetic') {
      const layer = getLayer(s.doc, s.doc.activeLayerId ?? '');
      const source = s.sampleAll ? compositeDocument(s.doc) : layer?.pixels;
      if (!source || !layer) return;
      dragRef.current = {
        kind: 'magnetic',
        points: [docPt],
        map: gradientMagnitude(source),
        mw: source.width,
        mh: source.height,
        origin: s.sampleAll ? { x: 0, y: 0 } : { x: layer.x, y: layer.y },
        lastDab: docPt,
      };
      setLassoDraft([docPt]);
      return;
    }
    if (effectiveTool === 'eraser-magic') {
      magicEraseAt(docPt.x, docPt.y);
      return;
    }
    if (effectiveTool === 'bucket') {
      const session = beginPixelEdit();
      if (!session) return;
      const bufPt = { x: docPt.x - session.origin.x, y: docPt.y - session.origin.y };
      const paintCtx: PaintContext = { selection: s.selection, origin: session.origin };
      const color = hexToRgba(s.foreground);
      color.a = Math.round((color.a * s.fillOpacity) / 100);
      const filled = floodFill(
        session.pixels,
        Math.floor(bufPt.x),
        Math.floor(bufPt.y),
        color,
        s.wandTolerance,
        paintCtx,
        s.contiguous,
      );
      finishPixelEdit(session.before, 'Paint Bucket', filled);
      return;
    }
    if (effectiveTool === 'text') {
      placeTextLayer(docPt.x, docPt.y);
      return;
    }
    if (effectiveTool === 'shape') {
      dragRef.current = { kind: 'shape', startX: docPt.x, startY: docPt.y };
      setShapeDraft(null);
      return;
    }
    if (
      effectiveTool === 'shape-round' ||
      effectiveTool === 'shape-ellipse' ||
      effectiveTool === 'shape-poly'
    ) {
      dragRef.current = { kind: 'shape', startX: docPt.x, startY: docPt.y };
      setShapeDraft(null);
      return;
    }
    if (effectiveTool === 'shape-line') {
      dragRef.current = { kind: 'line', startX: docPt.x, startY: docPt.y };
      setGradientDraft({ x1: docPt.x, y1: docPt.y, x2: docPt.x, y2: docPt.y });
      return;
    }
    if (effectiveTool === 'gradient') {
      dragRef.current = { kind: 'gradient', startX: docPt.x, startY: docPt.y };
      setGradientDraft(null);
      return;
    }
    if (effectiveTool === 'patch') {
      // Inside an existing selection → drag it to the source area (patch);
      // otherwise draw a freehand selection around the defect first.
      const inSel =
        s.selection && selectionAlpha(s.selection, Math.floor(docPt.x), Math.floor(docPt.y)) > 128;
      if (inSel && s.selection) {
        dragRef.current = { kind: 'patch', startX: docPt.x, startY: docPt.y, sel: s.selection };
        setLassoDraft(null);
      } else {
        dragRef.current = { kind: 'lasso', points: [docPt], label: 'Patch' };
        setLassoDraft([docPt]);
      }
      return;
    }
    if (effectiveTool === 'move') {
      // Auto-Select: pick the topmost visible layer with opaque pixels under
      // the click before starting the drag.
      let layerId = s.doc.activeLayerId ?? '';
      if (s.moveAutoSelect) {
        const hit = autoSelectLayerId(s.doc, docPt);
        if (hit) {
          layerId = hit;
          setActiveLayer(hit);
        }
      }
      const docNow = getState().doc;
      if (!docNow) return;
      const layer = getLayer(docNow, layerId);
      if (!layer) return;
      dragRef.current = {
        kind: 'move',
        startX: docPt.x,
        startY: docPt.y,
        origX: layer.x,
        origY: layer.y,
        layerId: layer.id,
        before: docNow,
      };
      return;
    }
    if (STROKE_TOOLS.includes(effectiveTool)) {
      const needsSource = effectiveTool === 'clone' || effectiveTool === 'healing';
      if (needsSource) {
        if (e.altKey) {
          setCloneOffset({ x: docPt.x, y: docPt.y });
          toast('info', `Clone source set at ${Math.round(docPt.x)}, ${Math.round(docPt.y)}`);
          return;
        }
        if (!s.cloneOffset) {
          toast('warning', 'Alt-click the canvas to set a clone source first.');
          return;
        }
      }
      const session = beginPixelEdit();
      if (!session) return;
      const bufPt = { x: docPt.x - session.origin.x, y: docPt.y - session.origin.y };
      let src: PixelBuffer | null = null;
      let offset = { x: 0, y: 0 };
      if (needsSource && s.cloneOffset) {
        // "Aligned" keeps the sampled offset fixed across strokes until the
        // user Alt-clicks a new source; unaligned re-bases every stroke.
        const persisted = s.cloneAligned ? s.cloneStrokeOffset : null;
        if (persisted) {
          offset = persisted;
        } else if (s.sampleAll) {
          // Sample the flattened image (composite is document space).
          src = compositeDocument(session.before);
          offset = {
            x: docPt.x - s.cloneOffset.x + session.origin.x,
            y: docPt.y - s.cloneOffset.y + session.origin.y,
          };
        } else {
          const beforeLayer = getLayer(session.before, session.layerId);
          src = beforeLayer ? beforeLayer.pixels : null;
          offset = {
            x: bufPt.x - (s.cloneOffset.x - session.origin.x),
            y: bufPt.y - (s.cloneOffset.y - session.origin.y),
          };
        }
        if (s.cloneAligned && !persisted) setState({ cloneStrokeOffset: offset });
      }
      const stroke: StrokeRuntime = {
        session,
        tool: effectiveTool,
        last: bufPt,
        src,
        snapshot: SNAPSHOT_TOOLS.includes(effectiveTool)
          ? {
              width: session.pixels.width,
              height: session.pixels.height,
              data: new Uint8ClampedArray(session.pixels.data),
            }
          : null,
        state: { carry: 0, started: false },
        offset,
        // Background eraser ("once" mode) locks its sample to stroke start.
        sample:
          effectiveTool === 'eraser-bg' && s.bgSampleMode === 'once'
            ? (() => {
                const sx = Math.floor(bufPt.x);
                const sy = Math.floor(bufPt.y);
                const { width, height, data } = session.pixels;
                if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
                const o = (sy * width + sx) * 4;
                return { r: data[o], g: data[o + 1], b: data[o + 2], a: data[o + 3] };
              })()
            : null,
        changed: false,
      };
      smoothRef.current = bufPt;
      strokeRef.current = { pixels: session.pixels, dirty: null };
      const dirty = runStroke(stroke, [bufPt]);
      if (dirty) {
        stroke.changed = true;
        strokeRef.current.dirty = dirty;
      }
      dragRef.current = { kind: 'stroke', stroke };
      touchDoc();
      return;
    }
    // Safety net: pan instead of doing nothing.
    dragRef.current = { kind: 'pan', lastX: local.x, lastY: local.y };
  };

  const startCropDrag = (
    docPt: { x: number; y: number },
    local: { x: number; y: number },
    existing: Rect | null,
  ) => {
    const view = getState().viewport;
    if (existing) {
      // Corner hit-test (screen space).
      const sx = view.panX + existing.x * view.zoom;
      const sy = view.panY + existing.y * view.zoom;
      const sw = existing.width * view.zoom;
      const sh = existing.height * view.zoom;
      const corners: Array<[number, number]> = [
        [sx, sy],
        [sx + sw, sy],
        [sx, sy + sh],
        [sx + sw, sy + sh],
      ];
      for (let i = 0; i < 4; i++) {
        const [cx, cy] = corners[i];
        if (Math.hypot(cx - local.x, cy - local.y) < 10) {
          dragRef.current = { kind: 'crop-resize', corner: i, orig: existing };
          return;
        }
      }
      const inside =
        local.x > sx && local.x < sx + sw && local.y > sy && local.y < sy + sh;
      if (inside) {
        dragRef.current = { kind: 'crop-move', startX: docPt.x, startY: docPt.y, orig: existing };
        return;
      }
    }
    dragRef.current = { kind: 'crop-new', startX: docPt.x, startY: docPt.y };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = getState();
    if (!s.doc) return;
    const local = localPoint(e);
    const docPt = screenToDoc(local, s.viewport);
    const inside =
      docPt.x >= 0 && docPt.y >= 0 && docPt.x < s.doc.width && docPt.y < s.doc.height;
    setCursor(inside ? Math.floor(docPt.x) : null, inside ? Math.floor(docPt.y) : null);

    // Eyedropper loupe: live sample + hex/RGB readout under the cursor.
    if (s.tool === 'eyedropper') {
      if (inside) {
        const c = sampleAtDoc(s.doc, docPt.x, docPt.y, s.eyedropperSize);
        if (c) {
          setLoupe({ x: local.x, y: local.y, r: c.r, g: c.g, b: c.b, hex: rgbToHex(c.r, c.g, c.b) });
        } else if (loupe !== null) setLoupe(null);
      } else if (loupe !== null) setLoupe(null);
    } else if (loupe !== null) setLoupe(null);

    // Follow the pointer with the brush-size ring (unless panning or zoomed out
    // of the way with Space). `ring` is read from the latest render closure.
    const wantsRing =
      !spaceHeld && !s.transform && RING_TOOLS.includes(s.tool) && dragRef.current?.kind !== 'pan';
    if (wantsRing) setRing({ x: local.x, y: local.y });
    else if (ring !== null) setRing(null);

    const drag = dragRef.current;
    // Keep the polygonal-lasso rubber band alive while hovering (no buttons).
    if (!drag && polyRef.current.length > 0 && tool === 'lasso-poly') {
      setLassoDraft([...polyRef.current, docPt]);
    }
    if (!drag) return;

    if (drag.kind === 'pan') {
      panBy(local.x - drag.lastX, local.y - drag.lastY);
      drag.lastX = local.x;
      drag.lastY = local.y;
      return;
    }

    if (drag.kind === 'transform-move') {
      setTransformLive({
        x: drag.base.x + (docPt.x - drag.startX),
        y: drag.base.y + (docPt.y - drag.startY),
      });
      return;
    }

    if (drag.kind === 'transform-rotate') {
      const angle = Math.atan2(docPt.y - drag.centerY, docPt.x - drag.centerX);
      let rot = drag.base.rotation + (angle - drag.startAngle);
      if (e.shiftKey) {
        const step = Math.PI / 12; // Shift snaps to 15°
        rot = Math.round(rot / step) * step;
      }
      setTransformLive({ rotation: rot });
      return;
    }

    if (drag.kind === 'transform-scale') {
      // Project the cursor onto the box's own (rotated) axes, anchored so the
      // opposite corner/edge stays pinned.
      const c = Math.cos(drag.base.rotation);
      const sn = Math.sin(drag.base.rotation);
      const vx = docPt.x - drag.anchorX;
      const vy = docPt.y - drag.anchorY;
      const spanX = drag.fromCenter ? drag.bw * (drag.hx - 0.5) : drag.bw * (2 * drag.hx - 1);
      const spanY = drag.fromCenter ? drag.bh * (drag.hy - 0.5) : drag.bh * (2 * drag.hy - 1);
      let sx = drag.hx === 0.5 ? drag.base.scaleX : (vx * c + vy * sn) / spanX;
      let sy = drag.hy === 0.5 ? drag.base.scaleY : (-vx * sn + vy * c) / spanY;
      if (e.shiftKey && drag.hx !== 0.5 && drag.hy !== 0.5) {
        // Shift keeps the aspect ratio: the larger relative change drives both.
        const rx = Math.abs(sx / drag.base.scaleX);
        const ry = Math.abs(sy / drag.base.scaleY);
        const k = Math.max(rx, ry);
        sx = (sx < 0 ? -k : k) * drag.base.scaleX;
        sy = (sy < 0 ? -k : k) * drag.base.scaleY;
      }
      const lim = (v: number) =>
        Math.abs(v) < 0.01 ? (v < 0 ? -0.01 : 0.01) : Math.max(-100, Math.min(100, v));
      sx = lim(sx);
      sy = lim(sy);
      // Pin the anchor: newPos = anchor − R(θ)·(sx·Pa.x, sy·Pa.y).
      const ox = c * (sx * drag.anchorLocalX) - sn * (sy * drag.anchorLocalY);
      const oy = sn * (sx * drag.anchorLocalX) + c * (sy * drag.anchorLocalY);
      setTransformLive({ x: drag.anchorX - ox, y: drag.anchorY - oy, scaleX: sx, scaleY: sy });
      return;
    }

    if (drag.kind === 'crop-new') {
      const ratio = resolveAspect(s.cropAspect, s.doc.width, s.doc.height);
      let dx = docPt.x - drag.startX;
      let dy = docPt.y - drag.startY;
      let w = Math.abs(dx);
      let h = Math.abs(dy);
      if (ratio) {
        if (w / ratio > h) h = w / ratio;
        else w = h * ratio;
        w = Math.min(w, s.doc.width);
        h = Math.min(h, s.doc.height);
      }
      const x = dx < 0 ? drag.startX - w : drag.startX;
      const y = dy < 0 ? drag.startY - h : drag.startY;
      const rect = clampRectToDocument(s.doc, { x, y, width: w, height: h });
      setCropRect(rect);
      return;
    }

    if (drag.kind === 'crop-move') {
      const dx = docPt.x - drag.startX;
      const dy = docPt.y - drag.startY;
      const x = Math.min(Math.max(0, drag.orig.x + dx), s.doc.width - drag.orig.width);
      const y = Math.min(Math.max(0, drag.orig.y + dy), s.doc.height - drag.orig.height);
      setCropRect({ ...drag.orig, x, y });
      return;
    }

    if (drag.kind === 'crop-resize') {
      const o = drag.orig;
      let left = o.x;
      let top = o.y;
      let right = o.x + o.width;
      let bottom = o.y + o.height;
      const cx = Math.min(Math.max(0, docPt.x), s.doc.width);
      const cy = Math.min(Math.max(0, docPt.y), s.doc.height);
      if (drag.corner === 0 || drag.corner === 2) left = cx;
      if (drag.corner === 0 || drag.corner === 1) top = cy;
      if (drag.corner === 1 || drag.corner === 3) right = cx;
      if (drag.corner === 2 || drag.corner === 3) bottom = cy;
      const rect = clampRectToDocument(s.doc, {
        x: Math.min(left, right - 1),
        y: Math.min(top, bottom - 1),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top),
      });
      setCropRect(rect);
      return;
    }

    if (drag.kind === 'marquee') {
      let end = docPt;
      if (e.shiftKey) {
        // Shift constrains the marquee to a square (classic-editor parity).
        const dx = docPt.x - drag.startX;
        const dy = docPt.y - drag.startY;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        end = { x: drag.startX + (dx < 0 ? -m : m), y: drag.startY + (dy < 0 ? -m : m) };
      }
      setMarqueeDraft(
        clampRectToDocument(
          s.doc,
          styledMarqueeRect(s, drag.startX, drag.startY, end),
        ),
      );
      return;
    }

    if (drag.kind === 'lasso') {
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(docPt.x - last.x, docPt.y - last.y) >= 1) {
        drag.points.push(docPt);
        setLassoDraft([...drag.points]);
      }
      return;
    }

    if (drag.kind === 'poly') {
      // Rubber-band preview from the last vertex to the cursor.
      const pts = polyRef.current;
      if (pts.length > 0) setLassoDraft([...pts, docPt]);
      return;
    }

    if (drag.kind === 'magnetic') {
      // Frequency: higher = denser anchor points along the traced edge.
      const spacing = Math.max(2, Math.round(20 - s.magneticFrequency * 0.18));
      if (Math.hypot(docPt.x - drag.lastDab.x, docPt.y - drag.lastDab.y) >= spacing) {
        drag.lastDab = docPt;
        const bp = { x: docPt.x - drag.origin.x, y: docPt.y - drag.origin.y };
        const last = drag.points[drag.points.length - 1];
        const snapped = snapToEdge(
          drag.map,
          drag.mw,
          drag.mh,
          bp.x,
          bp.y,
          s.magneticWidth,
          // Real object edges in photos carry far less contrast than a
          // black↔white step; 98 (old mapping) only fired on poster-like art,
          // so the tool silently degraded to a plain lasso. 6 + 0.9×contrast
          // puts the default at ~51: above sensor noise, below real edges.
          6 + s.magneticContrast * 0.9,
          // Previous anchor, so the search follows the direction of travel
          // rather than leaping to whichever edge is strongest in the window.
          { x: last.x - drag.origin.x, y: last.y - drag.origin.y },
        );
        const pt = snapped ? { x: snapped.x + drag.origin.x, y: snapped.y + drag.origin.y } : docPt;
        if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 0.5) drag.points.push(pt);
      }
      // The preview always ends at the raw pointer, so the trailing segment
      // behaves like a rubber band: the anchor lags behind on the edge, but
      // the line reaches your finger or pen (and updates on every move, not
      // only when an anchor is due — same as the polygonal lasso).
      if (!drag.preview || Math.hypot(docPt.x - drag.preview.x, docPt.y - drag.preview.y) >= 0.75) {
        drag.preview = docPt;
        setLassoDraft([...drag.points, docPt]);
      }
      return;
    }

    if (drag.kind === 'quicksel') {
      // Paint-to-select: each dab floods the connected region under the
      // cursor, bounded by the brush circle, unioned into the live preview.
      const spacing = Math.max(3, s.brushSize * 0.35);
      if (Math.hypot(docPt.x - drag.lastDab.x, docPt.y - drag.lastDab.y) < spacing) return;
      drag.lastDab = docPt;
      applyQuickSelDab(drag, docPt);
      return;
    }

    if (drag.kind === 'line') {
      let ex = docPt.x;
      let ey = docPt.y;
      if (e.shiftKey) {
        // Shift snaps the line to 45° increments.
        const dx = docPt.x - drag.startX;
        const dy = docPt.y - drag.startY;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          const step = Math.PI / 4;
          const ang = Math.round(Math.atan2(dy, dx) / step) * step;
          ex = drag.startX + Math.cos(ang) * len;
          ey = drag.startY + Math.sin(ang) * len;
        }
      }
      setGradientDraft({ x1: drag.startX, y1: drag.startY, x2: ex, y2: ey });
      return;
    }

    if (drag.kind === 'patch') {
      // The dragged selection outline is drawn at pointer-up (the mask can be
      // non-polygonal); nothing to preview live.
      return;
    }

    if (drag.kind === 'move-handle') {
      // Deferred: only after real movement does the transform start, so a
      // stray click on an edge handle never traps the pointer.
      const moved = Math.hypot(local.x - drag.startX, local.y - drag.startY);
      if (moved < 2) return;
      if ((getState().doc?.activeLayerId ?? '') !== drag.layerId) setActiveLayer(drag.layerId);
      beginFreeTransform();
      const st = getState();
      if (!st.transform) return;
      const next = transformDragFor(st, st.transform, local, docPt, e);
      if (next) dragRef.current = next;
      return;
    }

    if (drag.kind === 'shape') {
      let ex = docPt.x;
      let ey = docPt.y;
      if (e.shiftKey) {
        // Shift constrains the shape to a square from the drag origin.
        const dx = docPt.x - drag.startX;
        const dy = docPt.y - drag.startY;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        ex = drag.startX + (dx < 0 ? -m : m);
        ey = drag.startY + (dy < 0 ? -m : m);
      }
      setShapeDraft(
        clampRectToDocument(s.doc, {
          x: Math.min(drag.startX, ex),
          y: Math.min(drag.startY, ey),
          width: Math.abs(ex - drag.startX),
          height: Math.abs(ey - drag.startY),
        }),
      );
      return;
    }

    if (drag.kind === 'gradient') {
      let ex = docPt.x;
      let ey = docPt.y;
      if (e.shiftKey) {
        // Shift snaps the gradient direction to 45° increments.
        const dx = docPt.x - drag.startX;
        const dy = docPt.y - drag.startY;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          const step = Math.PI / 4;
          const ang = Math.round(Math.atan2(dy, dx) / step) * step;
          ex = drag.startX + Math.cos(ang) * len;
          ey = drag.startY + Math.sin(ang) * len;
        }
      }
      setGradientDraft({ x1: drag.startX, y1: drag.startY, x2: ex, y2: ey });
      return;
    }

    if (drag.kind === 'move') {
      let dx = docPt.x - drag.startX;
      let dy = docPt.y - drag.startY;
      if (e.shiftKey) {
        dx = Math.round(dx / 10) * 10;
        dy = Math.round(dy / 10) * 10;
      }
      setLayerOffsetLive(
        drag.layerId,
        Math.round(drag.origX + dx),
        Math.round(drag.origY + dy),
      );
      return;
    }

    if (drag.kind === 'stroke') {
      const st = drag.stroke;
      const raw = { x: docPt.x - st.session.origin.x, y: docPt.y - st.session.origin.y };
      // Pointer smoothing: exponentially average toward the raw position.
      const k = 1 - (getState().brushSmoothing / 100) * 0.9;
      const prev = smoothRef.current ?? raw;
      const bufPt = { x: prev.x + (raw.x - prev.x) * k, y: prev.y + (raw.y - prev.y) * k };
      smoothRef.current = bufPt;
      if (Math.hypot(bufPt.x - st.last.x, bufPt.y - st.last.y) < 0.75) return;
      const dirty = runStroke(st, [st.last, bufPt]);
      st.last = bufPt;
      if (dirty) {
        st.changed = true;
        if (strokeRef.current) strokeRef.current.dirty = unionDirty(strokeRef.current.dirty, dirty);
        touchDoc();
      }
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const s = getState();
    const local = localPoint(e);
    const docPt = s.doc ? screenToDoc(local, s.viewport) : { x: 0, y: 0 };

    if (drag && drag.kind === 'crop-new' && s.doc) {
      const distPx = Math.hypot(
        (docPt.x - drag.startX) * s.viewport.zoom,
        (docPt.y - drag.startY) * s.viewport.zoom,
      );
      if (distPx < 5) {
        // A simple click with the crop tool selects the whole canvas.
        setCropRect({ x: 0, y: 0, width: s.doc.width, height: s.doc.height });
      }
    } else if (drag && s.doc) {
      if (drag.kind === 'marquee') {
        setMarqueeDraft(null);
        const rect = clampRectToDocument(s.doc, styledMarqueeRect(s, drag.startX, drag.startY, docPt));
        if (rect && rect.width >= 1 && rect.height >= 1) {
          const sel =
            marqueeShapeOf(drag.tool) === 'ellipse'
              ? ellipseSelection(s.doc.width, s.doc.height, rect)
              : rectSelection(s.doc.width, s.doc.height, rect);
          if (sel) commitNewSelection(sel, `Marquee — ${sel.bounds.width} × ${sel.bounds.height} px`);
        }
      } else if (drag.kind === 'lasso') {
        setLassoDraft(null);
        const label = drag.label ?? 'Lasso';
        if (drag.points.length >= 3) {
          const sel = pathSelection(s.doc.width, s.doc.height, drag.points);
          if (sel) commitNewSelection(sel, `${label} — ${sel.bounds.width} × ${sel.bounds.height} px`);
          else setSelection(null, `${label} too small — nothing selected`);
        }
      } else if (drag.kind === 'magnetic') {
        setLassoDraft(null);
        if (drag.points.length >= 3) {
          const sel = pathSelection(s.doc.width, s.doc.height, drag.points);
          if (sel) {
            commitNewSelection(sel, `Magnetic Lasso — ${sel.bounds.width} × ${sel.bounds.height} px`);
          } else {
            setSelection(null, 'Magnetic lasso — trace missed the image');
          }
        } else {
          setSelection(getState().selection, 'Magnetic lasso — needs at least 3 points');
        }
      } else if (drag.kind === 'quicksel') {
        if (!drag.union) {
          setSelection(drag.base, 'Quick Selection — nothing matched');
        } else {
          const union = s.featherPx > 0 ? featherSelection(drag.union, s.featherPx) : drag.union;
          const finalSel = combineSelection(drag.base, union, s.selectionMode);
          setSelection(
            finalSel,
            finalSel
              ? `Quick Selection — ${finalSel.bounds.width} × ${finalSel.bounds.height} px`
              : 'Quick Selection cleared',
          );
        }
      } else if (drag.kind === 'poly') {
        // Vertex placement continues across clicks; nothing to commit here.
      } else if (drag.kind === 'shape') {
        const w = Math.abs(docPt.x - drag.startX);
        const h = Math.abs(docPt.y - drag.startY);
        setShapeDraft(null);
        if (w >= 1 && h >= 1) {
          const rect = clampRectToDocument(s.doc, {
            x: Math.min(drag.startX, docPt.x),
            y: Math.min(drag.startY, docPt.y),
            width: w,
            height: h,
          });
          if (rect) applyShape(rect);
        }
      } else if (drag.kind === 'gradient') {
        setGradientDraft(null);
        const dist = Math.hypot(
          (docPt.x - drag.startX) * s.viewport.zoom,
          (docPt.y - drag.startY) * s.viewport.zoom,
        );
        if (dist >= 4) applyGradient(drag.startX, drag.startY, docPt.x, docPt.y);
      } else if (drag.kind === 'line') {
        setGradientDraft(null);
        const dist = Math.hypot(
          (docPt.x - drag.startX) * s.viewport.zoom,
          (docPt.y - drag.startY) * s.viewport.zoom,
        );
        if (dist >= 4) applyLineShape(drag.startX, drag.startY, docPt.x, docPt.y);
      } else if (drag.kind === 'patch') {
        // Drag the defect selection to a clean area: rebuild it from there.
        const dx = docPt.x - drag.startX;
        const dy = docPt.y - drag.startY;
        if (Math.hypot(dx, dy) >= 3) {
          const session = beginPixelEdit();
          if (session) {
            patchFill(session.pixels, drag.sel, session.origin, { x: dx, y: dy });
            finishPixelEdit(session.before, 'Patch', true);
          }
        }
      } else if (drag.kind === 'move-handle') {
        // Released before any movement: the click was a no-op by design.
      } else if (drag.kind === 'stroke') {
        finishPixelEdit(
          drag.stroke.session.before,
          STROKE_LABEL[drag.stroke.tool] ?? 'Paint',
          drag.stroke.changed,
        );
      } else if (drag.kind === 'move') {
        const layer = getLayer(s.doc, drag.layerId);
        const changed = !!layer && (layer.x !== drag.origX || layer.y !== drag.origY);
        finishPixelEdit(drag.before, 'Move Layer', changed);
      }
    }

    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  /** Complete the polygonal lasso with the current vertices. */
  const finishPolyLasso = (pts: Array<{ x: number; y: number }>) => {
    const s = getState();
    polyRef.current = [];
    setLassoDraft(null);
    if (!s.doc || pts.length < 3) {
      if (pts.length < 3) setSelection(getState().selection, 'Polygonal lasso — needs at least 3 points');
      return;
    }
    const sel = pathSelection(s.doc.width, s.doc.height, pts);
    if (sel) commitNewSelection(sel, `Polygonal Lasso — ${sel.bounds.width} × ${sel.bounds.height} px`);
    else setSelection(getState().selection, 'Polygonal Lasso — polygon missed the image');
  };

  /** Abandon the polygonal lasso without changing the selection. */
  const cancelPolyLasso = () => {
    if (polyRef.current.length === 0) return;
    polyRef.current = [];
    setLassoDraft(null);
  };

  /* Free Transform: Enter commits, Esc cancels (capture, first in line). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = getState();
      if (!st.transform || isTypingTarget(e.target as HTMLElement | null)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commitFreeTransform();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelFreeTransform();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* Polygonal lasso: double-click closes; Enter confirms; Escape cancels. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = getState();
      if (st.tool !== 'lasso-poly' || polyRef.current.length === 0) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finishPolyLasso(polyRef.current);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelPolyLasso();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /* Drag & drop import. */
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (/\.pixelforge$/i.test(file.name)) {
      void openProjectFromFile(file);
      return;
    }
    if (getState().doc) void placeImageAsLayer(file);
    else void openImageFile(file);
  };

  const showRing = !!doc && !spaceHeld && !transform && tool !== 'hand' && RING_TOOLS.includes(tool);
  const cursorClass = transform
    ? styles.cursorDefault
    : spaceHeld || tool === 'hand'
      ? styles.cursorGrab
      : tool === 'zoom'
        ? styles.cursorZoom
        : showRing
          ? styles.cursorNone
          : CROSS_TOOLS.includes(tool)
            ? styles.cursorCross
            : styles.cursorDefault;
  const ringPx = doc ? Math.max(3, brushSize * viewport.zoom) : 0;

  const openImage = async () => {
    const file = await pickFile('image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp');
    if (file) await openImageFile(file);
  };

  return (
    <div
      ref={containerRef}
      className={`${styles.workspace} ${cursorClass}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={onDrop}
      data-testid="workspace"
      data-pf-canvas=""
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          // Double-click inside a live transform commits it; with the move
          // tool on a plain canvas it starts one (classic-editor parity).
          const st = getState();
          if (st.transform) {
            e.preventDefault();
            commitFreeTransform();
            return;
          }
          if (st.doc && st.tool === 'move' && st.doc.activeLayerId) beginFreeTransform();
        }}
        onPointerLeave={() => {
          setCursor(null, null);
          setRing(null);
          setLoupe(null);
        }}
        data-testid="editor-canvas"
      />

      {showRing && ring ? (
        <div
          className={styles.brushRing}
          data-testid="brush-ring"
          data-size={brushSize}
          style={{ translate: `${ring.x}px ${ring.y}px`, width: ringPx, height: ringPx }}
        />
      ) : null}
      {showRing && ring && ringHud ? (
        <div
          className={styles.brushHud}
          data-testid="brush-hud"
          style={{ translate: `${ring.x + 20}px ${ring.y + 20}px` }}
        >
          <span>{brushSize} px</span>
          <span>{brushOpacity}%</span>
          {tool === 'brush' || tool === 'eraser' ? <span>Hard {brushHardness}%</span> : null}
        </div>
      ) : null}

      {tool === 'eyedropper' && loupe ? (
        <div
          className={styles.loupe}
          data-testid="eyedropper-loupe"
          style={{ translate: `${loupe.x}px ${loupe.y}px` }}
        >
          <span className={styles.loupeLineH} />
          <span className={styles.loupeLineV} />
          <span className={styles.loupeDot} style={{ background: loupe.hex }} />
          <span className={styles.loupeSwatch}>
            <i style={{ background: foreground }} />
            <i style={{ background: background }} />
          </span>
          <span className={styles.loupeLabel} data-testid="eyedropper-loupe-label">
            <b>{loupe.hex.toUpperCase()}</b>
            <span>
              R {loupe.r} G {loupe.g} B {loupe.b}
            </span>
          </span>
        </div>
      ) : null}

      {!doc ? (
        <div className={styles.empty}>
          <div className={styles.emptyCard}>
            <svg width="44" height="44" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1l6 3.5v7L8 15l-6-3.5v-7L8 1z" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
              <path d="M8 4.6l3 1.75v3.5L8 11.6 5 9.85v-3.5L8 4.6z" fill="var(--accent)" opacity="0.85" />
            </svg>
            <h1 className={styles.emptyTitle}>PixelForge</h1>
            <p className={styles.emptyText}>
              A local-first photo editor. Open an image or drop one anywhere in this area —
              files never leave your device.
            </p>
            <div className={styles.emptyActions}>
              <button className="pf-btn primary" onClick={() => void openImage()}>
                <FolderOpen size={14} /> Open Image
              </button>
            </div>
            <p className={styles.emptyHint}>
              Supported: JPEG · PNG · WebP · GIF · AVIF — or reopen a saved <code>.pixelforge</code>{' '}
              project.
            </p>
          </div>
        </div>
      ) : null}

      {dropActive ? (
        <div className={styles.dropOverlay} data-testid="drop-overlay">
          <div className={styles.dropCard}>
            <ImagePlus size={26} />
            <span>
              {doc ? 'Drop to place as a new layer' : 'Drop to open image'}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
