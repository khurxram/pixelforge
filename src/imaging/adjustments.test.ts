import { describe, expect, it } from 'vitest';
import type { PixelBuffer } from '../core/document/types';
import {
  applyAdjustments,
  buildCurveLut,
  DEFAULT_ADJUSTMENTS,
  isCurveActive,
  isIdentityAdjustment,
  isNeutralGrade,
  type AdjustParams,
} from './adjustments';

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

function p(overrides: Partial<AdjustParams> = {}): AdjustParams {
  return { ...DEFAULT_ADJUSTMENTS, ...overrides };
}

describe('applyAdjustments', () => {
  it('returns an identical copy for identity parameters', () => {
    const src = buf(2, 2, [10, 20, 30, 255]);
    src.data[4] = 200;
    const out = applyAdjustments(src, p());
    expect(out).not.toBe(src);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
    // Input must not be mutated.
    expect(src.data[4]).toBe(200);
  });

  it('applies brightness additively and preserves alpha', () => {
    const out = applyAdjustments(buf(1, 1, [10, 20, 30, 128]), p({ brightness: 40 }));
    // 40 * 1.275 = 51
    expect(px(out)).toEqual([61, 71, 81, 128]);
  });

  it('scales exposure multiplicatively (50 â‰ˆ +1 stop)', () => {
    const out = applyAdjustments(buf(1, 1, [64, 64, 64, 255]), p({ exposure: 50 }));
    expect(px(out)).toEqual([128, 128, 128, 255]);
  });

  it('leaves mid gray nearly unchanged at contrast 0', () => {
    const out = applyAdjustments(buf(1, 1, [128, 128, 128, 255]), p({ contrast: 40 }));
    const [r, g, b] = px(out);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 128)).toBeLessThanOrEqual(1);
  });

  it('converts to grayscale with Rec.709 luma and keeps alpha', () => {
    const out = applyAdjustments(buf(1, 1, [255, 0, 0, 200]), p({ grayscale: true }));
    const [r, g, b, a] = px(out);
    expect(Math.abs(r - Math.round(0.2126 * 255))).toBeLessThanOrEqual(1);
    expect(g).toBe(r);
    expect(b).toBe(r);
    expect(a).toBe(200);
  });

  it('reduces saturation to luma at -100', () => {
    const out = applyAdjustments(buf(1, 1, [200, 60, 30, 255]), p({ saturation: -100 }));
    const [r, g, b] = px(out);
    expect(g).toBe(r);
    expect(b).toBe(r);
  });

  it('rotates hue by 360Â° back to identity (Â±180 twice)', () => {
    // Mid-range, low-saturation color so the rotation never clamps.
    const src = buf(1, 1, [150, 140, 130, 255]);
    const half = applyAdjustments(src, p({ hue: 180 }));
    const full = applyAdjustments(half, p({ hue: 180 }));
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(px(full)[i] - px(src)[i])).toBeLessThanOrEqual(2);
    }
  });

  it('hue 0 is an exact no-op', () => {
    const src = buf(1, 1, [200, 60, 30, 255]);
    expect(px(applyAdjustments(src, p({ hue: 0 })))).toEqual([200, 60, 30, 255]);
  });

  it('warms reds with positive temperature', () => {
    const out = applyAdjustments(buf(1, 1, [100, 100, 100, 255]), p({ temperature: 50 }));
    const [r, , b] = px(out);
    expect(r).toBeGreaterThan(100);
    expect(b).toBeLessThan(100);
  });

  it('applies sepia tone at 100', () => {
    const out = applyAdjustments(buf(1, 1, [0, 0, 255, 255]), p({ sepia: 100 }));
    const [r, g, b] = px(out);
    // Sepia matrix row 1: 0.393/0.769/0.189 of (0,0,255)
    expect(Math.abs(r - Math.round(0.189 * 255))).toBeLessThanOrEqual(1);
    expect(Math.abs(g - Math.round(0.168 * 255))).toBeLessThanOrEqual(1);
    expect(Math.abs(b - Math.round(0.131 * 255))).toBeLessThanOrEqual(1);
  });

  it('blurs an impulse into its neighbors and keeps alpha', () => {
    const src = buf(5, 5, [0, 0, 0, 255]);
    // Red impulse in the center.
    const center = (2 * 5 + 2) * 4;
    src.data[center] = 255;
    const out = applyAdjustments(src, p({ blurRadius: 1 }));
    const afterCenter = px(out, 2 * 5 + 2)[0];
    const neighbor = px(out, 2 * 5 + 3)[0];
    expect(afterCenter).toBeGreaterThan(0);
    expect(afterCenter).toBeLessThan(255);
    expect(neighbor).toBeGreaterThan(0);
    expect(out.data[center + 3]).toBe(255);
  });

  it('leaves flat images untouched when sharpening', () => {
    const out = applyAdjustments(buf(4, 4, [90, 120, 150, 255]), p({ sharpenAmount: 120 }));
    expect(px(out)).toEqual([90, 120, 150, 255]);
  });

  it('does not modify alpha anywhere in the pipeline', () => {
    const src = buf(3, 3, [12, 200, 90, 77]);
    const out = applyAdjustments(src, p({ brightness: 30, blurRadius: 1, sharpenAmount: 50 }));
    for (let i = 3; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(77);
    }
  });
});

