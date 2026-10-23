import { describe, expect, it } from 'vitest';
import { gradientMagnitude, snapToEdge } from './edges';
import type { PixelBuffer } from '../core/document/types';

function buffer(w: number, h: number, fill: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { width: w, height: h, data };
}

/** Left half black, right half white — a full-contrast vertical step edge. */
function stepEdge(): PixelBuffer {
  const px = buffer(16, 16, [255, 255, 255, 255]);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 8; x++) {
      const o = (y * 16 + x) * 4;
      px.data[o] = 0;
      px.data[o + 1] = 0;
      px.data[o + 2] = 0;
    }
  }
  return px;
}

describe('gradientMagnitude', () => {
  it('reads ~0 across a flat field', () => {
    const map = gradientMagnitude(buffer(8, 8, [120, 40, 200, 255]));
    for (const v of map) expect(v).toBeLessThan(0.5);
  });

  it('normalizes a black↔white step edge to ≈255', () => {
    const map = gradientMagnitude(stepEdge());
    // Columns 7 and 8 straddle the boundary.
    expect(map[8 * 16 + 7]).toBeGreaterThan(200);
    expect(map[8 * 16 + 8]).toBeGreaterThan(200);
    expect(map[8 * 16 + 2]).toBeLessThan(1); // far from the edge
    expect(map[0]).toBe(0); // borders have no neighborhood
  });

  it('detects a saturated color boundary that shares luminance', () => {
    // (255,0,0) and (0,130,0) both read ≈76 luma — a luma-only Sobel sees
    // nothing here, which is why the magnetic lasso ignored real object
    // edges. The per-channel response catches the red channel's 255 step.
    const px = buffer(16, 16, [0, 130, 0, 255]);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 8; x++) {
        const o = (y * 16 + x) * 4;
        px.data[o] = 255;
        px.data[o + 1] = 0;
        px.data[o + 2] = 0;
      }
    }
    const map = gradientMagnitude(px);
    expect(map[8 * 16 + 7]).toBeGreaterThan(200);
    expect(map[8 * 16 + 2]).toBeLessThan(1);
  });
});

/** Build a gradient map directly, so a test can place edges at exact spots. */
function mapOf(width: number, height: number, peaks: Array<[number, number, number]>): Float32Array {
  const m = new Float32Array(width * height);
  for (const [x, y, v] of peaks) m[y * width + x] = v;
  return m;
}

describe('snapToEdge', () => {
  it('snaps a point onto the edge it is standing on', () => {
    const map = gradientMagnitude(stepEdge());
    const snapped = snapToEdge(map, 16, 16, 6, 8, 4, 100);
    expect(snapped).not.toBeNull();
    expect([7, 8]).toContain(snapped!.x);
    expect(snapped!.y).toBe(8);
  });

  it('returns null when nothing meets the threshold', () => {
    const map = gradientMagnitude(buffer(8, 8, [120, 120, 120, 255]));
    expect(snapToEdge(map, 8, 8, 4, 4, 3, 50)).toBeNull();
  });

  it('stays inside the search radius', () => {
    const map = gradientMagnitude(stepEdge());
    // Centre 4 px away from the edge columns — outside a 2 px radius.
    expect(snapToEdge(map, 16, 16, 3, 8, 2, 100)).toBeNull();
    expect(snapToEdge(map, 16, 16, 3, 8, 5, 100)).not.toBeNull();
  });

  it('prefers a nearby edge over a much stronger distant one', () => {
    // The bug that made the tool lurch off the contour: a busy background edge
    // three times as strong, but 16 px away, beat the edge under the cursor.
    const map = mapOf(
      40,
      32,
      [
        [12, 16, 100],
        [26, 16, 300],
      ],
    );
    const snapped = snapToEdge(map, 40, 32, 10, 16, 20, 50, { x: 8, y: 16 });
    expect(snapped).toMatchObject({ x: 12, y: 16 });
  });

  it('keeps following the direction of travel instead of a sideways edge', () => {
    // Equal contrast, equal distance from the pointer: the one carrying the
    // trace onward (to the right) must win over the one off to the side,
    // which is also the one that happens to be scanned first.
    const map = mapOf(
      32,
      32,
      [
        [10, 15, 200],
        [15, 20, 200],
      ],
    );
    const snapped = snapToEdge(map, 32, 32, 10, 20, 8, 50, { x: 5, y: 20 });
    expect(snapped).toMatchObject({ x: 15, y: 20 });
  });

  it('refuses to double the trace back onto an edge behind it', () => {
    // Tracing leftwards past x=13. An edge 200-strong sits behind the pointer;
    // the edge actually being followed is only 60. Distance alone would pick
    // the strong one — the direction term is what keeps the trace on course.
    const map = mapOf(
      32,
      32,
      [
        [6, 10, 60],
        [15, 10, 200],
      ],
    );
    const snapped = snapToEdge(map, 32, 32, 10, 10, 8, 50, { x: 13, y: 10 });
    expect(snapped).toMatchObject({ x: 6, y: 10 });
  });

  it('falls back to a weak edge rather than refusing to snap on a photo', () => {
    // Photographic edges rarely reach the contrast of a black↔white step;
    // refusing to snap below the full threshold degraded the tool to a plain
    // lasso. Half the threshold still counts, a quarter does not.
    const weak = mapOf(16, 16, [[8, 8, 50]]);
    expect(snapToEdge(weak, 16, 16, 8, 8, 4, 100)).toMatchObject({ x: 8, y: 8 });
    const noisier = mapOf(16, 16, [[8, 8, 30]]);
    expect(snapToEdge(noisier, 16, 16, 8, 8, 4, 100)).toBeNull();
  });
});
