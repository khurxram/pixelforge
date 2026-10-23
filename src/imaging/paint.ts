/**
 * Painting and retouching primitives.
 *
 * Pure, DOM-free pixel operations on RGBA buffers (no canvas dependency), so
 * every brush is unit tested in Node. Coordinates are BUFFER coordinates —
 * callers convert document space by the active layer's x/y offset, and pass a
 * `PaintContext` so selections gate writes correctly.
 */
import type { PixelBuffer, Rect } from '../core/document/types';
import type { Selection } from '../core/document/selection';
import { selectionAlpha } from '../core/document/selection';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface StampOptions {
  /** Brush diameter in document pixels. */
  size: number;
  /** 0..1 coverage multiplier (Opacity / Strength / Exposure). */
  opacity: number;
  /** 0..1 edge hardness: solid core up to this fraction of the radius. */
  hardness?: number;
  /** 0..1 per-stamp flow multiplier (accumulates along the stroke). */
  flow?: number;
}

/** Tonal range targeted by dodge/burn. */
export type ToneRange = 'shadows' | 'midtones' | 'highlights';

/** Live stamp progress for one stroke, carried across per-event segment
 *  calls: `carry` keeps dab spacing continuous between pointer moves, and
 *  `started` stops every segment from re-stamping the joint (which used to
 *  stack opacity on slow drags and made strokes feel flaky). */
export interface StrokeState {
  carry: number;
  started: boolean;
}

export interface PaintContext {
  /** Active selection gating writes, or null for no selection. */
  selection: Selection | null;
  /** Buffer (x, y) → document (x, y): the layer's x/y offset. */
  origin: { x: number; y: number };
  /** Per-stroke stamp state shared across segment calls (optional). */
  strokeState?: StrokeState;
}

export const NO_CONTEXT: PaintContext = { selection: null, origin: { x: 0, y: 0 } };

/** Parse #rgb / #rrggbb into an opaque color (alpha from a separate param). */
export function hexToRgba(hex: string): Rgba {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0, a: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

function gate(ctx: PaintContext, bx: number, by: number): number {
  if (!ctx.selection) return 255;
  return selectionAlpha(ctx.selection, bx + ctx.origin.x, by + ctx.origin.y);
}

/** Soft round falloff: solid core up to `hardness` (0..1) of the radius,
 *  feathered rim. Default 0.4 keeps the classic soft-brush look. */
function softAlpha(d: number, r: number, hardness = 0.4): number {
  const t = d / r;
  const start = Math.min(0.95, Math.max(0, hardness));
  if (t <= start) return 1;
  if (t >= 1) return 0;
  const u = (t - start) / (1 - start);
  return 1 - u * u * (3 - 2 * u);
}

/** Source-over blend of an opaque color with fractional coverage. */
function blendAt(px: Uint8ClampedArray, i: number, r: number, g: number, b: number, sa: number): void {
  if (sa <= 0) return;
  const s = Math.min(1, sa);
  const da = px[i + 3] / 255;
  const outA = s + da * (1 - s);
  if (outA <= 0) {
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = 0;
    return;
  }
  const keep = (da * (1 - s)) / outA;
  const take = s / outA;
  px[i] = r * take + px[i] * keep;
  px[i + 1] = g * take + px[i + 1] * keep;
  px[i + 2] = b * take + px[i + 2] * keep;
  px[i + 3] = outA * 255;
}

function circleBounds(w: number, h: number, cx: number, cy: number, r: number): Rect {
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0 + 1), height: Math.max(0, y1 - y0 + 1) };
}

type PixelVisitor = (px: Uint8ClampedArray, i: number, alpha: number) => void;

/** Apply a per-pixel visitor over a soft circle stamp (selection-gated). */
function stampCircle(
  pixels: PixelBuffer,
  cx: number,
  cy: number,
  opts: StampOptions,
  ctx: PaintContext,
  visit: PixelVisitor,
): void {
  const r = Math.max(0.5, opts.size / 2);
  const b = circleBounds(pixels.width, pixels.height, cx, cy, r + 1);
  const px = pixels.data;
  const W = pixels.width;
  for (let y = b.y; y < b.y + b.height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = b.x; x < b.x + b.width; x++) {
      const dx = x + 0.5 - cx;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      const f = softAlpha(d, r, opts.hardness) * (g / 255) * (opts.flow ?? 1);
      if (f <= 0) continue;
      visit(px, (y * W + x) * 4, f);
    }
  }
}

/** Walk a polyline, stamping every `step` document pixels along the way.
 *  Pass a shared `state` when the stroke arrives as several segment calls
 *  (one per pointer event) so spacing stays continuous and the joint
 *  between segments isn't stamped twice. */
export function strokePath(
  points: Array<{ x: number; y: number }>,
  step: number,
  stamp: (x: number, y: number, dir: { x: number; y: number }) => void,
  state?: StrokeState,
): void {
  if (points.length === 0) return;
  const st = state ?? { carry: 0, started: false };
  const first = points[0];
  if (!st.started) {
    stamp(first.x, first.y, { x: 0, y: 0 });
    st.started = true;
    st.carry = step; // the next stamp belongs a full step along the path
  }
  if (points.length === 1) return;
  let carry = st.carry;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const dir = { x: dx / len, y: dy / len };
    let dist = carry;
    while (dist < len) {
      stamp(a.x + dir.x * dist, a.y + dir.y * dist, dir);
      dist += step;
    }
    carry = dist - len;
  }
  st.carry = carry;
}

/* ------------------------------------------------------------------ */
/* Brushes                                                             */
/* ------------------------------------------------------------------ */

/** Paint the foreground color along a stroke. */
export function paintStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(0.75, opts.size * 0.18);
  strokePath(
    points,
    step,
    (x, y) =>
      stampCircle(pixels, x, y, opts, ctx, (px, i, f) => blendAt(px, i, color.r, color.g, color.b, f * opts.opacity)),
    ctx.strokeState,
  );
}

