/**
 * Convolution-style filters: box blur (separable, alpha-premultiplied to avoid
 * dark fringes) and unsharp masking. Pure functions, worker-safe.
 */
import type { PixelBuffer } from '../core/document/types';
import { clamp255 } from './color';

function premultiply(data: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = data[i] * a;
    out[i + 1] = data[i + 1] * a;
    out[i + 2] = data[i + 2] * a;
    out[i + 3] = data[i + 3];
  }
  return out;
}

function unpremultiply(src: Float32Array, dst: Uint8ClampedArray): void {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
      continue;
    }
    const inv = 255 / a;
    dst[i] = clamp255(src[i] * inv);
    dst[i + 1] = clamp255(src[i + 1] * inv);
    dst[i + 2] = clamp255(src[i + 2] * inv);
    dst[i + 3] = clamp255(a);
  }
}

/**
 * Separable box blur with edge clamping, run `passes` times (3 passes ≈ Gaussian).
 * Works on premultiplied colors so transparent pixels cannot bleed dark hues.
 */
export function boxBlur(buf: PixelBuffer, radius: number, passes = 3): PixelBuffer {
  const r = Math.max(1, Math.round(radius));
  const { width, height } = buf;

  const pm = premultiply(buf.data);
  let cur = pm;
  const tmp = new Float32Array(pm.length);
  const outPm = new Float32Array(pm.length);

  for (let pass = 0; pass < passes; pass++) {
    // Horizontal on premultiplied float data by converting to a byte-like view:
    // blurAxis works on Uint8ClampedArray, so blur in two byte stages would
    // quantize; instead do direct float sliding windows here.
    boxBlurFloat(cur, tmp, width, height, r, true);
    boxBlurFloat(tmp, outPm, width, height, r, false);
    cur = outPm;
  }

  const data = new Uint8ClampedArray(buf.data.length);
  unpremultiply(cur, data);
  return { width, height, data };
}

function boxBlurFloat(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const lineCount = horizontal ? height : width;
  const lineLen = horizontal ? width : height;
  const window = radius * 2 + 1;
  const idx = (line: number, pos: number) =>
    (horizontal ? line * width + pos : pos * width + line) * 4;

  for (let line = 0; line < lineCount; line++) {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let k = -radius; k <= radius; k++) {
      const p = Math.min(lineLen - 1, Math.max(0, k));
      const o = idx(line, p);
      s0 += src[o];
      s1 += src[o + 1];
      s2 += src[o + 2];
      s3 += src[o + 3];
    }
    for (let pos = 0; pos < lineLen; pos++) {
      const o = idx(line, pos);
      dst[o] = s0 / window;
      dst[o + 1] = s1 / window;
      dst[o + 2] = s2 / window;
      dst[o + 3] = s3 / window;

      const addPos = Math.min(lineLen - 1, pos + radius + 1);
      const subPos = Math.max(0, pos - radius);
      const addO = idx(line, addPos);
      const subO = idx(line, subPos);
      s0 += src[addO] - src[subO];
      s1 += src[addO + 1] - src[subO + 1];
      s2 += src[addO + 2] - src[subO + 2];
      s3 += src[addO + 3] - src[subO + 3];
    }
  }
}

/**
 * Unsharp mask: `src + amount * (src - blur(src))` on RGB only.
 * Alpha is preserved so edges of transparent layers stay crisp.
 */
export function unsharpMask(buf: PixelBuffer, amount: number, radius = 1): PixelBuffer {
  if (amount <= 0) return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
  const blurred = boxBlur(buf, radius, 2);
  const src = buf.data;
  const bl = blurred.data;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = clamp255(src[i] + amount * (src[i] - bl[i]));
    out[i + 1] = clamp255(src[i + 1] + amount * (src[i + 1] - bl[i + 1]));
    out[i + 2] = clamp255(src[i + 2] + amount * (src[i + 2] - bl[i + 2]));
    out[i + 3] = src[i + 3];
  }
  return { width: buf.width, height: buf.height, data: out };
}
