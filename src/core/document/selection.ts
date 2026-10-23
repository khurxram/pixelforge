/**
 * Selection model — a document-space alpha mask with bounds.
 *
 * Pure data + pure functions (no DOM), so the whole model is unit tested in
 * Node and reusable inside Web Workers. The renderer turns `computeOutline`
 * output into marching-ants dashes; `rect` marks selections that fully cover
 * their bounds so the renderer can draw a crisp vector rectangle instead.
 */
import type { PixelBuffer, Rect } from './types';

export interface Selection {
  /** Bounds in document coordinates (integer, clamped to the document). */
  bounds: Rect;
  /** Non-null when the mask fully covers `bounds` (vector fast path). */
  rect: Rect | null;
  /** Alpha mask over `bounds`: bounds.width * bounds.height bytes, 0..255. */
  mask: Uint8Array;
}

/** Clamp an arbitrary rect to integer document bounds; null when empty. */
function clampIntRect(rect: Rect, docW: number, docH: number): Rect | null {
  const x0 = Math.max(0, Math.min(docW, Math.floor(rect.x)));
  const y0 = Math.max(0, Math.min(docH, Math.floor(rect.y)));
  const x1 = Math.max(0, Math.min(docW, Math.ceil(rect.x + rect.width)));
  const y1 = Math.max(0, Math.min(docH, Math.ceil(rect.y + rect.height)));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Rectangular selection (also used for Select All). */
export function rectSelection(docW: number, docH: number, rect: Rect): Selection | null {
  const bounds = clampIntRect(rect, docW, docH);
  if (!bounds) return null;
  const mask = new Uint8Array(bounds.width * bounds.height);
  mask.fill(255);
  return { bounds, rect: bounds, mask };
}

/**
 * Elliptical selection with edge anti-aliasing: coverage is a smooth ramp of
 * about one pixel around the normalized ellipse boundary.
 */
export function ellipseSelection(docW: number, docH: number, rect: Rect): Selection | null {
  const bounds = clampIntRect(rect, docW, docH);
  if (!bounds) return null;
  const W = bounds.width;
  const H = bounds.height;
  const mask = new Uint8Array(W * H);
  const cx = bounds.x + W / 2;
  const cy = bounds.y + H / 2;
  const rx = W / 2;
  const ry = H / 2;
  // One-pixel AA ramp measured against the local gradient of the ellipse metric.
  const aa = 0.5 / Math.max(1, Math.min(rx, ry));
  for (let y = 0; y < H; y++) {
    const ny = (bounds.y + y + 0.5 - cy) / ry;
    for (let x = 0; x < W; x++) {
      const nx = (bounds.x + x + 0.5 - cx) / rx;
      const d = Math.sqrt(nx * nx + ny * ny);
      const v = 1 - (d - 1) / aa;
      mask[y * W + x] = v >= 1 ? 255 : v <= 0 ? 0 : Math.round(v * 255);
    }
  }
  return { bounds, rect: null, mask };
}

/** Single-pixel-high row selection across the full document width. */
export function rowSelection(docW: number, docH: number, y: number): Selection | null {
  const yy = Math.floor(y);
  if (yy < 0 || yy >= docH) return null;
  return rectSelection(docW, docH, { x: 0, y: yy, width: docW, height: 1 });
}

/** Single-pixel-wide column selection across the full document height. */
export function columnSelection(docW: number, docH: number, x: number): Selection | null {
  const xx = Math.floor(x);
  if (xx < 0 || xx >= docW) return null;
  return rectSelection(docW, docH, { x: xx, y: 0, width: 1, height: docH });
}

/** Full-document selection. */
export function selectAll(docW: number, docH: number): Selection {
  const all = rectSelection(docW, docH, { x: 0, y: 0, width: docW, height: docH });
  /* c8 ignore next */
  if (!all) return { bounds: { x: 0, y: 0, width: docW, height: docH }, rect: null, mask: new Uint8Array(docW * docH) };
  return all;
}

/**
 * Freehand polygon selection (lasso). Even-odd scanline fill of the closed
 * polygon defined by `points` in document coordinates.
 */
export function pathSelection(docW: number, docH: number, points: Array<{ x: number; y: number }>): Selection | null {
  if (points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bounds = clampIntRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, docW, docH);
  if (!bounds) return null;

  const W = bounds.width;
  const H = bounds.height;
  const mask = new Uint8Array(W * H);
  const n = points.length;

  for (let row = 0; row < H; row++) {
    const yc = bounds.y + row + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a.y === b.y) continue;
      const belowA = a.y <= yc;
      const belowB = b.y <= yc;
      if (belowA === belowB) continue;
      xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const start = Math.max(bounds.x, Math.ceil(xs[k] - 0.5));
      const end = Math.min(bounds.x + W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = start; x <= end; x++) {
        mask[row * W + (x - bounds.x)] = 255;
      }
    }
  }
  return { bounds, rect: null, mask };
}

