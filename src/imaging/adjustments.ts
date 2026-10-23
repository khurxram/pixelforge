/**
 * Tone/color adjustments as pure functions over PixelBuffer.
 *
 * All parameters are UI-normalized:
 *   -100..100 for bipolar controls, 0..100 for amounts, degrees for hue.
 * Alpha is never modified. Each function is deterministic so undo/redo can
 * re-derive results instead of storing duplicate buffers.
 */
import type { PixelBuffer } from '../core/document/types';
import { clamp255, luma } from './color';
import { boxBlur, unsharpMask } from './filters';

export interface AdjustParams {
  /** -100..100, roughly ±2 stops at the extremes. */
  exposure: number;
  /** -100..100. */
  brightness: number;
  /** -100..100. */
  contrast: number;
  /** -100..100, luma-weighted recover/lift of bright regions. */
  highlights: number;
  /** -100..100, luma-weighted recover/lift of dark regions. */
  shadows: number;
  /** -100..100, + = warmer (more red), - = cooler (more blue). */
  temperature: number;
  /** -100..100, + = magenta, - = green. */
  tint: number;
  /** -100..100, -100 = grayscale. */
  saturation: number;
  /** -180..180 degrees. */
  hue: number;
  /** Convert to grayscale. */
  grayscale: boolean;
  /** 0..100. */
  sepia: number;
  /** Blur radius in pixels of the buffer being processed, 0 = off. */
  blurRadius: number;
  /** 0..200, unsharp amount (0 = off). */
  sharpenAmount: number;
  /* ---------------- colour grading: DaVinci-style primaries ----------------
     Three trackball wheels (Lift / Gamma / Gain) plus neutral masters.
     A wheel position (x, y) in -1..1 maps to per-channel amounts using the
     standard colour-wheel arrangement — red right, green up, blue down-left,
     120° apart:
       r = x,  g = -0.5x - 0.866y,  b = -0.5x + 0.866y
     The masters are pure-luma axes the wheels cannot express on their own.
     Every field defaults to 0 = identity. */
  /** Lift wheel X (shadows tint, + = red). -1..1 */
  liftX: number;
  /** Lift wheel Y (shadows tint, + = blue). -1..1 */
  liftY: number;
  /** Lift master: + raises blacks, - crushes them. -100..100 */
  liftM: number;
  /** Gamma wheel X (midtone tint). -1..1 */
  gammaX: number;
  /** Gamma wheel Y (midtone tint, + = blue, and down = darker mids). -1..1 */
  gammaY: number;
  /** Gamma master: + brightens midtones, - darkens them. -100..100 */
  gammaM: number;
  /** Gain wheel X (highlight tint). -1..1 */
  gainX: number;
  /** Gain wheel Y (highlight tint). -1..1 */
  gainY: number;
  /** Gain master: + scales highlights up, - pulls them down. -100..100 */
  gainM: number;
  /* ---------------- advanced grading / stylization ---------------- */
  /** Per-channel tone curves (Photoshop-style). Empty channel = identity. */
  curve: CurveSet;
  /** Threshold: 0 = off, 1..255 = binarize at this luma. */
  threshold: number;
  /** Posterize: 0 = off, 2..64 = tonal levels per channel. */
  posterize: number;
  /** Gradient map preset id ('' = off); maps luminance through a colour ramp. */
  gradientMap: string;
  /** Flip the gradient map ramp (dark → light becomes light → dark). */
  gradientMapReverse: boolean;
  /** Photo filter: '' = off, 'warming' | 'cooling' (capture-style tint). */
  photoFilter: string;
  /** Photo filter strength 1..100 (used only when a filter is on). */
  photoFilterDensity: number;
}

/** One tone-curve control point, normalized 0..1 (x = input, y = output). */
export interface CurvePoint {
  x: number;
  y: number;
}

