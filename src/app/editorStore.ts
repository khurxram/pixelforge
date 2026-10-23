/**
 * Central editor store. A tiny observable store (no external dependency)
 * consumed by React through `useSyncExternalStore`.
 *
 * Invariants:
 *  - `doc` is immutable; every change produces a new document object.
 *  - All document changes go through `commitDocument` so history stays exact.
 */
import { useSyncExternalStore } from 'react';
import type { EditorDocument, PixelBuffer, Rect, ToolId, Viewport } from '../core/document/types';
import type { Selection, SelectionMode } from '../core/document/selection';
import { emptyHistory, type HistoryState } from '../core/history/history';
import { DEFAULT_ADJUSTMENTS, type AdjustParams } from '../imaging/adjustments';
import type { ToneRange } from '../imaging/paint';

export interface Toast {
  kind: 'info' | 'error' | 'warning';
  message: string;
}

export type DialogId =
  | 'export'
  | 'shortcuts'
  | 'about'
  | 'storage'
  | 'imageSize'
  | 'openProject'
  | 'feather'
  | null;

export interface RecoveryInfo {
  name: string;
  savedAt: number;
}

/** Free-transform session (Photoshop-style Ctrl+T) on a single layer.
 *  (x, y) is the document-space position of the layer's local (0, 0)
 *  corner; rotation is in radians. */
