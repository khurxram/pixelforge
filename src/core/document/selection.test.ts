import { describe, expect, it } from 'vitest';
import {
  combineSelection,
  columnSelection,
  computeOutline,
  ellipseSelection,
  expandQuickSelection,
  featherSelection,
  growSelection,
  invertSelection,
  offsetSelection,
  pathSelection,
  rectSelection,
  rowSelection,
  selectAll,
  selectionAlpha,
  shrinkSelection,
  smoothSelection,
  wandSelection,
} from './selection';
import type { PixelBuffer } from './types';

function buffer(w: number, h: number, fill: [number, number, number, number] = [0, 0, 0, 255]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { width: w, height: h, data };
}

describe('rectSelection', () => {
  it('creates a full-mask selection clamped to the document', () => {
    const sel = rectSelection(10, 10, { x: -5, y: 2, width: 20, height: 3 });
    expect(sel).not.toBeNull();
    expect(sel!.bounds).toEqual({ x: 0, y: 2, width: 10, height: 3 });
    expect(sel!.rect).toEqual(sel!.bounds);
    expect(sel!.mask.every((v) => v === 255)).toBe(true);
    expect(sel!.mask.length).toBe(30);
  });

  it('returns null for empty rects', () => {
    expect(rectSelection(10, 10, { x: 0, y: 0, width: 0, height: 5 })).toBeNull();
    expect(rectSelection(10, 10, { x: 50, y: 0, width: 5, height: 5 })).toBeNull();
  });
});

describe('selectAll / invertSelection', () => {
  it('select all covers the document', () => {
    const sel = selectAll(4, 3);
    expect(sel.bounds).toEqual({ x: 0, y: 0, width: 4, height: 3 });
    expect(sel.rect).toEqual(sel.bounds);
    expect(sel.mask.every((v) => v === 255)).toBe(true);
  });

  it('inverts a partial selection across the whole document', () => {
    const base = rectSelection(4, 4, { x: 1, y: 1, width: 2, height: 2 })!;
    const inv = invertSelection(4, 4, base);
    expect(inv.bounds).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(selectionAlpha(inv, 0, 0)).toBe(255);
    expect(selectionAlpha(inv, 1, 1)).toBe(0);
    expect(selectionAlpha(inv, 2, 2)).toBe(0);
    expect(selectionAlpha(inv, 3, 3)).toBe(255);
  });

  it('inverting null selection means select all', () => {
    const inv = invertSelection(3, 3, null);
    expect(inv.rect).toEqual({ x: 0, y: 0, width: 3, height: 3 });
  });
});

describe('pathSelection (lasso)', () => {
  it('fills a closed triangle with even-odd scanline', () => {
    const sel = pathSelection(20, 20, [
      { x: 2, y: 2 },
      { x: 12, y: 2 },
      { x: 2, y: 12 },
    ]);
    expect(sel).not.toBeNull();
    expect(selectionAlpha(sel, 3, 3)).toBe(255); // inside
    expect(selectionAlpha(sel, 11, 11)).toBe(0); // outside hypotenuse
    expect(selectionAlpha(sel, 2, 2)).toBe(255); // corner
  });

  it('rejects degenerate paths', () => {
    expect(pathSelection(10, 10, [{ x: 1, y: 1 }, { x: 5, y: 5 }])).toBeNull();
  });

  it('handles self-tracing rectangles around bounds', () => {
    const sel = pathSelection(10, 10, [
      { x: 1, y: 1 },
      { x: 8, y: 1 },
      { x: 8, y: 8 },
      { x: 1, y: 8 },
    ]);
    expect(sel).not.toBeNull();
    expect(selectionAlpha(sel, 5, 5)).toBe(255);
    expect(selectionAlpha(sel, 0, 0)).toBe(0);
    expect(selectionAlpha(sel, 9, 9)).toBe(0);
  });
});

