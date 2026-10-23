import { describe, expect, it } from 'vitest';
import {
  applyAngleGradient,
  applyDiamondGradient,
  applyLinearGradient,
  applyRadialGradient,
  applyReflectedGradient,
  bgEraseStroke,
  blurStroke,
  cloneStroke,
  clearPixels,
  dodgeBurnStroke,
  eraseStroke,
  fillEllipse,
  fillPixels,
  fillPolygon,
  fillRect,
  fillRoundedRect,
  floodErase,
  floodFill,
  healStroke,
  hexToRgba,
  invertPixels,
  paintStroke,
  patchFill,
  pencilStroke,
  redEyeStroke,
  replaceColorStroke,
  sharpenStroke,
  smudgeStroke,
  spongeStroke,
  spotHealStroke,
  strokeThickLine,
  NO_CONTEXT,
  type PaintContext,
  type Rgba,
} from './paint';
import { rectSelection } from '../core/document/selection';
import type { PixelBuffer } from '../core/document/types';

function solid(w: number, h: number, color: Rgba): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = color.r;
    data[i * 4 + 1] = color.g;
    data[i * 4 + 2] = color.b;
    data[i * 4 + 3] = color.a;
  }
  return { width: w, height: h, data };
}

function pxAt(buf: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]];
}

/** Stroke-start snapshot for the src-based effect tools. */
function snap(buf: PixelBuffer): PixelBuffer {
  return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
}

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };

