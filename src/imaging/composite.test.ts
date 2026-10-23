import { describe, expect, it } from 'vitest';
import { BLEND_MODES, type BlendMode, type PixelBuffer } from '../core/document/types';
import { createDocument, createRasterLayer } from '../core/document/ops';
import { blendRgb, compositeDocument, compositeLayerInto, sampleComposite } from './composite';

function fill(b: PixelBuffer, rgba: [number, number, number, number]): PixelBuffer {
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = rgba[0];
    b.data[i + 1] = rgba[1];
    b.data[i + 2] = rgba[2];
    b.data[i + 3] = rgba[3];
  }
  return b;
}

function at(b: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const o = (y * b.width + x) * 4;
  return [b.data[o], b.data[o + 1], b.data[o + 2], b.data[o + 3]];
}

function makeDoc(
  w: number,
  h: number,
  layers: Array<{ pixels: PixelBuffer; x?: number; y?: number; opacity?: number; blendMode?: BlendMode; visible?: boolean }>,
) {
  const doc = createDocument({
    name: 't',
    width: w,
    height: h,
    layers: [],
  });
  const built = layers.map((l, i) =>
    createRasterLayer(l.pixels, { name: `L${i}`, x: l.x ?? 0, y: l.y ?? 0, opacity: l.opacity ?? 1 }),
  );
  for (let i = 0; i < built.length; i++) {
    if (layers[i].blendMode) built[i] = { ...built[i], blendMode: layers[i].blendMode! };
    if (layers[i].visible === false) built[i] = { ...built[i], visible: false };
  }
  return { ...doc, layers: built, activeLayerId: built[0]?.id ?? null };
}

describe('blendRgb', () => {
  it('implements multiply per the W3C formula', () => {
    const [r, g, b] = blendRgb('multiply', [100, 150, 200], [150, 150, 150]);
    expect(Math.abs(r - (100 * 150) / 255)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - (150 * 150) / 255)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - (200 * 150) / 255)).toBeLessThanOrEqual(1);
  });

  it('implements screen', () => {
    // screen(100, 0) = 100 · screen(100, 255) = 255 · screen(100, 100) ≈ 161
    const out = blendRgb('screen', [100, 100, 100], [0, 255, 100]);
    expect(out[0]).toBe(100);
    expect(out[1]).toBe(255);
    expect(Math.abs(out[2] - (255 - (155 * 155) / 255))).toBeLessThanOrEqual(1);
  });

  it('implements difference and exclusion', () => {
    expect(blendRgb('difference', [100, 10, 250], [250, 10, 100])).toEqual([150, 0, 150]);
    const [r] = blendRgb('exclusion', [100, 0, 0], [100, 0, 0]);
    expect(Math.abs(r - (100 + 100 - (2 * 100 * 100) / 255))).toBeLessThanOrEqual(1);
  });

  it('keeps luminosity blend in the gray ramp for gray backdrops', () => {
    const [r, g, b] = blendRgb('luminosity', [120, 120, 120], [200, 40, 40]);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });

  it('supports every declared blend mode without throwing', () => {
    for (const mode of BLEND_MODES) {
      const out = blendRgb(mode, [120, 80, 200], [40, 180, 90]);
      for (const c of out) {
        expect(Number.isFinite(c)).toBe(true);
      }
    }
  });
});