/** How a new selection combines with the existing one (Photoshop-style modes). */
export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect';

/**
 * Combine two document-space selections per `mode`.
 * Returns the effective single selection; null means "no selection".
 */
export function combineSelection(
  prev: Selection | null,
  next: Selection | null,
  mode: SelectionMode = 'new',
): Selection | null {
  if (mode === 'new') return next;
  if (!next) return prev;
  if (!prev) return mode === 'subtract' ? null : next;

  // Result bounds: union for add, intersection for intersect, prev for subtract.
  const pb = prev.bounds;
  const nb = next.bounds;
  let bx: number;
  let by: number;
  let bw: number;
  let bh: number;
  if (mode === 'add') {
    const x0 = Math.min(pb.x, nb.x);
    const y0 = Math.min(pb.y, nb.y);
    const x1 = Math.max(pb.x + pb.width, nb.x + nb.width);
    const y1 = Math.max(pb.y + pb.height, nb.y + nb.height);
    bx = x0;
    by = y0;
    bw = x1 - x0;
    bh = y1 - y0;
  } else if (mode === 'intersect') {
    const x0 = Math.max(pb.x, nb.x);
    const y0 = Math.max(pb.y, nb.y);
    const x1 = Math.min(pb.x + pb.width, nb.x + nb.width);
    const y1 = Math.min(pb.y + pb.height, nb.y + nb.height);
    if (x1 <= x0 || y1 <= y0) return null;
    bx = x0;
    by = y0;
    bw = x1 - x0;
    bh = y1 - y0;
  } else {
    bx = pb.x;
    by = pb.y;
    bw = pb.width;
    bh = pb.height;
  }

  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const dy = by + y;
    for (let x = 0; x < bw; x++) {
      const dx = bx + x;
      const a = selectionAlpha(prev, dx, dy) / 255;
      const b = selectionAlpha(next, dx, dy) / 255;
      let v: number;
      switch (mode) {
        case 'add':
          v = a + b - a * b;
          break;
        case 'subtract':
          v = a * (1 - b);
          break;
        case 'intersect':
          v = a * b;
          break;
        /* c8 ignore next 2 */
        default:
          v = b;
      }
      mask[y * bw + x] = Math.round(v * 255);
    }
  }

  // Vector fast path only for fully-opaque, exactly-rect results.
  let rect: Rect | null = null;
  if (mode !== 'add') {
    let full = true;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 255) {
        full = false;
        break;
      }
    }
    if (full) rect = { x: bx, y: by, width: bw, height: bh };
  }
  // Any all-zero result means no selection at all (any mode).
  let any = false;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  return { bounds: { x: bx, y: by, width: bw, height: bh }, rect, mask };
}

/** Options for the magic-wand selection. */
export interface WandOptions {
  /** Flood-fill adjacency (default true). False selects every matching pixel. */
  contiguous?: boolean;
  /** Soften the selection boundary by ~1px (default true). */
  antialias?: boolean;
  /** Restrict growth/scan to this rectangle (clamped to the image). Lets a
   *  quick-selection dab cost O(brush area) instead of O(image). */
  bounds?: Rect | null;
  /** Reused W*H visited scratch buffer — cleared inside `bounds` only, so
   *  repeated dabs don't reallocate millions of cells every pointer move. */
  visited?: Uint8Array;
  /** Object Selection barrier: the flood refuses to *enter* pixels whose
   *  edge magnitude reaches `threshold` (per-channel Sobel map), so growth
   *  stops at object boundaries even when their colours still match. */
  edge?: { map: Float32Array; threshold: number } | null;
}

