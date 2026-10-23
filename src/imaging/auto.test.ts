import { describe, expect, it } from 'vitest';
import type { PixelBuffer } from '../core/document/types';
import { rectSelection } from '../core/document/selection';
import { autoColor, autoContrast, autoTone } from './auto';

function buf(width: number, height: number, rgba: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

function px(b: PixelBuffer, i = 0): [number, number, number, number] {
  return [b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2], b.data[i * 4 + 3]];
}

describe('autoTone', () => {
  it('stretches a low-contrast channel to the full range', () => {
    // Set all three channels so every channel sees the same 40..70 range.
    const src = buf(4, 1, [40, 40, 40, 255]);
    const ramp = [40, 50, 60, 70];
    for (let i = 0; i < 4; i++) {
      src.data[i * 4] = ramp[i];
      src.data[i * 4 + 1] = ramp[i];
      src.data[i * 4 + 2] = ramp[i];
    }
    autoTone(src);
    // The darkest sample lands on black, the brightest on white.
    expect(px(src, 0)).toEqual([0, 0, 0, 255]);
    expect(px(src, 3)).toEqual([255, 255, 255, 255]);
    // Mid values interpolate (clip points land just inside the extremes).
    const [mid] = px(src, 2);
    expect(mid).toBeGreaterThan(140);
    expect(mid).toBeLessThan(220);
  });

  it('only touches pixels inside the selection', () => {
    const src = buf(4, 1, [40, 40, 40, 255]);
    // Selected pixels (0,1) span 40..50; unselected (2,3) are 200 gray.
    src.data[4] = 50;
    src.data[5] = 50;
    src.data[6] = 50;
    for (let i = 2; i < 4; i++) {
      src.data[i * 4] = 200;
      src.data[i * 4 + 1] = 200;
      src.data[i * 4 + 2] = 200;
    }
    // Selection covers the left half only (x = 0..1).
    const sel = rectSelection(4, 1, { x: 0, y: 0, width: 2, height: 1 })!;
    autoTone(src, { selection: sel, origin: { x: 0, y: 0 } });
    // Selected pixels got the stretch…
    expect(px(src, 0)[0]).toBe(0);
    expect(px(src, 1)[0]).toBe(255);
    // …unselected pixels are untouched.
    expect(px(src, 2)).toEqual([200, 200, 200, 255]);
    expect(px(src, 3)).toEqual([200, 200, 200, 255]);
  });
});

describe('autoContrast', () => {
  it('applies one luma-derived stretch to every channel', () => {
    const src = buf(2, 1, [20, 20, 20, 255]);
    src.data[4] = 220;
    src.data[5] = 220;
    src.data[6] = 220;
    autoContrast(src);
    expect(px(src, 0)[0]).toBe(0);
    expect(px(src, 1)[0]).toBe(255);
  });
});

describe('autoColor', () => {
  it('neutralizes midtones toward mid gray', () => {
    // A uniformly warm-cast patch: R high, B low.
    const src = buf(4, 1, [160, 140, 120, 255]);
    autoColor(src);
    const [r, g, b] = px(src);
    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
  });
});