describe('wandSelection', () => {
  it('selects only the contiguous same-color region', () => {
    // Left half red, right half blue.
    const px = buffer(6, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 3; x < 6; x++) {
        const i = (y * 6 + x) * 4;
        px.data[i] = 0;
        px.data[i + 2] = 255;
      }
    }
    const sel = wandSelection(px, 0, 0, 0);
    expect(sel).not.toBeNull();
    expect(sel!.bounds).toEqual({ x: 0, y: 0, width: 3, height: 4 });
    expect(selectionAlpha(sel, 2, 3)).toBe(255);
    expect(selectionAlpha(sel, 3, 0)).toBe(0); // other region not included
  });

  it('tolerance lets near-colors join the region', () => {
    const px = buffer(3, 1);
    px.data[4] = 10; // neighbor of seed (0,0,0): red 10
    px.data[8] = 60; // too far for tolerance 12, fine for 100
    const strict = wandSelection(px, 0, 0, 12)!;
    expect(strict.bounds.width).toBe(2);
    const loose = wandSelection(px, 0, 0, 100)!;
    expect(loose.bounds.width).toBe(3);
  });

  it('rejects seeds outside the document', () => {
    expect(wandSelection(buffer(2, 2), 5, 5, 10)).toBeNull();
  });

  it('uses a perceptual color distance (green weighs far more than blue)', () => {
    // Seed pixel is black. Neighbor (1,1) shifts green by 30; neighbor
    // (2,1) shifts blue by the same amount. Perceptually the green neighbor
    // is much farther away, so at tolerance 6 only the blue neighbor joins.
    const px = buffer(3, 3);
    px.data[(1 * 3 + 1) * 4 + 1] = 30; // (1,1): green +30 → dist ≈ 23.1
    px.data[(1 * 3 + 2) * 4 + 2] = 30; // (2,1): blue +30 → dist ≈ 9.9
    const thr = 6 * 2.55; // 15.3
    expect(Math.sqrt(0.59 * 900)).toBeGreaterThan(thr);
    expect(Math.sqrt(0.11 * 900)).toBeLessThan(thr);
    const sel = wandSelection(px, 0, 1, 6, { contiguous: false, antialias: false })!;
    expect(selectionAlpha(sel, 0, 1)).toBe(255); // seed joins
    expect(selectionAlpha(sel, 2, 1)).toBe(255); // blue neighbor joins
    expect(selectionAlpha(sel, 1, 1)).toBe(0); // green neighbor stays out
  });
});

describe('growSelection / shrinkSelection / smoothSelection', () => {
  it('grow expands the mask by the given radius', () => {
    const base = rectSelection(9, 9, { x: 3, y: 3, width: 3, height: 3 })!;
    const grown = growSelection(base, 2);
    expect(grown.bounds).toEqual({ x: 1, y: 1, width: 7, height: 7 });
    expect(selectionAlpha(grown, 2, 2)).toBe(255); // 2 px out is now inside
    expect(selectionAlpha(grown, 0, 0)).toBe(0); // 3 px out is still out
  });

  it('shrink contracts the mask by the given radius', () => {
    const base = rectSelection(9, 9, { x: 2, y: 2, width: 5, height: 5 })!;
    const shrunk = shrinkSelection(base, 1);
    // Interior core survives, the outer ring is eaten away.
    expect(selectionAlpha(shrunk, 4, 4)).toBe(255);
    expect(selectionAlpha(shrunk, 2, 4)).toBe(0);
    expect(selectionAlpha(shrunk, 6, 6)).toBe(0);
  });

  it('smooth rounds off protruding specks and keeps the body', () => {
    // A solid body with a 1 px protrusion: smoothing (blur + re-threshold)
    // drops the jagged speck but leaves the body intact.
    const body = rectSelection(9, 9, { x: 2, y: 2, width: 4, height: 4 })!;
    const speck = rectSelection(9, 9, { x: 6, y: 4, width: 1, height: 1 })!;
    const jagged = combineSelection(body, speck, 'add')!;
    const sm = smoothSelection(jagged, 1);
    expect(selectionAlpha(sm, 4, 4)).toBe(255); // body interior survives
    expect(selectionAlpha(sm, 6, 4)).toBe(0); // the speck is gone
    expect(selectionAlpha(sm, 8, 8)).toBe(0); // outside stays out
    // Smooth re-thresholds, so the output is a clean binary mask.
    expect(Array.from(sm.mask).every((v) => v === 0 || v === 255)).toBe(true);
  });
});

