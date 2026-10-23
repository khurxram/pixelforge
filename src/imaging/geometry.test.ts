import { describe, expect, it } from 'vitest';
import type { PixelBuffer } from '../core/document/types';
import { cropBuffer, flipHorizontal, flipVertical, rotate180, rotate90ccw, rotate90cw, warpBuffer } from './geometry';

/** Build a buffer whose red channel encodes row-major values 1..n. */
function numbered(width: number, height: number): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i + 1;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function reds(b: PixelBuffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.width * b.height; i++) out.push(b.data[i * 4]);
  return out;
}

describe('geometry', () => {
  it('cropBuffer extracts the requested sub-rectangle', () => {
    const src = numbered(4, 4); // values 1..16
    const out = cropBuffer(src, { x: 1, y: 1, width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(reds(out)).toEqual([6, 7, 10, 11]);
  });

  it('cropBuffer clamps to source bounds', () => {
    const src = numbered(3, 3);
    const out = cropBuffer(src, { x: 2, y: 2, width: 5, height: 5 });
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(reds(out)).toEqual([9]);
  });

  it('flipHorizontal mirrors each row', () => {
    const out = flipHorizontal(numbered(3, 2));
    expect(reds(out)).toEqual([3, 2, 1, 6, 5, 4]);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
  });

  it('flipVertical mirrors the row order', () => {
    const out = flipVertical(numbered(3, 2));
    expect(reds(out)).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it('rotate90cw maps (x,y) → (h-1-y, x) and swaps dimensions', () => {
    // 2×3:  1 2 / 3 4 / 5 6   →   5 3 1 / 6 4 2   (3 wide, 2 tall)
    const out = rotate90cw(numbered(2, 3));
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(reds(out)).toEqual([5, 3, 1, 6, 4, 2]);
  });

  it('rotate90ccw maps (x,y) → (y, w-1-x)', () => {
    // 2×3 → 2 4 6 / 1 3 5
    const out = rotate90ccw(numbered(2, 3));
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(reds(out)).toEqual([2, 4, 6, 1, 3, 5]);
  });

  it('four clockwise rotations equal identity', () => {
    const src = numbered(4, 3);
    let cur = src;
    for (let i = 0; i < 4; i++) cur = rotate90cw(cur);
    expect(cur.width).toBe(4);
    expect(cur.height).toBe(3);
    expect(reds(cur)).toEqual(reds(src));
  });

  it('cw then ccw equals identity', () => {
    const src = numbered(5, 2);
    expect(reds(rotate90ccw(rotate90cw(src)))).toEqual(reds(src));
  });

  it('rotate180 equals two clockwise rotations', () => {
    const src = numbered(3, 4);
    expect(reds(rotate180(src))).toEqual(reds(rotate90cw(rotate90cw(src))));
  });
});

describe('warpBuffer', () => {
  it('copies exactly on identity and integer translation', () => {
    const src = numbered(2, 2);
    const id = warpBuffer(src, [1, 0, 0, 1, 0, 0]);
    expect(id.x).toBe(0);
    expect(id.y).toBe(0);
    expect(reds(id.pixels)).toEqual([1, 2, 3, 4]);
    const moved = warpBuffer(src, [1, 0, 0, 1, 3, -2]);
    expect(moved.x).toBe(3);
    expect(moved.y).toBe(-2);
    expect(reds(moved.pixels)).toEqual([1, 2, 3, 4]);
  });

  it('scales 2x and offsets to the transformed bounding box', () => {
    // Use a genuinely constant buffer so bilinear sampling must reproduce it.
    const src: PixelBuffer = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    for (let i = 0; i < 4; i++) {
      src.data[i * 4] = 200;
      src.data[i * 4 + 1] = 120;
      src.data[i * 4 + 2] = 60;
      src.data[i * 4 + 3] = 255;
    }
    const out = warpBuffer(src, [2, 0, 0, 2, 0, 0]);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.pixels.width).toBe(4);
    expect(out.pixels.height).toBe(4);
    // A constant region stays constant under bilinear resampling.
    expect(out.pixels.data[0]).toBe(200);
    expect(out.pixels.data[1]).toBe(120);
    expect(out.pixels.data[2]).toBe(60);
    expect(out.pixels.data[15 * 4]).toBe(200);
    expect(out.pixels.data[15 * 4 + 3]).toBe(255);
  });

  it('maps corners correctly under a 90 degree rotation', () => {
    const src = numbered(2, 1); // pixels: 1 2
    // Canvas-order 90� CW: x' = -y, y' = x.
    const out = warpBuffer(src, [0, 1, -1, 0, 0, 0]);
    // Bounding box of the rotated corners: 1 wide, 2 tall at x = -1.
    expect(out.x).toBe(-1);
    expect(out.y).toBe(0);
    expect(out.pixels.width).toBe(1);
    expect(out.pixels.height).toBe(2);
    // The original row now reads downward: [1, 2].
    expect(reds(out.pixels)).toEqual([1, 2]);
  });

  it('keeps transparent regions empty (premultiplied sampling, no halos)', () => {
    const src: PixelBuffer = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]) };
    const out = warpBuffer(src, [3, 0, 0, 3, 0, 0]);
    expect(out.pixels.width).toBe(3);
    for (let i = 3; i < out.pixels.data.length; i += 4) expect(out.pixels.data[i]).toBe(0);
  });
});
