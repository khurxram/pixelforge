/**
 * Core document types.
 *
 * Pure data structures — no DOM APIs — so the whole model can be unit tested
 * in Node and reused inside Web Workers.
 */

/** Supported layer blend modes (compositing implemented in imaging/composite.ts). */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;

/** 8-bit RGBA pixel buffer in document space. */
export interface PixelBuffer {
  width: number;
  height: number;
  /** RGBA, length = width * height * 4. Always backed by a normal ArrayBuffer. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Layer kinds. `raster` is implemented; the rest are reserved discriminants for later stages. */
export type LayerKind = 'raster' | 'text' | 'shape' | 'adjustment' | 'group';

interface LayerBase {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  /** Offset of the layer's pixel origin in document coordinates. */
  x: number;
  y: number;
  /** Layer mask (Stage D). */
  mask: LayerMask | null;
}

export interface LayerMask {
  width: number;
  height: number;
  /** 0..255 coverage; 255 = fully revealed. */
  data: Uint8Array;
  enabled: boolean;
}

export interface RasterLayer extends LayerBase {
  kind: 'raster';
  pixels: PixelBuffer;
}

/** Union of layer types. Only `raster` is produced today. */
export type Layer = RasterLayer;

export interface Guide {
  id: string;
  axis: 'horizontal' | 'vertical';
  /** Document-space position in pixels. */
  position: number;
}

/** Free-form metadata recorded in the project file. */
export interface DocumentMeta {
  /** Project format version the document was saved with. */
  formatVersion: number;
  createdAt: number;
  modifiedAt: number;
  /** Original imported file name, when applicable. */
  sourceFile?: string;
}

export interface EditorDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Pixels per inch metadata (stored/exported where the format supports it). */
  dpi: number;
  /** Ordered bottom → top. */
  layers: Layer[];
  activeLayerId: string | null;
  guides: Guide[];
  meta: DocumentMeta;
}

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export type ToolId =
  | 'move'
  | 'marquee'
  | 'marquee-ellipse'
  | 'marquee-row'
  | 'marquee-col'
  | 'lasso'
  | 'lasso-poly'
  | 'lasso-magnetic'
  | 'wand'
  | 'quickselect'
  | 'objectselect'
  | 'crop'
  | 'brush'
  | 'pencil'
  | 'brush-replace'
  | 'eraser'
  | 'eraser-magic'
  | 'eraser-bg'
  | 'clone'
  | 'healing'
  | 'healing-spot'
  | 'patch'
  | 'redeye'
  | 'bucket'
  | 'gradient'
  | 'blur'
  | 'sharpen'
  | 'smudge'
  | 'dodge'
  | 'burn'
  | 'sponge'
  | 'text'
  | 'shape'
  | 'shape-round'
  | 'shape-ellipse'
  | 'shape-poly'
  | 'shape-line'
  | 'hand'
  | 'zoom'
  | 'eyedropper';

/** Tools whose behavior is implemented and therefore selectable. */
export const IMPLEMENTED_TOOLS: readonly ToolId[] = [
  'move',
  'marquee',
  'marquee-ellipse',
  'marquee-row',
  'marquee-col',
  'lasso',
  'lasso-poly',
  'lasso-magnetic',
  'wand',
  'quickselect',
  'objectselect',
  'crop',
  'brush',
  'pencil',
  'brush-replace',
  'eraser',
  'eraser-magic',
  'eraser-bg',
  'clone',
  'healing',
  'healing-spot',
  'patch',
  'redeye',
  'bucket',
  'gradient',
  'blur',
  'sharpen',
  'smudge',
  'dodge',
  'burn',
  'sponge',
  'text',
  'shape',
  'shape-round',
  'shape-ellipse',
  'shape-poly',
  'shape-line',
  'hand',
  'zoom',
  'eyedropper',
];

export const MAX_HISTORY_ENTRIES = 25;

/** Refuse to open images larger than this (browser canvas/memory safety). */
export const MAX_IMAGE_DIMENSION = 16_384;
/** Warn the user above this many megapixels before allocating. */
export const WARN_IMAGE_MEGAPIXELS = 40;