/**
 * Magic-wand selection: contiguous flood of pixels within `tolerance` of the
 * seed colour. Distance is luma-weighted RGB Euclidean plus a full alpha term,
 * so it tracks perceptual colour difference far better than a raw per-channel
 * maximum; the 0..100 tolerance slider maps linearly onto that 0..255 space.
 */
export function wandSelection(
  pixels: PixelBuffer,
  seedX: number,
  seedY: number,
  tolerance: number,
  opts: WandOptions = {},
): Selection | null {
  const contiguous = opts.contiguous ?? true;
  const antialias = opts.antialias ?? true;
  const W = pixels.width;
  const H = pixels.height;
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;

  // Working rectangle: the caller's bounds, clamped to the image. Clearing,
  // scanning and flood expansion all stay inside it.
  const bx0 = opts.bounds ? Math.max(0, Math.floor(opts.bounds.x)) : 0;
  const by0 = opts.bounds ? Math.max(0, Math.floor(opts.bounds.y)) : 0;
  const bx1 = opts.bounds ? Math.min(W - 1, Math.ceil(opts.bounds.x + opts.bounds.width) - 1) : W - 1;
  const by1 = opts.bounds ? Math.min(H - 1, Math.ceil(opts.bounds.y + opts.bounds.height) - 1) : H - 1;
  if (sx < bx0 || sy < by0 || sx > bx1 || sy > by1) return null;

  const data = pixels.data;
  const seed = (sy * W + sx) * 4;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const sa = data[seed + 3];
  const tol = Math.max(0, tolerance);
  /** Tolerance in perceptual distance space (100 ≈ the full range). */
  const thr = tol * 2.55;
  /** Match test without a per-pixel sqrt: luma-weighted RGB distance plus
   *  the alpha term must fit the budget (identical maths, much faster). */
  const within = (o: number): boolean => {
    const dA = data[o + 3] - sa;
    const budget = thr - (dA < 0 ? -dA : dA);
    if (budget < 0) return false;
    const dr = data[o] - sr;
    const dg = data[o + 1] - sg;
    const db = data[o + 2] - sb;
    return 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db <= budget * budget;
  };

  let visited: Uint8Array;
  if (opts.visited) {
    visited = opts.visited;
    for (let y = by0; y <= by1; y++) visited.fill(0, y * W + bx0, y * W + bx1 + 1);
  } else {
    visited = new Uint8Array(W * H);
  }
  const stack: number[] = [sy * W + sx];
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;

  if (!contiguous) {
    // Global scan: every matching pixel inside the working rectangle.
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const i = y * W + x;
        if (!within(i * 4)) continue;
        visited[i] = 2;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  } else {
    const seedIdx = sy * W + sx;
    const edge = opts.edge ?? null;
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (visited[i]) continue;
      if (!within(i * 4)) {
        visited[i] = 1; // remember the rejected pixel too
        continue;
      }
      // Edge barrier: stop at strong boundaries (the seed always enters, so
      // clicking directly on an object's edge still grows from it).
      if (edge && i !== seedIdx && edge.map[i] >= edge.threshold) {
        visited[i] = 1;
        continue;
      }
      visited[i] = 2; // selected
      const x = i % W;
      const y = (i / W) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > bx0) stack.push(i - 1);
      if (x < bx1) stack.push(i + 1);
      if (y > by0) stack.push(i - W);
      if (y < by1) stack.push(i + W);
    }
  }
  if (visited[sy * W + sx] !== 2) return null; // seed itself not matched

  const bounds: Rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  let mask: Uint8Array<ArrayBuffer> = new Uint8Array(bounds.width * bounds.height);
  for (let y = 0; y < bounds.height; y++) {
    const srcRow = (bounds.y + y) * W + bounds.x;
    const dstRow = y * bounds.width;
    for (let x = 0; x < bounds.width; x++) {
      if (visited[srcRow + x] === 2) mask[dstRow + x] = 255;
    }
  }

  if (antialias) mask = softenMaskEdge(mask, bounds.width, bounds.height);
  return { bounds, rect: null, mask };
}

/**
 * Anti-alias pass: interior boundary pixels get partial coverage proportional
 * to how many of their 8 neighbors are selected — a real ~1px edge soften.
 */