/** Erase along a stroke (reduces destination alpha). */
export function eraseStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(0.75, opts.size * 0.18);
  strokePath(
    points,
    step,
    (x, y) =>
      stampCircle(pixels, x, y, opts, ctx, (px, i, f) => {
        px[i + 3] = px[i + 3] * (1 - f * opts.opacity);
      }),
    ctx.strokeState,
  );
}

/** Perceptual RGB distance (luma-weighted) — the same metric as the wand. */
function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db);
}

/** Sample the pixel under a buffer point (null when outside). */
function sampleAt(pixels: PixelBuffer, x: number, y: number): Rgba | null {
  const sx = Math.round(x);
  const sy = Math.round(y);
  if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) return null;
  const o = (sy * pixels.width + sx) * 4;
  return { r: pixels.data[o], g: pixels.data[o + 1], b: pixels.data[o + 2], a: pixels.data[o + 3] };
}

/** Apply a per-pixel visitor over a hard (aliased) circle stamp. */
function stampCircleBinary(
  pixels: PixelBuffer,
  cx: number,
  cy: number,
  opts: StampOptions,
  ctx: PaintContext,
  visit: PixelVisitor,
): void {
  const r = Math.max(0.5, opts.size / 2);
  const b = circleBounds(pixels.width, pixels.height, cx, cy, r + 1);
  const px = pixels.data;
  const W = pixels.width;
  for (let y = b.y; y < b.y + b.height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = b.x; x < b.x + b.width; x++) {
      const dx = x + 0.5 - cx;
      if (Math.hypot(dx, dy) > r) continue;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      const f = (g / 255) * (opts.flow ?? 1);
      if (f <= 0) continue;
      visit(px, (y * W + x) * 4, f);
    }
  }
}

/** Pencil: crisp, aliased hard-edge painting (pixel-art strokes). */
export function pencilStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(0.75, opts.size * 0.18);
  strokePath(
    points,
    step,
    (x, y) =>
      stampCircleBinary(pixels, x, y, opts, ctx, (px, i, f) =>
        blendAt(px, i, color.r, color.g, color.b, f * opts.opacity),
      ),
    ctx.strokeState,
  );
}

/**
 * Color Replacement: repaint pixels near the color under the cursor with the
 * foreground color, preserving each pixel's luminosity (texture and shading
 * survive — a red flower becomes blue, not a flat blob). Samples continuously
 * under the brush center, like the classic tool's default mode.
 */
export function replaceColorStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  tolerance: number,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(0.75, opts.size * 0.18);
  const thr = Math.max(0, tolerance) * 2.55;
  const lumSrc = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
  strokePath(
    points,
    step,
    (x, y) => {
      const target = sampleAt(pixels, x, y);
      if (!target || target.a === 0) return;
      stampCircle(pixels, x, y, opts, ctx, (px, i, f) => {
        if (px[i + 3] === 0) return;
        if (colorDist(px[i], px[i + 1], px[i + 2], target.r, target.g, target.b) > thr) return;
        // "Color" blend: source hue + saturation over the backdrop's luminosity.
        const lumDst = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        blendAt(
          px,
          i,
          lumDst + (color.r - lumSrc),
          lumDst + (color.g - lumSrc),
          lumDst + (color.b - lumSrc),
          f * opts.opacity,
        );
      });
    },
    ctx.strokeState,
  );
}

/**
 * Background Eraser: erase pixels matching the sampled color under the
 * brush. `once` locks the sample to the stroke start; `continuous`
 * resamples under the cursor. With `contiguous`, only connected matching
 * pixels inside the brush are erased (limits parity); otherwise every
 * matching pixel under the brush goes.
 */
export function bgEraseStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  sample: Rgba | null,
  sampleMode: 'continuous' | 'once',
  tolerance: number,
  ctx: PaintContext = NO_CONTEXT,
  contiguous = true,
): void {
  const step = Math.max(0.75, opts.size * 0.18);
  const thr = Math.max(0, tolerance) * 2.55;
  const W = pixels.width;
  const H = pixels.height;
  const data = pixels.data;
  strokePath(points, step, (x, y) => {
    const target = sampleMode === 'once' && sample ? sample : sampleAt(pixels, x, y);
    if (!target || target.a === 0) return;
    const sx = Math.round(x);
    const sy = Math.round(y);
    const r = Math.max(0.5, opts.size / 2);
    const matches = (o: number): boolean =>
      colorDist(data[o], data[o + 1], data[o + 2], target.r, target.g, target.b) <= thr;
    const eraseAt = (px2: number, py2: number): void => {
      const d = Math.hypot(px2 + 0.5 - x, py2 + 0.5 - y);
      if (d > r) return;
      const g = gate(ctx, px2, py2);
      if (g === 0) return;
      const f = softAlpha(d, r, opts.hardness) * (g / 255) * (opts.flow ?? 1);
      if (f <= 0) return;
      const o = (py2 * W + px2) * 4;
      data[o + 3] = data[o + 3] * (1 - f * opts.opacity);
    };

    if (!contiguous) {
      const b = circleBounds(W, H, x, y, r + 1);
      for (let py2 = b.y; py2 < b.y + b.height; py2++) {
        for (let px2 = b.x; px2 < b.x + b.width; px2++) {
          if (!matches((py2 * W + px2) * 4)) continue;
          eraseAt(px2, py2);
        }
      }
      return;
    }

    // Contiguous: flood from the brush centre, but only inside the circle.
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const pad = Math.ceil(r) + 1;
    const b = circleBounds(W, H, x, y, pad);
    const bw = b.width;
    const bh = b.height;
    if (bw <= 0 || bh <= 0) return;
    const visited = new Uint8Array(bw * bh);
    const startL = (sy - b.y) * bw + (sx - b.x);
    if (startL < 0 || startL >= bw * bh) return;
    const stack: number[] = [startL];
    while (stack.length > 0) {
      const li = stack.pop()!;
      if (visited[li]) continue;
      visited[li] = 1;
      const px2 = b.x + (li % bw);
      const py2 = b.y + ((li / bw) | 0);
      if (!matches((py2 * W + px2) * 4)) continue;
      eraseAt(px2, py2);
      if (px2 > b.x) stack.push(li - 1);
      if (px2 < b.x + bw - 1) stack.push(li + 1);
      if (py2 > b.y) stack.push(li - bw);
      if (py2 < b.y + bh - 1) stack.push(li + bw);
    }
  }, ctx.strokeState);
}