describe('isIdentityAdjustment', () => {
  it('detects defaults as identity and any change as non-identity', () => {
    expect(isIdentityAdjustment(DEFAULT_ADJUSTMENTS)).toBe(true);
    expect(isIdentityAdjustment(p({ brightness: 1 }))).toBe(false);
    expect(isIdentityAdjustment(p({ grayscale: true }))).toBe(false);
    expect(isIdentityAdjustment(p({ blurRadius: 0.5 }))).toBe(false);
  });
});

describe('colour grading (lift/gamma/gain wheels)', () => {
  it('lift master raises blacks but pins white', () => {
    const [r] = px(applyAdjustments(buf(1, 1, [0, 0, 0, 255]), p({ liftM: 50 })));
    expect(r).toBeGreaterThan(10);
    expect(r).toBeLessThan(60);
    expect(px(applyAdjustments(buf(1, 1, [255, 255, 255, 255]), p({ liftM: 50 })))).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it('negative lift master darkens shadows and pins both ends', () => {
    expect(px(applyAdjustments(buf(1, 1, [128, 128, 128, 255]), p({ liftM: -50 })), 0)[0]).toBeLessThan(128);
    expect(px(applyAdjustments(buf(1, 1, [0, 0, 0, 255]), p({ liftM: -50 })), 0)[0]).toBe(0);
    expect(px(applyAdjustments(buf(1, 1, [255, 255, 255, 255]), p({ liftM: -50 })), 0)[0]).toBe(255);
  });

  it('gamma master brightens midtones and pins both ends', () => {
    const mid = px(applyAdjustments(buf(1, 1, [128, 128, 128, 255]), p({ gammaM: 50 })), 0)[0];
    expect(mid).toBeGreaterThan(130);
    expect(mid).toBeLessThan(160);
    expect(px(applyAdjustments(buf(1, 1, [0, 0, 0, 255]), p({ gammaM: 50 })), 0)[0]).toBe(0);
    expect(px(applyAdjustments(buf(1, 1, [255, 255, 255, 255]), p({ gammaM: 50 })), 0)[0]).toBe(255);
  });

  it('negative gamma master darkens midtones', () => {
    expect(px(applyAdjustments(buf(1, 1, [128, 128, 128, 255]), p({ gammaM: -50 })), 0)[0]).toBeLessThan(120);
  });

  it('gain master scales midtones upward', () => {
    const mid = px(applyAdjustments(buf(1, 1, [128, 128, 128, 255]), p({ gainM: 50 })), 0)[0];
    expect(mid).toBeGreaterThan(140);
    expect(mid).toBeLessThan(160);
  });

  it('lift wheel to the right warms the shadows (red up, green/blue down)', () => {
    const [r, g, b] = px(applyAdjustments(buf(1, 1, [100, 100, 100, 255]), p({ liftX: 1 })));
    expect(r).toBeGreaterThan(g + 30);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });

  it('lift wheel up tints the shadows green', () => {
    const [r, g, b] = px(applyAdjustments(buf(1, 1, [100, 100, 100, 255]), p({ liftY: -1 })));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b + 30);
  });

  it('gain wheel right warms the highlights and cools the rest', () => {
    const [r, g, b] = px(applyAdjustments(buf(1, 1, [200, 200, 200, 255]), p({ gainX: 0.6 })));
    expect(r).toBeGreaterThan(230);
    expect(b).toBeLessThan(190);
    expect(b).toBe(g);
  });

  it('neutral wheels are an exact no-op', () => {
    const src = buf(2, 2, [30, 140, 210, 255]);
    expect(px(applyAdjustments(src, p()))).toEqual([30, 140, 210, 255]);
  });

  it('preserves alpha through the grade', () => {
    const out = applyAdjustments(
      buf(2, 2, [40, 90, 140, 64]),
      p({ liftX: 0.4, gammaM: 30, gainM: -20 }),
    );
    for (let i = 3; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(64);
    }
  });
});

describe('isNeutralGrade', () => {
  it('is true only when every wheel and master is centred', () => {
    expect(isNeutralGrade(DEFAULT_ADJUSTMENTS)).toBe(true);
    expect(isNeutralGrade(p({ liftX: 0.1 }))).toBe(false);
    expect(isNeutralGrade(p({ gammaM: -1 }))).toBe(false);
    expect(isNeutralGrade(p({ gainY: 0.01 }))).toBe(false);
  });
});

describe('advanced stylization', () => {
  it('threshold binarizes at the target luma (0 = off)', () => {
    const src = buf(2, 1, [200, 190, 180, 255]); // luma ˜ 191
    src.data[4] = 60;
    src.data[5] = 60;
    src.data[6] = 60; // luma 60
    const out = applyAdjustments(src, p({ threshold: 128 }));
    expect(px(out, 0)).toEqual([255, 255, 255, 255]);
    expect(px(out, 1)).toEqual([0, 0, 0, 255]);
    // 0 means the effect is off entirely.
    const same = applyAdjustments(src, p({ threshold: 0 }));
    expect(px(same, 0)).toEqual([200, 190, 180, 255]);
  });

  it('posterize quantizes channels to N tonal levels', () => {
    // 2 levels collapse each channel to 0 or 255 at the midpoint.
    const two = applyAdjustments(buf(1, 1, [200, 100, 30, 255]), p({ posterize: 2 }));
    expect(px(two)).toEqual([255, 0, 0, 255]);
    // 3 levels allow 0 / 128 / 255.
    const three = applyAdjustments(buf(1, 1, [130, 60, 200, 255]), p({ posterize: 3 }));
    expect(px(three)).toEqual([128, 0, 255, 255]);
  });

  it('gradient map drives colour from luminance (and reverses)', () => {
    const src = buf(2, 1, [0, 0, 0, 255]);
    src.data[4] = 255;
    src.data[5] = 255;
    src.data[6] = 255;
    const out = applyAdjustments(src, p({ gradientMap: 'mono' }));
    expect(px(out, 0)).toEqual([0, 0, 0, 255]);
    expect(px(out, 1)).toEqual([255, 255, 255, 255]);
    const rev = applyAdjustments(src, p({ gradientMap: 'mono', gradientMapReverse: true }));
    expect(px(rev, 0)).toEqual([255, 255, 255, 255]);
    expect(px(rev, 1)).toEqual([0, 0, 0, 255]);
  });

  it('photo filter tints toward the warming/cooling color', () => {
    const warm = applyAdjustments(
      buf(1, 1, [200, 200, 200, 255]),
      p({ photoFilter: 'warming', photoFilterDensity: 100 }),
    );
    const [wr, wg, wb] = px(warm);
    expect(wr).toBe(200); // red tint component is neutral
    expect(wg).toBeLessThan(200);
    expect(wb).toBeLessThan(wg); // blue drops most ? warm cast
    const cool = applyAdjustments(
      buf(1, 1, [200, 200, 200, 255]),
      p({ photoFilter: 'cooling', photoFilterDensity: 100 }),
    );
    const [, cg, cb] = px(cool);
    expect(cb).toBeGreaterThan(cg); // blue retained ? cool cast
  });
});

describe('buildCurveLut', () => {
  it('returns null for an empty curve (identity)', () => {
    expect(buildCurveLut([])).toBeNull();
  });

  it('pins the endpoints, passes through control points, stays monotonic', () => {
    const lut = buildCurveLut([{ x: 0.5, y: 0.8 }])!;
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
    expect(lut[128]).toBeGreaterThan(180); // lifted midtone (0.5 ? ˜ 0.8)
    for (let v = 1; v < 256; v++) expect(lut[v]).toBeGreaterThanOrEqual(lut[v - 1]);
  });

  it('applies the master curve to every channel through the pipeline', () => {
    const out = applyAdjustments(
      buf(1, 1, [128, 128, 128, 255]),
      p({ curve: { rgb: [{ x: 0.5, y: 0.2 }], r: [], g: [], b: [] } }),
    );
    const [r, g, b] = px(out);
    expect(r).toBeLessThan(80); // 0.5 ? ˜ 0.2 pulls mid gray down
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('isCurveActive detects any channel with points', () => {
    expect(isCurveActive({ rgb: [], r: [], g: [], b: [] })).toBe(false);
    expect(isCurveActive({ rgb: [], r: [{ x: 0.3, y: 0.3 }], g: [], b: [] })).toBe(true);
  });

  it('treats active curves as non-identity adjustments', () => {
    expect(isIdentityAdjustment(p())).toBe(true);
    expect(isIdentityAdjustment(p({ curve: { rgb: [{ x: 0.5, y: 0.7 }], r: [], g: [], b: [] } }))).toBe(false);
    expect(isIdentityAdjustment(p({ threshold: 128 }))).toBe(false);
    expect(isIdentityAdjustment(p({ posterize: 4 }))).toBe(false);
    expect(isIdentityAdjustment(p({ gradientMap: 'sunset' }))).toBe(false);
    expect(isIdentityAdjustment(p({ photoFilter: 'warming' }))).toBe(false);
  });
});