/** Tone curves for the composite channel and each primary. */
export interface CurveSet {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export const DEFAULT_ADJUSTMENTS: AdjustParams = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  hue: 0,
  grayscale: false,
  sepia: 0,
  blurRadius: 0,
  sharpenAmount: 0,
  liftX: 0,
  liftY: 0,
  liftM: 0,
  gammaX: 0,
  gammaY: 0,
  gammaM: 0,
  gainX: 0,
  gainY: 0,
  gainM: 0,
  curve: { rgb: [], r: [], g: [], b: [] },
  threshold: 0,
  posterize: 0,
  gradientMap: '',
  gradientMapReverse: false,
  photoFilter: '',
  photoFilterDensity: 50,
};

/** True when any channel has at least one curve point. */
export function isCurveActive(c: CurveSet): boolean {
  return c.rgb.length > 0 || c.r.length > 0 || c.g.length > 0 || c.b.length > 0;
}

export function cloneAdjustments(p: AdjustParams): AdjustParams {
  return { ...p };
}

export function isIdentityAdjustment(p: AdjustParams): boolean {
  return (
    p.exposure === 0 &&
    p.brightness === 0 &&
    p.contrast === 0 &&
    p.highlights === 0 &&
    p.shadows === 0 &&
    p.temperature === 0 &&
    p.tint === 0 &&
    p.saturation === 0 &&
    p.hue === 0 &&
    !p.grayscale &&
    p.sepia === 0 &&
    p.blurRadius <= 0 &&
    p.sharpenAmount <= 0 &&
    p.threshold === 0 &&
    p.posterize === 0 &&
    p.gradientMap === '' &&
    p.photoFilter === '' &&
    !isCurveActive(p.curve) &&
    isNeutralGrade(p)
  );
}

/** True when every grading wheel/master sits at its neutral (identity) value. */
export function isNeutralGrade(p: AdjustParams): boolean {
  return (
    p.liftX === 0 &&
    p.liftY === 0 &&
    p.liftM === 0 &&
    p.gammaX === 0 &&
    p.gammaY === 0 &&
    p.gammaM === 0 &&
    p.gainX === 0 &&
    p.gainY === 0 &&
    p.gainM === 0
  );
}

/** Contrast factor: tan curve mapped from -100..100. */
function contrastFactor(v: number): number {
  const c = Math.max(-0.99, Math.min(0.99, v / 100));
  return Math.tan(((c + 1) * Math.PI) / 4);
}

/** Exposure stops: -100 → -2 stops, +100 → +2 stops. */
function exposureFactor(v: number): number {
  return Math.pow(2, (v / 100) * 2);
}

/** Map a colour-wheel offset (x, y) to per-channel R/G/B amounts. */
function wheelToRgb(x: number, y: number): [number, number, number] {
  return [x, -0.5 * x - 0.866 * y, -0.5 * x + 0.866 * y];
}

/**
 * Build the combined lift → gamma → gain transfer curve for one channel as a
 * 256-entry LUT, so the per-pixel grade is a table lookup instead of three
 * pow() calls. Lift preserves white, gamma pins both ends, gain scales.
 */
function buildGradeLut(lift: number, gamma: number, gain: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const invGamma = 1 / gamma;
  for (let v = 0; v < 256; v++) {
    let f = v / 255;
    f += lift * (1 - f);
    if (invGamma !== 1) f = Math.pow(f, invGamma);
    f *= gain;
    lut[v] = clamp255(f * 255);
  }
  return lut;
}

/**
 * Build a 256-entry LUT from tone-curve control points using monotone cubic
 * (PCHIP) interpolation — smooth like Photoshop's curves but without the
 * overshoot ringing a plain spline would introduce. Endpoints are pinned to
 * (0,0) and (1,1) so the black and white points stay put.
 */
