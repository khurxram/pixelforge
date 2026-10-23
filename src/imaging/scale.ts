/**
 * Resampling: coverage-weighted (area) filtering for downscaling with
 * premultiplied alpha, bilinear for sub-pixel ranges. Used by document
 * resize, preview downsampling, and layer transforms.
 */
import type { PixelBuffer } from '../core/document/types';

function bilinearAt(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  fx: number,
  fy: number,
  out: Float64Array,
): void {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(sw - 1, x0 + 1);
  const y1 = Math.min(sh - 1, y0 + 1);
  const cx = fx - x0;
  const cy = fy - y0;
  const xi = Math.min(sw - 1, Math.max(0, x0));
  const yi = Math.min(sh - 1, Math.max(0, y0));

  const p = (x: number, y: number, c: number) => src[(y * sw + x) * 4 + c];
  for (let c = 0; c < 4; c++) {
    const top = p(xi, yi, c) * (1 - cx) + p(x1, yi, c) * cx;
    const bot = p(xi, y1, c) * (1 - cx) + p(x1, y1, c) * cx;
    out[c] = top * (1 - cy) + bot * cy;
  }
}

/** Resize a buffer to `dw`×`dh` (works for both upscale and downscale). */
export function resizeBuffer(buf: PixelBuffer, dw: number, dh: number): PixelBuffer {
  const { width: sw, height: sh, data: src } = buf;
  dw = Math.max(1, Math.round(dw));
  dh = Math.max(1, Math.round(dh));
  if (dw === sw && dh === sh) {
    return { width: sw, height: sh, data: new Uint8ClampedArray(src) };
  }

  const out = new Uint8ClampedArray(dw * dh * 4);
  const sxRatio = sw / dw;
  const syRatio = sh / dh;

  // Accumulate in premultiplied space to avoid halo artifacts.
  const acc = new Float64Array(4);
  const sample = new Float64Array(4);

  for (let oy = 0; oy < dh; oy++) {
    let fy0 = oy * syRatio;
    let fy1 = (oy + 1) * syRatio;
    if (fy1 - fy0 < 1) fy1 = Math.min(sh, fy0 + 1);

    for (let ox = 0; ox < dw; ox++) {
      let fx0 = ox * sxRatio;
      let fx1 = (ox + 1) * sxRatio;
      if (fx1 - fx0 < 1) fx1 = Math.min(sw, fx0 + 1);

      const x0 = Math.floor(fx0);
      const x1 = Math.min(sw, Math.ceil(fx1));
      const y0 = Math.floor(fy0);
      const y1 = Math.min(sh, Math.ceil(fy1));

      acc[0] = 0;
      acc[1] = 0;
      acc[2] = 0;
      acc[3] = 0;
      let totalW = 0;

      for (let sy = y0; sy < y1; sy++) {
        const wy = Math.min(fy1, sy + 1) - Math.max(fy0, sy);
        if (wy <= 0) continue;
        for (let sx = x0; sx < x1; sx++) {
          const wx = Math.min(fx1, sx + 1) - Math.max(fx0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (sy * sw + sx) * 4;
          const a = src[o + 3] / 255;
          acc[0] += src[o] * a * w;
          acc[1] += src[o + 1] * a * w;
          acc[2] += src[o + 2] * a * w;
          acc[3] += src[o + 3] * w;
          totalW += w;
        }
      }

      const d = (oy * dw + ox) * 4;
      if (totalW === 0) {
        // Fully sub-pixel: fall back to bilinear.
        bilinearAt(src, sw, sh, (fx0 + fx1) / 2 - 0.5, (fy0 + fy1) / 2 - 0.5, sample);
        out[d] = sample[0];
        out[d + 1] = sample[1];
        out[d + 2] = sample[2];
        out[d + 3] = sample[3];
        continue;
      }
      const alpha = acc[3] / totalW;
      if (alpha === 0) {
        out[d] = 0;
        out[d + 1] = 0;
        out[d + 2] = 0;
        out[d + 3] = 0;
      } else {
        const scale = 255 / totalW / alpha;
        out[d] = acc[0] * scale;
        out[d + 1] = acc[1] * scale;
        out[d + 2] = acc[2] * scale;
        out[d + 3] = alpha;
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Downscale so the longest side is at most `maxDim` (no-op when already smaller). */
export function downscaleToMax(buf: PixelBuffer, maxDim: number): PixelBuffer {
  const longest = Math.max(buf.width, buf.height);
  if (longest <= maxDim) return buf;
  const k = maxDim / longest;
  return resizeBuffer(buf, buf.width * k, buf.height * k);
}
