/**
 * Document compositor: renders visible layers bottom→top into a single RGBA
 * buffer at full document resolution, honoring opacity, blend modes, offsets
 * and (later) masks. Implements the W3C Compositing and Blending formulas so
 * results can be checked against the spec's examples.
 */
import type { BlendMode, EditorDocument, Layer, PixelBuffer } from '../core/document/types';

/* ------------------------------------------------------------------ */
/* Channel blend modes (inputs/outputs 0..255)                         */
/* ------------------------------------------------------------------ */

function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal':
      return cs;
    case 'multiply':
      return (cb * cs) / 255;
    case 'screen':
      return 255 - ((255 - cb) * (255 - cs)) / 255;
    case 'overlay':
      // Overlay is hard-light with backdrop/source swapped.
      return cb <= 127.5
        ? (2 * cb * cs) / 255
        : 255 - (2 * (255 - cb) * (255 - cs)) / 255;
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'color-dodge':
      if (cb === 0) return 0;
      if (cs === 255) return 255;
      return Math.min(255, (255 * cb) / (255 - cs));
    case 'color-burn':
      if (cb === 255) return 255;
      if (cs === 0) return 0;
      return Math.max(0, 255 - (255 * (255 - cb)) / cs);
    case 'hard-light':
      return cs <= 127.5
        ? (2 * cb * cs) / 255
        : 255 - (2 * (255 - cb) * (255 - cs)) / 255;
    case 'difference':
      return Math.abs(cb - cs);
    case 'exclusion':
      return cb + cs - (2 * cb * cs) / 255;
    default:
      return cs;
  }
}

function softLightChannel(cb: number, cs: number): number {
  const b = cb / 255;
  const s = cs / 255;
  let d: number;
  if (b <= 0.25) d = ((16 * b - 12) * b + 4) * b;
  else d = Math.sqrt(b);
  const r = s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
  return r * 255;
}

/* Nonseparable helpers operate in 0..1 (W3C Compositing and Blending). */
type Vec3 = [number, number, number];

function lumC(c: Vec3): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

function clipColor(c: Vec3): void {
  const l = lumC(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) {
    const denom = l - n;
    for (let i = 0; i < 3; i++) c[i] = denom > 1e-9 ? l + ((c[i] - l) * l) / denom : 0;
  }
  if (x > 1) {
    const denom = x - l;
    for (let i = 0; i < 3; i++) c[i] = denom > 1e-9 ? l + ((c[i] - l) * (1 - l)) / denom : 1;
  }
  for (let i = 0; i < 3; i++) c[i] = c[i] < 0 ? 0 : c[i] > 1 ? 1 : c[i];
}

function setLum(c: Vec3, l: number): Vec3 {
  const out: Vec3 = [c[0] + (l - lumC(c)), c[1] + (l - lumC(c)), c[2] + (l - lumC(c))];
  clipColor(out);
  return out;
}

function sat(c: Vec3): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

function setSat(c: Vec3, s: number): Vec3 {
  const idx: Vec3 = [0, 1, 2];
  idx.sort((a, b) => c[a] - c[b]);
  const [minI, midI, maxI] = idx;
  const out: Vec3 = [c[0], c[1], c[2]];
  const max = c[maxI];
  const min = c[minI];
  if (max > min) {
    out[midI] = ((c[midI] - min) * s) / (max - min);
    out[maxI] = s;
  } else {
    out[midI] = 0;
    out[maxI] = 0;
  }
  out[minI] = 0;
  return out;
}