describe('compositeDocument', () => {
  it('source-over with opaque pixels takes the top layer', () => {
    const bottom = fill({ width: 2, height: 2, data: new Uint8ClampedArray(16) }, [100, 100, 100, 255]);
    const top = fill({ width: 2, height: 2, data: new Uint8ClampedArray(16) }, [200, 200, 200, 255]);
    const doc = makeDoc(2, 2, [{ pixels: bottom }, { pixels: top }]);
    const out = compositeDocument(doc);
    expect(at(out, 0, 0)).toEqual([200, 200, 200, 255]);
  });

  it('respects layer opacity', () => {
    const bottom = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [100, 100, 100, 255]);
    const top = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [200, 200, 200, 255]);
    const doc = makeDoc(1, 1, [{ pixels: bottom }, { pixels: top, opacity: 0.5 }]);
    const out = compositeDocument(doc);
    expect(at(out, 0, 0)[0]).toBe(150);
    expect(at(out, 0, 0)[3]).toBe(255);
  });

  it('blends semi-transparent sources exactly (128 red over opaque black)', () => {
    const black = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [0, 0, 0, 255]);
    const top = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [255, 0, 0, 128]);
    const doc = makeDoc(1, 1, [{ pixels: black }, { pixels: top }]);
    const out = compositeDocument(doc);
    // ao = as + ab(1−as) = 1 · co = as·Cs = (128/255)·255 = 128
    expect(at(out, 0, 0)).toEqual([128, 0, 0, 255]);
  });

  it('keeps straight (non-premultiplied) color for sources over transparency', () => {
    const top = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [255, 0, 0, 128]);
    const doc = makeDoc(1, 1, [{ pixels: top }]);
    const out = compositeDocument(doc);
    expect(at(out, 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it('honors layer offsets and clips to the canvas', () => {
    const layer = fill({ width: 2, height: 2, data: new Uint8ClampedArray(16) }, [255, 255, 255, 255]);
    const doc = makeDoc(4, 4, [{ pixels: layer, x: 1, y: 1 }]);
    const out = compositeDocument(doc);
    expect(at(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(out, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(at(out, 2, 2)).toEqual([255, 255, 255, 255]);
    expect(at(out, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it('skips hidden layers and zero-opacity layers', () => {
    const layer = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [255, 255, 255, 255]);
    const hidden = makeDoc(1, 1, [{ pixels: layer, visible: false }]);
    expect(at(compositeDocument(hidden), 0, 0)).toEqual([0, 0, 0, 0]);
    const faded = makeDoc(1, 1, [{ pixels: layer, opacity: 0 }]);
    expect(at(compositeDocument(faded), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('applies blend modes between layers (multiply darkens)', () => {
    const bottom = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [200, 200, 200, 255]);
    const top = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [128, 128, 128, 255]);
    const doc = makeDoc(1, 1, [{ pixels: bottom }, { pixels: top, blendMode: 'multiply' }]);
    const out = compositeDocument(doc);
    expect(Math.abs(at(out, 0, 0)[0] - (200 * 128) / 255)).toBeLessThanOrEqual(1);
    expect(at(out, 0, 0)[3]).toBe(255);
  });

  it('supports layer masks that hide pixels', () => {
    const layer = fill({ width: 2, height: 1, data: new Uint8ClampedArray(8) }, [255, 255, 255, 255]);
    const doc = makeDoc(2, 1, [{ pixels: layer }]);
    const masked = {
      ...doc,
      layers: [{ ...doc.layers[0], mask: { width: 2, height: 1, data: new Uint8Array([0, 255]), enabled: true } }],
    };
    const out = compositeDocument(masked);
    expect(at(out, 0, 0)[3]).toBe(0);
    expect(at(out, 1, 0)[3]).toBe(255);
  });
});

describe('sampleComposite', () => {
  it('matches the compositor for every pixel of a mixed document', () => {
    const a = fill({ width: 3, height: 3, data: new Uint8ClampedArray(3 * 3 * 4) }, [33, 77, 201, 255]);
    const b = fill({ width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) }, [211, 41, 91, 150]);
    const doc = makeDoc(3, 3, [
      { pixels: a },
      { pixels: b, x: 1, y: 1, opacity: 0.7, blendMode: 'overlay' },
    ]);
    const out = compositeDocument(doc);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const s = sampleComposite(doc, x, y);
        const c = at(out, x, y);
        expect(Math.abs(s.r - c[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(s.g - c[1])).toBeLessThanOrEqual(1);
        expect(Math.abs(s.b - c[2])).toBeLessThanOrEqual(1);
        expect(Math.abs(s.a - c[3])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns transparent outside the canvas', () => {
    const doc = makeDoc(2, 2, []);
    expect(sampleComposite(doc, -1, 0).a).toBe(0);
    expect(sampleComposite(doc, 5, 5).a).toBe(0);
  });
});

describe('compositeLayerInto', () => {
  it('composites onto an existing backdrop buffer', () => {
    const target = new Uint8ClampedArray([10, 10, 10, 255]);
    const layer = fill({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [210, 210, 210, 255]);
    const doc = makeDoc(1, 1, [{ pixels: layer }]);
    compositeLayerInto(target, 1, 1, doc.layers[0]);
    expect(target[0]).toBe(210);
    expect(target[3]).toBe(255);
  });
});