describe('featherSelection', () => {
  it('expands bounds and softens the mask edges', () => {
    const base = rectSelection(9, 9, { x: 3, y: 3, width: 3, height: 3 })!;
    const soft = featherSelection(base, 2);
    // Bounds grow by 3 × radius so the 3-pass (gaussian-style) blur sees out.
    expect(soft.bounds).toEqual({ x: -3, y: -3, width: 15, height: 15 });
    expect(soft.rect).toBeNull();
    expect(soft.mask.length).toBe(225);
    // Corners radiate ~6px (the 3-pass support = 3r) but land on a negligible
    // trace — effectively unselected compared to the solid interior.
    expect(selectionAlpha(soft, 0, 0)).toBeLessThan(10);
    expect(selectionAlpha(soft, 8, 8)).toBeLessThan(10);
    // The mask peaks at the centre of the original box, but the blur erodes
    // it well below solid — a true falloff, not a binary edge.
    const center = soft.mask[7 * 15 + 7];
    expect(center).toBe(Math.max(...soft.mask));
    expect(center).toBeGreaterThan(30);
    expect(center).toBeLessThan(255);
    // Just outside the original edge the falloff is a real intermediate
    // value that tapers toward zero as it radiates away.
    const near = soft.mask[10 * 15 + 9]; // ~1 px outside the old box
    const far = soft.mask[10 * 15 + 11]; // ~3 px outside
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(center);
    expect(far).toBeLessThan(near);
    // …and the whole mask is a gradient, not a binary edge.
    expect(Array.from(soft.mask).some((v) => v > 0 && v < 255)).toBe(true);
  });
});