/* ------------------------------ region ops ------------------------------ */

/** Copy a buffer region into a standalone RGBA array (with 1 px margin). */
function copyRegion(
  pixels: PixelBuffer,
  b: Rect,
): { data: Uint8ClampedArray; width: number; height: number } {
  const W = pixels.width;
  const H = pixels.height;
  const x0 = Math.max(0, b.x);
  const y0 = Math.max(0, b.y);
  const x1 = Math.min(W, b.x + b.width);
  const y1 = Math.min(H, b.y + b.height);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * W + x0) * 4;
    out.set(pixels.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Separable box blur (2 passes ≈ gaussian-ish) over an RGBA region. */
function boxBlur(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
): Uint8ClampedArray {
  const r = Math.max(1, Math.round(radius));
  const horizontal = new Uint8ClampedArray(data.length);
  const output = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      let count = 0;
      for (let k = -r; k <= r; k++) {
        const x = Math.min(w - 1, Math.max(0, k));
        sum += data[(y * w + x) * 4 + c];
        count++;
      }
      for (let x = 0; x < w; x++) {
        horizontal[(y * w + x) * 4 + c] = sum / count;
        const outX = Math.min(w - 1, Math.max(0, x - r));
        const inX = Math.min(w - 1, Math.max(0, x + r + 1));
        sum += data[(y * w + inX) * 4 + c] - data[(y * w + outX) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      let count = 0;
      for (let k = -r; k <= r; k++) {
        const y = Math.min(h - 1, Math.max(0, k));
        sum += horizontal[(y * w + x) * 4 + c];
        count++;
      }
      for (let y = 0; y < h; y++) {
        output[(y * w + x) * 4 + c] = sum / count;
        const outY = Math.min(h - 1, Math.max(0, y - r));
        const inY = Math.min(h - 1, Math.max(0, y + r + 1));
        sum += horizontal[(inY * w + x) * 4 + c] - horizontal[(outY * w + x) * 4 + c];
      }
    }
  }
  return output;
}

function blurRadiusFor(size: number): number {
  return Math.max(1, Math.min(12, Math.round(size / 8)));
}

/** Soft blur along a stroke (strength = opts.opacity).
 *  Reads the stroke-start snapshot (`src`) and pushes each pixel toward its
 *  blurred value with a directional clamp, so overlapping dabs converge on
 *  one application instead of stacking. */
export function blurStroke(
  pixels: PixelBuffer,
  src: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const sp = src.width === pixels.width && src.height === pixels.height ? src : pixels;
  regionStroke(pixels, sp, points, opts, ctx, (region, ox, oy, hits) => {
    const blurred = boxBlur(region.data, region.width, region.height, blurRadiusFor(opts.size));
    const px = pixels.data;
    const sd = sp.data;
    for (const h of hits) {
      const si = (h.by * region.width + h.bx) * 4;
      const di = ((oy + h.by) * pixels.width + (ox + h.bx)) * 4;
      const k = h.f * opts.opacity;
      for (let c = 0; c < 4; c++) {
        const t = sd[di + c] * (1 - k) + blurred[si + c] * k;
        px[di + c] = t >= sd[di + c] ? Math.max(px[di + c], t) : Math.min(px[di + c], t);
      }
    }
  });
}

/** Sharpen along a stroke (unsharp mask, strength = opts.opacity).
 *  Source-snapshot based like blurStroke — one application per stroke. */
export function sharpenStroke(
  pixels: PixelBuffer,
  src: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const sp = src.width === pixels.width && src.height === pixels.height ? src : pixels;
  regionStroke(pixels, sp, points, opts, ctx, (region, ox, oy, hits) => {
    const blurred = boxBlur(region.data, region.width, region.height, blurRadiusFor(opts.size));
    const px = pixels.data;
    const sd = sp.data;
    for (const h of hits) {
      const si = (h.by * region.width + h.bx) * 4;
      const di = ((oy + h.by) * pixels.width + (ox + h.bx)) * 4;
      const k = h.f * opts.opacity * 2;
      for (let c = 0; c < 3; c++) {
        const t = sd[di + c] + (sd[di + c] - blurred[si + c]) * k;
        px[di + c] = t >= sd[di + c] ? Math.max(px[di + c], t) : Math.min(px[di + c], t);
      }
      // Alpha is intentionally untouched (sharpening edges would erode masks).
    }
  });
}

/** Luma weight that isolates a tonal range (dodge/burn targeting). */
function rangeWeight(luma: number, range: ToneRange): number {
  if (range === 'shadows') return (1 - luma) * (1 - luma);
  if (range === 'highlights') return luma * luma;
  // Midtones: peak at 0.5, falling off steeply to both ends.
  const t = 1 - Math.abs(2 * luma - 1);
  return t * t * t;
}

/** Dodge (lighten) or burn (darken) along a stroke, within a tonal range.
 *  Each dab reads the stroke-start snapshot (`src`) and pushes pixels away
 *  from it with a directional clamp — overlapping dabs converge on one
 *  application, so slow strokes can no longer blow out the image. */
export function dodgeBurnStroke(
  pixels: PixelBuffer,
  src: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  mode: 'dodge' | 'burn',
  ctx: PaintContext = NO_CONTEXT,
  range: ToneRange = 'midtones',
): void {
  const sp = src.width === pixels.width && src.height === pixels.height ? src : pixels;
  const step = Math.max(0.75, opts.size * 0.18);
  strokePath(
    points,
    step,
    (x, y) =>
      stampEffect(pixels, sp, x, y, opts, ctx, (px, sd, i, f) => {
        if (px[i + 3] === 0) return;
        const luma = (sd[i] * 0.299 + sd[i + 1] * 0.587 + sd[i + 2] * 0.114) / 255;
        const k = f * opts.opacity * rangeWeight(luma, range);
        if (k <= 0) return;
        for (let c = 0; c < 3; c++) {
          const base = sd[i + c];
          const t = mode === 'dodge' ? base + (255 - base) * k : base - base * k;
          px[i + c] = t >= base ? Math.max(px[i + c], t) : Math.min(px[i + c], t);
        }
      }),
    ctx.strokeState,
  );
}

/** Smudge: drag pixels along the stroke direction (strength = opts.opacity).
 *  Each stamp samples the content one step behind it, so pixels smear the way
 *  a wet finger would. Source reads come from a pre-write copy of the stamp
 *  region, so overlapping stamps never feed on partially-written output. */
export function smudgeStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(1, opts.size * 0.3);
  strokePath(points, step, (x, y, dir) => {
    const dx = dir.x * step;
    const dy = dir.y * step;
    if (dx === 0 && dy === 0) return; // stroke start: nothing behind to drag
    const r = Math.max(0.5, opts.size / 2);
    const pad = Math.ceil(r + step) + 2;
    const b = circleBounds(pixels.width, pixels.height, x, y, pad);
    const region = copyRegion(pixels, b);
    const px = pixels.data;
    const W = pixels.width;
    for (let y2 = b.y; y2 < b.y + b.height; y2++) {
      const dy2 = y2 + 0.5 - y;
      for (let x2 = b.x; x2 < b.x + b.width; x2++) {
        const d = Math.hypot(x2 + 0.5 - x, dy2);
        if (d > r) continue;
        const g = gate(ctx, x2, y2);
        if (g === 0) continue;
        const f = softAlpha(d, r, opts.hardness) * (g / 255) * (opts.flow ?? 1);
        if (f <= 0) continue;
        const sxp = Math.round(x2 - dx) - b.x;
        const syp = Math.round(y2 - dy) - b.y;
        if (sxp < 0 || syp < 0 || sxp >= region.width || syp >= region.height) continue;
        const si = (syp * region.width + sxp) * 4;
        const di = (y2 * W + x2) * 4;
        const k = f * opts.opacity;
        for (let c = 0; c < 4; c++) px[di + c] = px[di + c] * (1 - k) + region.data[si + c] * k;
      }
    }
  }, ctx.strokeState);
}

