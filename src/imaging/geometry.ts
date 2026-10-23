/**
 * Pixel-buffer geometry: crop, flip, 90°/180° rotation.
 * All pure and DOM-free; document-level variants live in core/document/transforms.ts.
 */
import type { PixelBuffer, Rect } from '../core/document/types';

/** Extract a sub-rectangle (clamped to the source). */
export function cropBuffer(buf: PixelBuffer, rect: Rect): PixelBuffer {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(buf.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(buf.height, Math.round(rect.y + rect.height));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * buf.width + x0) * 4;
    out.set(buf.data.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

export function flipHorizontal(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = (y * w + (w - 1 - x)) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

export function flipVertical(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const out = new Uint8ClampedArray(src.length);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const s = y * rowBytes;
    const d = (h - 1 - y) * rowBytes;
    out.set(src.subarray(s, s + rowBytes), d);
  }
  return { width: w, height: h, data: out };
}

/** Rotate 90° clockwise: (x,y) → (h-1-y, x). */
export function rotate90cw(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = (x * h + (h - 1 - y)) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return { width: h, height: w, data: out };
}

/** Rotate 90° counter-clockwise: (x,y) → (y, w-1-x). */
export function rotate90ccw(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((w - 1 - x) * h + y) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return { width: h, height: w, data: out };
}

export function rotate180(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const out = new Uint8ClampedArray(src.length);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const s = i * 4;
    const d = (n - 1 - i) * 4;
    out[d] = src[s];
    out[d + 1] = src[s + 1];
    out[d + 2] = src[s + 2];
    out[d + 3] = src[s + 3];
  }
  return { width: w, height: h, data: out };
}

/* ------------------------------ affine warp ------------------------------ */

/** Canvas2D-order affine matrix [a, b, c, d, e, f]:
 *  x' = a·x + c·y + e,  y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

export function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) return IDENTITY_MATRIX;
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

/** Multiply matrices: `mul(A, B)` applies B first, then A. */
export function mulMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function translateMatrix(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function rotateMatrix(rad: number): Matrix {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

export function scaleMatrix(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

/**
 * Warp a buffer through an affine matrix using premultiplied bilinear
 * sampling (no dark halos on transparent edges). Returns the resampled
 * buffer plus the document-space offset of its top-left corner — the
 * bounding box of the transformed corners.
 */
export function warpBuffer(
  buf: PixelBuffer,
  m: Matrix,
): { pixels: PixelBuffer; x: number; y: number } {
  const W = buf.width;
  const H = buf.height;
  const c0 = applyMatrix(m, 0, 0);
  const c1 = applyMatrix(m, W, 0);
  const c2 = applyMatrix(m, W, H);
  const c3 = applyMatrix(m, 0, H);
  const minX = Math.floor(Math.min(c0.x, c1.x, c2.x, c3.x));
  const minY = Math.floor(Math.min(c0.y, c1.y, c2.y, c3.y));
  const maxX = Math.ceil(Math.max(c0.x, c1.x, c2.x, c3.x));
  const maxY = Math.ceil(Math.max(c0.y, c1.y, c2.y, c3.y));
  const outW = Math.max(1, maxX - minX);
  const outH = Math.max(1, maxY - minY);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const src = buf.data;
  // Fast path: identity (or integer translation) copies exactly — no blur.
  if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
    const tx = Math.round(m[4]);
    const ty = Math.round(m[5]);
    if (Math.abs(m[4] - tx) < 1e-9 && Math.abs(m[5] - ty) < 1e-9) {
      return { pixels: { width: W, height: H, data: new Uint8ClampedArray(src) }, x: tx, y: ty };
    }
  }
  const inv = invertMatrix(m);
  // Bilinear bilinear weights (tap weights sum to 1 only where all 4 taps are
  // in-bounds). We renormalize by the *geometric* weight so an opaque source
  // stays opaque; colour is normalized by accumulated alpha to avoid halos.
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      // Map the output pixel centre back into source pixel-centre space. The
      // matrix maps document (boundary) coordinates, where pixel k's centre is
      // k + 0.5, so we shift the result back by 0.5 to land on source centres.
      const px = inv[0] * (minX + x + 0.5) + inv[2] * (minY + y + 0.5) + inv[4] - 0.5;
      const py = inv[1] * (minX + x + 0.5) + inv[3] * (minY + y + 0.5) + inv[5] - 0.5;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      let accA = 0;
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let wsum = 0; // total geometric weight of in-bounds taps
      for (let j = 0; j <= 1; j++) {
        const sy = y0 + j;
        if (sy < 0 || sy >= H) continue;
        const wy = j === 0 ? 1 - fy : fy;
        for (let i = 0; i <= 1; i++) {
          const sx = x0 + i;
          if (sx < 0 || sx >= W) continue;
          const w = (i === 0 ? 1 - fx : fx) * wy;
          const o = (sy * W + sx) * 4;
          const a = (src[o + 3] * w) / 255;
          accR += src[o] * a;
          accG += src[o + 1] * a;
          accB += src[o + 2] * a;
          accA += a;
          wsum += w;
        }
      }
      const d = (y * outW + x) * 4;
      if (accA > 0 && wsum > 0) {
        // Premultiplied colour normalized by coverage keeps hues halo-free;
        // alpha is coverage × average source opacity (opaque in → opaque out).
        out[d] = accR / accA;
        out[d + 1] = accG / accA;
        out[d + 2] = accB / accA;
        out[d + 3] = (accA / wsum) * 255;
      }
    }
  }
  return { pixels: { width: outW, height: outH, data: out }, x: minX, y: minY };
}
