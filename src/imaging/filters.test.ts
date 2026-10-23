import { describe, expect, it } from 'vitest';
import type { PixelBuffer } from '../core/document/types';
import { boxBlur, unsharpMask } from './filters';

function solid(width: number, height: number, rgba: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

describe('boxBlur', () => {
  it('leaves a constant opaque image unchanged', () => {
    const out = boxBlur(solid(7, 7, [80, 120, 160, 255]), 2);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(80);
      expect(out.data[i + 1]).toBe(120);
      expect(out.data[i + 2]).toBe(160);
      expect(out.data[i + 3]).toBe(255);
    }
  });

  it('spreads an impulse symmetrically', () => {
    const src = solid(7, 7, [0, 0, 0, 255]);
    src.data[(3 * 7 + 3) * 4] = 255;
    const out = boxBlur(src, 1, 1);
    const at = (x: number, y: number) => out.data[(y * 7 + x) * 4];
    const center = at(3, 3);
    expect(center).toBeGreaterThan(0);
    expect(center).toBeLessThan(255);
    expect(at(2, 3)).toBe(center); // horizontal symmetry
    expect(at(4, 3)).toBe(center);
    expect(at(3, 2)).toBe(center);
    expect(at(3, 4)).toBe(center);
    expect(at(0, 0)).toBe(0); // far corner untouched
  });

  it('does not let transparent black bleed into opaque color', () => {
    // Left half opaque red, right half fully transparent black.
    const w = 6;
    const h = 3;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (x < 3) {
          data[o] = 200;
          data[o + 3] = 255;
        }
      }
    }
    const out = boxBlur({ width: w, height: h, data }, 1, 1);
    // An opaque pixel near the boundary must keep red ≈ 200 (premultiplied blur).
    const edge = (1 * w + 2) * 4;
    expect(Math.abs(out.data[edge] - 200)).toBeLessThanOrEqual(3);
    expect(out.data[edge + 3]).toBeLessThan(255); // alpha did get feathered
    expect(out.data[edge + 3]).toBeGreaterThan(0);
  });
});

describe('unsharpMask', () => {
  it('returns a copy at amount 0', () => {
    const src = solid(3, 3, [10, 20, 30, 255]);
    const out = unsharpMask(src, 0);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('increases local contrast around an edge', () => {
    const w = 8;
    const h = 8;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const v = x < 4 ? 60 : 190;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    const out = unsharpMask({ width: w, height: h, data }, 1.5);
    // Dark side gets darker, light side gets lighter.
    expect(out.data[(4 * w + 2) * 4]).toBeLessThan(60);
    expect(out.data[(4 * w + 5) * 4]).toBeGreaterThan(190);
    // Far from the edge stays unchanged.
    expect(out.data[(4 * w + 0) * 4]).toBe(60);
    expect(out.data[(4 * w + 7) * 4]).toBe(190);
  });
});