/** Sponge: push saturation up or down under the brush, luminosity preserved.
 *  Source-snapshot based like dodgeBurnStroke — one application per stroke. */
export function spongeStroke(
  pixels: PixelBuffer,
  src: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  mode: 'saturate' | 'desaturate',
  ctx: PaintContext = NO_CONTEXT,
): void {
  const sp = src.width === pixels.width && src.height === pixels.height ? src : pixels;
  const step = Math.max(0.75, opts.size * 0.18);
  strokePath(
    points,
    step,
    (x, y) =>
      stampEffect(pixels, sp, x, y, opts, ctx, (px, sd, i, f) => {
        if (sd[i + 3] === 0) return;
        const k = f * opts.opacity;
        const r = sd[i];
        const g = sd[i + 1];
        const b = sd[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const factor = mode === 'saturate' ? 1 + k : 1 - k;
        const t0 = lum + (r - lum) * factor;
        const t1 = lum + (g - lum) * factor;
        const t2 = lum + (b - lum) * factor;
        px[i] = t0 >= r ? Math.max(px[i], t0) : Math.min(px[i], t0);
        px[i + 1] = t1 >= g ? Math.max(px[i + 1], t1) : Math.min(px[i + 1], t1);
        px[i + 2] = t2 >= b ? Math.max(px[i + 2], t2) : Math.min(px[i + 2], t2);
      }),
    ctx.strokeState,
  );
}

/** Like stampCircle, but the visitor reads SOURCE values (the stroke-start
 *  snapshot) alongside the destination — so effect dabs compute from one
 *  immutable base no matter how many times the brush passes over a pixel. */
function stampEffect(
  pixels: PixelBuffer,
  src: PixelBuffer,
  cx: number,
  cy: number,
  opts: StampOptions,
  ctx: PaintContext,
  visit: (dst: Uint8ClampedArray, sp: Uint8ClampedArray, i: number, f: number) => void,
): void {
  const r = Math.max(0.5, opts.size / 2);
  const b = circleBounds(pixels.width, pixels.height, cx, cy, r + 1);
  const dst = pixels.data;
  const sp = src.data;
  const W = pixels.width;
  for (let y = b.y; y < b.y + b.height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = b.x; x < b.x + b.width; x++) {
      const dx = x + 0.5 - cx;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      const f = softAlpha(d, r, opts.hardness) * (g / 255) * (opts.flow ?? 1);
      if (f <= 0) continue;
      visit(dst, sp, (y * W + x) * 4, f);
    }
  }
}

/** Shared scaffold for region-based stamps (blur/sharpen): copies the stamp
 *  area from the stroke-start snapshot, then hands `apply` the copy plus the
 *  precomputed in-circle hits. */