function softenMaskEdge(mask: Uint8Array<ArrayBuffer>, W: number, H: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] === 0) {
        out[i] = 0;
        continue;
      }
      let n = 0; // selected in-bounds neighbors
      let t = 0; // total in-bounds neighbors
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          t++;
          if (mask[yy * W + xx] !== 0) n++;
        }
      }
      // Fully interior stays 255; boundary pixels ramp with neighbor coverage.
      out[i] = t === 0 || n === t ? 255 : Math.round((n / t) * 255);
    }
  }
  return out;
}

/** Inverse of the current selection (null selection = select nothing? no — select all). */
export function invertSelection(docW: number, docH: number, sel: Selection | null): Selection {
  if (!sel) return selectAll(docW, docH);
  const bounds: Rect = { x: 0, y: 0, width: docW, height: docH };
  const mask = new Uint8Array(docW * docH);
  mask.fill(255);
  const b = sel.bounds;
  for (let y = 0; y < b.height; y++) {
    const dy = b.y + y;
    if (dy < 0 || dy >= docH) continue;
    for (let x = 0; x < b.width; x++) {
      const dx = b.x + x;
      if (dx < 0 || dx >= docW) continue;
      mask[dy * docW + dx] = 255 - sel.mask[y * b.width + x];
    }
  }
  return { bounds, rect: null, mask };
}

/** Separable box-blur of a mask, repeated `passes` times to approximate a
 *  gaussian. Returns a new Uint8Array; the caller decides bounds padding. */
function blurMaskFloat(base: Float32Array, W: number, H: number, r: number, passes: number): Float32Array {
  let src = base;
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);
  const n = r * 2 + 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < W) sum += src[y * W + xx];
        }
        tmp[y * W + x] = sum / n;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < H) sum += tmp[yy * W + x];
        }
        dst[y * W + x] = sum / n;
      }
    }
    src = dst;
  }
  return src;
}

/** Soften selection edges with a gaussian-style falloff (`radius` px).
 *  Three box passes give a smooth curve instead of the stepped ramp a single
 *  box blur produces — feathered cut-outs no longer show banding.
 *  Bounds expand by 3 × radius (zero padding) so the blur sees outside. */
export function featherSelection(sel: Selection, radius: number): Selection {
  const r = Math.max(1, Math.round(radius));
  const pad = r * 3;
  const oldW = sel.bounds.width;
  const oldH = sel.bounds.height;
  const W = oldW + pad * 2;
  const H = oldH + pad * 2;

  // Re-lay the mask into the expanded canvas with a zero border.
  const base = new Float32Array(W * H);
  for (let y = 0; y < oldH; y++) {
    for (let x = 0; x < oldW; x++) {
      base[(y + pad) * W + (x + pad)] = sel.mask[y * oldW + x];
    }
  }

  const blurred = blurMaskFloat(base, W, H, r, 3);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(blurred[i]);
  return {
    bounds: { x: sel.bounds.x - pad, y: sel.bounds.y - pad, width: W, height: H },
    rect: null,
    mask: out,
  };
}

/** Grow the selection outward by `radius` px (separable max filter). */
export function growSelection(sel: Selection, radius = 1): Selection {
  const r = Math.max(1, Math.round(radius));
  const oldW = sel.bounds.width;
  const oldH = sel.bounds.height;
  const W = oldW + r * 2;
  const H = oldH + r * 2;
  const base = new Uint8Array(W * H);
  for (let y = 0; y < oldH; y++) {
    for (let x = 0; x < oldW; x++) base[(y + r) * W + (x + r)] = sel.mask[y * oldW + x];
  }
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < W && base[y * W + xx] > m) m = base[y * W + xx];
      }
      tmp[y * W + x] = m;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < H && tmp[yy * W + x] > m) m = tmp[yy * W + x];
      }
      out[y * W + x] = m;
    }
  }
  return { bounds: { x: sel.bounds.x - r, y: sel.bounds.y - r, width: W, height: H }, rect: null, mask: out };
}

/** Contract the selection inward by `radius` px (separable min filter;
 *  outside the bounds counts as unselected, so edges pull in from borders). */
export function shrinkSelection(sel: Selection, radius = 1): Selection {
  const r = Math.max(1, Math.round(radius));
  const W = sel.bounds.width;
  const H = sel.bounds.height;
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 255;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        const v = xx < 0 || xx >= W ? 0 : sel.mask[y * W + xx];
        if (v < m) m = v;
      }
      tmp[y * W + x] = m;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = 255;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        const v = yy < 0 || yy >= H ? 0 : tmp[yy * W + x];
        if (v < m) m = v;
      }
      out[y * W + x] = m;
    }
  }
  return { bounds: sel.bounds, rect: null, mask: out };
}