const NONSEPARABLE: ReadonlySet<BlendMode> = new Set<BlendMode>([
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

/**
 * Blend source color over backdrop color for a given mode (0..255 in/out).
 * Covers every supported mode; used by the compositor and unit tests.
 */
export function blendRgb(mode: BlendMode, cb: [number, number, number], cs: [number, number, number]): [number, number, number] {
  if (NONSEPARABLE.has(mode)) {
    const b: Vec3 = [cb[0] / 255, cb[1] / 255, cb[2] / 255];
    const s: Vec3 = [cs[0] / 255, cs[1] / 255, cs[2] / 255];
    let res: Vec3;
    switch (mode) {
      case 'hue':
        res = setLum(setSat(s, sat(b)), lumC(b));
        break;
      case 'saturation':
        res = setLum(setSat(b, sat(s)), lumC(b));
        break;
      case 'color':
        res = setLum(s, lumC(b));
        break;
      default: // luminosity
        res = setLum(b, lumC(s));
        break;
    }
    return [res[0] * 255, res[1] * 255, res[2] * 255];
  }
  if (mode === 'soft-light') {
    return [softLightChannel(cb[0], cs[0]), softLightChannel(cb[1], cs[1]), softLightChannel(cb[2], cs[2])];
  }
  return [
    blendChannel(mode, cb[0], cs[0]),
    blendChannel(mode, cb[1], cs[1]),
    blendChannel(mode, cb[2], cs[2]),
  ];
}

/* ------------------------------------------------------------------ */
/* Document compositing                                                */
/* ------------------------------------------------------------------ */

export interface CompositeOptions {
  /** Optional backdrop painted before the layers (e.g. flattened export bg). */
  background?: PixelBuffer | null;
}

/** Composite all visible layers into a new full-resolution buffer. */
export function compositeDocument(doc: EditorDocument, opts: CompositeOptions = {}): PixelBuffer {
  const { width: W, height: H } = doc;
  const out = new Uint8ClampedArray(W * H * 4);
  if (opts.background && opts.background.width === W && opts.background.height === H) {
    out.set(opts.background.data);
  }
  for (const layer of doc.layers) {
    compositeLayerInto(out, W, H, layer);
  }
  return { width: W, height: H, data: out };
}

/**
 * Composite a single document pixel (eyedropper) without allocating a full
 * buffer. Returns RGBA 0..255; transparent outside the canvas.
 */
export function sampleComposite(
  doc: EditorDocument,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  let br = 0;
  let bg = 0;
  let bb = 0;
  let ba = 0;

  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const lx = px - layer.x;
    const ly = py - layer.y;
    if (lx < 0 || ly < 0 || lx >= layer.pixels.width || ly >= layer.pixels.height) continue;
    const si = (ly * layer.pixels.width + lx) * 4;
    const srcA = layer.pixels.data[si + 3];
    if (srcA === 0) continue;
    let as = (srcA / 255) * layer.opacity;
    if (layer.mask?.enabled) {
      const mi = ly * layer.mask.width + lx;
      if (mi < layer.mask.data.length) as *= layer.mask.data[mi] / 255;
    }
    if (as <= 0) continue;

    const sr = layer.pixels.data[si];
    const sg = layer.pixels.data[si + 1];
    const sb = layer.pixels.data[si + 2];
    const ab = ba / 255;
    const ao = as + ab * (1 - as);
    if (ao <= 0) continue;

    let or: number;
    let og: number;
    let ob: number;
    if (layer.blendMode === 'normal') {
      or = (1 - as) * ab * br + as * sr;
      og = (1 - as) * ab * bg + as * sg;
      ob = (1 - as) * ab * bb + as * sb;
      if (ab === 0) {
        or = sr * as;
        og = sg * as;
        ob = sb * as;
      }
    } else {
      const [b1, g1, b2] = blendRgb(layer.blendMode, [br, bg, bb], [sr, sg, sb]);
      or = (1 - as) * ab * br + (1 - ab) * as * sr + as * ab * b1;
      og = (1 - as) * ab * bg + (1 - ab) * as * sg + as * ab * g1;
      ob = (1 - as) * ab * bb + (1 - ab) * as * sb + as * ab * b2;
    }
    br = or / ao;
    bg = og / ao;
    bb = ob / ao;
    ba = ao * 255;
  }

  return {
    r: br < 0 ? 0 : br > 255 ? 255 : Math.round(br),
    g: bg < 0 ? 0 : bg > 255 ? 255 : Math.round(bg),
    b: bb < 0 ? 0 : bb > 255 ? 255 : Math.round(bb),
    a: Math.round(ba),
  };
}

/** Composite one layer onto an existing W×H RGBA buffer (in place). */
export function compositeLayerInto(
  target: Uint8ClampedArray,
  W: number,
  H: number,
  layer: Layer,
): void {
  if (!layer.visible || layer.opacity <= 0) return;
  const { width: lw, height: lh, data: src } = layer.pixels;
  const x0 = Math.max(0, layer.x);
  const y0 = Math.max(0, layer.y);
  const x1 = Math.min(W, layer.x + lw);
  const y1 = Math.min(H, layer.y + lh);
  if (x1 <= x0 || y1 <= y0) return;

  const opacity = layer.opacity;
  const mode = layer.blendMode;
  const normal = mode === 'normal';
  const mask = layer.mask?.enabled ? layer.mask : null;

  for (let y = y0; y < y1; y++) {
    const ly = y - layer.y;
    for (let x = x0; x < x1; x++) {
      const lx = x - layer.x;
      const si = (ly * lw + lx) * 4;
      const srcA = src[si + 3];
      if (srcA === 0) continue;
      let as = (srcA / 255) * opacity;
      if (mask) {
        const mi = ly * mask.width + lx;
        if (mi >= mask.data.length) continue;
        as *= mask.data[mi] / 255;
      }
      if (as <= 0) continue;

      const di = (y * W + x) * 4;
      const ab = target[di + 3] / 255;
      const ao = as + ab * (1 - as);
      if (ao <= 0) {
        target[di] = 0;
        target[di + 1] = 0;
        target[di + 2] = 0;
        target[di + 3] = 0;
        continue;
      }

      const sr = src[si];
      const sg = src[si + 1];
      const sb = src[si + 2];
      let or: number;
      let og: number;
      let ob: number;

      if (normal && ab === 0) {
        // No backdrop color contribution — straight copy scaled by alpha.
        or = sr;
        og = sg;
        ob = sb;
      } else {
        const br = target[di];
        const bg = target[di + 1];
        const bb = target[di + 2];
        if (normal) {
          or = (1 - as) * ab * br + as * sr;
          og = (1 - as) * ab * bg + as * sg;
          ob = (1 - as) * ab * bb + as * sb;
        } else {
          const [br2, bg2, bb2] = blendRgb(mode, [br, bg, bb], [sr, sg, sb]);
          or = (1 - as) * ab * br + (1 - ab) * as * sr + as * ab * br2;
          og = (1 - as) * ab * bg + (1 - ab) * as * sg + as * ab * bg2;
          ob = (1 - as) * ab * bb + (1 - ab) * as * sb + as * ab * bb2;
        }
        // Un-premultiply: co above is already the non-premultiplied result
        // scaled by backdrop alpha; normalize by alpha-out.
        or /= ao;
        og /= ao;
        ob /= ao;
      }

      target[di] = or < 0 ? 0 : or > 255 ? 255 : or;
      target[di + 1] = og < 0 ? 0 : og > 255 ? 255 : og;
      target[di + 2] = ob < 0 ? 0 : ob > 255 ? 255 : ob;
      target[di + 3] = ao * 255;
    }
  }
}