describe('computeOutline', () => {
  it('marks a dashed boundary ring and nothing inside (bounds-local)', () => {
    const sel = rectSelection(5, 5, { x: 1, y: 1, width: 3, height: 3 })!;
    const out = computeOutline(sel);
    // Output covers the selection bounds (3 × 3), not the whole document.
    expect(out.length).toBe(3 * 3 * 4);
    const alphaAt = (x: number, y: number) => out[(y * 3 + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(255); // corner
    expect(alphaAt(1, 0)).toBe(255); // top edge
    expect(alphaAt(1, 1)).toBe(0); // interior
    // Dashes alternate black/white along the edge.
    const v1 = out[(0 * 3 + 1) * 4];
    const v2 = out[(0 * 3 + 2) * 4];
    expect(v1).not.toBe(v2);
  });
});

describe('selectionAlpha', () => {
  it('is 255 with no selection and 0 outside bounds', () => {
    expect(selectionAlpha(null, 99, 99)).toBe(255);
    const sel = rectSelection(10, 10, { x: 4, y: 4, width: 2, height: 2 })!;
    expect(selectionAlpha(sel, 5, 5)).toBe(255);
    expect(selectionAlpha(sel, 3, 5)).toBe(0);
    expect(selectionAlpha(sel, 6, 5)).toBe(0);
  });
});

describe('ellipseSelection', () => {
  it('fills the ellipse interior and leaves corners empty with soft AA edges', () => {
    const sel = ellipseSelection(21, 21, { x: 0, y: 0, width: 21, height: 21 })!;
    expect(sel).not.toBeNull();
    expect(sel.rect).toBeNull(); // ellipses are never the vector fast path
    expect(selectionAlpha(sel, 10, 10)).toBe(255); // center
    expect(selectionAlpha(sel, 0, 0)).toBe(0); // corner
    expect(selectionAlpha(sel, 20, 0)).toBe(0);
    expect(selectionAlpha(sel, 20, 20)).toBe(0);
    // The rim is a gradient of partial values (anti-aliased edge).
    const vals = Array.from(sel.mask);
    expect(vals.some((v) => v > 0 && v < 255)).toBe(true);
  });

  it('selects an exact circle when width equals height', () => {
    const sel = ellipseSelection(9, 9, { x: 0, y: 0, width: 9, height: 9 })!;
    // Center fully selected, square corners empty — a circle, not a box.
    expect(selectionAlpha(sel, 4, 4)).toBe(255);
    expect(selectionAlpha(sel, 0, 0)).toBe(0);
    expect(selectionAlpha(sel, 8, 8)).toBe(0);
  });
});

describe('rowSelection / columnSelection', () => {
  it('creates a single-pixel row across the document', () => {
    const sel = rowSelection(6, 4, 2)!;
    expect(sel).not.toBeNull();
    expect(sel.bounds).toEqual({ x: 0, y: 2, width: 6, height: 1 });
    expect(sel.mask.every((v) => v === 255)).toBe(true);
    expect(rowSelection(6, 4, 9)).toBeNull();
    expect(rowSelection(6, 4, -1)).toBeNull();
  });

  it('creates a single-pixel column across the document', () => {
    const sel = columnSelection(6, 4, 3)!;
    expect(sel).not.toBeNull();
    expect(sel.bounds).toEqual({ x: 3, y: 0, width: 1, height: 4 });
    expect(columnSelection(6, 4, 6)).toBeNull();
  });
});

describe('combineSelection', () => {
  const A = () => rectSelection(10, 10, { x: 0, y: 0, width: 6, height: 6 })!;
  const B = () => rectSelection(10, 10, { x: 4, y: 4, width: 6, height: 6 })!;

  it('new mode replaces the previous selection', () => {
    const out = combineSelection(A(), B(), 'new')!;
    expect(selectionAlpha(out, 5, 5)).toBe(255);
    expect(selectionAlpha(out, 0, 0)).toBe(0); // old area gone
  });

  it('add mode unions both masks', () => {
    const out = combineSelection(A(), B(), 'add')!;
    expect(selectionAlpha(out, 0, 0)).toBe(255); // from A
    expect(selectionAlpha(out, 9, 9)).toBe(255); // from B
    expect(selectionAlpha(out, 5, 5)).toBe(255); // overlap
    expect(selectionAlpha(out, 9, 0)).toBe(0); // outside both
  });

  it('subtract mode removes the second mask from the first', () => {
    const out = combineSelection(A(), B(), 'subtract')!;
    expect(selectionAlpha(out, 0, 0)).toBe(255); // untouched
    expect(selectionAlpha(out, 5, 5)).toBe(0); // removed overlap
    expect(selectionAlpha(out, 9, 9)).toBe(0); // B-only was never in A
  });

  it('intersect mode keeps only the overlap', () => {
    const out = combineSelection(A(), B(), 'intersect')!;
    expect(selectionAlpha(out, 5, 5)).toBe(255);
    expect(selectionAlpha(out, 0, 0)).toBe(0);
    expect(selectionAlpha(out, 9, 9)).toBe(0);
  });

  it('intersect of disjoint selections yields null', () => {
    const far = rectSelection(10, 10, { x: 8, y: 8, width: 2, height: 2 })!;
    expect(combineSelection(A(), far, 'intersect')).toBeNull();
  });

  it('subtracting from nothing stays nothing; adding to nothing adopts the new mask', () => {
    const a = A();
    const b = B();
    expect(combineSelection(null, b, 'subtract')).toBeNull();
    expect(combineSelection(null, b, 'add')).toBe(b);
    expect(combineSelection(a, null, 'add')).toBe(a);
    expect(combineSelection(a, null, 'subtract')).toBe(a);
  });

  it('subtracting everything yields null', () => {
    const whole = selectAll(10, 10);
    expect(combineSelection(whole, whole, 'subtract')).toBeNull();
  });
});

describe('wandSelection options', () => {
  function twoRegions(): PixelBuffer {
    // Left half black, right half white, two disconnected black islands on the right.
    const px = buffer(6, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 3; x < 6; x++) {
        const i = (y * 6 + x) * 4;
        px.data[i] = 255;
        px.data[i + 1] = 255;
        px.data[i + 2] = 255;
      }
    }
    // isolated black pixels inside the white region
    px.data[(1 * 6 + 4) * 4] = 0;
    px.data[(1 * 6 + 4) * 4 + 1] = 0;
    px.data[(1 * 6 + 4) * 4 + 2] = 0;
    px.data[(2 * 6 + 5) * 4] = 0;
    px.data[(2 * 6 + 5) * 4 + 1] = 0;
    px.data[(2 * 6 + 5) * 4 + 2] = 0;
    return px;
  }

  it('contiguous:false selects every matching pixel in the document', () => {
    const px = twoRegions();
    const cont = wandSelection(px, 0, 0, 10, { contiguous: true, antialias: false })!;
    expect(cont.bounds).toEqual({ x: 0, y: 0, width: 3, height: 4 });
    const global = wandSelection(px, 0, 0, 10, { contiguous: false, antialias: false })!;
    expect(selectionAlpha(global, 4, 1)).toBe(255); // the isolated island
    expect(selectionAlpha(global, 5, 2)).toBe(255);
    expect(selectionAlpha(global, 3, 0)).toBe(0); // white pixels never match
  });

  it('antialias:false keeps a hard binary edge', () => {
    const px = buffer(4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 2; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        px.data[i] = 255;
        px.data[i + 1] = 255;
        px.data[i + 2] = 255;
      }
    }
    const hard = wandSelection(px, 0, 0, 10, { antialias: false })!;
    expect(hard.mask.every((v) => v === 0 || v === 255)).toBe(true);
  });

  it('antialias:true keeps the interior solid and softens only the rim', () => {
    const px = buffer(6, 6);
    const sel = wandSelection(px, 3, 3, 10, { antialias: true })!;
    // Everything is black and within tolerance, so the whole doc is selected.
    // The interior stays fully selected even with AA.
    expect(selectionAlpha(sel, 3, 3)).toBe(255);
    expect(sel.mask.every((v) => v === 255)).toBe(true); // image borders count as interior
  });

  it('returns null when the seed is out of bounds', () => {
    const px = buffer(3, 3, [10, 20, 30, 255]);
    expect(wandSelection(px, 5, 1, 5)).toBeNull();
    expect(wandSelection(px, 1, -2, 5)).toBeNull();
  });
});