export interface FreeTransform {
  layerId: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export interface EditorState {
  doc: EditorDocument | null;
  history: HistoryState;
  viewport: Viewport;
  /** Re-fit the document whenever the workspace is resized. */
  fitMode: boolean;
  tool: ToolId;
  /** Pending (previewed) adjustment parameters for the active layer. */
  adjustments: AdjustParams;
  /** Layer id the pending adjustments target. */
  adjustmentsLayerId: string | null;
  foreground: string;
  background: string;
  /** Short human-readable status line. */
  status: string;
  /** Non-null while a long operation runs. */
  busy: string | null;
  progress: number | null;
  toast: Toast | null;
  /** Active crop rectangle in document coordinates. */
  cropRect: Rect | null;
  /** Active Free Transform session (Ctrl+T) on a single layer, or null. */
  transform: FreeTransform | null;
  /** Workspace size in CSS pixels (for fit calculations). */
  workspace: { width: number; height: number };
  /** Cursor position in document coordinates, null when outside the canvas. */
  cursor: { x: number; y: number } | null;
  /** Unsaved changes since last project save. */
  dirty: boolean;
  /** IndexedDB record id of the last saved/loaded project, null if new. */
  projectId: string | null;
  /** Background autosave timestamp (ms). */
  lastAutosave: number | null;
  /** Modal dialog currently open. */
  dialog: DialogId;
  /** Pending autosave recovery offer. */
  recovery: RecoveryInfo | null;
  /** Canvas checkerboard under transparent pixels. */
  showCheckerboard: boolean;
  /** Crop tool aspect constraint. */
  cropAspect: CropAspect;
  /** Right inspector panel: width in px and visibility (Photoshop-style). */
  inspectorWidth: number;
  inspectorOpen: boolean;

  /* --------------------------- selections --------------------------- */
  /** Active selection mask in document space (null = nothing selected). */
  selection: Selection | null;
  /** Live marquee drag preview (document coords). */
  marqueeDraft: Rect | null;
  /** Live lasso path preview (document coords). */
  lassoDraft: Array<{ x: number; y: number }> | null;
  /** Live shape drag preview (document coords). */
  shapeDraft: Rect | null;
  /** Live gradient drag preview (document coords). */
  gradientDraft: { x1: number; y1: number; x2: number; y2: number } | null;

  /* --------------------------- tool options -------------------------- */
  /** Brush / eraser / retouch diameter in document pixels. */
  brushSize: number;
  /** Opacity / strength / exposure in percent (1..100). */
  brushOpacity: number;
  /** Brush edge hardness percent (0 = fully feathered, 100 = hard edge). */
  brushHardness: number;
  /** Per-stamp flow percent (1..100) — how heavily each stamp deposits. */
  brushFlow: number;
  /** Pointer smoothing percent (0..100) — evens out shaky strokes. */
  brushSmoothing: number;
  /** Magic-wand tolerance (0..100, max channel difference). */
  wandTolerance: number;
  /** Object Selection: edge strength (0..100 → 0..255 gradient) that stops
   *  growth — higher values let the flood cross weaker boundaries. */
  edgeThreshold: number;
  /** Wand/bucket: restrict to connected pixels (vs every matching pixel). */
  contiguous: boolean;
  /** Wand: soften selection edges by ~1px. */
  antialias: boolean;
  /** Sample the flattened image instead of only the active layer. */
  sampleAll: boolean;
  /** How a new selection combines with the existing one. */
  selectionMode: SelectionMode;
  /** Marquee feather radius in px (0 = hard edge). */
  featherPx: number;
  /** Marquee style: free drag, fixed ratio, or fixed pixel size. */
  marqueeStyle: 'normal' | 'ratio' | 'fixed';
  /** Fixed-ratio numerator/denominator (e.g. 4 / 3). */
  ratioW: number;
  ratioH: number;
  /** Fixed-size marquee dimensions in px. */
  fixedW: number;
  fixedH: number;
  /** Dodge/burn tonal range. */
  toneRange: ToneRange;
  /** Gradient shape. */
  gradientStyle: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  /** Swap gradient start/end colors. */
  gradientReverse: boolean;
  /** Paint-bucket fill opacity percent (1..100). */
  fillOpacity: number;
  /** Type-tool alignment and font (local/system families only). */
  textAlign: 'left' | 'center' | 'right';
  fontFamily: string;
  /** Shape outline width in px (0 = fill only; outline uses background color).
   *  For the Line shape this is the line weight (min 1 px). */
  shapeStroke: number;
  /** Eyedropper sample area (n × n average). */
  eyedropperSize: 1 | 3 | 5;
  shapeKind: 'rect' | 'ellipse';
  /** Rounded-rectangle corner radius in px. */
  shapeCornerRadius: number;
  /** Regular polygon side count (3..12). */
  polygonSides: number;
  /** Magnetic-lasso edge search radius in px. */
  magneticWidth: number;
  /** Edge contrast required before the magnetic lasso snaps (0..100). */
  magneticContrast: number;
  /** Magnetic-lasso point frequency (0..100 — higher places points denser). */
  magneticFrequency: number;
  /** Sponge direction. */
  spongeMode: 'saturate' | 'desaturate';
  /** Background-eraser sampling: follow the cursor or lock at stroke start. */
  bgSampleMode: 'continuous' | 'once';
  /** Move tool: auto-select the layer whose pixels sit under the click. */
  moveAutoSelect: boolean;
  /** Move tool: show transform handles around the active layer. */
  moveShowControls: boolean;
  /** Draft text typed in the tool options bar (placed by clicking the canvas). */
  textValue: string;
  textSize: number;
  /** Clone-stamp source offset (set with Alt-click), document space. */
  cloneOffset: { x: number; y: number } | null;
  /** Keep the clone offset fixed across strokes ("aligned" sampling). */
  cloneAligned: boolean;
  /** Persisted clone offset for aligned sampling across strokes. */
  cloneStrokeOffset: { x: number; y: number } | null;
}

export type CropAspect = 'free' | 'original' | '1:1' | '4:3' | '3:2' | '16:9';

const initialState: EditorState = {
  doc: null,
  history: emptyHistory(),
  viewport: { zoom: 1, panX: 0, panY: 0 },
  fitMode: true,
  tool: 'hand',
  adjustments: DEFAULT_ADJUSTMENTS,
  adjustmentsLayerId: null,
  foreground: '#000000',
  background: '#ffffff',
  status: 'Ready — open an image to start',
  busy: null,
  progress: null,
  toast: null,
  cropRect: null,
  transform: null,
  workspace: { width: 0, height: 0 },
  cursor: null,
  dirty: false,
  projectId: null,
  lastAutosave: null,
  dialog: null,
  recovery: null,
  showCheckerboard: true,
  cropAspect: 'free',
  inspectorWidth: 304,
  inspectorOpen: true,
  selection: null,
  marqueeDraft: null,
  lassoDraft: null,
  shapeDraft: null,
  gradientDraft: null,
  brushSize: 40,
  brushOpacity: 100,
  brushHardness: 40,
  brushFlow: 100,
  brushSmoothing: 0,
  wandTolerance: 32,
  edgeThreshold: 35,
  contiguous: true,
  antialias: true,
  sampleAll: false,
  selectionMode: 'new',
  featherPx: 0,
  marqueeStyle: 'normal',
  ratioW: 1,
  ratioH: 1,
  fixedW: 100,
  fixedH: 100,
  toneRange: 'midtones',
  gradientStyle: 'linear',
  gradientReverse: false,
  fillOpacity: 100,
  textAlign: 'left',
  fontFamily: 'sans-serif',
  shapeStroke: 0,
  eyedropperSize: 1,
  shapeKind: 'rect',
  shapeCornerRadius: 20,
  polygonSides: 6,
  magneticWidth: 22,
  magneticContrast: 50,
  magneticFrequency: 60,
  spongeMode: 'saturate',
  bgSampleMode: 'continuous',
  moveAutoSelect: false,
  moveShowControls: true,
  textValue: '',
  textSize: 48,
  cloneOffset: null,
  cloneAligned: true,
  cloneStrokeOffset: null,
};

type Listener = () => void;

let state: EditorState = initialState;
const listeners = new Set<Listener>();

export function getState(): EditorState {
  return state;
}

export function setState(partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)): void {
  const patch = typeof partial === 'function' ? partial(state) : partial;
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe a component to a slice of state. Selectors must return stable
 * references (a field, or a memoized object) — never freshly built objects.
 */
export function useEditorStore<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/** Reset everything (used when opening a project/document). Layout prefs
 *  (inspector size/visibility) survive document resets. */
export function resetState(partial: Partial<EditorState> = {}): void {
  state = {
    ...initialState,
    inspectorWidth: state.inspectorWidth,
    inspectorOpen: state.inspectorOpen,
    ...partial,
  };
  for (const l of listeners) l();
}

export { initialState };

/** Convenience: pixels of the active layer, or null. */
export function activeLayerPixels(state: EditorState): PixelBuffer | null {
  if (!state.doc || !state.doc.activeLayerId) return null;
  const layer = state.doc.layers.find((l) => l.id === state.doc?.activeLayerId);
  return layer ? layer.pixels : null;
}
