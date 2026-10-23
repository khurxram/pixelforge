/**
 * Document-level geometric operations: rotate/flip the whole canvas, crop,
 * and resize. Each returns a new document (snapshot-friendly for history);
 * existing layer pixel buffers are reused unless the operation rewrites them.
 */
import type { EditorDocument, Guide, Layer, LayerMask, PixelBuffer, Rect } from './types';
import {
  flipHorizontal,
  flipVertical,
  rotate180,
  rotate90ccw,
  rotate90cw,
} from '../../imaging/geometry';
import { resizeBuffer } from '../../imaging/scale';

export type DocumentTransform = 'rotate-cw' | 'rotate-ccw' | 'rotate-180' | 'flip-h' | 'flip-v';

function mapMask(mask: LayerMask | null, fn: (buf: PixelBuffer) => PixelBuffer): LayerMask | null {
  if (!mask) return null;
  const res = fn({ width: mask.width, height: mask.height, data: new Uint8ClampedArray(mask.data) as Uint8ClampedArray<ArrayBuffer> });
  return { width: res.width, height: res.height, data: new Uint8Array(res.data), enabled: mask.enabled };
}

function transformGuides(guides: Guide[], op: DocumentTransform, w: number, h: number): Guide[] {
  return guides.map((g) => {
    switch (op) {
      case 'flip-h':
        return g.axis === 'vertical' ? { ...g, position: w - g.position } : g;
      case 'flip-v':
        return g.axis === 'horizontal' ? { ...g, position: h - g.position } : g;
      case 'rotate-cw':
        return g.axis === 'vertical'
          ? { ...g, axis: 'horizontal', position: g.position }
          : { ...g, axis: 'vertical', position: h - g.position };
      case 'rotate-ccw':
        return g.axis === 'vertical'
          ? { ...g, axis: 'horizontal', position: w - g.position }
          : { ...g, axis: 'vertical', position: g.position };
      case 'rotate-180':
        return g.axis === 'vertical'
          ? { ...g, position: w - g.position }
          : { ...g, position: h - g.position };
    }
  });
}

/** Rotate or flip the entire document (all layers + guides). */
export function transformDocument(doc: EditorDocument, op: DocumentTransform): EditorDocument {
  const { width: w, height: h } = doc;
  const swapsAxis = op === 'rotate-cw' || op === 'rotate-ccw';

  const layers: Layer[] = doc.layers.map((layer) => {
    const { x, y } = layer;
    const lw = layer.pixels.width;
    const lh = layer.pixels.height;
    let nx = x;
    let ny = y;
    let pixels = layer.pixels;
    let mask = layer.mask;

    switch (op) {
      case 'flip-h':
        nx = w - x - lw;
        pixels = flipHorizontal(pixels);
        mask = mapMask(mask, flipHorizontal);
        break;
      case 'flip-v':
        ny = h - y - lh;
        pixels = flipVertical(pixels);
        mask = mapMask(mask, flipVertical);
        break;
      case 'rotate-cw':
        // (px,py) → (h-py, px) in the new H×W space.
        nx = h - y - lh;
        ny = x;
        pixels = rotate90cw(pixels);
        mask = mapMask(mask, rotate90cw);
        break;
      case 'rotate-ccw':
        // (px,py) → (py, w-px) in the new H×W space.
        nx = y;
        ny = w - x - lw;
        pixels = rotate90ccw(pixels);
        mask = mapMask(mask, rotate90ccw);
        break;
      case 'rotate-180':
        nx = w - x - lw;
        ny = h - y - lh;
        pixels = rotate180(pixels);
        mask = mapMask(mask, rotate180);
        break;
    }
    return { ...layer, x: nx, y: ny, pixels, mask };
  });

  return {
    ...doc,
    width: swapsAxis ? h : w,
    height: swapsAxis ? w : h,
    layers,
    guides: transformGuides(doc.guides, op, w, h),
  };
}

function intersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): Rect | null {
  const x0 = Math.max(ax, bx);
  const y0 = Math.max(ay, by);
  const x1 = Math.min(ax + aw, bx + bw);
  const y1 = Math.min(ay + ah, by + bh);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Crop the document canvas to `rect` (document coordinates, already clamped).
 * Layer offsets shift with the canvas; layer pixels are preserved (content
 * outside the canvas is hidden, not deleted — matching Photoshop's default).
 */
export function cropDocument(doc: EditorDocument, rect: Rect): EditorDocument {
  const x0 = Math.round(rect.x);
  const y0 = Math.round(rect.y);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w <= 0 || h <= 0) return doc;

  const layers = doc.layers.map((layer) => ({ ...layer, x: layer.x - x0, y: layer.y - y0 }));
  const guides: Guide[] = [];
  for (const g of doc.guides) {
    if (g.axis === 'vertical') {
      const p = g.position - x0;
      if (p >= 0 && p <= w) guides.push({ ...g, position: p });
    } else {
      const p = g.position - y0;
      if (p >= 0 && p <= h) guides.push({ ...g, position: p });
    }
  }
  return { ...doc, width: w, height: h, layers, guides };
}

/** Area of a layer's pixels in document space (used to skip redundant work). */
function layerRect(layer: Layer): Rect {
  return { x: layer.x, y: layer.y, width: layer.pixels.width, height: layer.pixels.height };
}

export { intersect as intersectRects, layerRect };

/** Resize the document to `width`×`height`, resampling every layer proportionally. */
export function resizeDocument(doc: EditorDocument, width: number, height: number): EditorDocument {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === doc.width && h === doc.height) return doc;
  const sx = w / doc.width;
  const sy = h / doc.height;

  const layers = doc.layers.map((layer) => {
    const nlw = Math.max(1, Math.round(layer.pixels.width * sx));
    const nlh = Math.max(1, Math.round(layer.pixels.height * sy));
    const pixels = resizeBuffer(layer.pixels, nlw, nlh);
    let mask: LayerMask | null = null;
    if (layer.mask) {
      const resized = resizeBuffer(
        {
          width: layer.mask.width,
          height: layer.mask.height,
          data: new Uint8ClampedArray(layer.mask.data),
        },
        nlw,
        nlh,
      );
      mask = { width: resized.width, height: resized.height, data: new Uint8Array(resized.data), enabled: layer.mask.enabled };
    }
    return {
      ...layer,
      x: Math.round(layer.x * sx),
      y: Math.round(layer.y * sy),
      pixels,
      mask,
    };
  });

  const guides = doc.guides.map((g) =>
    g.axis === 'vertical'
      ? { ...g, position: Math.round(g.position * sx) }
      : { ...g, position: Math.round(g.position * sy) },
  );

  return { ...doc, width: w, height: h, layers, guides };
}