describe('offsetSelection', () => {
  it('translates bounds and rect while sharing the mask', () => {
    const sel = rectSelection(20, 20, { x: 2, y: 3, width: 5, height: 4 })!;
    const moved = offsetSelection(sel, 4, 1);
    expect(moved.bounds).toEqual({ x: 6, y: 4, width: 5, height: 4 });
    expect(moved.rect).toEqual({ x: 6, y: 4, width: 5, height: 4 });
    expect(moved.mask).toBe(sel.mask); // masks are immutable — shared, not copied
  });

  it('returns the same object for a zero offset', () => {
    const sel = rectSelection(20, 20, { x: 1, y: 1, width: 3, height: 3 })!;
    expect(offsetSelection(sel, 0, 0)).toBe(sel);
  });
});

describe('object-select edge barrier', () => {
  it('stops growth at a strong edge even when colors still match', () => {
    // Uniform color with a flagged "edge" column: the flood must refuse to
    // step onto it despite a perfect color match.
    const px = buffer(24, 12, [255, 0, 0, 255]);
    const map = new Float32Array(24 * 12);
    for (let y = 0; y < 12; y++) map[y * 24 + 12] = 200;
    const sel = wandSelection(px, 4, 6, 10, {
      contiguous: true,
      antialias: false,
      edge: { map, threshold: 100 },
    });
    expect(sel).not.toBeNull();
    expect(selectionAlpha(sel, 4, 6)).toBe(255);
    expect(sel!.bounds.x + sel!.bounds.width).toBe(12); // stopped before column 12
    expect(selectionAlpha(sel, 13, 6)).toBe(0);
  });

  it('always lets the seed enter even when it sits on an edge', () => {
    const px = buffer(8, 8, [10, 200, 90, 255]);
    const map = new Float32Array(8 * 8).fill(255); // everything is an edge
    const sel = wandSelection(px, 4, 4, 10, {
      contiguous: true,
      antialias: false,
      edge: { map, threshold: 100 },
    });
    expect(sel).not.toBeNull();
    expect(selectionAlpha(sel, 4, 4)).toBe(255);
    expect(sel!.bounds).toEqual({ x: 4, y: 4, width: 1, height: 1 }); // seed only
  });
});

