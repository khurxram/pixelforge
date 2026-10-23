/**
 * Edge detection primitives for the Magnetic Lasso.
 *
 * Pure, DOM-free, unit tested in Node: a Sobel gradient-magnitude map (the
 * strongest per-channel response, so chromatic boundaries with equal luma
 * still register), plus a search that scores nearby edge candidates by
 * contrast, distance and direction of travel so a traced point holds the
 * contour it is following. No ML involved — classic per-pixel convolution only.
 */
import type { PixelBuffer } from '../core/document/types';

/**
 * Sobel gradient magnitude, normalized so a full step edge in any channel
 * reads ≈ that channel's delta (a black↔white step ≈ 255). The per-channel
 * responses take the maximum, so a saturated red/green boundary — which has
 * near-identical luminance — is still a strong edge. Border pixels stay 0.
 */
export function gradientMagnitude(pixels: PixelBuffer): Float32Array {
  const W = pixels.width;
  const H = pixels.height;
  const data = pixels.data;
  const out = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const o = i * 4;
      const ul = o - W * 4 - 4;
      const uc = o - W * 4;
      const ur = o - W * 4 + 4;
      const ml = o - 4;
      const mr = o + 4;
      const bl = o + W * 4 - 4;
      const bc = o + W * 4;
      const br = o + W * 4 + 4;
      let m = 0;
      for (let c = 0; c < 3; c++) {
        const gx = data[ur + c] + 2 * data[mr + c] + data[br + c] - (data[ul + c] + 2 * data[ml + c] + data[bl + c]);
        const gy = data[bl + c] + 2 * data[bc + c] + data[br + c] - (data[ul + c] + 2 * data[uc + c] + data[ur + c]);
        const sq = (gx * gx + gy * gy) * 0.0625; // (hypot / 4)²
        if (sq > m) m = sq;
      }
      out[i] = Math.sqrt(m);
    }
  }
  return out;
}

/**
 * Snap (x, y) onto a nearby edge and return the snapped integer position, or
 * null when the window holds no edge at all (the caller then falls back to
 * the raw pointer).
 *
 * Candidates are scored, not simply ranked by contrast:
 *
 *     score = contrast × distanceFalloff × directionContinuity
 *
 * "Strongest response wins" is what made the tool lurch off the contour it
 * was tracing the moment a busier edge — a doorway, a horizon, sensor
 * texture — entered the search window. Two terms correct that:
 *
 * - **distance** falls off linearly across `radius`, so an edge sitting under
 *   the cursor outranks a much stronger one grazing the far edge of the
 *   window. At the default width of 22 px the falloff is ~23:1 from centre to
 *   rim, i.e. a rim edge has to be over twenty times stronger to win;
 * - **direction** compares the candidate against the direction of travel from
 *   `prev` to (x, y). Carrying on scores 1, right angles ~0.65, backtracking
 *   ~0.05, so the trace follows a contour around corners instead of doubling
 *   back onto a neighbouring edge at equal contrast.
 *
 * `threshold` is the contrast the user asked for (Options-bar Contrast).
 * Candidates may drop to 45% of it: real photographic edges rarely carry
 * black↔white step contrast, and refusing to snap below the full threshold
 * is what silently degraded the tool into a plain lasso on photographs.
 *
 * @param prev Previous anchor in buffer space, or null for the first point.
 */
export function snapToEdge(
  map: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  threshold: number,
  prev: { x: number; y: number } | null = null,
): { x: number; y: number } | null {
  const r = Math.max(1, Math.round(radius));
  const cx = Math.round(x);
  const cy = Math.round(y);
  const x0 = Math.max(1, cx - r);
  const y0 = Math.max(1, cy - r);
  const x1 = Math.min(width - 2, cx + r);
  const y1 = Math.min(height - 2, cy + r);

  // Direction of travel: previous anchor -> the raw pointer. Only used when
  // the two are far enough apart to say anything (a first click, or a
  // micro-movement, carries no heading).
  let dirX = 0;
  let dirY = 0;
  const hasDir = (() => {
    if (!prev) return false;
    const dx = cx - prev.x;
    const dy = cy - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1.5) return false;
    dirX = dx / len;
    dirY = dy / len;
    return true;
  })();

  const minMag = Math.max(threshold * 0.45, 6);
  const span = r + 1;
  let bestScore = 0;
  let bestX = -1;
  let bestY = -1;

  for (let by = y0; by <= y1; by++) {
    for (let bx = x0; bx <= x1; bx++) {
      const mag = map[by * width + bx];
      if (mag < minMag) continue;

      const dx = bx - cx;
      const dy = by - cy;
      const wDist = (span - Math.hypot(dx, dy)) / span;
      if (wDist <= 0) continue;

      let wDir = 1;
      if (hasDir) {
        const vx = bx - (prev as { x: number; y: number }).x;
        const vy = by - (prev as { x: number; y: number }).y;
        const vlen = Math.hypot(vx, vy);
        if (vlen >= 0.5) {
          // exp(-(1-cosθ)·k): 1 when carrying on, 0.65 at 45°, 0.22 at a
          // right angle, ~0.05 for a full reversal. At a genuine corner every
          // candidate turns together, so the relative ranking still lets the
          // trace turn — it only stops one stray candidate winning outright.
          const cos = (vx / vlen) * dirX + (vy / vlen) * dirY;
          wDir = Math.max(0.05, Math.exp(-(1 - cos) * 1.5));
        }
      }

      const score = mag * wDist * wDir;
      if (score > bestScore) {
        bestScore = score;
        bestX = bx;
        bestY = by;
      }
    }
  }
  if (bestX < 0) return null;
  return { x: bestX, y: bestY };
}