export function buildCurveLut(points: CurvePoint[]): Uint8ClampedArray | null {
  if (points.length === 0) return null;
  const pts: CurvePoint[] = [...points].sort((a, b) => a.x - b.x);
  if (pts[0].x > 0) pts.unshift({ x: 0, y: 0 });
  const last = pts[pts.length - 1];
  if (last.x < 1) pts.push({ x: 1, y: 1 });
  const n = pts.length;
  if (n === 1) pts.push({ x: pts[0].x === 0 ? 1 : 0, y: pts[0].y });
  const m = pts.length;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < m - 1; i++) {
    h.push(Math.max(1e-6, pts[i + 1].x - pts[i].x));
    d.push((pts[i + 1].y - pts[i].y) / h[i]);
  }
  const slopes: number[] = new Array(m);
  slopes[0] = d[0];
  slopes[m - 1] = d[m - 2];
  for (let i = 1; i < m - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      slopes[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      slopes[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  const lut = new Uint8ClampedArray(256);
  let seg = 0;
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    while (seg < m - 2 && x > pts[seg + 1].x) seg++;
    const t = Math.min(1, Math.max(0, (x - pts[seg].x) / h[seg]));
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y =
      h00 * pts[seg].y + h10 * h[seg] * slopes[seg] + h01 * pts[seg + 1].y + h11 * h[seg] * slopes[seg + 1];
    lut[v] = clamp255(y * 255);
  }
  return lut;
}

/** Built-in gradient-map ramps (the "gradient LUT gallery"). */
export const GRADIENT_MAPS: Record<string, { name: string; stops: Array<[number, number, number, number]> }> = {
  mono: { name: 'Mono', stops: [[0, 0, 0, 0], [1, 255, 255, 255]] },
  'blue-yellow': {
    name: 'Blue → Yellow',
    stops: [[0, 24, 32, 80], [0.5, 120, 170, 200], [1, 255, 240, 170]],
  },
  sunset: {
    name: 'Sunset',
    stops: [[0, 40, 16, 60], [0.45, 190, 60, 70], [0.8, 255, 170, 90], [1, 255, 245, 220]],
  },
  ocean: {
    name: 'Ocean',
    stops: [[0, 4, 24, 48], [0.5, 30, 120, 170], [1, 200, 240, 255]],
  },
  'sepia-map': {
    name: 'Sepia',
    stops: [[0, 44, 26, 12], [0.5, 150, 112, 72], [1, 252, 235, 210]],
  },
  infrared: {
    name: 'Infrared',
    stops: [[0, 20, 24, 40], [0.5, 190, 110, 200], [1, 255, 250, 255]],
  },
};

/** Build a 256 × RGB lookup ramp from gradient-map stops. */
export function buildGradientLut(stops: Array<[number, number, number, number]>, reverse: boolean): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const sorted = [...stops].sort((a, b) => a[0] - b[0]);
  for (let v = 0; v < 256; v++) {
    const t = reverse ? 1 - v / 255 : v / 255;
    let i = 0;
    while (i < sorted.length - 2 && t > sorted[i + 1][0]) i++;
    const [t0, r0, g0, b0] = sorted[i];
    const [t1, r1, g1, b1] = sorted[i + 1] ?? sorted[i];
    const span = Math.max(1e-6, t1 - t0);
    const f = Math.min(1, Math.max(0, (t - t0) / span));
    lut[v * 3] = Math.round(r0 + (r1 - r0) * f);
    lut[v * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    lut[v * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return lut;
}

/** Capture-style photo-filter tints (multiplied toward at the given density). */
const PHOTO_FILTERS: Record<string, [number, number, number]> = {
  warming: [255, 226, 198],
  cooling: [198, 226, 255],
};

/**
 * Apply all tone/color adjustments (except blur/sharpen) to the RGB channels.
 * Operates in place when `dst === src`.
 */
function applyToneColor(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  p: AdjustParams,
): void {
  const expo = exposureFactor(p.exposure);
  const cf = contrastFactor(p.contrast);
  const bright = p.brightness * 1.275;
  const hl = p.highlights / 100;
  const sh = p.shadows / 100;
  const temp = p.temperature / 100;
  const tint = p.tint / 100;
  const sat = 1 + p.saturation / 100;
  const hueRad = (p.hue * Math.PI) / 180;

  const doTemp = temp !== 0;
  const doTint = tint !== 0;
  const doHue = p.hue !== 0;
  const doSepia = p.sepia > 0;
  const sepiaT = Math.min(1, p.sepia / 100);

  // CSS-filter hue-rotation matrix coefficients (luminance-preserving).
  const cosH = Math.cos(hueRad);
  const sinH = Math.sin(hueRad);

  // Lift/gamma/gain grading wheels → per-channel LUTs (see buildGradeLut).
  let lutR: Uint8ClampedArray | null = null;
  let lutG: Uint8ClampedArray | null = null;
  let lutB: Uint8ClampedArray | null = null;
  if (!isNeutralGrade(p)) {
    const [lr, lg, lb] = wheelToRgb(p.liftX, p.liftY);
    const [gr, gg, gb] = wheelToRgb(p.gammaX, p.gammaY);
    const [ar, ag, ab] = wheelToRgb(p.gainX, p.gainY);
    const m = p.liftM * 0.002; // ±0.2 shadow offset
    const gm = p.gammaM * 0.005; // ±0.5 in log2 space
    const am = p.gainM * 0.004; // ±0.4 in log2 space
    lutR = buildGradeLut(lr * 0.25 + m, Math.pow(2, gr * 0.8 + gm), Math.pow(2, ar * 0.6 + am));
    lutG = buildGradeLut(lg * 0.25 + m, Math.pow(2, gg * 0.8 + gm), Math.pow(2, ag * 0.6 + am));
    lutB = buildGradeLut(lb * 0.25 + m, Math.pow(2, gb * 0.8 + gm), Math.pow(2, ab * 0.6 + am));
  }

  // Tone curves: the master (rgb) curve feeds each channel's own curve.
  const curveRgb = buildCurveLut(p.curve.rgb);
  const curveR = buildCurveLut(p.curve.r);
  const curveG = buildCurveLut(p.curve.g);
  const curveB = buildCurveLut(p.curve.b);
  const doCurves = !!(curveRgb || curveR || curveG || curveB);

  // Gradient map, photo filter, threshold, posterize.
  const gradDef = p.gradientMap ? GRADIENT_MAPS[p.gradientMap] : undefined;
  const gradLut = gradDef ? buildGradientLut(gradDef.stops, p.gradientMapReverse) : null;
  const pfTint = PHOTO_FILTERS[p.photoFilter] ?? null;
  const pfD = Math.min(1, Math.max(0, p.photoFilterDensity / 100));
  const pfR = pfTint ? pfTint[0] / 255 : 0;
  const pfG = pfTint ? pfTint[1] / 255 : 0;
  const pfB = pfTint ? pfTint[2] / 255 : 0;
  const thr = p.threshold > 0 ? p.threshold : -1;
  const post = p.posterize >= 2 ? Math.min(64, Math.round(p.posterize)) : 0;
  /** Index helper: clamp a float to a valid 0..255 LUT slot. */
  const q = (v: number): number => {
    const r = Math.round(v);
    return r < 0 ? 0 : r > 255 ? 255 : r;
  };

  for (let i = 0; i < src.length; i += 4) {
    let r = src[i];
    let g = src[i + 1];
    let b = src[i + 2];
    const a = src[i + 3];
    if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
      continue;
    }

    // 1. Exposure (multiplicative).
    if (p.exposure !== 0) {
      r *= expo;
      g *= expo;
      b *= expo;
    }

    // 2. Highlights / shadows — luma-derived deltas keep hue stable.
    if (hl !== 0 || sh !== 0) {
      const L = luma(r, g, b) / 255;
      const shadowW = (1 - L) * (1 - L);
      const highW = L * L;
      const delta = sh * 110 * shadowW + hl * 110 * highW;
      r += delta;
      g += delta;
      b += delta;
    }

    // 2b. Lift / gamma / gain (DaVinci-style primaries via LUTs).
    if (lutR && lutG && lutB) {
      r = lutR[r < 0 ? 0 : r > 255 ? 255 : r | 0];
      g = lutG[g < 0 ? 0 : g > 255 ? 255 : g | 0];
      b = lutB[b < 0 ? 0 : b > 255 ? 255 : b | 0];
    }

    // 3. White balance (temperature/tint).
    if (doTemp) {
      r *= 1 + 0.25 * temp;
      b *= 1 - 0.25 * temp;
      g *= 1 + 0.03 * temp;
    }
    if (doTint) {
      g *= 1 - 0.2 * tint;
      r *= 1 + 0.05 * tint;
      b *= 1 + 0.05 * tint;
    }

    // 4. Brightness (additive) then contrast (scale around mid gray).
    if (bright !== 0) {
      r += bright;
      g += bright;
      b += bright;
    }
    if (cf !== 1) {
      r = r * cf + 128 * (1 - cf);
      g = g * cf + 128 * (1 - cf);
      b = b * cf + 128 * (1 - cf);
    }

    // 5. Hue rotation around the luminance axis.
    if (doHue) {
      // Standard luminance-preserving hue rotation matrix (same as SVG feColorMatrix hueRotate).
      const a00 = 0.213 + cosH * 0.787 - sinH * 0.213;
      const a01 = 0.715 - cosH * 0.715 - sinH * 0.715;
      const a02 = 0.072 - cosH * 0.072 + sinH * 0.928;
      const a10 = 0.213 - cosH * 0.213 + sinH * 0.143;
      const a11 = 0.715 + cosH * 0.285 + sinH * 0.14;
      const a12 = 0.072 - cosH * 0.072 - sinH * 0.283;
      const a20 = 0.213 - cosH * 0.213 - sinH * 0.787;
      const a21 = 0.715 - cosH * 0.715 + sinH * 0.715;
      const a22 = 0.072 + cosH * 0.928 + sinH * 0.072;
      const nr = a00 * r + a01 * g + a02 * b;
      const ng = a10 * r + a11 * g + a12 * b;
      const nb = a20 * r + a21 * g + a22 * b;
      r = nr;
      g = ng;
      b = nb;
    }

    // 6. Saturation (luma mix).
    if (sat !== 1) {
      const L = luma(r, g, b);
      r = L + (r - L) * sat;
      g = L + (g - L) * sat;
      b = L + (b - L) * sat;
    }

    // 7. Grayscale.
    if (p.grayscale) {
      const L = luma(r, g, b);
      r = L;
      g = L;
      b = L;
    }

    // 8. Sepia tone (matrix mixed by amount).
    if (doSepia) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * sepiaT;
      g += (sg - g) * sepiaT;
      b += (sb - b) * sepiaT;
    }

    // 8b. Photo filter: multiply toward a warming/cooling tint by density.
    if (pfTint) {
      r += (r * pfR - r) * pfD;
      g += (g * pfG - g) * pfD;
      b += (b * pfB - b) * pfD;
    }

    // 9. Tone curves (master LUT feeding each channel's LUT).
    if (doCurves) {
      const map = (v: number, ch: Uint8ClampedArray | null): number => {
        const base = curveRgb ? curveRgb[q(v)] : q(v);
        return ch ? ch[base] : base;
      };
      r = map(r, curveR);
      g = map(g, curveG);
      b = map(b, curveB);
    }

    // 10. Gradient map: luminance drives a colour ramp.
    if (gradLut) {
      const t = q(luma(r, g, b));
      r = gradLut[t * 3];
      g = gradLut[t * 3 + 1];
      b = gradLut[t * 3 + 2];
    }

    // 11. Threshold: binarize at the target luma.
    if (thr > 0) {
      const v = luma(r, g, b) >= thr ? 255 : 0;
      r = v;
      g = v;
      b = v;
    }

    // 12. Posterize: quantize each channel to N tonal levels.
    if (post > 0) {
      const k = (post - 1) / 255;
      r = (Math.round(q(r) * k) / (post - 1)) * 255;
      g = (Math.round(q(g) * k) / (post - 1)) * 255;
      b = (Math.round(q(b) * k) / (post - 1)) * 255;
    }

    dst[i] = clamp255(r);
    dst[i + 1] = clamp255(g);
    dst[i + 2] = clamp255(b);
    dst[i + 3] = a;
  }
}

/**
 * Apply the full adjustment pipeline to a buffer, returning a new buffer.
 * Order: tone/color → blur → sharpen (unsharp mask).
 */
export function applyAdjustments(src: PixelBuffer, p: AdjustParams): PixelBuffer {
  const data = new Uint8ClampedArray(src.data.length);
  applyToneColor(src.data, data, p);
  let buf: PixelBuffer = { width: src.width, height: src.height, data };

  if (p.blurRadius > 0) {
    buf = boxBlur(buf, p.blurRadius);
  }
  if (p.sharpenAmount > 0) {
    buf = unsharpMask(buf, p.sharpenAmount / 100);
  }
  return buf;
}
