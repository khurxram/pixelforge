/**
 * One-click auto corrections (Auto Tone / Auto Contrast / Auto Color),
 * computed from channel histograms with a 0.5 % clipped black/white point —
 * the same idea the classic desktop editors use.
 *
 * All functions mutate in place and honor the active selection: statistics
 * are gathered from selected pixels only, and pixels blend toward the
 * corrected value proportionally to their selection coverage.
 */
import type { PixelBuffer } from '../core/document/types';
import { selectionAlpha, type Selection } from '../core/document/selection';
import { luma } from './color';

export interface AutoContext {
  selection: Selection | null;
  origin: { x: number; y: number };
}

const NO_CTX: AutoContext = { selection: null, origin: { x: 0, y: 0 } };

function gateAt(ctx: AutoContext, bx: number, by: number): number {
  if (!ctx.selection) return 255;
  return selectionAlpha(ctx.selection, bx + ctx.origin.x, by + ctx.origin.y);
}

/** 0.5 % clipped black/white points from a 256-bin histogram. */
function clipPoints(hist: Uint32Array): { lo: number; hi: number } {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  if (total === 0) return { lo: 0, hi: 255 };
  const tail = total * 0.005;
  let lo = 0;
  let acc = 0;
  while (lo < 255 && acc < tail) acc += hist[lo++];
  let hi = 255;
  acc = 0;
  while (hi > lo && acc < tail) acc += hist[hi--];
  if (hi - lo < 8) return { lo: 0, hi: 255 };
  return { lo, hi };
}

function stretch(v: number, lo: number, hi: number): number {
  return ((v - lo) * 255) / (hi - lo);
}

/** Auto Tone: independent black/white point stretch per channel (cast removal). */
export function autoTone(pixels: PixelBuffer, ctx: AutoContext = NO_CTX): void {
  const { data, width, height } = pixels;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gateAt(ctx, x, y) === 0) continue;
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      hist[0][data[i]]++;
      hist[1][data[i + 1]]++;
      hist[2][data[i + 2]]++;
    }
  }
  const pts = hist.map(clipPoints);
  applyStretch(pixels, ctx, pts[0], pts[1], pts[2]);
}

/** Auto Contrast: one luma-derived stretch applied to every channel,
 *  preserving the colour ratios (contrast without a cast shift). */
export function autoContrast(pixels: PixelBuffer, ctx: AutoContext = NO_CTX): void {
  const { data, width, height } = pixels;
  const hist = new Uint32Array(256);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gateAt(ctx, x, y) === 0) continue;
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      hist[q(luma(data[i], data[i + 1], data[i + 2]))]++;
    }
  }
  const { lo, hi } = clipPoints(hist);
  const same = { lo, hi };
  applyStretch(pixels, ctx, same, same, same);
}

/** Auto Color: per-channel stretch followed by a mid-tone neutralize so the
 *  average of each channel lands on mid grey (128). */
export function autoColor(pixels: PixelBuffer, ctx: AutoContext = NO_CTX): void {
  const { data, width, height } = pixels;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gateAt(ctx, x, y) === 0) continue;
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        hist[c][v]++;
        sums[c] += v;
        counts[c]++;
      }
    }
  }
  const pts = hist.map(clipPoints);
  applyStretch(pixels, ctx, pts[0], pts[1], pts[2]);
  // Neutralize midtones: scale each channel so its mean lands on 128.
  for (let c = 0; c < 3; c++) {
    const mean = counts[c] ? sums[c] / counts[c] : 128;
    const gain = mean > 8 ? Math.min(2.5, Math.max(0.4, 128 / mean)) : 1;
    if (gain === 1) continue;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const g = gateAt(ctx, x, y);
        if (g === 0) continue;
        const i = (y * width + x) * 4;
        if (data[i + 3] === 0) continue;
        const t = g / 255;
        const v = data[i + c];
        data[i + c] = v + (Math.min(255, v * gain) - v) * t;
      }
    }
  }
}

function applyStretch(
  pixels: PixelBuffer,
  ctx: AutoContext,
  pr: { lo: number; hi: number },
  pg: { lo: number; hi: number },
  pb: { lo: number; hi: number },
): void {
  const { data, width, height } = pixels;
  const chans = [pr, pg, pb];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = gateAt(ctx, x, y);
      if (g === 0) continue;
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const t = g / 255;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        const target = stretch(v, chans[c].lo, chans[c].hi);
        // Blend toward the corrected value so feathered edges stay soft.
        const clamped = target < 0 ? 0 : target > 255 ? 255 : target;
        data[i + c] = v + (clamped - v) * t;
      }
    }
  }
}

/** Local int-index helper (kept here to avoid exporting paint internals). */
function q(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