describe('expandQuickSelection', () => {
  function twoTone(): PixelBuffer {
    const px = buffer(16, 8, [255, 0, 0, 255]);
    for (let y = 0; y < 8; y++) {
      for (let x = 8; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        px.data[o] = 0;
        px.data[o + 1] = 0;
        px.data[o + 2] = 255;
      }
    }
    return px;
  }

  it('floods the matching color under the brush and skips the rest', () => {
    const px = twoTone();
    const dab = expandQuickSelection(px, 3, 4, 4, 20, null);
    expect(dab).not.toBeNull();
    expect(selectionAlpha(dab, 3, 4)).toBe(255);
    expect(selectionAlpha(dab, 12, 4)).toBe(0); // other color never selected
  });

  it('unions dabs across strokes and keeps the previous selection', () => {
    const px = buffer(16, 8, [255, 0, 0, 255]);
    for (let y = 4; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        px.data[o] = 0;
        px.data[o + 1] = 0;
        px.data[o + 2] = 255;
      }
    }
    const dab1 = expandQuickSelection(px, 8, 1, 3, 20, null);
    expect(dab1).not.toBeNull();
    expect(selectionAlpha(dab1!, 8, 6)).toBe(0); // blue not in the first dab
    const dab2 = expandQuickSelection(px, 8, 6, 3, 20, dab1);
    expect(dab2).not.toBeNull();
    expect(selectionAlpha(dab2!, 8, 6)).toBe(255);
    expect(selectionAlpha(dab2!, 8, 1)).toBe(255); // first dab retained
  });

  it('bounds growth to the brush circle even on a uniform image', () => {
    const px = buffer(32, 32, [255, 0, 0, 255]);
    const dab = expandQuickSelection(px, 16, 16, 4, 50, null);
    expect(dab).not.toBeNull();
    expect(selectionAlpha(dab, 16, 16)).toBe(255);
    expect(selectionAlpha(dab, 2, 2)).toBe(0); // flood stopped at the circle
  });

  it('keeps the previous selection when the seed is out of bounds', () => {
    const px = buffer(8, 8, [255, 0, 0, 255]);
    const prev = rectSelection(8, 8, { x: 0, y: 0, width: 2, height: 2 });
    expect(expandQuickSelection(px, 40, 40, 4, 20, prev)).toBe(prev);
  });

  it('yields identical results with a shared scratch buffer', () => {
    const px = twoTone();
    const fresh = expandQuickSelection(px, 3, 4, 4, 20, null);
    const scratch = new Uint8Array(px.width * px.height);
    const reused = expandQuickSelection(px, 3, 4, 4, 20, null, { visited: scratch });
    expect(reused).toEqual(fresh);
    // A later dab through the same scratch must also match a fresh run.
    const fresh2 = expandQuickSelection(px, 10, 4, 4, 20, null);
    const reused2 = expandQuickSelection(px, 10, 4, 4, 20, null, { visited: scratch });
    expect(reused2).toEqual(fresh2);
  });
});

describe('wandSelection bounds & scratch', () => {
  it('clamps the flood to the requested rectangle', () => {
    const px = buffer(40, 40, [255, 0, 0, 255]);
    const sel = wandSelection(px, 5, 5, 10, { bounds: { x: 0, y: 0, width: 12, height: 10 } });
    expect(sel).not.toBeNull();
    expect(sel!.bounds).toEqual({ x: 0, y: 0, width: 12, height: 10 });
    expect(sel!.mask.length).toBe(12 * 10); // mask sized to the bounded box
  });

  it('clears the bounded region of a reused scratch buffer', () => {
    const px = buffer(16, 16, [255, 0, 0, 255]);
    const scratch = new Uint8Array(16 * 16);
    // First dab marks its box as visited (selected).
    const a = wandSelection(px, 2, 2, 5, {
      bounds: { x: 0, y: 0, width: 6, height: 6 },
      visited: scratch,
      antialias: false,
    });
    expect(a).not.toBeNull();
    expect(scratch[3 * 16 + 3]).toBe(2); // stale flag left behind...
    // ...which must NOT make a later dab skip its seed and report no match.
    const b = wandSelection(px, 3, 3, 5, {
      bounds: { x: 1, y: 1, width: 6, height: 6 },
      visited: scratch,
      antialias: false,
    });
    expect(b).not.toBeNull();
    expect(b!.bounds).toEqual({ x: 1, y: 1, width: 6, height: 6 });
  });

  it('produces identical results with and without a scratch buffer', () => {
    const px = buffer(12, 12, [10, 200, 90, 255]);
    const fresh = wandSelection(px, 6, 6, 40, { bounds: { x: 2, y: 2, width: 8, height: 8 } });
    const scratch = new Uint8Array(12 * 12);
    const reused = wandSelection(px, 6, 6, 40, {
      bounds: { x: 2, y: 2, width: 8, height: 8 },
      visited: scratch,
    });
    expect(reused).toEqual(fresh);
  });
});