describe('hexToRgba', () => {
  it('parses 6-digit and 3-digit hex', () => {
    expect(hexToRgba('#ff8000')).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(hexToRgba('#f80')).toEqual({ r: 255, g: 136, b: 0, a: 255 });
    expect(hexToRgba('00ff00')).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it('falls back to black for garbage input', () => {
    expect(hexToRgba('#zzz').r).toBe(0);
  });
});

describe('paintStroke', () => {
  it('paints the color inside the brush and leaves the rim soft', () => {
    const buf = solid(24, 24, BLACK);
    paintStroke(buf, [{ x: 12, y: 12 }], { size: 12, opacity: 1 }, RED);
    const [r, g, b] = pxAt(buf, 12, 12);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // Outside the brush radius: untouched.
    expect(pxAt(buf, 0, 0)).toEqual([0, 0, 0, 255]);
    // Rim is a blend, not a hard cut.
    const rim = pxAt(buf, 12, 6);
    expect(rim[0]).toBeGreaterThan(0);
    expect(rim[0]).toBeLessThan(255);
    expect(rim[1]).toBe(0); // red over black never raises green
  });

  it('honors opacity', () => {
    const buf = solid(24, 24, BLACK);
    paintStroke(buf, [{ x: 12, y: 12 }], { size: 16, opacity: 0.5 }, WHITE);
    const [r] = pxAt(buf, 12, 12);
    expect(r).toBeGreaterThan(80);
    expect(r).toBeLessThan(160);
  });

  it('interpolates between two points (no gaps)', () => {
    const buf = solid(40, 12, BLACK);
    paintStroke(buf, [{ x: 4, y: 6 }, { x: 36, y: 6 }], { size: 6, opacity: 1 }, WHITE);
    for (let x = 5; x <= 35; x += 5) {
      expect(pxAt(buf, x, 6)[0]).toBe(255);
    }
  });

  it('clips writes to the buffer bounds', () => {
    const buf = solid(8, 8, BLACK);
    expect(() => paintStroke(buf, [{ x: -50, y: -50 }], { size: 20, opacity: 1 }, RED)).not.toThrow();
    expect(() => paintStroke(buf, [{ x: 100, y: 100 }], { size: 20, opacity: 1 }, RED)).not.toThrow();
  });

  it('gates writes through an active selection', () => {
    const buf = solid(16, 16, BLACK);
    const ctx: PaintContext = {
      selection: rectSelection(16, 16, { x: 0, y: 0, width: 8, height: 16 })!,
      origin: { x: 0, y: 0 },
    };
    paintStroke(buf, [{ x: 8, y: 8 }], { size: 8, opacity: 1 }, RED, ctx);
    // Inside the selection half: painted.
    expect(pxAt(buf, 6, 8)[0]).toBe(255);
    // Outside it: untouched even though the brush overlaps.
    expect(pxAt(buf, 11, 8)).toEqual([0, 0, 0, 255]);
  });

  it('applies the layer origin when gating a moved layer', () => {
    const buf = solid(16, 16, BLACK);
    const ctx: PaintContext = {
      selection: rectSelection(32, 32, { x: 0, y: 0, width: 8, height: 32 })!,
      origin: { x: 8, y: 0 }, // buffer (0,0) is document (8,0)
    };
    paintStroke(buf, [{ x: 2, y: 8 }], { size: 4, opacity: 1 }, RED, ctx);
    // buffer x=2 → doc x=10 → outside the 0..8 selection → no write.
    expect(pxAt(buf, 2, 8)).toEqual([0, 0, 0, 255]);
  });
});

describe('eraseStroke', () => {
  it('reduces alpha toward transparency', () => {
    const buf = solid(24, 24, WHITE);
    eraseStroke(buf, [{ x: 12, y: 12 }], { size: 24, opacity: 1 });
    expect(pxAt(buf, 12, 12)[3]).toBe(0);
    expect(pxAt(buf, 0, 0)[3]).toBe(255); // outside radius
    expect(pxAt(buf, 12, 12)[0]).toBe(255); // RGB preserved
  });
});

describe('dodgeBurnStroke', () => {
  it('dodge lightens midtones toward white', () => {
    const buf = solid(16, 16, { r: 100, g: 100, b: 100, a: 255 });
    dodgeBurnStroke(buf, snap(buf), [{ x: 8, y: 8 }], { size: 16, opacity: 1 }, 'dodge');
    expect(pxAt(buf, 8, 8)[0]).toBeGreaterThan(100);
  });

  it('burn darkens midtones toward black', () => {
    const buf = solid(16, 16, { r: 100, g: 100, b: 100, a: 255 });
    dodgeBurnStroke(buf, snap(buf), [{ x: 8, y: 8 }], { size: 16, opacity: 1 }, 'burn');
    expect(pxAt(buf, 8, 8)[0]).toBeLessThan(100);
  });
});

describe('blurStroke / sharpenStroke', () => {
  it('blur softens a hard edge', () => {
    const buf = solid(32, 16, BLACK);
    // Right half white.
    for (let y = 0; y < 16; y++) {
      for (let x = 16; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        buf.data[i] = 255;
        buf.data[i + 1] = 255;
        buf.data[i + 2] = 255;
      }
    }
    const before = pxAt(buf, 16, 8);
    blurStroke(buf, snap(buf), [{ x: 16, y: 8 }], { size: 24, opacity: 1 });
    const after = pxAt(buf, 16, 8);
    // The hard 0→255 jump at x=16 is pulled toward its neighbors.
    expect(after[0]).toBeLessThan(before[0]);
    expect(after[0]).toBeGreaterThan(0);
  });

  it('sharpen pushes contrast away from the local average', () => {
    const buf = solid(32, 16, { r: 120, g: 120, b: 120, a: 255 });
    // A few bright specks.
    buf.data[(8 * 32 + 16) * 4] = 200;
    buf.data[(8 * 32 + 16) * 4 + 1] = 200;
    buf.data[(8 * 32 + 16) * 4 + 2] = 200;
    sharpenStroke(buf, snap(buf), [{ x: 16, y: 8 }], { size: 16, opacity: 1 });
    const [r] = pxAt(buf, 16, 8);
    expect(r).toBeGreaterThanOrEqual(200); // speck pushed up (or held at clamp)
    const corner = pxAt(buf, 4, 4);
    expect(corner[0]).toBeLessThanOrEqual(120); // flat area pushed down
  });
});

describe('floodFill', () => {
  it('fills only the contiguous region within tolerance', () => {
    const buf = solid(6, 4, WHITE);
    // Vertical barrier of gray down the middle.
    for (let y = 0; y < 4; y++) {
      const i = (y * 6 + 3) * 4;
      buf.data[i] = 128;
      buf.data[i + 1] = 128;
      buf.data[i + 2] = 128;
    }
    expect(floodFill(buf, 0, 0, RED, 10)).toBe(true);
    expect(pxAt(buf, 0, 0)[0]).toBe(255);
    expect(pxAt(buf, 2, 3)[0]).toBe(255);
    expect(pxAt(buf, 3, 0)).toEqual([128, 128, 128, 255]); // barrier intact
    expect(pxAt(buf, 5, 0)).toEqual([255, 255, 255, 255]); // far side untouched
  });

  it('returns false when the seed is out of bounds', () => {
    expect(floodFill(solid(4, 4, WHITE), 9, 9, RED, 10)).toBe(false);
  });

  it('respects the selection gate', () => {
    const buf = solid(8, 8, WHITE);
    const ctx: PaintContext = {
      selection: rectSelection(8, 8, { x: 0, y: 0, width: 4, height: 8 })!,
      origin: { x: 0, y: 0 },
    };
    floodFill(buf, 0, 0, RED, 10, ctx);
    expect(pxAt(buf, 3, 4)[0]).toBe(255);
    expect(pxAt(buf, 4, 4)).toEqual([255, 255, 255, 255]); // unselected side
  });
});

describe('applyLinearGradient', () => {
  it('interpolates from start color to end color along the axis', () => {
    const buf = solid(16, 4, BLACK);
    applyLinearGradient(buf, 0, 0, 16, 0, { r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 });
    const start = pxAt(buf, 0, 2)[0];
    const mid = pxAt(buf, 8, 2)[0];
    const end = pxAt(buf, 15, 2)[0];
    expect(start).toBeLessThan(40);
    expect(mid).toBeGreaterThan(90);
    expect(mid).toBeLessThan(170);
    expect(end).toBeGreaterThan(215);
  });

  it('is clipped to the selection', () => {
    const buf = solid(8, 8, BLACK);
    const ctx: PaintContext = {
      selection: rectSelection(8, 8, { x: 0, y: 0, width: 8, height: 4 })!,
      origin: { x: 0, y: 0 },
    };
    applyLinearGradient(buf, 0, 0, 8, 0, RED, WHITE, ctx);
    expect(pxAt(buf, 4, 1)[0]).toBeGreaterThan(0);
    expect(pxAt(buf, 4, 6)).toEqual([0, 0, 0, 255]);
  });
});

describe('fillRect / fillEllipse', () => {
  it('fills the rectangle area', () => {
    const buf = solid(16, 16, BLACK);
    fillRect(buf, { x: 4, y: 4, width: 8, height: 8 }, RED);
    expect(pxAt(buf, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pxAt(buf, 1, 1)).toEqual([0, 0, 0, 255]);
  });

  it('covers fractional rect edges proportionally', () => {
    const buf = solid(8, 8, BLACK);
    fillRect(buf, { x: 2.5, y: 0, width: 3, height: 8 }, WHITE);
    const edge = pxAt(buf, 2, 0)[0];
    expect(edge).toBeGreaterThan(80);
    expect(edge).toBeLessThan(180); // half-covered pixel ≈ 50 %
  });

  it('fills an ellipse but not its bounding corners', () => {
    const buf = solid(16, 16, BLACK);
    fillEllipse(buf, { x: 2, y: 2, width: 12, height: 12 }, RED);
    expect(pxAt(buf, 8, 8)).toEqual([255, 0, 0, 255]); // center
    expect(pxAt(buf, 2, 2)[3]).toBe(255);
    expect(pxAt(buf, 2, 2)[0]).toBe(0); // corner stays black
  });
});

describe('cloneStroke / healStroke', () => {
  function scene(): { buf: PixelBuffer; src: PixelBuffer } {
    const buf = solid(32, 32, BLACK);
    // A white blob at (24, 8) that we will clone over a black area.
    for (let y = 4; y < 13; y++) {
      for (let x = 20; x < 29; x++) {
        const i = (y * 32 + x) * 4;
        buf.data[i] = 255;
        buf.data[i + 1] = 255;
        buf.data[i + 2] = 255;
      }
    }
    const src: PixelBuffer = { width: 32, height: 32, data: new Uint8ClampedArray(buf.data) };
    return { buf, src };
  }

  it('copies from the source offset', () => {
    const { buf, src } = scene();
    // Paint at (8, 20); sample should come from (8+16, 20-12) = (24, 8) — white.
    cloneStroke(buf, src, [{ x: 8, y: 20 }], { size: 8, opacity: 1 }, { x: -16, y: 12 });
    expect(pxAt(buf, 8, 20)[0]).toBe(255);
    expect(pxAt(buf, 24, 8)[0]).toBe(255); // source region untouched
  });

  it('skips transparent source pixels', () => {
    const buf = solid(16, 16, BLACK);
    const src = solid(16, 16, { r: 255, g: 255, b: 255, a: 0 });
    cloneStroke(buf, src, [{ x: 8, y: 8 }], { size: 8, opacity: 1 }, { x: 0, y: 0 });
    expect(pxAt(buf, 8, 8)).toEqual([0, 0, 0, 255]);
  });

  it('heal blends the sample toward the destination brightness', () => {
    const { buf, src } = scene();
    // Destination is black; sample is white → healing should not paint pure white.
    healStroke(buf, src, [{ x: 8, y: 20 }], { size: 8, opacity: 1 }, { x: -16, y: 12 });
    const value = pxAt(buf, 8, 20)[0];
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(255); // brightness-matched, not a raw copy
  });
});

describe('clearPixels', () => {
  it('clears everything without a partial selection', () => {
    const buf = solid(6, 6, WHITE);
    clearPixels(buf, { selection: null, origin: { x: 0, y: 0 } }, false);
    expect(pxAt(buf, 3, 3)[3]).toBe(0);
  });

  it('clears only inside the selection when partial', () => {
    const buf = solid(6, 6, WHITE);
    const ctx: PaintContext = {
      selection: rectSelection(6, 6, { x: 0, y: 0, width: 3, height: 6 })!,
      origin: { x: 0, y: 0 },
    };
    clearPixels(buf, ctx, true);
    expect(pxAt(buf, 1, 3)[3]).toBe(0);
    expect(pxAt(buf, 5, 3)[3]).toBe(255);
  });
});

describe('stamp hardness & flow', () => {
  it('hardness 100 produces a hard-edged stamp', () => {
    const soft = solid(21, 21, WHITE);
    const hard = solid(21, 21, WHITE);
    paintStroke(soft, [{ x: 10, y: 10 }], { size: 12, opacity: 1, hardness: 0 }, BLACK);
    paintStroke(hard, [{ x: 10, y: 10 }], { size: 12, opacity: 1, hardness: 1 }, BLACK);
    // The rim pixel (just inside the radius) is fully black when hard…
    expect(pxAt(hard, 15, 10)[0]).toBe(0);
    // …but still mostly white when fully feathered.
    expect(pxAt(soft, 15, 10)[0]).toBeGreaterThan(120);
  });

  it('flow scales how much each stamp deposits', () => {
    const full = solid(21, 21, WHITE);
    const light = solid(21, 21, WHITE);
    paintStroke(full, [{ x: 10, y: 10 }], { size: 16, opacity: 1, flow: 1 }, BLACK);
    paintStroke(light, [{ x: 10, y: 10 }], { size: 16, opacity: 1, flow: 0.3 }, BLACK);
    const cf = pxAt(full, 10, 10)[0];
    const cl = pxAt(light, 10, 10)[0];
    expect(cf).toBe(0);
    expect(cl).toBeGreaterThan(cf);
    expect(cl).toBeLessThan(255);
  });
});

describe('dodgeBurnStroke tonal range', () => {
  function gray21(v: number) {
    return solid(21, 21, { r: v, g: v, b: v, a: 255 });
  }

  it('midtones dodge leaves near-black shadows almost untouched', () => {
    const buf = gray21(16);
    dodgeBurnStroke(buf, snap(buf), [{ x: 10, y: 10 }], { size: 20, opacity: 1 }, 'dodge', NO_CONTEXT, 'midtones');
    expect(pxAt(buf, 10, 10)[0]).toBeLessThan(20);
  });

  it('shadows dodge lifts dark pixels strongly', () => {
    const buf = gray21(16);
    dodgeBurnStroke(buf, snap(buf), [{ x: 10, y: 10 }], { size: 20, opacity: 1 }, 'dodge', NO_CONTEXT, 'shadows');
    expect(pxAt(buf, 10, 10)[0]).toBeGreaterThan(80);
  });

  it('highlights burn leaves dark pixels alone but darkens bright ones', () => {
    const dark = gray21(20);
    const bright = gray21(235);
    dodgeBurnStroke(dark, snap(dark), [{ x: 10, y: 10 }], { size: 20, opacity: 1 }, 'burn', NO_CONTEXT, 'highlights');
    dodgeBurnStroke(bright, snap(bright), [{ x: 10, y: 10 }], { size: 20, opacity: 1 }, 'burn', NO_CONTEXT, 'highlights');
    expect(pxAt(dark, 10, 10)[0]).toBeGreaterThan(15);
    expect(pxAt(bright, 10, 10)[0]).toBeLessThan(200);
  });

  it('slow multi-segment strokes converge instead of blowing out', () => {
    // Regression: every pointer event used to re-stamp the segment joint,
    // stacking dodge until the image blew out to white/red streaks.
    const buf = solid(48, 32, { r: 120, g: 100, b: 80, a: 255 });
    const base = snap(buf);
    const state = { carry: 0, started: false };
    const ctx = { selection: null, origin: { x: 0, y: 0 }, strokeState: state };
    for (let i = 0; i < 16; i++) {
      dodgeBurnStroke(
        buf,
        base,
        [
          { x: 8 + i, y: 16 },
          { x: 8 + i + 0.4, y: 16 },
        ],
        { size: 16, opacity: 0.1 },
        'dodge',
        ctx,
        'midtones',
      );
    }
    const [r, g] = pxAt(buf, 14, 16);
    // One pass at k ≤ 0.1: at most ~10% of the headroom, never stacked.
    expect(r).toBeLessThanOrEqual(135);
    expect(r).toBeGreaterThanOrEqual(120);
    expect(g).toBeLessThanOrEqual(112); // no channel blow-out either
  });

  it('a shared stroke state never re-stamps the segment joint', () => {
    const buf = solid(16, 16, { r: 0, g: 0, b: 0, a: 255 });
    const state = { carry: 0, started: false };
    const ctx = { selection: null, origin: { x: 0, y: 0 }, strokeState: state };
    eraseStroke(buf, [{ x: 8, y: 8 }], { size: 8, opacity: 0.5 }, ctx);
    const after1 = pxAt(buf, 8, 8)[3];
    expect(after1).toBeGreaterThan(0);
    // A tiny follow-up segment (less than one dab-step) adds nothing at the joint.
    eraseStroke(buf, [{ x: 8, y: 8 }, { x: 8.2, y: 8 }], { size: 8, opacity: 0.5 }, ctx);
    expect(pxAt(buf, 8, 8)[3]).toBe(after1);
  });
});

describe('applyRadialGradient', () => {
  it('fades from the start color at the center to the end color at the radius', () => {
    const buf = solid(21, 21, BLACK);
    applyRadialGradient(buf, 10, 10, 20, 10, WHITE, BLACK);
    // Center is (nearly) the start color; edge is the end color. Gradients
    // sample at pixel centers, so the exact center is close-but-not 255.
    expect(pxAt(buf, 10, 10)[0]).toBeGreaterThan(200);
    expect(pxAt(buf, 20, 10)[0]).toBe(0);
    // A midpoint is between the two.
    const mid = pxAt(buf, 15, 10)[0];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
  });
});

describe('floodFill modes', () => {
  it('contiguous:false fills every matching pixel', () => {
    const buf = solid(4, 2, WHITE);
    // Make the right half black (a disconnected island of white remains at 0,0/0,1).
    for (let y = 0; y < 2; y++) {
      for (let x = 2; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        buf.data[i] = 0;
        buf.data[i + 1] = 0;
        buf.data[i + 2] = 0;
      }
    }
    // Seed on the white left half; with contiguous the black island stays.
    const cont = solid(4, 2, WHITE);
    cont.data.set(buf.data);
    expect(floodFill(cont, 0, 0, RED, 10, NO_CONTEXT, true)).toBe(true);
    expect(pxAt(cont, 3, 0)[0]).toBe(0); // island untouched
    // With contiguous:false every white pixel flips even if disconnected.
    const glob = solid(4, 2, WHITE);
    glob.data.set(buf.data);
    glob.data[(1 * 4 + 3) * 4] = 255; // white island in the black half
    glob.data[(1 * 4 + 3) * 4 + 1] = 255;
    glob.data[(1 * 4 + 3) * 4 + 2] = 255;
    expect(floodFill(glob, 0, 0, RED, 10, NO_CONTEXT, false)).toBe(true);
    expect(pxAt(glob, 3, 1)[0]).toBe(255); // the far island was filled
  });

  it('partial fill opacity blends instead of replacing', () => {
    const buf = solid(2, 1, WHITE);
    floodFill(buf, 0, 0, { ...RED, a: 128 }, 10, NO_CONTEXT, true);
    // 50 % red over white: red stays saturated, green/blue drop halfway.
    expect(pxAt(buf, 0, 0)[0]).toBe(255);
    const g = pxAt(buf, 0, 0)[1];
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(255);
  });
});

describe('fillPixels', () => {
  it('fills the whole buffer when there is no selection', () => {
    const buf = solid(4, 4, BLACK);
    fillPixels(buf, RED);
    expect(pxAt(buf, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pxAt(buf, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it('constrains the fill to the selection', () => {
    const buf = solid(4, 4, BLACK);
    const sel = rectSelection(4, 4, { x: 0, y: 0, width: 2, height: 4 })!;
    fillPixels(buf, RED, { selection: sel, origin: { x: 0, y: 0 } });
    expect(pxAt(buf, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pxAt(buf, 1, 3)).toEqual([255, 0, 0, 255]);
    expect(pxAt(buf, 2, 0)).toEqual([0, 0, 0, 255]);
    expect(pxAt(buf, 3, 3)).toEqual([0, 0, 0, 255]);
  });

  it('respects a translucent fill color over transparent pixels', () => {
    const buf = solid(2, 2, { r: 0, g: 0, b: 0, a: 0 });
    fillPixels(buf, { r: 255, g: 255, b: 255, a: 128 });
    const [r, g, b, a] = pxAt(buf, 0, 0);
    expect([r, g, b]).toEqual([255, 255, 255]);
    expect(a).toBeGreaterThanOrEqual(127);
    expect(a).toBeLessThanOrEqual(129);
  });
});

describe('invertPixels', () => {
  it('inverts every RGB channel when there is no selection', () => {
    const buf = solid(2, 2, { r: 10, g: 128, b: 200, a: 255 });
    invertPixels(buf);
    expect(pxAt(buf, 0, 0)).toEqual([245, 127, 55, 255]);
    expect(pxAt(buf, 1, 1)).toEqual([245, 127, 55, 255]);
  });

  it('keeps alpha and stays inside the selection', () => {
    const buf = solid(4, 1, { r: 0, g: 0, b: 0, a: 200 });
    const sel = rectSelection(4, 1, { x: 0, y: 0, width: 2, height: 1 })!;
    invertPixels(buf, { selection: sel, origin: { x: 0, y: 0 } });
    expect(pxAt(buf, 0, 0)).toEqual([255, 255, 255, 200]); // inside: inverted, alpha kept
    expect(pxAt(buf, 3, 0)).toEqual([0, 0, 0, 200]); // outside: untouched
  });
});

/* ------------------------------------------------------------------ */
/* Phase 7 sub-tools                                                   */
/* ------------------------------------------------------------------ */

function setPx(buf: PixelBuffer, x: number, y: number, color: Rgba): void {
  const i = (y * buf.width + x) * 4;
  buf.data[i] = color.r;
  buf.data[i + 1] = color.g;
  buf.data[i + 2] = color.b;
  buf.data[i + 3] = color.a;
}

describe('pencilStroke', () => {
  it('paints an aliased hard edge — every pixel is fully on or off', () => {
    const buf = solid(24, 24, BLACK);
    pencilStroke(buf, [{ x: 12, y: 12 }], { size: 10, opacity: 1 }, RED);
    expect(pxAt(buf, 12, 12)).toEqual([255, 0, 0, 255]);
    for (let x = 0; x < 24; x++) {
      const [r, g] = pxAt(buf, x, 12);
      expect(r === 0 || r === 255).toBe(true); // no blend ramp anywhere
      expect(g).toBe(0);
    }
    expect(pxAt(buf, 12, 1)).toEqual([0, 0, 0, 255]); // outside the circle
  });

  it('honors opacity', () => {
    const buf = solid(24, 24, BLACK);
    pencilStroke(buf, [{ x: 12, y: 12 }], { size: 8, opacity: 0.5 }, WHITE);
    const [r] = pxAt(buf, 12, 12);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(160);
  });
});

describe('replaceColorStroke', () => {
  it('recolors the sampled range, keeping luminosity, and spares other colors', () => {
    const buf = solid(16, 8, RED);
    for (let y = 0; y < 8; y++) {
      for (let x = 8; x < 16; x++) setPx(buf, x, y, { r: 0, g: 0, b: 255, a: 255 });
    }
    setPx(buf, 1, 4, { r: 255, g: 0, b: 255, a: 255 }); // magenta in-brush outlier
    const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };
    replaceColorStroke(buf, [{ x: 4, y: 4 }], { size: 6, opacity: 1 }, 10, GREEN);
    // Red under the stamp becomes green with red's luminosity preserved.
    const [r, g, b] = pxAt(buf, 4, 4);
    expect(g).toBeGreaterThan(100);
    expect(r).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    // Out-of-tolerance magenta inside the brush stays untouched.
    expect(pxAt(buf, 1, 4)).toEqual([255, 0, 255, 255]);
    // Blue half untouched.
    expect(pxAt(buf, 12, 4)).toEqual([0, 0, 255, 255]);
  });
});

describe('bgEraseStroke', () => {
  function twoReds(): PixelBuffer {
    const buf = solid(17, 9, { r: 0, g: 0, b: 255, a: 255 });
    setPx(buf, 8, 4, RED); // sample dot / flood seed
    setPx(buf, 6, 4, RED); // disconnected match, inside the brush's solid core
    setPx(buf, 13, 4, RED); // far disconnected match, out on the feathered rim
    setPx(buf, 13, 5, RED);
    return buf;
  }

  it('erases only connected matches inside the brush (contiguous)', () => {
    const buf = twoReds();
    bgEraseStroke(buf, [{ x: 8, y: 4 }], { size: 12, opacity: 1 }, null, 'continuous', 20, NO_CONTEXT, true);
    expect(pxAt(buf, 8, 4)[3]).toBe(0); // the sampled dot went
    expect(pxAt(buf, 6, 4)[3]).toBe(255); // disconnected match survived
    expect(pxAt(buf, 13, 4)[3]).toBe(255); // as did the one on the rim
    expect(pxAt(buf, 0, 0)[3]).toBe(255); // background color untouched
  });

  it('erases disconnected matches when the limit is discontiguous', () => {
    const buf = twoReds();
    bgEraseStroke(buf, [{ x: 8, y: 4 }], { size: 12, opacity: 1 }, null, 'continuous', 20, NO_CONTEXT, false);
    expect(pxAt(buf, 8, 4)[3]).toBe(0);
    expect(pxAt(buf, 6, 4)[3]).toBe(0); // core: fully erased
    expect(pxAt(buf, 13, 4)[3]).toBeGreaterThan(0); // rim: feathered, partial…
    expect(pxAt(buf, 13, 4)[3]).toBeLessThan(255); // …but still removed
    expect(pxAt(buf, 0, 0)[3]).toBe(255); // blue never matches the red sample
  });

  it('"once" locks the sample from the stroke start', () => {
    const buf = solid(17, 9, { r: 0, g: 0, b: 255, a: 255 });
    bgEraseStroke(
      buf,
      [{ x: 8, y: 4 }],
      { size: 12, opacity: 1 },
      { r: 255, g: 0, b: 0, a: 255 },
      'once',
      20,
      NO_CONTEXT,
      true,
    );
    expect(pxAt(buf, 8, 4)[3]).toBe(255); // blues don't match the locked red sample
  });
});

describe('smudgeStroke', () => {
  it('drags pixel content along the stroke', () => {
    const buf = solid(32, 16, WHITE);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) setPx(buf, x, y, RED);
    smudgeStroke(buf, [{ x: 6, y: 8 }, { x: 14, y: 8 }], { size: 10, opacity: 1 });
    const [r, g] = pxAt(buf, 10, 8);
    expect(r).toBeGreaterThan(200); // red dragged past its original boundary
    expect(g).toBeLessThan(50);
    expect(pxAt(buf, 30, 8)).toEqual([255, 255, 255, 255]); // far pixels untouched
  });

  it('does nothing on a single unmoved point (nothing to drag)', () => {
    const buf = solid(16, 16, WHITE);
    smudgeStroke(buf, [{ x: 8, y: 8 }], { size: 8, opacity: 1 });
    expect(pxAt(buf, 8, 8)).toEqual([255, 255, 255, 255]);
  });
});

describe('spongeStroke', () => {
  it('desaturates all the way to neutral at full strength', () => {
    const buf = solid(16, 16, { r: 200, g: 60, b: 60, a: 255 });
    spongeStroke(buf, snap(buf), [{ x: 8, y: 8 }], { size: 12, opacity: 1 }, 'desaturate');
    const [r, g, b] = pxAt(buf, 8, 8);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
    const lum = Math.round(0.299 * 200 + 0.587 * 60 + 0.114 * 60);
    expect(Math.abs(r - lum)).toBeLessThanOrEqual(2); // luminosity preserved
  });

  it('saturates chroma without touching neutral grays', () => {
    const buf = solid(16, 16, { r: 160, g: 100, b: 100, a: 255 });
    spongeStroke(buf, snap(buf), [{ x: 8, y: 8 }], { size: 12, opacity: 1 }, 'saturate');
    const [r, g] = pxAt(buf, 8, 8);
    expect(r).toBeGreaterThan(160);
    expect(g).toBeLessThan(100);

    const gray = solid(16, 16, { r: 128, g: 128, b: 128, a: 255 });
    spongeStroke(gray, snap(gray), [{ x: 8, y: 8 }], { size: 12, opacity: 1 }, 'saturate');
    expect(pxAt(gray, 8, 8)).toEqual([128, 128, 128, 255]);
  });

  it('overlapping passes converge instead of over-saturating', () => {
    const buf = solid(32, 32, { r: 160, g: 100, b: 100, a: 255 });
    const base = snap(buf);
    const state = { carry: 0, started: false };
    const ctx = { selection: null, origin: { x: 0, y: 0 }, strokeState: state };
    for (let i = 0; i < 10; i++) {
      spongeStroke(
        buf,
        base,
        [
          { x: 8 + i, y: 16 },
          { x: 8 + i + 0.4, y: 16 },
        ],
        { size: 16, opacity: 0.2 },
        'saturate',
        ctx,
      );
    }
    // One application at k ≤ 0.2: r ≈ 160 + 42*0.2… bounded well below clipping.
    expect(pxAt(buf, 14, 16)[0]).toBeLessThanOrEqual(210);
    expect(pxAt(buf, 14, 16)[0]).toBeGreaterThanOrEqual(160);
  });
});

describe('spotHealStroke', () => {
  it('rebuilds a dark blemish from the surrounding ring', () => {
    const bg: Rgba = { r: 200, g: 190, b: 180, a: 255 };
    const buf = solid(32, 32, bg);
    for (let y = 14; y <= 18; y++) {
      for (let x = 14; x <= 18; x++) setPx(buf, x, y, { r: 10, g: 10, b: 10, a: 255 });
    }
    spotHealStroke(buf, [{ x: 16, y: 16 }], { size: 14, opacity: 1 });
    const [r, g, b] = pxAt(buf, 16, 16);
    expect(r).toBeGreaterThan(150);
    expect(Math.abs(r - 200)).toBeLessThan(40);
    expect(Math.abs(g - b)).toBeLessThan(40);
    expect(pxAt(buf, 30, 30)).toEqual([200, 190, 180, 255]); // outside untouched
  });
});

describe('patchFill', () => {
  it('copies source texture with a brightness match to the destination', () => {
    const buf = solid(32, 8, { r: 140, g: 140, b: 140, a: 255 });
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 32; x++) {
        const v = x < 16 ? 100 : x % 2 === 0 ? 140 : 150; // flat dst, striped src
        setPx(buf, x, y, { r: v, g: v, b: v, a: 255 });
      }
    }
    const sel = rectSelection(32, 8, { x: 4, y: 2, width: 6, height: 4 })!;
    patchFill(buf, sel, { x: 0, y: 0 }, { x: 16, y: 0 });
    // src mean 145, dst mean 100 → texture rides at the destination level.
    expect(pxAt(buf, 4, 3)[0]).toBe(95);
    expect(pxAt(buf, 5, 3)[0]).toBe(105);
    expect(pxAt(buf, 12, 3)[0]).toBe(100); // outside the patch mask: untouched
    expect(pxAt(buf, 4, 3)[3]).toBe(255); // alpha never changes
  });
});

describe('redEyeStroke', () => {
  it('neutralizes a flash-red pupil and leaves skin tones alone', () => {
    const buf = solid(16, 16, { r: 200, g: 150, b: 120, a: 255 });
    for (let y = 7; y <= 8; y++) {
      for (let x = 7; x <= 8; x++) setPx(buf, x, y, { r: 220, g: 30, b: 30, a: 255 });
    }
    redEyeStroke(buf, [{ x: 8, y: 8 }], { size: 8, opacity: 1 });
    const [r, g, b] = pxAt(buf, 8, 8);
    expect(r).toBeLessThan(120); // red pulled toward neutral + darkened
    expect(Math.abs(r - g)).toBeLessThan(15);
    expect(Math.abs(r - b)).toBeLessThan(15);
    // Skin pixel inside the brush is protected by the reddish-only threshold.
    expect(pxAt(buf, 10, 8)).toEqual([200, 150, 120, 255]);
  });
});

describe('floodErase', () => {
  it('floods alpha to zero over the matching region only', () => {
    const buf = solid(16, 8, RED);
    for (let y = 0; y < 8; y++) for (let x = 8; x < 16; x++) setPx(buf, x, y, { r: 0, g: 0, b: 255, a: 255 });
    const changed = floodErase(buf, 2, 2, 30, NO_CONTEXT, true, 1);
    expect(changed).toBe(true);
    expect(pxAt(buf, 1, 1)[3]).toBe(0);
    expect(pxAt(buf, 7, 6)[3]).toBe(0);
    expect(pxAt(buf, 14, 4)).toEqual([0, 0, 255, 255]); // other color intact
  });

  it('scales the erase with strength and reports no-op misses', () => {
    const buf = solid(8, 8, RED);
    floodErase(buf, 4, 4, 30, NO_CONTEXT, true, 0.5);
    const a = pxAt(buf, 4, 4)[3];
    expect(a).toBeGreaterThanOrEqual(127);
    expect(a).toBeLessThanOrEqual(128);

    const flat = solid(8, 8, RED);
    expect(floodErase(flat, 100, 100, 30)).toBe(false); // seed outside
  });
});

describe('gradient shapes (phase 7)', () => {
  const T = { r: 0, g: 0, b: 0, a: 0 };

  it('reflected mirrors the ramp about the start point', () => {
    const buf = solid(21, 5, T);
    applyReflectedGradient(buf, 1, 2, 11, 2, BLACK, WHITE, NO_CONTEXT);
    expect(pxAt(buf, 1, 2)[0]).toBeLessThan(20); // start is dark
    expect(pxAt(buf, 0, 2)[0]).toBe(pxAt(buf, 1, 2)[0]); // mirrored about x=1
    expect(pxAt(buf, 10, 2)[0]).toBeGreaterThan(pxAt(buf, 5, 2)[0]); // grows both ways
    expect(pxAt(buf, 15, 2)[0]).toBe(255); // clamped past the end
  });

  it('angle sweeps around the start with the seam along the drag', () => {
    const buf = solid(21, 21, T);
    applyAngleGradient(buf, 10, 10, 20, 10, BLACK, WHITE, NO_CONTEXT); // base points +x
    expect(pxAt(buf, 15, 10)[0]).toBeLessThan(30); // along +x: t ≈ 0
    const up = pxAt(buf, 10, 4)[0]; // counterclockwise (screen-up) ≈ 0.76
    const down = pxAt(buf, 10, 16)[0]; // clockwise ≈ 0.24
    expect(up).toBeGreaterThan(140);
    expect(down).toBeLessThan(110);
    expect(up + down).toBeGreaterThan(180); // same sweep fraction either way
  });

  it('diamond measures Manhattan distance', () => {
    const buf = solid(21, 21, T);
    applyDiamondGradient(buf, 10, 10, 20, 10, BLACK, WHITE, NO_CONTEXT); // den = 10
    expect(pxAt(buf, 15, 10)[0]).toBe(pxAt(buf, 10, 15)[0]); // equal |d| → equal value
    expect(pxAt(buf, 13, 10)[0]).toBeGreaterThan(pxAt(buf, 11, 10)[0]); // grows outward
    expect(pxAt(buf, 20, 10)[0]).toBe(255); // clamped at the drag end distance
  });
});

describe('shape rasterizers (phase 7)', () => {
  const T = { r: 0, g: 0, b: 0, a: 0 };

  it('fillRoundedRect cuts the corners and fills centre + edges', () => {
    const buf = solid(24, 24, T);
    fillRoundedRect(buf, { x: 4, y: 4, width: 16, height: 16 }, 6, RED, NO_CONTEXT);
    expect(pxAt(buf, 12, 12)).toEqual([255, 0, 0, 255]); // centre
    expect(pxAt(buf, 12, 4)).toEqual([255, 0, 0, 255]); // edge midpoint
    expect(pxAt(buf, 4, 4)[3]).toBe(0); // corner rounded away
    expect(pxAt(buf, 3, 12)[3]).toBe(0); // just outside the box
  });

  it('fillRoundedRect degrades to a crisp rect at radius 0', () => {
    const a = solid(16, 16, T);
    const b = solid(16, 16, T);
    const rect = { x: 3, y: 3, width: 10, height: 8 };
    fillRoundedRect(a, rect, 0, RED, NO_CONTEXT);
    fillRect(b, rect, RED, NO_CONTEXT);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('fillPolygon fills a point-up hexagon and skips the bounding corners', () => {
    const buf = solid(24, 24, T);
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      pts.push({ x: 12 + Math.cos(a) * 10, y: 12 + Math.sin(a) * 10 });
    }
    fillPolygon(buf, pts, RED, NO_CONTEXT);
    expect(pxAt(buf, 12, 12)[3]).toBe(255); // centre
    expect(pxAt(buf, 12, 3)[3]).toBe(255); // inside near the top vertex
    expect(pxAt(buf, 2, 2)[3]).toBe(0); // bbox corner outside the hexagon
    expect(pxAt(buf, 22, 22)[3]).toBe(0);
  });

  it('strokeThickLine draws a butt-capped segment of the requested weight', () => {
    const buf = solid(24, 8, T);
    strokeThickLine(buf, 4, 4, 20, 4, 4, RED, NO_CONTEXT);
    expect(pxAt(buf, 10, 4)[3]).toBe(255); // on the line
    expect(pxAt(buf, 10, 3)[3]).toBe(255); // inside the 4 px band
    expect(pxAt(buf, 10, 1)[3]).toBe(0); // above it
    expect(pxAt(buf, 3, 4)[3]).toBe(0); // butt end — nothing before the start
    expect(pxAt(buf, 19, 4)[3]).toBe(255);
    expect(pxAt(buf, 21, 4)[3]).toBe(0); // nothing past the end
  });
});