/** Smooth ragged edges: blur then re-threshold — isolated specks drop out
 *  and jagged corners round off (the classic "Smooth" modify command). */
export function smoothSelection(sel: Selection, radius = 2): Selection {
  const r = Math.max(1, Math.round(radius));
  const W = sel.bounds.width;
  const H = sel.bounds.height;
  const base = new Float32Array(W * H);
  base.set(sel.mask);
  const blurred = blurMaskFloat(base, W, H, r, 1);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = blurred[i] >= 128 ? 255 : 0;
  return { bounds: sel.bounds, rect: null, mask: out };
}

/** Alpha of the selection at document coordinates (255 when sel is null). */
export function selectionAlpha(sel: Selection | null, x: number, y: number): number {
  if (!sel) return 255;
  const b = sel.bounds;
  const lx = x - b.x;
  const ly = y - b.y;
  if (lx < 0 || ly < 0 || lx >= b.width || ly >= b.height) return 0;
  return sel.mask[ly * b.width + lx];
}

/**
 * Translate a selection's bounds (buffer → document space fixes). The mask
 * itself never moves — only where it lives in document coordinates. Shares
 * the mask array (selections are treated as immutable throughout).
 */
export function offsetSelection(sel: Selection, dx: number, dy: number): Selection {
  if (dx === 0 && dy === 0) return sel;
  return {
    bounds: { x: sel.bounds.x + dx, y: sel.bounds.y + dy, width: sel.bounds.width, height: sel.bounds.height },
    rect: sel.rect ? { x: sel.rect.x + dx, y: sel.rect.y + dy, width: sel.rect.width, height: sel.rect.height } : null,
    mask: sel.mask,
  };
}

/**
 * Quick-selection dab: flood the connected color region around the seed
 * (wand semantics), bound it to the brush circle so growth stays brush-
 * driven, and union it into the running stroke selection. The flood itself
 * is clamped to the brush box — a dab costs O(brush area), not O(image),
 * which is what made painting a selection lag on large documents.
 */
export interface QuickSelectOptions {
  /** Reused W*H visited scratch buffer (avoids per-dab reallocation). */
  visited?: Uint8Array;
}

export function expandQuickSelection(
  pixels: PixelBuffer,
  seedX: number,
  seedY: number,
  radius: number,
  tolerance: number,
  prev: Selection | null,
  opts: QuickSelectOptions = {},
): Selection | null {
  const r = Math.max(1, radius);
  const dab = wandSelection(pixels, seedX, seedY, tolerance, {
    contiguous: true,
    antialias: true,
    bounds: {
      x: Math.floor(seedX - r),
      y: Math.floor(seedY - r),
      width: Math.ceil(r * 2) + 1,
      height: Math.ceil(r * 2) + 1,
    },
    visited: opts.visited,
  });
  if (!dab) return prev;
  const circle = ellipseSelection(pixels.width, pixels.height, {
    x: seedX - r,
    y: seedY - r,
    width: r * 2,
    height: r * 2,
  });
  const bounded = circle ? combineSelection(dab, circle, 'intersect') : dab;
  if (!bounded) return prev;
  if (!prev) return bounded;
  return combineSelection(prev, bounded, 'add');
}

/**
 * Marching-ants outline for the renderer: RGBA where boundary pixels alternate
 * white dash / black dash (always readable over light and dark imagery).
 * Boundary pixels form a 1-px ring, dashed with a period of 4.
 */
export function computeOutline(sel: Selection): Uint8ClampedArray {
  const W = sel.bounds.width;
  const H = sel.bounds.height;
  const out = new Uint8ClampedArray(W * H * 4);
  const mask = sel.mask;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] < 128) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === W - 1 ||
        y === H - 1 ||
        mask[i - 1] < 128 ||
        mask[i + 1] < 128 ||
        mask[i - W] < 128 ||
        mask[i + W] < 128;
      if (!edge) continue;
      const white = (x + y) & 3;
      const o = i * 4;
      const v = white < 2 ? 255 : 0;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return out;
}
