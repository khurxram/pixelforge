import { describe, expect, it } from 'vitest';
import { traceContours } from './contour';

/** width × height mask; `set` lists selected pixels as [x, y] pairs. */
function maskOf(width: number, height: number, set: Array<[number, number]>): Uint8Array {
  const m = new Uint8Array(width * height);
  for (const [x, y] of set) m[y * width + x] = 255;
  return m;
}

/** Fill a rectangle (inclusive) into a list of selected [x, y] pairs. */
function rect(x0: number, y0: number, x1: number, y1: number) {
  const pts: Array<[number, number]> = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pts.push([x, y]);
  return pts;
}

function bbox(loop: Float32Array) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < loop.length; i += 2) {
    minX = Math.min(minX, loop[i]);
    maxX = Math.max(maxX, loop[i]);
    minY = Math.min(minY, loop[i + 1]);
    maxY = Math.max(maxY, loop[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

/** Signed area (shoelace). Its sign encodes the winding the tracer guarantees. */
function area(loop: Float32Array): number {
  let s = 0;
  for (let i = 0; i < loop.length; i += 2) {
    const j = (i + 2) % loop.length;
    s += loop[i] * loop[j + 1] - loop[j] * loop[i + 1];
  }
  return s * 0.5;
}

describe('traceContours', () => {
  it('traces a lone pixel as a closed 4-point diamond around its centre', () => {
    const m = maskOf(5, 5, [[2, 2]]);
    const loops = traceContours(m, 5, 5);
    expect(loops).toHaveLength(1);
    expect(loops[0].length).toBe(8); // 4 vertices × xy
    for (let i = 0; i < loops[0].length; i += 2) {
      // Each vertex is one of the four edge midpoints hugging the pixel: it
      // sits half a pixel off the centre on one axis and exactly on it for the
      // other, e.g. (2, 1.5) or (2.5, 2).
      const dx = Math.abs(loops[0][i] - 2);
      const dy = Math.abs(loops[0][i + 1] - 2);
      expect(Math.min(dx, dy)).toBeCloseTo(0, 5); // exactly on the centre line
      expect(Math.max(dx, dy)).toBeCloseTo(0.5, 5); // and half a pixel off it
    }
    // A diamond with both diagonals of length 1.
    expect(Math.abs(area(loops[0]))).toBeCloseTo(0.5, 5);
  });

  it('closes a single loop around a block, chamfering its corners', () => {
    const m = maskOf(7, 7, rect(1, 1, 2, 2));
    const loops = traceContours(m, 7, 7);
    expect(loops).toHaveLength(1);
    // 4 straight runs + 4 half-pixel corner chamfers.
    expect(loops[0].length).toBe(16);
    const b = bbox(loops[0]);
    expect(b.minX).toBe(0.5);
    expect(b.maxX).toBe(2.5);
    expect(b.minY).toBe(0.5);
    expect(b.maxY).toBe(2.5);
  });

  it('keeps every vertex within a pixel of its neighbour (chain never breaks)', () => {
    // An L-shaped blob: several straight runs and two reflex corners.
    const pts = [...rect(1, 1, 5, 3), ...rect(1, 4, 2, 7)];
    const loops = traceContours(maskOf(9, 9, pts), 9, 9);
    expect(loops).toHaveLength(1);
    const l = loops[0];
    for (let i = 0; i < l.length; i += 2) {
      const j = (i + 2) % l.length;
      const d = Math.hypot(l[j] - l[i], l[j + 1] - l[i + 1]);
      expect(d).toBeLessThanOrEqual(Math.SQRT2);
    }
  });

  it('separates a hole into its own contour', () => {
    const inHole = new Set(rect(2, 2, 4, 4).map(([x, y]) => `${x},${y}`));
    const ring = rect(1, 1, 5, 5).filter(([x, y]) => !inHole.has(`${x},${y}`));
    const loops = traceContours(maskOf(7, 7, ring), 7, 7);
    expect(loops).toHaveLength(2);
    const boxes = loops.map(bbox).sort((a, b) => a.minX - b.minX);
    expect(boxes[0]).toMatchObject({ minX: 0.5, maxX: 5.5, minY: 0.5, maxY: 5.5 }); // outer
    expect(boxes[1]).toMatchObject({ minX: 1.5, maxX: 4.5, minY: 1.5, maxY: 4.5 }); // hole
    // Orientation is guaranteed (selected region on the right), so an outer
    // ring and the hole it encloses necessarily wind against each other.
    expect(Math.sign(area(loops[0]))).toBe(-Math.sign(area(loops[1])));
  });

  it('keeps two diagonally touching pixels as two separate loops', () => {
    const m = maskOf(5, 5, [
      [1, 1],
      [2, 2],
    ]);
    const loops = traceContours(m, 5, 5);
    expect(loops).toHaveLength(2);
    for (const l of loops) expect(l.length).toBe(8);
  });

  it('closes along the image edge for a selection that fills the frame', () => {
    const m = maskOf(4, 4, rect(0, 0, 3, 3));
    const loops = traceContours(m, 4, 4);
    expect(loops).toHaveLength(1);
    // 3 runs per side + 4 chamfered corners = 16 vertices.
    expect(loops[0].length).toBe(32);
    const b = bbox(loops[0]);
    expect(b.minX).toBe(-0.5);
    expect(b.maxX).toBe(3.5);
    expect(b.minY).toBe(-0.5);
    expect(b.maxY).toBe(3.5);
  });

  it('returns nothing for an empty or degenerate mask', () => {
    expect(traceContours(new Uint8Array(16), 4, 4)).toHaveLength(0);
    expect(traceContours(new Uint8Array(0), 0, 0)).toHaveLength(0);
    expect(traceContours(new Uint8Array([255]), 1, 1)).toHaveLength(1);
  });
});