function regionStroke(
  pixels: PixelBuffer,
  src: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  ctx: PaintContext,
  apply: (
    region: { data: Uint8ClampedArray; width: number; height: number },
    ox: number,
    oy: number,
    hits: Array<{ bx: number; by: number; f: number }>,
  ) => void,
): void {
  const sp = src.width === pixels.width && src.height === pixels.height ? src : pixels;
  const step = Math.max(1, opts.size * 0.5); // region ops are heavier: stamp less often
  strokePath(points, step, (x, y) => {
    const r = Math.max(0.5, opts.size / 2);
    const pad = Math.ceil(r) + blurRadiusFor(opts.size) + 1;
    const b = circleBounds(pixels.width, pixels.height, x, y, pad);
    const region = copyRegion(sp, b);
    const hits: Array<{ bx: number; by: number; f: number }> = [];
    const cb = circleBounds(pixels.width, pixels.height, x, y, r + 1);
    for (let y2 = cb.y; y2 < cb.y + cb.height; y2++) {
      const dy = y2 + 0.5 - y;
      for (let x2 = cb.x; x2 < cb.x + cb.width; x2++) {
        const dx = x2 + 0.5 - x;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const g = gate(ctx, x2, y2);
        if (g === 0) continue;
        const f = softAlpha(d, r, opts.hardness) * (g / 255) * (opts.flow ?? 1);
        if (f > 0) hits.push({ bx: x2 - b.x, by: y2 - b.y, f });
      }
    }
    if (hits.length === 0) return;
    apply(region, b.x, b.y, hits);
  }, ctx.strokeState);
}

/* ------------------------------------------------------------------ */
/* Clone / healing                                                     */
/* ------------------------------------------------------------------ */

/** Copy from `src` (the pre-stroke snapshot) with an offset. */
export function cloneStroke(
  pixels: PixelBuffer,
  src: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  offset: { x: number; y: number },
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(0.75, opts.size * 0.18);
  strokePath(points, step, (x, y) =>
    stampCircle(pixels, x, y, opts, ctx, (px, i, f) => {
      const idx = i / 4;
      const cx = idx % pixels.width;
      const cy = (idx / pixels.width) | 0;
      const sxp = Math.round(cx - offset.x);
      const syp = Math.round(cy - offset.y);
      if (sxp < 0 || syp < 0 || sxp >= src.width || syp >= src.height) return;
      const so = (syp * src.width + sxp) * 4;
      const sa = src.data[so + 3] / 255;
      if (sa <= 0) return;
      blendAt(px, i, src.data[so], src.data[so + 1], src.data[so + 2], f * opts.opacity * sa);
    }),
  );
}

/** Clone with local brightness matching (a pragmatic healing brush). */
export function healStroke(
  pixels: PixelBuffer,
  src: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  offset: { x: number; y: number },
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(1, opts.size * 0.35);
  strokePath(points, step, (x, y) => {
    const r = Math.max(0.5, opts.size / 2);
    // Average the source sample and the destination patch (RGB of opaque px).
    let sR = 0;
    let sG = 0;
    let sB = 0;
    let sN = 0;
    let dR = 0;
    let dG = 0;
    let dB = 0;
    let dN = 0;
    const b = circleBounds(pixels.width, pixels.height, x, y, r);
    for (let y2 = b.y; y2 < b.y + b.height; y2++) {
      for (let x2 = b.x; x2 < b.x + b.width; x2++) {
        const d = Math.hypot(x2 + 0.5 - x, y2 + 0.5 - y);
        if (d > r) continue;
        const dofs = (y2 * pixels.width + x2) * 4;
        if (pixels.data[dofs + 3] > 8) {
          dR += pixels.data[dofs];
          dG += pixels.data[dofs + 1];
          dB += pixels.data[dofs + 2];
          dN++;
        }
        const sx2 = x2 - offset.x;
        const sy2 = y2 - offset.y;
        if (sx2 >= 0 && sy2 >= 0 && sx2 < src.width && sy2 < src.height) {
          const sofs = (sy2 * src.width + sx2) * 4;
          if (src.data[sofs + 3] > 8) {
            sR += src.data[sofs];
            sG += src.data[sofs + 1];
            sB += src.data[sofs + 2];
            sN++;
          }
        }
      }
    }
    if (sN === 0 || dN === 0) return;
    const dR2 = dR / dN - sR / sN;
    const dG2 = dG / dN - sG / sN;
    const dB2 = dB / dN - sB / sN;

    stampCircle(pixels, x, y, opts, ctx, (px, i, f) => {
      const idx = i / 4;
      const cx = idx % pixels.width;
      const cy = (idx / pixels.width) | 0;
      const sxp = Math.round(cx - offset.x);
      const syp = Math.round(cy - offset.y);
      if (sxp < 0 || syp < 0 || sxp >= src.width || syp >= src.height) return;
      const so = (syp * src.width + sxp) * 4;
      const sa = src.data[so + 3] / 255;
      if (sa <= 0) return;
      blendAt(
        px,
        i,
        src.data[so] + dR2,
        src.data[so + 1] + dG2,
        src.data[so + 2] + dB2,
        f * opts.opacity * sa,
      );
    });
  });
}

/**
 * Spot Healing (proximity match): repair small defects with no manual source
 * point. Each stamp rebuilds its interior by projecting the surrounding ring
 * (just outside the brush) radially inward — blemishes vanish while the
 * nearby texture direction is preserved. Brightness matching is deliberately
 * skipped here: matching the defect's brightness is exactly what we're fixing.
 */
export function spotHealStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(1, opts.size * 0.4);
  strokePath(points, step, (x, y) => {
    const r = Math.max(0.5, opts.size / 2);
    const ringR = r * 1.6; // sample ring sits outside the repair area
    const b = circleBounds(pixels.width, pixels.height, x, y, Math.ceil(ringR) + 2);
    const region = copyRegion(pixels, b);
    const px = pixels.data;
    const W = pixels.width;
    for (let y2 = b.y; y2 < b.y + b.height; y2++) {
      const dy2 = y2 + 0.5 - y;
      for (let x2 = b.x; x2 < b.x + b.width; x2++) {
        const dx2 = x2 + 0.5 - x;
        const d = Math.hypot(dx2, dy2);
        if (d > r) continue;
        const g = gate(ctx, x2, y2);
        if (g === 0) continue;
        const f = softAlpha(d, r, opts.hardness) * (g / 255) * (opts.flow ?? 1);
        if (f <= 0) continue;
        // Radially project onto the clean ring outside the brush.
        const sxp = Math.round(x + (dx2 * ringR) / d) - b.x;
        const syp = Math.round(y + (dy2 * ringR) / d) - b.y;
        if (sxp < 0 || syp < 0 || sxp >= region.width || syp >= region.height) continue;
        const si = (syp * region.width + sxp) * 4;
        const di = (y2 * W + x2) * 4;
        const k = f * opts.opacity;
        if (region.data[si + 3] === 0) continue;
        for (let c = 0; c < 3; c++) px[di + c] = px[di + c] * (1 - k) + region.data[si + c] * k;
      }
    }
  });
}

