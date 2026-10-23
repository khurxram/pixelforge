import { describe, expect, it } from 'vitest';
import type { PixelBuffer } from '../core/document/types';
import { resizeBuffer } from './scale';

function solid(width: number, height: number, r: number, a = 255): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 3] = a;
  }
  return { width, height, data };
}

describe('resizeBuffer', () => {
  it('averages 2×2 down to 1×1 (area filter)', () => {
    const src = solid(2, 2, 100);
    src.data[0] = 0; // top-left pixel red = 0
    const out = resizeBuffer(src, 1, 1);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    // (0 + 100 + 100 + 100) / 4 = 75
    expect(out.data[0]).toBe(75);
    expect(out.data[3]).toBe(255);
  });

  it('keeps dimensions when target equals source', () => {
    const src = solid(3, 2, 42);
    const out = resizeBuffer(src, 3, 2);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('upscales to requested dimensions', () => {
    const out = resizeBuffer(solid(2, 2, 200), 5, 7);
    expect(out.width).toBe(5);
    expect(out.height).toBe(7);
    expect(out.data.length).toBe(5 * 7 * 4);
    expect(out.data[0]).toBe(200);
  });

  it('preserves fully transparent pixels without color fringes', () => {
    // Fully transparent *white* — a straight (non-premultiplied) filter would
    // leak 255s into the output; a correct one collapses it to zero.
    const out = resizeBuffer(solid(4, 4, 255, 0), 2, 2);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i + 3]).toBe(0);
      expect(out.data[i]).toBe(0); // no white/black halo
    }
  });

  it('blends semi-transparent colors by alpha coverage', () => {
    // Left half opaque red, right half transparent.
    const src = solid(2, 1, 255);
    src.data[4] = 0;
    src.data[7] = 0;
    const out = resizeBuffer(src, 1, 1);
    // Premultiplied average: red = 255*1*0.5 + 0*1*0.5 → 127.5 premult, alpha 127.5
    // unpremultiplied red stays 255.
    expect(Math.abs(out.data[0] - 255)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[3] - 128)).toBeLessThanOrEqual(1);
  });
});
