/**
 * Pure document operations. Every function returns a NEW document object;
 * pixel buffers are shared by reference unless the operation replaces them.
 * This keeps undo/redo snapshots cheap and the model predictable.
 */
import type { EditorDocument, Layer, PixelBuffer, Rect, RasterLayer } from './types';

let idCounter = 0;

/** Stable unique id (crypto.randomUUID when available, counter fallback). */
export function newId(prefix = 'id'): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `${prefix}_${c.randomUUID()}`;
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function createPixelBuffer(width: number, height: number, fill?: number): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill !== undefined) data.fill(fill);
  return { width, height, data };
}

export function clonePixelBuffer(src: PixelBuffer): PixelBuffer {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

export interface CreateRasterLayerOptions {
  id?: string;
  name?: string;
  visible?: boolean;
  opacity?: number;
  x?: number;
  y?: number;
}

export function createRasterLayer(pixels: PixelBuffer, opts: CreateRasterLayerOptions = {}): RasterLayer {
  return {
    id: opts.id ?? newId('layer'),
    name: opts.name ?? 'Layer',
    kind: 'raster',
    visible: opts.visible ?? true,
    opacity: opts.opacity ?? 1,
    blendMode: 'normal',
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    mask: null,
    pixels,
  };
}

export interface CreateDocumentOptions {
  id?: string;
  name: string;
  width: number;
  height: number;
  dpi?: number;
  layers?: Layer[];
  sourceFile?: string;
  now?: number;
}

export function createDocument(opts: CreateDocumentOptions): EditorDocument {
  const layers =
    opts.layers && opts.layers.length > 0
      ? opts.layers
      : [createRasterLayer(createPixelBuffer(opts.width, opts.height, 0), { name: 'Background' })];
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? newId('doc'),
    name: opts.name,
    width: opts.width,
    height: opts.height,
    dpi: opts.dpi ?? 72,
    layers,
    activeLayerId: layers[layers.length - 1]?.id ?? null,
    guides: [],
    meta: { formatVersion: 1, createdAt: now, modifiedAt: now, sourceFile: opts.sourceFile },
  };
}

export function getLayer(doc: EditorDocument, id: string | null): Layer | null {
  if (!id) return null;
  return doc.layers.find((l) => l.id === id) ?? null;
}

export function getActiveLayer(doc: EditorDocument): Layer | null {
  return getLayer(doc, doc.activeLayerId);
}

export function layerIndex(doc: EditorDocument, id: string): number {
  return doc.layers.findIndex((l) => l.id === id);
}

/** Replace a layer (by id) with a new object; returns the same doc if not found. */
export function replaceLayer(doc: EditorDocument, id: string, next: Layer): EditorDocument {
  const idx = layerIndex(doc, id);
  if (idx === -1) return doc;
  const layers = doc.layers.slice();
  layers[idx] = next;
  return { ...doc, layers };
}

export function addLayer(doc: EditorDocument, layer: Layer, opts: { aboveActive?: boolean } = {}): EditorDocument {
  let insertAt = doc.layers.length;
  if (opts.aboveActive) {
    const activeIdx = layerIndex(doc, doc.activeLayerId ?? '');
    insertAt = activeIdx === -1 ? doc.layers.length : activeIdx + 1;
  }
  const layers = doc.layers.slice();
  layers.splice(insertAt, 0, layer);
  return { ...doc, layers, activeLayerId: layer.id };
}

export function removeLayer(doc: EditorDocument, id: string): EditorDocument {
  const idx = layerIndex(doc, id);
  if (idx === -1) return doc;
  const layers = doc.layers.filter((l) => l.id !== id);
  const activeLayerId =
    doc.activeLayerId === id
      ? (layers[Math.min(idx, layers.length - 1)]?.id ?? null)
      : doc.activeLayerId;
  return { ...doc, layers, activeLayerId };
}

/**
 * Move layer `id` to a new bottom-indexed position in the layer stack.
 * Returns the same document when the move is a no-op or invalid.
 */
export function reorderLayer(doc: EditorDocument, id: string, toIndex: number): EditorDocument {
  const from = layerIndex(doc, id);
  if (from === -1) return doc;
  const clamped = Math.max(0, Math.min(doc.layers.length - 1, toIndex));
  if (clamped === from) return doc;
  const layers = doc.layers.slice();
  const [moved] = layers.splice(from, 1);
  layers.splice(clamped, 0, moved);
  return { ...doc, layers };
}

export function duplicateLayer(doc: EditorDocument, id: string): EditorDocument {
  const src = getLayer(doc, id);
  if (!src) return doc;
  const copy: Layer = {
    ...src,
    id: newId('layer'),
    name: `${src.name} copy`,
    pixels: clonePixelBuffer(src.pixels),
    mask: src.mask ? { ...src.mask, data: new Uint8Array(src.mask.data) } : null,
  };
  const idx = layerIndex(doc, id);
  const layers = doc.layers.slice();
  layers.splice(idx + 1, 0, copy);
  return { ...doc, layers, activeLayerId: copy.id };
}

export function setActiveLayer(doc: EditorDocument, id: string | null): EditorDocument {
  if (id !== null && layerIndex(doc, id) === -1) return doc;
  if (doc.activeLayerId === id) return doc;
  return { ...doc, activeLayerId: id };
}

export function updateLayer(doc: EditorDocument, id: string, patch: Partial<Omit<Layer, 'id' | 'kind'>>): EditorDocument {
  const layer = getLayer(doc, id);
  if (!layer) return doc;
  return replaceLayer(doc, id, { ...layer, ...patch });
}

/** Resize the document canvas, keeping layer pixels at their document positions. */
export function setDocumentSize(doc: EditorDocument, width: number, height: number): EditorDocument {
  return { ...doc, width, height };
}

/** Total opaque pixel count (rough memory proxy used for warnings). */
export function documentMegapixels(doc: EditorDocument): number {
  return (doc.width * doc.height) / 1e6;
}

/** Clamp a rect to document bounds; returns null when fully outside. */
export function clampRectToDocument(doc: EditorDocument, rect: Rect): Rect | null {
  const x = Math.max(0, Math.min(doc.width, Math.round(rect.x)));
  const y = Math.max(0, Math.min(doc.height, Math.round(rect.y)));
  const right = Math.max(0, Math.min(doc.width, Math.round(rect.x + rect.width)));
  const bottom = Math.max(0, Math.min(doc.height, Math.round(rect.y + rect.height)));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