/**
 * Patch: rebuild the masked region from pixels `offset` away (the dragged-to
 * source), brightness-matched to the destination so the fix blends in —
 * the same local-offset healing math as `healStroke`, at region scale.
 * `sel` is the document-space patch selection; `origin` maps it to the buffer.
 */
export function patchFill(
  pixels: PixelBuffer,
  sel: Selection,
  origin: { x: number; y: number },
  offset: { x: number; y: number },
): void {
  const W = pixels.width;
  const H = pixels.height;
  const b = sel.bounds;
  const src = new Uint8ClampedArray(pixels.data);
  let dR = 0;
  let dG = 0;
  let dB = 0;
  let n = 0;
  // Mean source−destination delta over the valid overlap (lighting match).
  for (let y = 0; y < b.height; y++) {
    const docY = b.y + y;
    const by = docY - origin.y;
    if (by < 0 || by >= H) continue;
    for (let x = 0; x < b.width; x++) {
      const a = sel.mask[y * b.width + x];
      if (a === 0) continue;
      const bx = b.x + x - origin.x;
      if (bx < 0 || bx >= W) continue;
      const sx = bx + offset.x;
      const sy = by + offset.y;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const di = (by * W + bx) * 4;
      const si = (sy * W + sx) * 4;
      if (pixels.data[di + 3] < 8 || src[si + 3] < 8) continue;
      dR += src[si] - pixels.data[di];
      dG += src[si + 1] - pixels.data[di + 1];
      dB += src[si + 2] - pixels.data[di + 2];
      n++;
    }
  }
  if (n === 0) return;
  dR /= n;
  dG /= n;
  dB /= n;
  for (let y = 0; y < b.height; y++) {
    const docY = b.y + y;
    const by = docY - origin.y;
    if (by < 0 || by >= H) continue;
    for (let x = 0; x < b.width; x++) {
      const k = (sel.mask[y * b.width + x] / 255) * 1;
      if (k === 0) continue;
      const bx = b.x + x - origin.x;
      if (bx < 0 || bx >= W) continue;
      const sx = bx + offset.x;
      const sy = by + offset.y;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const si = (sy * W + sx) * 4;
      if (src[si + 3] === 0) continue;
      const di = (by * W + bx) * 4;
      if (pixels.data[di + 3] === 0) continue;
      pixels.data[di] = pixels.data[di] * (1 - k) + (src[si] - dR) * k;
      pixels.data[di + 1] = pixels.data[di + 1] * (1 - k) + (src[si + 1] - dG) * k;
      pixels.data[di + 2] = pixels.data[di + 2] * (1 - k) + (src[si + 2] - dB) * k;
      // Alpha never changes: patching recolors, it doesn't cut holes.
    }
  }
}

/** Red-eye correction: pull dominant flash-red toward neutral and darken
 *  slightly, only where the pixel is unmistakably a red pupil. Conservative
 *  thresholds keep skin tones and red objects untouched. */
