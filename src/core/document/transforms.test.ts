import { describe, expect, it } from 'vitest';
import { createDocument, createPixelBuffer, createRasterLayer } from './ops';
import { cropDocument, resizeDocument, transformDocument } from './transforms';
import type { EditorDocument } from './types';

/** Build a document with one layer carrying distinct red values. */
function fixture(): EditorDocument {
  const pixels = createPixelBuffer(2, 2, 0);
  // R channel: 1 2 / 3 4
  pixels.data[0] = 1;
  pixels.data[4] = 2;
  pixels.data[8] = 3;
  pixels.data[12] = 4;
  for (let i = 3; i < 16; i += 4) pixels.data[i] = 255;
  const layer = createRasterLayer(pixels, { name: 'layer', x: 1, y: 0 });
  return createDocument({ name: 'doc', width: 4, height: 3, layers: [layer], now: 1000 });
}

function reds(doc: EditorDocument): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.layers[0].pixels.data.length; i += 4) {
    out.push(doc.layers[0].pixels.data[i]);
  }
  return out;
}

describe('transformDocument', () => {
  it('flips horizontally: mirror pixels and reposition the layer', () => {
    const doc = transformDocument(fixture(), 'flip-h');
    expect(doc.width).toBe(4);
    expect(doc.height).toBe(3);
    expect(reds(doc)).toEqual([2, 1, 4, 3]);
    // x' = W - x - lw = 4 - 1 - 2 = 1
    expect(doc.layers[0].x).toBe(1);
    expect(doc.layers[0].y).toBe(0);
  });

  it('flips vertically', () => {
    const doc = transformDocument(fixture(), 'flip-v');
    expect(reds(doc)).toEqual([3, 4, 1, 2]);
    // y' = H - y - lh = 3 - 0 - 2 = 1
    expect(doc.layers[0].y).toBe(1);
  });

  it('rotates 90° cw: canvas swaps, layer relocates, pixels rotate', () => {
    const doc = transformDocument(fixture(), 'rotate-cw');
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(4);
    expect(reds(doc)).toEqual([3, 1, 4, 2]);
    // x' = H - y - lh = 3 - 0 - 2 = 1, y' = x = 1
    expect(doc.layers[0].x).toBe(1);
    expect(doc.layers[0].y).toBe(1);
  });

  it('rotates 90° ccw', () => {
    const doc = transformDocument(fixture(), 'rotate-ccw');
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(4);
    expect(reds(doc)).toEqual([2, 4, 1, 3]);
    // x' = y = 0, y' = W - x - lw = 4 - 1 - 2 = 1
    expect(doc.layers[0].x).toBe(0);
    expect(doc.layers[0].y).toBe(1);
  });

  it('rotates 180° keeping the canvas', () => {
    const doc = transformDocument(fixture(), 'rotate-180');
    expect(doc.width).toBe(4);
    expect(doc.height).toBe(3);
    expect(reds(doc)).toEqual([4, 3, 2, 1]);
    expect(doc.layers[0].x).toBe(1);
    expect(doc.layers[0].y).toBe(1);
  });

  it('transforms guides with the canvas', () => {
    const base = fixture();
    const withGuides: EditorDocument = {
      ...base,
      guides: [
        { id: 'g1', axis: 'vertical', position: 2 },
        { id: 'g2', axis: 'horizontal', position: 1 },
      ],
    };
    const flipped = transformDocument(withGuides, 'flip-h');
    expect(flipped.guides.find((g) => g.id === 'g1')?.position).toBe(2); // 4 - 2
    expect(flipped.guides.find((g) => g.id === 'g2')?.position).toBe(1);

    const rotated = transformDocument(withGuides, 'rotate-cw');
    expect(rotated.guides.find((g) => g.id === 'g1')?.axis).toBe('horizontal');
    expect(rotated.guides.find((g) => g.id === 'g2')?.axis).toBe('vertical');
    // horizontal guide at 1 → vertical at H - 1 = 3 - 1 = 2
    expect(rotated.guides.find((g) => g.id === 'g2')?.position).toBe(2);
  });
});

describe('cropDocument', () => {
  it('resizes the canvas and shifts layers, preserving pixels', () => {
    const doc = fixture();
    const cropped = cropDocument(doc, { x: 1, y: 0, width: 2, height: 2 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    expect(cropped.layers[0].x).toBe(0);
    expect(cropped.layers[0].y).toBe(0);
    expect(reds(cropped)).toEqual(reds(doc)); // pixels preserved, not deleted
    // Guides outside the crop are dropped.
    const withGuides = {
      ...doc,
      guides: [
        { id: 'a', axis: 'vertical' as const, position: 1 },
        { id: 'b', axis: 'vertical' as const, position: 4 },
      ],
    };
    const croppedGuides = cropDocument(withGuides, { x: 1, y: 0, width: 2, height: 2 });
    expect(croppedGuides.guides.map((g) => g.id)).toEqual(['a']);
  });
});

describe('resizeDocument', () => {
  it('scales canvas, layer buffers and offsets proportionally', () => {
    const doc = fixture();
    const up = resizeDocument(doc, 8, 6);
    expect(up.width).toBe(8);
    expect(up.height).toBe(6);
    expect(up.layers[0].pixels.width).toBe(4);
    expect(up.layers[0].pixels.height).toBe(4);
    expect(up.layers[0].x).toBe(2);
    expect(up.layers[0].y).toBe(0);

    const down = resizeDocument(doc, 2, 1.5);
    expect(down.layers[0].pixels.width).toBe(1);
    expect(down.layers[0].pixels.height).toBe(1);
  });

  it('is a no-op for identical dimensions', () => {
    const doc = fixture();
    expect(resizeDocument(doc, 4, 3)).toBe(doc);
  });
});
