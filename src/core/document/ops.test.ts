import { describe, expect, it } from 'vitest';
import {
  addLayer,
  clampRectToDocument,
  createDocument,
  createPixelBuffer,
  createRasterLayer,
  duplicateLayer,
  getActiveLayer,
  removeLayer,
  reorderLayer,
  replaceLayer,
  setActiveLayer,
  updateLayer,
} from './ops';

function docWith(n: number) {
  const layers = Array.from({ length: n }, (_, i) =>
    createRasterLayer(createPixelBuffer(2, 2, 0), { name: `L${i}` }),
  );
  return createDocument({ name: 'doc', width: 2, height: 2, layers });
}

describe('document ops', () => {
  it('creates a document with a default background layer and activates it', () => {
    const doc = createDocument({ name: 'x', width: 10, height: 5 });
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].name).toBe('Background');
    expect(doc.activeLayerId).toBe(doc.layers[0].id);
    expect(doc.layers[0].pixels.width).toBe(10);
  });

  it('adds layers above the active layer and activates them', () => {
    const doc = docWith(2);
    const first = doc.layers[0];
    const withActiveFirst = setActiveLayer(doc, first.id);
    const layer = createRasterLayer(createPixelBuffer(1, 1, 0), { name: 'new' });
    const next = addLayer(withActiveFirst, layer, { aboveActive: true });
    expect(next.layers.map((l) => l.name)).toEqual(['L0', 'new', 'L1']);
    expect(next.activeLayerId).toBe(layer.id);
    // Original untouched (immutability).
    expect(doc.layers).toHaveLength(2);
  });

  it('removes a layer and re-selects a neighbor', () => {
    const doc = docWith(3);
    const target = doc.layers[1].id;
    const next = removeLayer(doc, target);
    expect(next.layers).toHaveLength(2);
    expect(next.layers.some((l) => l.id === target)).toBe(false);
    expect(next.activeLayerId).not.toBe(target);
    expect(next.layers.some((l) => l.id === next.activeLayerId)).toBe(true);
  });

  it('reorders layers with clamping', () => {
    const doc = docWith(3);
    const names = (d: typeof doc) => d.layers.map((l) => l.name);
    expect(names(reorderLayer(doc, doc.layers[0].id, 2))).toEqual(['L1', 'L2', 'L0']);
    expect(names(reorderLayer(doc, doc.layers[2].id, -5))).toEqual(['L2', 'L0', 'L1']);
    // No-op move keeps the same array.
    expect(reorderLayer(doc, doc.layers[1].id, 1)).toBe(doc);
  });

  it('duplicates with independent pixel data', () => {
    const doc = docWith(1);
    const src = doc.layers[0];
    src.pixels.data[0] = 42;
    const next = duplicateLayer(doc, src.id);
    expect(next.layers).toHaveLength(2);
    const copy = next.layers[1];
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe(`${src.name} copy`);
    expect(copy.pixels.data[0]).toBe(42);
    copy.pixels.data[0] = 99;
    expect(src.pixels.data[0]).toBe(42); // not aliased
  });

  it('updates layer properties without touching other layers', () => {
    const doc = docWith(2);
    const next = updateLayer(doc, doc.layers[0].id, { opacity: 0.3, name: 'renamed' });
    expect(next.layers[0].opacity).toBe(0.3);
    expect(next.layers[0].name).toBe('renamed');
    expect(next.layers[1]).toBe(doc.layers[1]); // shared reference
  });

  it('rejects invalid activation targets', () => {
    const doc = docWith(2);
    expect(setActiveLayer(doc, 'nope')).toBe(doc);
  });

  it('replaces layers by id', () => {
    const doc = docWith(2);
    const replacement = { ...doc.layers[0], name: 'replaced' };
    const next = replaceLayer(doc, doc.layers[0].id, replacement);
    expect(next.layers[0].name).toBe('replaced');
    expect(replaceLayer(doc, 'missing', replacement)).toBe(doc);
  });

  it('reports the active layer', () => {
    const doc = docWith(2);
    expect(getActiveLayer(doc)?.id).toBe(doc.activeLayerId);
    expect(getActiveLayer({ ...doc, activeLayerId: null })).toBeNull();
  });

  it('clamps rectangles to document bounds and rejects empty intersections', () => {
    const doc = createDocument({ name: 'd', width: 10, height: 10 });
    expect(clampRectToDocument(doc, { x: -5, y: -5, width: 20, height: 20 })).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(clampRectToDocument(doc, { x: 20, y: 20, width: 5, height: 5 })).toBeNull();
    expect(clampRectToDocument(doc, { x: 2, y: 3, width: 4, height: 4 })).toEqual({
      x: 2,
      y: 3,
      width: 4,
      height: 4,
    });
  });
});