export function redEyeStroke(
  pixels: PixelBuffer,
  points: Array<{ x: number; y: number }>,
  opts: StampOptions,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const step = Math.max(0.75, opts.size * 0.18);
  strokePath(points, step, (x, y) =>
    stampCircle(pixels, x, y, opts, ctx, (px, i, f) => {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const mx = Math.max(g, b);
      // Red must dominate hard: bright red, muted green/blue (pupil, not skin).
      if (r < 80 || r - g < 45 || r - b < 45 || g > 110 || b > 110) return;
      const k = f * opts.opacity;
      const dark = 1 - 0.3 * k;
      px[i] = (r + (mx - r) * k) * dark;
      px[i + 1] = g * dark;
      px[i + 2] = b * dark;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Fills                                                               */
/* ------------------------------------------------------------------ */

/** Flood fill from a seed pixel (max-channel tolerance).
 *  `contiguous` (default true) restricts the fill to connected pixels;
 *  false fills every matching pixel in the buffer. */
export function floodFill(
  pixels: PixelBuffer,
  seedX: number,
  seedY: number,
  color: Rgba,
  tolerance: number,
  ctx: PaintContext = NO_CONTEXT,
  contiguous = true,
): boolean {
  const W = pixels.width;
  const H = pixels.height;
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return false;
  const data = pixels.data;
  const seed = (sy * W + sx) * 4;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const sa = data[seed + 3];
  const tol = Math.max(0, tolerance);

  const matches = (i: number): boolean => {
    const o = i * 4;
    return (
      Math.max(
        Math.abs(data[o] - sr),
        Math.abs(data[o + 1] - sg),
        Math.abs(data[o + 2] - sb),
        Math.abs(data[o + 3] - sa),
      ) <= tol
    );
  };

  let changed = 0;
  if (!contiguous) {
    for (let i = 0; i < W * H; i++) {
      if (!matches(i)) continue;
      const x = i % W;
      const y = (i / W) | 0;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      blendAt(data, i * 4, color.r, color.g, color.b, (color.a / 255) * (g / 255));
      changed++;
    }
    return changed > 0;
  }

  const visited = new Uint8Array(W * H);
  const stack: number[] = [sy * W + sx];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (visited[i]) continue;
    visited[i] = 1;
    if (!matches(i)) continue;
    const x = i % W;
    const y = (i / W) | 0;
    const g = gate(ctx, x, y);
    if (g === 0) continue;
    blendAt(data, i * 4, color.r, color.g, color.b, (color.a / 255) * (g / 255));
    changed++;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  return changed > 0;
}

/**
 * Flood erase (Magic Eraser): reduce alpha toward zero over every pixel
 * within tolerance of the seed. `strength` (0..1) scales the erase so a
 * partial-opacity erase works. Max-channel matching, like `floodFill`.
 */
export function floodErase(
  pixels: PixelBuffer,
  seedX: number,
  seedY: number,
  tolerance: number,
  ctx: PaintContext = NO_CONTEXT,
  contiguous = true,
  strength = 1,
): boolean {
  const W = pixels.width;
  const H = pixels.height;
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return false;
  const data = pixels.data;
  const seed = (sy * W + sx) * 4;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const sa = data[seed + 3];
  const tol = Math.max(0, tolerance);
  const k = Math.max(0, Math.min(1, strength));

  const matches = (i: number): boolean => {
    const o = i * 4;
    return (
      Math.max(
        Math.abs(data[o] - sr),
        Math.abs(data[o + 1] - sg),
        Math.abs(data[o + 2] - sb),
        Math.abs(data[o + 3] - sa),
      ) <= tol
    );
  };
  const erase = (i: number, x: number, y: number): void => {
    const g = gate(ctx, x, y);
    if (g === 0) return;
    data[i * 4 + 3] = data[i * 4 + 3] * (1 - k * (g / 255));
  };

  let changed = 0;
  if (!contiguous) {
    for (let i = 0; i < W * H; i++) {
      if (!matches(i)) continue;
      erase(i, i % W, (i / W) | 0);
      changed++;
    }
    return changed > 0;
  }
  const visited = new Uint8Array(W * H);
  const stack: number[] = [sy * W + sx];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (visited[i]) continue;
    visited[i] = 1;
    if (!matches(i)) continue;
    const x = i % W;
    const y = (i / W) | 0;
    erase(i, x, y);
    changed++;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  return changed > 0;
}

/** Linear gradient from (x0,y0) to (x1,y1) across the buffer (or selection). */
export function applyLinearGradient(
  pixels: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  from: Rgba,
  to: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      let t = ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const i = (y * pixels.width + x) * 4;
      blendAt(
        data,
        i,
        from.r + (to.r - from.r) * t,
        from.g + (to.g - from.g) * t,
        from.b + (to.b - from.b) * t,
        g / 255,
      );
    }
  }
}

/** Radial gradient: `from` at the drag start, `to` at the dragged radius. */
export function applyRadialGradient(
  pixels: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  from: Rgba,
  to: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      let t = Math.hypot(x + 0.5 - x0, y + 0.5 - y0) / radius;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const i = (y * pixels.width + x) * 4;
      blendAt(
        data,
        i,
        from.r + (to.r - from.r) * t,
        from.g + (to.g - from.g) * t,
        from.b + (to.b - from.b) * t,
        g / 255,
      );
    }
  }
}

/** Reflected gradient: a linear ramp mirrored about the start point, so the
 *  `from` color sits at the origin and `to` lands at equal distance on both
 *  sides along the drag axis. */
export function applyReflectedGradient(
  pixels: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  from: Rgba,
  to: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      let t = Math.abs(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2);
      t = t > 1 ? 1 : t;
      const i = (y * pixels.width + x) * 4;
      blendAt(
        data,
        i,
        from.r + (to.r - from.r) * t,
        from.g + (to.g - from.g) * t,
        from.b + (to.b - from.b) * t,
        g / 255,
      );
    }
  }
}

/** Angle gradient: a full sweep around the start point, beginning along the
 *  drag direction (one hard seam at the base angle — classic behavior). */
export function applyAngleGradient(
  pixels: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  from: Rgba,
  to: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const base = Math.atan2(y1 - y0, x1 - x0);
  const TAU = Math.PI * 2;
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      let a = Math.atan2(y + 0.5 - y0, x + 0.5 - x0) - base;
      a %= TAU;
      if (a < 0) a += TAU;
      const t = a / TAU;
      const i = (y * pixels.width + x) * 4;
      blendAt(
        data,
        i,
        from.r + (to.r - from.r) * t,
        from.g + (to.g - from.g) * t,
        from.b + (to.b - from.b) * t,
        g / 255,
      );
    }
  }
}

/** Diamond gradient: Manhattan distance from the start produces diamond-
 *  shaped isolines; the drag endpoint defines where `to` lands. */
export function applyDiamondGradient(
  pixels: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  from: Rgba,
  to: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const den = Math.abs(x1 - x0) + Math.abs(y1 - y0) || 1;
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      let t = (Math.abs(x + 0.5 - x0) + Math.abs(y + 0.5 - y0)) / den;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const i = (y * pixels.width + x) * 4;
      blendAt(
        data,
        i,
        from.r + (to.r - from.r) * t,
        from.g + (to.g - from.g) * t,
        from.b + (to.b - from.b) * t,
        g / 255,
      );
    }
  }
}

/** Fill a rectangle with exact fractional edge coverage (crisp, antialiased). */
export function fillRect(
  pixels: PixelBuffer,
  rect: Rect,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const data = pixels.data;
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(pixels.width - 1, Math.ceil(right));
  const y1 = Math.min(pixels.height - 1, Math.ceil(bottom));
  for (let y = y0; y <= y1; y++) {
    const covY = Math.max(0, Math.min(y + 1, bottom) - Math.max(y, top));
    if (covY <= 0) continue;
    for (let x = x0; x <= x1; x++) {
      const covX = Math.max(0, Math.min(x + 1, right) - Math.max(x, left));
      if (covX <= 0) continue;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      blendAt(data, (y * pixels.width + x) * 4, color.r, color.g, color.b, covX * covY * (g / 255));
    }
  }
}

/** Fill an ellipse inscribed in `rect` with ~1 px antialiased edges. */
export function fillEllipse(
  pixels: PixelBuffer,
  rect: Rect,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const data = pixels.data;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = Math.max(0.5, rect.width / 2);
  const ry = Math.max(0.5, rect.height / 2);
  const edge = 1 / Math.min(rx, ry);
  const x0 = Math.max(0, Math.floor(rect.x - 1));
  const y0 = Math.max(0, Math.floor(rect.y - 1));
  const x1 = Math.min(pixels.width - 1, Math.ceil(rect.x + rect.width + 1));
  const y1 = Math.min(pixels.height - 1, Math.ceil(rect.y + rect.height + 1));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (dy < -1 - edge || dy > 1 + edge) continue;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dist = Math.hypot(dx, dy);
      if (dist > 1 + edge) continue;
      let cov = 0.5 + (1 - dist) / edge;
      cov = cov < 0 ? 0 : cov > 1 ? 1 : cov;
      if (cov <= 0) continue;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      blendAt(data, (y * pixels.width + x) * 4, color.r, color.g, color.b, cov * (g / 255));
    }
  }
}

/** Rounded rectangle: signed-distance coverage, ~1 px antialiased edges.
 *  Radius is clamped to the box (degenerate to a plain rect at ≤ 0). */
export function fillRoundedRect(
  pixels: PixelBuffer,
  rect: Rect,
  radius: number,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(rect.width, rect.height) / 2));
  if (r <= 0.5) {
    fillRect(pixels, rect, color, ctx);
    return;
  }
  const data = pixels.data;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const hx = rect.width / 2 - r;
  const hy = rect.height / 2 - r;
  const x0 = Math.max(0, Math.floor(rect.x - 1));
  const y0 = Math.max(0, Math.floor(rect.y - 1));
  const x1 = Math.min(pixels.width - 1, Math.ceil(rect.x + rect.width + 1));
  const y1 = Math.min(pixels.height - 1, Math.ceil(rect.y + rect.height + 1));
  for (let y = y0; y <= y1; y++) {
    const qy = Math.abs(y + 0.5 - cy) - hy;
    for (let x = x0; x <= x1; x++) {
      const qx = Math.abs(x + 0.5 - cx) - hx;
      const ax = qx > 0 ? qx : 0;
      const ay = qy > 0 ? qy : 0;
      const d = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
      let cov = 0.5 - d;
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      blendAt(data, (y * pixels.width + x) * 4, color.r, color.g, color.b, cov * (g / 255));
    }
  }
}

/** Point-in-polygon (ray cast to +x). */
function pointInPolygon(pts: Array<{ x: number; y: number }>, px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Fill a polygon with 4×4 supersampled antialiased edges (even-odd). */
export function fillPolygon(
  pixels: PixelBuffer,
  pts: Array<{ x: number; y: number }>,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  if (pts.length < 3) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const data = pixels.data;
  const x0 = Math.max(0, Math.floor(minX - 1));
  const y0 = Math.max(0, Math.floor(minY - 1));
  const x1 = Math.min(pixels.width - 1, Math.ceil(maxX + 1));
  const y1 = Math.min(pixels.height - 1, Math.ceil(maxY + 1));
  const SUB = 4;
  const INV = 1 / (SUB * SUB);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          if (pointInPolygon(pts, x + (sx + 0.5) / SUB, y + (sy + 0.5) / SUB)) hits++;
        }
      }
      if (hits === 0) continue;
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      blendAt(data, (y * pixels.width + x) * 4, color.r, color.g, color.b, hits * INV * (g / 255));
    }
  }
}

/** Thick line segment with butt caps (the Line shape tool). */
export function strokeThickLine(
  pixels: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  weight: number,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const w = Math.max(1, weight);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) {
    fillEllipse(pixels, { x: x0 - w / 2, y: y0 - w / 2, width: w, height: w }, color, ctx);
    return;
  }
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  fillPolygon(
    pixels,
    [
      { x: x0 + nx, y: y0 + ny },
      { x: x1 + nx, y: y1 + ny },
      { x: x1 - nx, y: y1 - ny },
      { x: x0 - nx, y: y0 - ny },
    ],
    color,
    ctx,
  );
}

/** Zero out alpha inside the selection (Delete with an active selection). */
export function clearPixels(
  pixels: PixelBuffer,
  ctx: PaintContext,
  partial: boolean,
): void {
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      if (partial) {
        const g = gate(ctx, x, y);
        if (g === 0) continue;
        const i = (y * pixels.width + x) * 4;
        data[i + 3] = (data[i + 3] * (255 - g)) / 255;
      } else {
        data[(y * pixels.width + x) * 4 + 3] = 0;
      }
    }
  }
}

/** Paint a solid color over the buffer, constrained by the selection
   (Alt/Ctrl+Backspace fills). The fill color's own alpha is respected. */
export function fillPixels(
  pixels: PixelBuffer,
  color: Rgba,
  ctx: PaintContext = NO_CONTEXT,
): void {
  const data = pixels.data;
  const sa = color.a / 255;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      const i = (y * pixels.width + x) * 4;
      if (g === 255 && sa === 1) {
        data[i] = color.r;
        data[i + 1] = color.g;
        data[i + 2] = color.b;
        data[i + 3] = color.a;
      } else {
        blendAt(data, i, color.r, color.g, color.b, sa * (g / 255));
      }
    }
  }
}

/** Invert RGB channels inside the selection (Ctrl+I); alpha is untouched. */
export function invertPixels(pixels: PixelBuffer, ctx: PaintContext = NO_CONTEXT): void {
  const data = pixels.data;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const g = gate(ctx, x, y);
      if (g === 0) continue;
      const i = (y * pixels.width + x) * 4;
      if (g === 255) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
      } else {
        // Lerp toward the inverted color, leaving alpha alone.
        const t = g / 255;
        data[i] += (255 - 2 * data[i]) * t;
        data[i + 1] += (255 - 2 * data[i + 1]) * t;
        data[i + 2] += (255 - 2 * data[i + 2]) * t;
      }
    }
  }
}
