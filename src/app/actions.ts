/**
 * Editor actions: the only place that mutates store state for document
 * changes. Every document change flows through `commit()` so undo/redo is
 * always exact. UI-only state (viewport, tool, toasts) changes directly.
 */
import {
  addLayer,
  clonePixelBuffer,
  createDocument,
  createPixelBuffer,
  createRasterLayer,
  getLayer,
  newId,
  removeLayer as removeLayerOp,
  reorderLayer as reorderLayerOp,
  replaceLayer,
  setActiveLayer as setActiveLayerOp,
  duplicateLayer as duplicateLayerOp,
  updateLayer,
} from '../core/document/ops';
import {
  combineSelection,
  featherSelection,
  growSelection,
  invertSelection as coreInvert,
  offsetSelection,
  selectAll as coreSelectAll,
  selectionAlpha,
  shrinkSelection,
  smoothSelection,
  wandSelection,
} from '../core/document/selection';
import {
  applyAngleGradient,
  applyDiamondGradient,
  applyLinearGradient,
  applyRadialGradient,
  applyReflectedGradient,
  clearPixels,
  fillEllipse,
  fillPixels,
  fillPolygon,
  fillRect,
  fillRoundedRect,
  floodErase,
  hexToRgba,
  invertPixels,
  strokeThickLine,
  type PaintContext,
  type Rgba,
} from '../imaging/paint';
import {
  cropDocument,
  resizeDocument,
  transformDocument,
  type DocumentTransform,
} from '../core/document/transforms';
import type { BlendMode, EditorDocument, PixelBuffer, Rect, ToolId } from '../core/document/types';
import type { Selection } from '../core/document/selection';
import {
  canRedo,
  canUndo,
  emptyHistory,
  jumpTo,
  pushEntry,
  redoOnce,
  undoOnce,
} from '../core/history/history';
import {
  DEFAULT_ADJUSTMENTS,
  isCurveActive,
  isIdentityAdjustment,
  type AdjustParams,
} from '../imaging/adjustments';
import { compositeDocument, compositeLayerInto } from '../imaging/composite';
import { autoColor, autoContrast, autoTone } from '../imaging/auto';
import { gradientMagnitude } from '../imaging/edges';
import { cropBuffer, warpBuffer, type Matrix } from '../imaging/geometry';
import {
  downloadBlob,
  exportDocument,
  exportFilename,
  type ExportFormat,
} from '../imaging/exportImage';
import {
  exceedsWarningThreshold,
  megapixels,
  probeImage,
  readPixels,
} from '../imaging/importImage';
import {
  clearAllProjects,
  clearAutosave,
  deleteProjectRecord,
  getAutosave,
  getProjectRecord,
  listProjects,
  putAutosave,
  saveProjectRecord,
  StorageError,
  type ProjectMeta,
} from '../persistence/indexedDb';
import { parseProject, serializeProject } from '../persistence/projectFormat';
import { fitView, nextZoomStep, zoomAt } from '../rendering/viewport';
import { cancelAdjustments as cancelWorkerAdjustments, runAdjustments } from '../workers/adjustClient';
import { getState, resetState, setState, type EditorState, type FreeTransform } from './editorStore';

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

export function setBusy(label: string | null, progress: number | null = null): void {
  setState({ busy: label, progress });
}

export function toast(kind: 'info' | 'error' | 'warning', message: string): void {
  setState({ toast: { kind, message } });
}

export function clearToast(): void {
  setState({ toast: null });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/** Apply `next` as the new document, recording an undo entry with `label`. */
export function commit(label: string, next: EditorDocument): void {
  const s = getState();
  if (!s.doc) return;
  const history = pushEntry(s.history, { label, before: s.doc, after: next });
  setState({
    doc: next,
    history,
    dirty: true,
    // Any committed change invalidates a live adjustment preview.
    adjustments: DEFAULT_ADJUSTMENTS,
    adjustmentsLayerId: null,
    status: label,
  });
  scheduleAutosave();
}

export function undo(): void {
  const s = getState();
  const result = undoOnce(s.history);
  if (!result) {
    setState({ status: 'Nothing to undo' });
    return;
  }
  setState({
    doc: result.doc,
    history: result.history,
    adjustments: DEFAULT_ADJUSTMENTS,
    adjustmentsLayerId: null,
    status: `Undo: ${s.history.entries[s.history.index - 1].label}`,
    dirty: true,
  });
  scheduleAutosave();
}

export function redo(): void {
  const s = getState();
  const result = redoOnce(s.history);
  if (!result) {
    setState({ status: 'Nothing to redo' });
    return;
  }
  setState({
    doc: result.doc,
    history: result.history,
    adjustments: DEFAULT_ADJUSTMENTS,
    adjustmentsLayerId: null,
    status: `Redo: ${s.history.entries[s.history.index].label}`,
    dirty: true,
  });
  scheduleAutosave();
}

export function jumpHistory(position: number): void {
  const s = getState();
  if (!s.doc) return;
  const result = jumpTo(s.history, position);
  if (!result.doc) return;
  setState({
    doc: result.doc,
    history: result.history,
    adjustments: DEFAULT_ADJUSTMENTS,
    adjustmentsLayerId: null,
    status: `History: ${s.history.entries[position - 1]?.label ?? 'start'}`,
    dirty: true,
  });
  scheduleAutosave();
}

export function historyUndoAvailable(): boolean {
  return canUndo(getState().history);
}

export function historyRedoAvailable(): boolean {
  return canRedo(getState().history);
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function stateForNewDocument(doc: EditorDocument) {
  const s = getState();
  const viewport =
    s.workspace.width > 0 && s.workspace.height > 0
      ? fitView(doc.width, doc.height, s.workspace.width, s.workspace.height)
      : s.viewport;
  return {
    doc,
    history: emptyHistory(),
    fitMode: true,
    viewport,
    workspace: s.workspace,
    foreground: s.foreground,
    background: s.background,
    adjustments: DEFAULT_ADJUSTMENTS,
    adjustmentsLayerId: null,
    cropRect: null,
    dirty: false,
    projectId: null,
    lastAutosave: null,
    status: `Opened ${doc.name} — ${doc.width}×${doc.height}`,
  };
}

/** Open an image file as a new document (File → Open / drag-and-drop). */
export async function openImageFile(file: File): Promise<void> {
  setBusy(`Opening ${file.name}…`);
  try {
    const probe = await probeImage(file);
    if (exceedsWarningThreshold(probe.width, probe.height)) {
      const ok = window.confirm(
        `"${file.name}" is ${probe.width}×${probe.height} (${megapixels(probe.width, probe.height).toFixed(1)} MP).\n` +
          'Very large images use a lot of memory and may make editing slow. Open anyway?',
      );
      if (!ok) {
        setState({ status: 'Open cancelled' });
        return;
      }
    }
    const pixels = readPixels(probe.bitmap);
    const doc = createDocument({
      name: file.name,
      width: pixels.width,
      height: pixels.height,
      layers: [createRasterLayer(pixels, { name: 'Background' })],
      sourceFile: file.name,
    });
    resetState(stateForNewDocument(doc));
  } catch (e) {
    toast('error', errorMessage(e));
    setState({ status: 'Open failed' });
  } finally {
    setBusy(null);
  }
}

/** Place an image as a new layer in the current document (drag-and-drop). */
export async function placeImageAsLayer(file: File): Promise<void> {
  const s = getState();
  if (!s.doc) {
    await openImageFile(file);
    return;
  }
  setBusy(`Placing ${file.name}…`);
  try {
    const probe = await probeImage(file);
    const pixels = readPixels(probe.bitmap);
    const doc = s.doc;
    const layer = createRasterLayer(pixels, {
      name: file.name.replace(/\.[a-z0-9]+$/i, ''),
      x: Math.round((doc.width - pixels.width) / 2),
      y: Math.round((doc.height - pixels.height) / 2),
    });
    const layers = doc.layers.slice();
    const activeIdx = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
    layers.splice(activeIdx === -1 ? layers.length : activeIdx + 1, 0, layer);
    commit('Place image layer', { ...doc, layers, activeLayerId: layer.id });
    setState({ status: `Placed "${file.name}" as a layer` });
  } catch (e) {
    toast('error', errorMessage(e));
  } finally {
    setBusy(null);
  }
}

/* ------------------------------------------------------------------ */
/* Adjustments                                                         */
/* ------------------------------------------------------------------ */

const ADJUST_LABELS: Record<keyof AdjustParams, string> = {
  exposure: 'Exposure',
  brightness: 'Brightness',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  temperature: 'Temperature',
  tint: 'Tint',
  saturation: 'Saturation',
  hue: 'Hue',
  grayscale: 'Grayscale',
  sepia: 'Sepia',
  blurRadius: 'Blur',
  sharpenAmount: 'Sharpen',
  liftX: 'Lift X',
  liftY: 'Lift Y',
  liftM: 'Lift',
  gammaX: 'Gamma X',
  gammaY: 'Gamma Y',
  gammaM: 'Gamma',
  gainX: 'Gain X',
  gainY: 'Gain Y',
  gainM: 'Gain',
  curve: 'Curves',
  threshold: 'Threshold',
  posterize: 'Posterize',
  gradientMap: 'Gradient Map',
  gradientMapReverse: 'Gradient Map Reverse',
  photoFilter: 'Photo Filter',
  photoFilterDensity: 'Filter Density',
};

export function describeAdjustments(p: AdjustParams): string {
  const parts: string[] = [];
  if (p.exposure) parts.push('Exposure');
  if (p.brightness) parts.push('Brightness');
  if (p.contrast) parts.push('Contrast');
  if (p.highlights) parts.push('Highlights');
  if (p.shadows) parts.push('Shadows');
  if (p.temperature) parts.push('Temperature');
  if (p.tint) parts.push('Tint');
  if (p.saturation) parts.push('Saturation');
  if (p.hue) parts.push('Hue');
  if (p.grayscale) parts.push('Grayscale');
  if (p.sepia) parts.push('Sepia');
  if (p.blurRadius > 0) parts.push('Blur');
  if (p.sharpenAmount > 0) parts.push('Sharpen');
  if (p.liftX || p.liftY || p.liftM) parts.push('Lift');
  if (p.gammaX || p.gammaY || p.gammaM) parts.push('Gamma');
  if (p.gainX || p.gainY || p.gainM) parts.push('Gain');
  if (isCurveActive(p.curve)) parts.push('Curves');
  if (p.threshold > 0) parts.push('Threshold');
  if (p.posterize >= 2) parts.push('Posterize');
  if (p.gradientMap) parts.push('Gradient Map');
  if (p.photoFilter) parts.push('Photo Filter');
  return parts.length > 0 ? parts.join(', ') : 'Adjustments';
}

export { ADJUST_LABELS };

/** Set one pending adjustment parameter (preview updates live). */
export function setAdjustment<K extends keyof AdjustParams>(key: K, value: AdjustParams[K]): void {
  const s = getState();
  if (!s.doc || !s.doc.activeLayerId) return;
  setState({
    adjustments: { ...s.adjustments, [key]: value },
    adjustmentsLayerId: s.adjustmentsLayerId ?? s.doc.activeLayerId,
    status: `Adjusting ${ADJUST_LABELS[key]}`,
  });
}

export function resetAdjustments(): void {
  setState({ adjustments: DEFAULT_ADJUSTMENTS, status: 'Adjustments reset' });
}

/** Merge a whole colour-grade preset into the pending adjustments. */
export function applyGradePreset(grade: Partial<AdjustParams>, label: string): void {
  const s = getState();
  if (!s.doc || !s.doc.activeLayerId) return;
  setState({
    adjustments: { ...s.adjustments, ...grade },
    adjustmentsLayerId: s.adjustmentsLayerId ?? s.doc.activeLayerId,
    status: `Color grade: ${label}`,
  });
}

export function cancelPendingAdjustments(): void {
  cancelWorkerAdjustments();
  setState({ adjustments: DEFAULT_ADJUSTMENTS, adjustmentsLayerId: null, status: 'Adjustments discarded' });
}

/** Commit pending adjustments at full resolution (runs in a worker). */
export async function applyPendingAdjustments(): Promise<void> {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layerId = s.adjustmentsLayerId ?? doc.activeLayerId;
  const layer = layerId ? getLayer(doc, layerId) : null;
  if (!layer) {
    toast('warning', 'No active layer to adjust.');
    return;
  }
  if (isIdentityAdjustment(s.adjustments)) {
    setState({ adjustments: DEFAULT_ADJUSTMENTS, adjustmentsLayerId: null, status: 'No adjustments to apply' });
    return;
  }
  const label = `Adjust: ${describeAdjustments(s.adjustments)}`;
  setBusy('Applying adjustments…');
  try {
    const afterPixels = await runAdjustments(layer.pixels, s.adjustments);
    const after = replaceLayer(doc, layer.id, { ...layer, pixels: afterPixels });
    setState({ adjustments: DEFAULT_ADJUSTMENTS, adjustmentsLayerId: null });
    commit(label, after);
  } catch (e) {
    toast('error', `Adjustment failed: ${errorMessage(e)}`);
    setState({ adjustments: DEFAULT_ADJUSTMENTS, adjustmentsLayerId: null });
  } finally {
    setBusy(null);
  }
}

/* ------------------------------------------------------------------ */
/* Document geometry                                                   */
/* ------------------------------------------------------------------ */

const TRANSFORM_LABELS: Record<DocumentTransform, string> = {
  'rotate-cw': 'Rotate 90° CW',
  'rotate-ccw': 'Rotate 90° CCW',
  'rotate-180': 'Rotate 180°',
  'flip-h': 'Flip Horizontal',
  'flip-v': 'Flip Vertical',
};

export function transformActiveDocument(op: DocumentTransform): void {
  const s = getState();
  if (!s.doc) return;
  commit(TRANSFORM_LABELS[op], transformDocument(s.doc, op));
}

export function cropActiveDocument(rect: Rect): void {
  const s = getState();
  if (!s.doc) return;
  commit(`Crop ${Math.round(rect.width)}×${Math.round(rect.height)}`, cropDocument(s.doc, rect));
  setState({ cropRect: null });
}

export function resizeActiveDocument(width: number, height: number): void {
  const s = getState();
  if (!s.doc) return;
  const next = resizeDocument(s.doc, width, height);
  if (next === s.doc) return;
  commit(`Resize to ${next.width}×${next.height}`, next);
}

export function flattenDocument(): void {
  const s = getState();
  if (!s.doc) return;
  const merged = compositeDocument(s.doc);
  const layer = createRasterLayer(merged, { name: 'Background', id: newId('layer') });
  commit('Flatten Image', { ...s.doc, layers: [layer], activeLayerId: layer.id });
}

/* ------------------------------------------------------------------ */
/* Layers (core operations used by the Layers panel)                   */
/* ------------------------------------------------------------------ */

export function addBlankLayer(): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = createRasterLayer(
    { width: doc.width, height: doc.height, data: new Uint8ClampedArray(doc.width * doc.height * 4) },
    { name: `Layer ${doc.layers.length + 1}`, x: 0, y: 0 },
  );
  const activeIdx = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  const layers = doc.layers.slice();
  layers.splice(activeIdx === -1 ? layers.length : activeIdx + 1, 0, layer);
  commit('New Layer', { ...doc, layers, activeLayerId: layer.id });
}

export function duplicateActiveLayer(): void {
  const s = getState();
  if (!s.doc || !s.doc.activeLayerId) return;
  commit('Duplicate Layer', duplicateLayerOp(s.doc, s.doc.activeLayerId));
}

export function deleteActiveLayer(): void {
  const s = getState();
  if (!s.doc || !s.doc.activeLayerId) return;
  if (s.doc.layers.length <= 1) {
    toast('warning', 'A document must keep at least one layer.');
    return;
  }
  commit('Delete Layer', removeLayerOp(s.doc, s.doc.activeLayerId));
}

export function setActiveLayer(id: string): void {
  const s = getState();
  if (!s.doc) return;
  setState({ doc: setActiveLayerOp(s.doc, id), adjustments: DEFAULT_ADJUSTMENTS, adjustmentsLayerId: null });
}

export function setLayerVisibility(id: string, visible: boolean): void {
  const s = getState();
  if (!s.doc) return;
  commit(visible ? 'Show Layer' : 'Hide Layer', updateLayer(s.doc, id, { visible }));
}

export function setLayerOpacity(id: string, opacity: number): void {
  const s = getState();
  if (!s.doc) return;
  const next = updateLayer(s.doc, id, { opacity });
  if (next === s.doc) return;
  // Sliding opacity shouldn't spam history: replace the last entry when it is
  // the same continuous action.
  const h = s.history;
  const lastIdx = h.index - 1;
  const last = lastIdx >= 0 ? h.entries[lastIdx] : null;
  if (last && last.label.startsWith('Layer Opacity') && getState().doc === last.after) {
    const entries = h.entries.slice();
    entries[lastIdx] = { ...last, after: next };
    setState({ doc: next, history: { entries, index: h.index }, dirty: true });
  } else {
    commit('Layer Opacity', next);
  }
  scheduleAutosave();
}

export function setLayerBlendMode(id: string, blendMode: BlendMode): void {
  const s = getState();
  if (!s.doc) return;
  commit(`Blend: ${blendMode}`, updateLayer(s.doc, id, { blendMode }));
}

export function renameLayer(id: string, name: string): void {
  const s = getState();
  if (!s.doc) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  commit('Rename Layer', updateLayer(s.doc, id, { name: trimmed }));
}

export function moveLayer(id: string, direction: 'up' | 'down'): void {
  const s = getState();
  if (!s.doc) return;
  const idx = s.doc.layers.findIndex((l) => l.id === id);
  if (idx === -1) return;
  const to = direction === 'up' ? idx + 1 : idx - 1;
  const next = reorderLayerOp(s.doc, id, to);
  if (next === s.doc) return;
  commit('Reorder Layer', next);
}

/* ------------------------------------------------------------------ */
/* Viewport                                                            */
/* ------------------------------------------------------------------ */

export function setWorkspaceSize(width: number, height: number): void {
  const s = getState();
  if (s.workspace.width === width && s.workspace.height === height) return;
  setState({ workspace: { width, height } });
  if (s.fitMode && s.doc && width > 0 && height > 0) {
    setState({ viewport: fitView(s.doc.width, s.doc.height, width, height) });
  }
}

export function fitToScreen(): void {
  const s = getState();
  if (!s.doc) return;
  const w = s.workspace.width || 800;
  const h = s.workspace.height || 600;
  setState({ viewport: fitView(s.doc.width, s.doc.height, w, h), fitMode: true, status: 'Fit to screen' });
}

export function setZoomAt(zoom: number, anchor: { x: number; y: number }): void {
  const s = getState();
  setState({ viewport: zoomAt(s.viewport, zoom, anchor), fitMode: false });
}

export function stepZoom(direction: 1 | -1): void {
  const s = getState();
  const anchor = s.workspace.width
    ? { x: s.workspace.width / 2, y: s.workspace.height / 2 }
    : { x: 0, y: 0 };
  setState({ viewport: nextZoomStep(s.viewport, direction, anchor), fitMode: false });
}

export function zoomToPercent(percent: number): void {
  const s = getState();
  const anchor = s.workspace.width
    ? { x: s.workspace.width / 2, y: s.workspace.height / 2 }
    : { x: 0, y: 0 };
  setState({ viewport: zoomAt(s.viewport, percent / 100, anchor), fitMode: false });
}

export function panBy(dx: number, dy: number): void {
  const s = getState();
  setState({ viewport: { ...s.viewport, panX: s.viewport.panX + dx, panY: s.viewport.panY + dy } });
}

/* ------------------------------------------------------------------ */
/* Tools & colors                                                      */
/* ------------------------------------------------------------------ */

export function setTool(tool: ToolId): void {
  // Switching tools commits a pending free transform (classic-editor parity).
  if (getState().transform) commitFreeTransform();
  setState({
    tool,
    cropRect: null,
    marqueeDraft: null,
    lassoDraft: null,
    shapeDraft: null,
    gradientDraft: null,
    status: `Tool: ${tool}`,
  });
}

export function setForeground(color: string): void {
  setState({ foreground: color });
}

export function setBackground(color: string): void {
  setState({ background: color });
}

export function swapColors(): void {
  const s = getState();
  setState({ foreground: s.background, background: s.foreground });
}

/** Photoshop "D" — foreground back to black, background back to white. */
export function resetColors(): void {
  setState({ foreground: '#000000', background: '#ffffff' });
}

/* ------------------------------------------------------------------ */
/* Inspector panel layout (Photoshop-style resize / hide)              */
/* ------------------------------------------------------------------ */

export const INSPECTOR_MIN = 240;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 304;

/** Resize the right panel (clamped) and remember the width. */
export function setInspectorWidth(width: number): void {
  const w = Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, width)));
  setState({ inspectorWidth: w });
  try {
    localStorage.setItem('pf-inspector-w', String(w));
  } catch {
    /* storage unavailable */
  }
}

/** Show/hide the right panel and remember the choice. */
export function setInspectorOpen(open: boolean): void {
  setState({ inspectorOpen: open });
  try {
    localStorage.setItem('pf-inspector-c', open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/** Restore remembered panel layout on editor boot. */
export function loadInspectorPrefs(): void {
  try {
    const w = localStorage.getItem('pf-inspector-w');
    const c = localStorage.getItem('pf-inspector-c');
    const patch: Partial<EditorState> = {};
    if (w) {
      const n = Number(w);
      if (Number.isFinite(n)) {
        patch.inspectorWidth = Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, n)));
      }
    }
    if (c !== null) patch.inspectorOpen = c !== '0';
    setState(patch);
  } catch {
    /* storage unavailable */
  }
}

/* ------------------------------------------------------------------ */
/* Selections                                                          */
/* ------------------------------------------------------------------ */

export function setSelection(sel: Selection | null, status?: string): void {
  setState({
    selection: sel,
    status:
      status ??
      (sel
        ? `Selection ${sel.bounds.width} × ${sel.bounds.height} px`
        : 'Nothing selected'),
  });
}

export function selectAll(): void {
  const doc = getState().doc;
  if (!doc) return;
  setSelection(coreSelectAll(doc.width, doc.height), `Select all — ${doc.width} × ${doc.height} px`);
}

export function deselect(): void {
  if (!getState().selection) return;
  setSelection(null, 'Deselect');
}

export function invertSelection(): void {
  const s = getState();
  if (!s.doc) return;
  setSelection(coreInvert(s.doc.width, s.doc.height, s.selection), 'Inverse selection');
}

/** Soften the selection edge by a fixed 5 px (menu: Select → Feather). */
export function featherActiveSelection(): void {
  const sel = getState().selection;
  if (!sel) return;
  setSelection(featherSelection(sel, 5), 'Feather selection (5 px)');
}

export function setMarqueeDraft(rect: Rect | null): void {
  setState({ marqueeDraft: rect });
}

export function setLassoDraft(points: Array<{ x: number; y: number }> | null): void {
  setState({ lassoDraft: points });
}

export function setShapeDraft(rect: Rect | null): void {
  setState({ shapeDraft: rect });
}

export function setGradientDraft(draft: { x1: number; y1: number; x2: number; y2: number } | null): void {
  setState({ gradientDraft: draft });
}

/** Magic-wand: select the color range around a document point.
 *  Honors tolerance, contiguous, antialias, sample source, feather, and the
 *  active selection mode (new / add / subtract / intersect). */
export function wandSelectAt(x: number, y: number): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  const source = s.sampleAll ? compositeDocument(doc) : layer?.pixels;
  if (!source) return;
  const lx = s.sampleAll ? x : x - (layer?.x ?? 0);
  const ly = s.sampleAll ? y : y - (layer?.y ?? 0);
  let sel = wandSelection(source, lx, ly, s.wandTolerance, {
    contiguous: s.contiguous,
    antialias: s.antialias,
  });
  if (!sel) return;
  // The wand ran in layer-buffer space — map the result back to document
  // space so an offset layer still selects where you actually clicked.
  if (!s.sampleAll && layer) sel = offsetSelection(sel, layer.x, layer.y);
  if (s.featherPx > 0) sel = featherSelection(sel, s.featherPx);
  const combined = combineSelection(s.selection, sel, s.selectionMode);
  setSelection(combined, `Wand — ${sel.bounds.width} × ${sel.bounds.height} px`);
}

/** Object Selection: click an object — the flood grows through matching
 *  colour but stops at strong edges (Sobel barrier), isolating the region
 *  the way a segmentation tool would, using only local pixel maths. */
export function objectSelectAt(x: number, y: number): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  const source = s.sampleAll ? compositeDocument(doc) : layer?.pixels;
  if (!source) return;
  const lx = s.sampleAll ? x : x - (layer?.x ?? 0);
  const ly = s.sampleAll ? y : y - (layer?.y ?? 0);
  const map = gradientMagnitude(source);
  let sel = wandSelection(source, lx, ly, s.wandTolerance, {
    contiguous: true,
    antialias: s.antialias,
    edge: { map, threshold: s.edgeThreshold * 2.55 },
  });
  if (!sel) return;
  // Result is in layer-buffer space — map back to document space.
  if (!s.sampleAll && layer) sel = offsetSelection(sel, layer.x, layer.y);
  if (s.featherPx > 0) sel = featherSelection(sel, s.featherPx);
  const combined = combineSelection(s.selection, sel, s.selectionMode);
  setSelection(combined, `Object Selection — ${sel.bounds.width} × ${sel.bounds.height} px`);
}

/** Magic Eraser: one click floods alpha-to-zero over the matching color
 *  range (tolerance, contiguous, and fill opacity all apply). */
export function magicEraseAt(x: number, y: number): void {
  const s = getState();
  if (!s.doc) return;
  const session = beginPixelEdit();
  if (!session) return;
  const bufPt = { x: x - session.origin.x, y: y - session.origin.y };
  const ctx: PaintContext = { selection: s.selection, origin: session.origin };
  const changed = floodErase(
    session.pixels,
    Math.floor(bufPt.x),
    Math.floor(bufPt.y),
    s.wandTolerance,
    ctx,
    s.contiguous,
    s.fillOpacity / 100,
  );
  finishPixelEdit(session.before, 'Magic Eraser', changed);
}

/** Delete/Backspace: clear the selection inside the active layer (or all of it). */
export function clearActivePixels(): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const partial = s.selection !== null;
  const pixels = clonePixelBuffer(layer.pixels);
  clearPixels(pixels, { selection: s.selection, origin: { x: layer.x, y: layer.y } }, partial);
  commit(partial ? 'Clear Selection' : 'Clear Layer', replaceLayer(doc, layer.id, { ...layer, pixels }));
}

/** Alt/Ctrl+Backspace: fill the selection (or the whole layer) with a color. */
export function fillActivePixels(which: 'fg' | 'bg'): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const partial = s.selection !== null;
  const pixels = clonePixelBuffer(layer.pixels);
  const color = hexToRgba(which === 'fg' ? s.foreground : s.background);
  fillPixels(pixels, color, { selection: s.selection, origin: { x: layer.x, y: layer.y } });
  const label = which === 'fg' ? 'Fill Foreground' : 'Fill Background';
  commit(partial ? `${label} (Selection)` : label, replaceLayer(doc, layer.id, { ...layer, pixels }));
}

/** Ctrl+I: invert the colors of the selection (or the whole layer). */
export function invertActivePixels(): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const partial = s.selection !== null;
  const pixels = clonePixelBuffer(layer.pixels);
  invertPixels(pixels, { selection: s.selection, origin: { x: layer.x, y: layer.y } });
  commit(partial ? 'Invert (Selection)' : 'Invert Colors', replaceLayer(doc, layer.id, { ...layer, pixels }));
}

/* ------------------------------------------------------------------ */
/* Selection modify commands (Select menu)                             */
/* ------------------------------------------------------------------ */

function modifySelection(label: string, op: (sel: Selection) => Selection): void {
  const s = getState();
  if (!s.doc || !s.selection) return;
  setSelection(op(s.selection), label);
}

/** Grow: dilate the mask outward (Select → Grow). */
export function growSelectionBy(radius = 1): void {
  modifySelection(`Grow Selection ${radius} px`, (sel) => growSelection(sel, radius));
}

/** Contract: erode the mask inward (Select → Shrink). */
export function shrinkSelectionBy(radius = 1): void {
  modifySelection(`Contract Selection ${radius} px`, (sel) => shrinkSelection(sel, radius));
}

/** Smooth: blur + re-threshold to drop specks and round corners. */
export function smoothSelectionBy(radius = 2): void {
  modifySelection(`Smooth Selection ${radius} px`, (sel) => smoothSelection(sel, radius));
}

/** Feather by an explicit radius (the Feather… dialog). */
export function featherBy(radius: number): void {
  modifySelection(`Feather ${radius} px`, (sel) => featherSelection(sel, radius));
}

/* ------------------------------------------------------------------ */
/* Auto corrections                                                    */
/* ------------------------------------------------------------------ */

/** One-click Auto Tone / Auto Contrast / Auto Color (histogram-based). */
export function applyAuto(kind: 'tone' | 'contrast' | 'color'): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const pixels = clonePixelBuffer(layer.pixels);
  const ctx = { selection: s.selection, origin: { x: layer.x, y: layer.y } };
  if (kind === 'tone') autoTone(pixels, ctx);
  else if (kind === 'contrast') autoContrast(pixels, ctx);
  else autoColor(pixels, ctx);
  const title = kind === 'tone' ? 'Auto Tone' : kind === 'contrast' ? 'Auto Contrast' : 'Auto Color';
  commit(title, replaceLayer(doc, layer.id, { ...layer, pixels }));
}

/* ------------------------------------------------------------------ */
/* Layer commands (classic-editor shortcuts)                           */
/* ------------------------------------------------------------------ */

/** Ctrl+J / Ctrl+Shift+J: selection-clipped copy (or cut) onto a new layer.
 *  With no selection this duplicates the layer, like the classic editors. */
export function layerViaCopy(cut = false): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const sel = s.selection;
  if (!sel) {
    duplicateActiveLayer();
    return;
  }
  // Clip to the document, then walk the selection bounds.
  const bx = Math.max(0, sel.bounds.x);
  const by = Math.max(0, sel.bounds.y);
  const bw = Math.min(doc.width, sel.bounds.x + sel.bounds.width) - bx;
  const bh = Math.min(doc.height, sel.bounds.y + sel.bounds.height) - by;
  if (bw <= 0 || bh <= 0) return;
  const out = createPixelBuffer(bw, bh, 0);
  const src = layer.pixels;
  const cutBuf = cut ? clonePixelBuffer(src) : null;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const dx = bx + x;
      const dy = by + y;
      const g = selectionAlpha(sel, dx, dy);
      if (g === 0) continue;
      const sx = dx - layer.x;
      const sy = dy - layer.y;
      if (sx >= 0 && sy >= 0 && sx < src.width && sy < src.height) {
        const si = (sy * src.width + sx) * 4;
        const di = (y * bw + x) * 4;
        out.data[di] = src.data[si];
        out.data[di + 1] = src.data[si + 1];
        out.data[di + 2] = src.data[si + 2];
        out.data[di + 3] = (src.data[si + 3] * g) / 255;
      }
      if (cutBuf && sx >= 0 && sy >= 0 && sx < cutBuf.width && sy < cutBuf.height) {
        const ci = (sy * cutBuf.width + sx) * 4;
        cutBuf.data[ci + 3] = (cutBuf.data[ci + 3] * (255 - g)) / 255;
      }
    }
  }
  let next = addLayer(
    doc,
    createRasterLayer(out, { name: `${layer.name} ${cut ? 'cut' : 'copy'}`, x: bx, y: by }),
    { aboveActive: true },
  );
  if (cutBuf) next = replaceLayer(next, layer.id, { ...layer, pixels: cutBuf });
  commit(cut ? 'Layer via Cut' : 'Layer via Copy', next);
}

/** Ctrl+E: merge the active layer into the one beneath it (masks and blend
 *  modes baked in, result clipped to the union of their rectangles). */
export function mergeDown(): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const idx = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
  if (idx <= 0) return; // layers[n-1] is the top; nothing below
  const top = doc.layers[idx];
  const bottom = doc.layers[idx - 1];
  const ux0 = Math.max(0, Math.min(top.x, bottom.x));
  const uy0 = Math.max(0, Math.min(top.y, bottom.y));
  const ux1 = Math.min(doc.width, Math.max(top.x + top.pixels.width, bottom.x + bottom.pixels.width));
  const uy1 = Math.min(doc.height, Math.max(top.y + top.pixels.height, bottom.y + bottom.pixels.height));
  const w = Math.max(1, ux1 - ux0);
  const h = Math.max(1, uy1 - uy0);
  // Bake both layers into a document-sized scratch, then crop to the union.
  const scratch: PixelBuffer = { width: doc.width, height: doc.height, data: new Uint8ClampedArray(doc.width * doc.height * 4) };
  compositeLayerInto(scratch.data, doc.width, doc.height, bottom);
  compositeLayerInto(scratch.data, doc.width, doc.height, top);
  const merged = cropBuffer(scratch, { x: ux0, y: uy0, width: w, height: h });
  let next = replaceLayer(doc, bottom.id, {
    ...bottom,
    pixels: merged,
    x: ux0,
    y: uy0,
    opacity: 1,
    blendMode: 'normal',
    mask: null,
  });
  next = removeLayerOp(next, top.id);
  next = setActiveLayerOp(next, bottom.id);
  commit('Merge Down', next);
}

/** Alt+Ctrl+Z: step backward through history. */
export function stepBackward(): void {
  const s = getState();
  if (s.history.index > 0) jumpHistory(s.history.index - 1);
}

/** Digit keys: set the active layer's opacity (0 → 100 %). */
export function setActiveSheetOpacity(percent: number): void {
  const s = getState();
  if (!s.doc || !s.doc.activeLayerId) return;
  // Layer.opacity is stored as a 0..1 fraction; the UI shows it as a percent.
  const fraction = Math.max(0, Math.min(100, Math.round(percent))) / 100;
  setLayerOpacity(s.doc.activeLayerId, fraction);
}

/* ------------------------------------------------------------------ */
/* Free Transform (Ctrl+T)                                             */
/* ------------------------------------------------------------------ */

/** Begin a free-transform session on the active layer. */
export function beginFreeTransform(): void {
  const s = getState();
  const doc = s.doc;
  if (!doc || s.transform) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  setState({
    transform: { layerId: layer.id, x: layer.x, y: layer.y, scaleX: 1, scaleY: 1, rotation: 0 },
    status: 'Free Transform — Enter commits, Esc cancels',
  });
}

/** Update the live transform (called on every pointer move while dragging). */
export function setTransformLive(next: Partial<Omit<FreeTransform, 'layerId'>>): void {
  const t = getState().transform;
  if (!t) return;
  setState({ transform: { ...t, ...next } });
}

export function cancelFreeTransform(): void {
  if (!getState().transform) return;
  setState({ transform: null, status: 'Transform cancelled' });
}

/** Matrix for a transform session (layer-local pixels → document space). */
export function transformMatrix(t: FreeTransform): Matrix {
  const c = Math.cos(t.rotation);
  const sn = Math.sin(t.rotation);
  return [c * t.scaleX, sn * t.scaleX, -sn * t.scaleY, c * t.scaleY, t.x, t.y];
}

/** Commit the transform: resample the layer's pixels through the matrix. */
export function commitFreeTransform(): void {
  const s = getState();
  const t = s.transform;
  if (!t) return;
  setState({ transform: null });
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, t.layerId);
  if (!layer) return;
  const identity =
    t.scaleX === 1 && t.scaleY === 1 && t.rotation === 0 && t.x === layer.x && t.y === layer.y;
  if (identity) {
    setState({ status: 'Transform unchanged' });
    return;
  }
  const { pixels, x, y } = warpBuffer(layer.pixels, transformMatrix(t));
  commit('Free Transform', replaceLayer(doc, layer.id, { ...layer, pixels, x, y }));
}

/* ------------------------------------------------------------------ */
/* Tool options                                                        */
/* ------------------------------------------------------------------ */

export function setBrushSize(size: number): void {
  setState({ brushSize: Math.max(1, Math.min(400, Math.round(size))) });
}

export function setBrushOpacity(percent: number): void {
  setState({ brushOpacity: Math.max(1, Math.min(100, Math.round(percent))) });
}

export function setWandTolerance(value: number): void {
  setState({ wandTolerance: Math.max(0, Math.min(100, Math.round(value))) });
}

export function setEdgeThreshold(value: number): void {
  setState({ edgeThreshold: Math.max(0, Math.min(100, Math.round(value))) });
}

export function setShapeKind(kind: 'rect' | 'ellipse'): void {
  setState({ shapeKind: kind });
}

export function setTextValue(value: string): void {
  setState({ textValue: value });
}

export function setTextSize(size: number): void {
  setState({ textSize: Math.max(6, Math.min(400, Math.round(size))) });
}

export function setCloneOffset(offset: { x: number; y: number } | null): void {
  // A fresh source also re-bases aligned sampling for subsequent strokes.
  setState({ cloneOffset: offset, cloneStrokeOffset: null });
}

/** Arrow-key nudge of the active layer (move tool). */
export function nudgeActiveLayer(dx: number, dy: number): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const moved = replaceLayer(doc, layer.id, { ...layer, x: layer.x + dx, y: layer.y + dy });
  commit('Move Layer', moved);
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

const ALIGN_LABEL: Record<AlignMode, string> = {
  left: 'Align Left',
  hcenter: 'Align Horizontal Centers',
  right: 'Align Right',
  top: 'Align Top',
  vcenter: 'Align Vertical Centers',
  bottom: 'Align Bottom',
};

/** Align the active layer to the selection's bounds — or to the canvas when
 *  nothing is selected. Pure geometry move, one history step. */
export function alignActiveLayer(mode: AlignMode): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const ref = s.selection
    ? s.selection.bounds
    : { x: 0, y: 0, width: doc.width, height: doc.height };
  const lw = layer.pixels.width;
  const lh = layer.pixels.height;
  let x = layer.x;
  let y = layer.y;
  switch (mode) {
    case 'left':
      x = ref.x;
      break;
    case 'hcenter':
      x = Math.round(ref.x + (ref.width - lw) / 2);
      break;
    case 'right':
      x = ref.x + ref.width - lw;
      break;
    case 'top':
      y = ref.y;
      break;
    case 'vcenter':
      y = Math.round(ref.y + (ref.height - lh) / 2);
      break;
    case 'bottom':
      y = ref.y + ref.height - lh;
      break;
  }
  if (x === layer.x && y === layer.y) {
    setState({ status: 'Layer already aligned' });
    return;
  }
  commit(ALIGN_LABEL[mode], replaceLayer(doc, layer.id, { ...layer, x, y }));
}

/* ------------------------------------------------------------------ */
/* Live pixel edits (strokes)                                          */
/* ------------------------------------------------------------------ */

export interface PixelEditSession {
  /** Document before the edit — the undo snapshot (its buffers stay intact). */
  before: EditorDocument;
  /** Fresh copy of the active layer's pixels; mutated in place while stroking. */
  pixels: PixelBuffer;
  layerId: string;
  /** Buffer (x, y) → document (x, y). */
  origin: { x: number; y: number };
}

/**
 * Start a stroke: copy the active layer's pixels (so history snapshots are
 * never aliased to the buffer being painted) and publish the new document
 * without recording history — `finishPixelEdit` commits exactly one entry.
 */
export function beginPixelEdit(): PixelEditSession | null {
  const s = getState();
  const doc = s.doc;
  if (!doc) return null;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return null;
  const pixels = clonePixelBuffer(layer.pixels);
  const next = replaceLayer(doc, layer.id, { ...layer, pixels });
  setState({ doc: next });
  return { before: doc, pixels, layerId: layer.id, origin: { x: layer.x, y: layer.y } };
}

/** Nudge the document reference so subscribers re-render after in-place edits. */
export function touchDoc(): void {
  const doc = getState().doc;
  if (doc) setState({ doc: { ...doc } });
}

/** Live (uncommitted) layer translation for the Move tool. */
export function setLayerOffsetLive(layerId: string, x: number, y: number): void {
  const doc = getState().doc;
  if (!doc) return;
  const layer = getLayer(doc, layerId);
  if (!layer || (layer.x === x && layer.y === y)) return;
  setState({ doc: replaceLayer(doc, layerId, { ...layer, x, y }) });
}

/** Commit one history entry for a finished stroke (or roll back if unchanged). */
export function finishPixelEdit(before: EditorDocument | null, label: string, changed: boolean): void {
  if (!before) return;
  const s = getState();
  if (!s.doc) return;
  if (!changed || s.doc === before) {
    setState({ doc: before, status: 'No change' });
    return;
  }
  const history = pushEntry(s.history, { label, before, after: s.doc });
  setState({ history, dirty: true, status: label });
  scheduleAutosave();
}

/* ------------------------------------------------------------------ */
/* Shape / gradient / text                                             */
/* ------------------------------------------------------------------ */

/** The shape kind for the active tool: flyout variants pin their own kind,
 *  while the base Shape tool keeps its rect/ellipse dropdown. */
export function currentShapeKind(s: EditorState): 'rect' | 'ellipse' | 'rounded' | 'polygon' {
  if (s.tool === 'shape-round') return 'rounded';
  if (s.tool === 'shape-poly') return 'polygon';
  if (s.tool === 'shape-ellipse') return 'ellipse';
  return s.shapeKind;
}

/** Regular polygon inscribed in `rect` (first vertex at the top). */
function regularPolygon(rect: Rect, sides: number): Array<{ x: number; y: number }> {
  const n = Math.max(3, Math.min(12, Math.round(sides)));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

/** Fill a rectangle, ellipse, rounded rectangle, or regular polygon. */
export function applyShape(docRect: Rect): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const pixels = clonePixelBuffer(layer.pixels);
  const ctx: PaintContext = {
    selection: s.selection,
    origin: { x: layer.x, y: layer.y },
  };
  const color = hexToRgba(s.foreground);
  const kind = currentShapeKind(s);
  const radius = s.shapeCornerRadius;
  const sides = Math.max(3, Math.min(12, Math.round(s.polygonSides)));
  const rect: Rect = { ...docRect, x: docRect.x - layer.x, y: docRect.y - layer.y };
  const drawShape = (r: Rect, c: Rgba, rad = radius): void => {
    switch (kind) {
      case 'ellipse':
        fillEllipse(pixels, r, c, ctx);
        break;
      case 'rounded':
        fillRoundedRect(pixels, r, rad, c, ctx);
        break;
      case 'polygon':
        fillPolygon(pixels, regularPolygon(r, sides), c, ctx);
        break;
      default:
        fillRect(pixels, r, c, ctx);
    }
  };
  if (s.shapeStroke > 0) {
    // Outline inside the shape edge, drawn in the background color.
    const w = Math.min(s.shapeStroke, Math.floor(Math.min(rect.width, rect.height) / 2));
    if (kind === 'polygon') {
      // Shrink proportionally about the centre so the outline stays parallel.
      const m = Math.max(1, Math.min(rect.width, rect.height));
      const k = Math.max(0, (m - 2 * w) / m);
      fillPolygon(pixels, regularPolygon(rect, sides), hexToRgba(s.background), ctx);
      drawShape(
        {
          x: rect.x + (rect.width * (1 - k)) / 2,
          y: rect.y + (rect.height * (1 - k)) / 2,
          width: rect.width * k,
          height: rect.height * k,
        },
        color,
      );
    } else {
      drawShape(rect, hexToRgba(s.background));
      drawShape(
        { x: rect.x + w, y: rect.y + w, width: Math.max(1, rect.width - 2 * w), height: Math.max(1, rect.height - 2 * w) },
        color,
        Math.max(0, radius - w),
      );
    }
  } else {
    drawShape(rect, color);
  }
  const label =
    kind === 'ellipse'
      ? 'Add Ellipse'
      : kind === 'rounded'
        ? 'Add Rounded Rectangle'
        : kind === 'polygon'
          ? `Add Polygon (${sides} sides)`
          : 'Add Rectangle';
  commit(label, replaceLayer(doc, layer.id, { ...layer, pixels }));
}

/** Drag-out line (the Line shape tool) into the active layer. */
export function applyLineShape(x0: number, y0: number, x1: number, y1: number): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const pixels = clonePixelBuffer(layer.pixels);
  const ctx: PaintContext = {
    selection: s.selection,
    origin: { x: layer.x, y: layer.y },
  };
  strokeThickLine(
    pixels,
    x0 - layer.x,
    y0 - layer.y,
    x1 - layer.x,
    y1 - layer.y,
    Math.max(1, s.shapeStroke),
    hexToRgba(s.foreground),
    ctx,
  );
  commit('Add Line', replaceLayer(doc, layer.id, { ...layer, pixels }));
}

/** Drag-out gradient (foreground → background) into the active layer.
 *  Linear, radial, angle, reflected, and diamond shapes, plus a reverse
 *  swap of the two colors. */
export function applyGradient(x0: number, y0: number, x1: number, y1: number): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const layer = getLayer(doc, doc.activeLayerId ?? '');
  if (!layer) return;
  const pixels = clonePixelBuffer(layer.pixels);
  const ctx: PaintContext = {
    selection: s.selection,
    origin: { x: layer.x, y: layer.y },
  };
  const fg = hexToRgba(s.foreground);
  const bg = hexToRgba(s.background);
  const [start, end] = s.gradientReverse ? [fg, bg] : [bg, fg];
  const px0 = x0 - layer.x;
  const py0 = y0 - layer.y;
  const px1 = x1 - layer.x;
  const py1 = y1 - layer.y;
  switch (s.gradientStyle) {
    case 'radial':
      applyRadialGradient(pixels, px0, py0, px1, py1, start, end, ctx);
      break;
    case 'angle':
      applyAngleGradient(pixels, px0, py0, px1, py1, start, end, ctx);
      break;
    case 'reflected':
      applyReflectedGradient(pixels, px0, py0, px1, py1, start, end, ctx);
      break;
    case 'diamond':
      applyDiamondGradient(pixels, px0, py0, px1, py1, start, end, ctx);
      break;
    default:
      applyLinearGradient(pixels, px0, py0, px1, py1, start, end, ctx);
  }
  commit('Gradient', replaceLayer(doc, layer.id, { ...layer, pixels }));
}

/** Place the Tool Options text as a new raster layer at the clicked point. */
export function placeTextLayer(x: number, y: number): void {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const text = s.textValue;
  if (!text.trim()) {
    toast('warning', 'Type some text in the tool options bar first.');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = doc.width;
  canvas.height = doc.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = s.textSize;
  const family = s.fontFamily;
  ctx.font = `600 ${size}px ${family}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = s.textAlign;
  ctx.fillStyle = s.foreground;
  const lines = text.split('\n');
  const lineHeight = Math.round(size * 1.25);
  // ctx.textAlign already anchors the fill at the click point: left starts
  // there, center straddles it, right ends there — no extra offsets.
  const ax = Math.round(x);
  lines.forEach((line, i) => ctx.fillText(line, ax, Math.round(y + i * lineHeight)));
  const image = ctx.getImageData(0, 0, doc.width, doc.height);
  const first = (lines[0] ?? '').trim();
  const layer = createRasterLayer(
    { width: doc.width, height: doc.height, data: new Uint8ClampedArray(image.data) },
    { name: `Text “${first.slice(0, 18)}${first.length > 18 ? '…' : ''}”` },
  );
  commit('Add Text Layer', addLayer(doc, layer, { aboveActive: true }));
}

export function setCropRect(rect: Rect | null): void {
  setState({ cropRect: rect });
}

export function setCursor(x: number | null, y: number | null): void {
  // No-op when the cell did not change: this fires on every pointer move, and a
  // fresh object here would wake every subscriber for a stale readout.
  const cur = getState().cursor;
  if (x === null || y === null) {
    if (cur !== null) setState({ cursor: null });
    return;
  }
  if (cur && cur.x === x && cur.y === y) return;
  setState({ cursor: { x, y } });
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export async function exportActiveImage(format: ExportFormat, quality = 0.92): Promise<void> {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  setBusy(`Exporting ${format.toUpperCase()}…`);
  try {
    const blob = await exportDocument(doc, {
      format,
      quality,
      background: format === 'jpeg' ? '#ffffff' : null,
    });
    downloadBlob(blob, exportFilename(doc.name, format));
    setState({
      status: `Exported ${format.toUpperCase()} — ${doc.width}×${doc.height}`,
      dirty: false,
    });
  } catch (e) {
    toast('error', errorMessage(e));
    setState({ status: 'Export failed' });
  } finally {
    setBusy(null);
  }
}

/* ------------------------------------------------------------------ */
/* Project files (.pixelforge)                                         */
/* ------------------------------------------------------------------ */

export async function downloadProjectFile(): Promise<void> {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  setBusy('Saving project…');
  try {
    const blob = await serializeProject({
      ...doc,
      meta: { ...doc.meta, modifiedAt: Date.now() },
    });
    const filename = `${doc.name.replace(/\.[a-z0-9]+$/i, '') || 'project'}.pixelforge`;
    downloadBlob(blob, filename);
    setState({ dirty: false, status: `Saved project file ${filename}` });
  } catch (e) {
    toast('error', `Could not save project: ${errorMessage(e)}`);
  } finally {
    setBusy(null);
  }
}

export async function openProjectFromFile(file: File): Promise<void> {
  setBusy(`Opening ${file.name}…`);
  try {
    const doc = await parseProject(file);
    resetState({ ...stateForNewDocument(doc), status: `Opened project ${doc.name}` });
  } catch (e) {
    toast('error', errorMessage(e));
    setState({ status: 'Could not open project' });
  } finally {
    setBusy(null);
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB persistence                                               */
/* ------------------------------------------------------------------ */

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let quotaWarned = false;

function scheduleAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    void runAutosave();
  }, 2000);
}

async function runAutosave(): Promise<void> {
  const s = getState();
  if (!s.doc || s.busy) {
    if (s.doc) scheduleAutosave();
    return;
  }
  try {
    const blob = await serializeProject({
      ...s.doc,
      meta: { ...s.doc.meta, modifiedAt: Date.now() },
    });
    await putAutosave({ key: 'current', savedAt: Date.now(), name: s.doc.name, data: blob });
    setState({ lastAutosave: Date.now() });
  } catch (e) {
    if (e instanceof StorageError && e.code === 'quota' && !quotaWarned) {
      quotaWarned = true;
      toast('warning', e.message);
    }
    // Autosave failures are otherwise silent; explicit saves report errors.
  }
}

export async function saveProjectToBrowser(): Promise<void> {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  setBusy('Saving to browser storage…');
  try {
    const id = s.projectId ?? newId('proj');
    const blob = await serializeProject({ ...doc, meta: { ...doc.meta, modifiedAt: Date.now() } });
    await saveProjectRecord({
      id,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      layerCount: doc.layers.length,
      modifiedAt: Date.now(),
      savedAt: Date.now(),
      data: blob,
    });
    setState({ projectId: id, dirty: false, status: `Saved "${doc.name}" to browser storage` });
    toast('info', 'Project saved to browser storage. Browser data can be cleared at any time — keep a project file copy for long-term safekeeping.');
  } catch (e) {
    toast('error', e instanceof StorageError ? e.message : errorMessage(e));
  } finally {
    setBusy(null);
  }
}

export async function listSavedProjects(): Promise<ProjectMeta[]> {
  return listProjects();
}

export async function openProjectFromBrowser(id: string): Promise<void> {
  setBusy('Loading saved project…');
  try {
    const record = await getProjectRecord(id);
    if (!record) throw new Error('That saved project no longer exists.');
    const doc = await parseProject(record.data);
    resetState({
      ...stateForNewDocument(doc),
      projectId: id,
      status: `Opened saved project "${doc.name}"`,
    });
  } catch (e) {
    toast('error', errorMessage(e));
  } finally {
    setBusy(null);
  }
}

export async function downloadSavedProject(id: string): Promise<void> {
  try {
    const record = await getProjectRecord(id);
    if (!record) throw new Error('That saved project no longer exists.');
    downloadBlob(record.data, `${record.name.replace(/\.[a-z0-9]+$/i, '')}.pixelforge`);
  } catch (e) {
    toast('error', errorMessage(e));
  }
}

export async function deleteSavedProject(id: string): Promise<void> {
  try {
    await deleteProjectRecord(id);
    const s = getState();
    if (s.projectId === id) setState({ projectId: null, dirty: true });
    toast('info', 'Saved project deleted from browser storage.');
  } catch (e) {
    toast('error', errorMessage(e));
  }
}

export async function clearBrowserStorage(): Promise<void> {
  try {
    await clearAllProjects();
    setState({ projectId: null, lastAutosave: null });
    toast('info', 'All locally saved projects and autosaves were cleared.');
  } catch (e) {
    toast('error', errorMessage(e));
  }
}

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

export async function peekAutosave(): Promise<{ name: string; savedAt: number } | null> {
  try {
    const rec = await getAutosave();
    if (!rec) return null;
    // Don't offer recovery for work that is already saved/open.
    const s = getState();
    if (s.doc && !s.dirty) {
      await clearAutosave();
      return null;
    }
    if (s.doc) return null; // an open document: never clobber it silently
    return { name: rec.name, savedAt: rec.savedAt };
  } catch {
    return null;
  }
}

export async function recoverAutosave(): Promise<void> {
  setBusy('Recovering…');
  try {
    const rec = await getAutosave();
    if (!rec) return;
    const doc = await parseProject(rec.data);
    resetState({
      ...stateForNewDocument(doc),
      status: `Recovered autosaved session "${doc.name}" from ${new Date(rec.savedAt).toLocaleTimeString()}`,
    });
    toast('info', 'Session recovered from local autosave.');
  } catch (e) {
    toast('error', `Recovery failed: ${errorMessage(e)}`);
  } finally {
    setBusy(null);
  }
}

export async function discardAutosave(): Promise<void> {
  try {
    await clearAutosave();
  } catch {
    /* best effort */
  }
}

/** Cancel background work tied to the current document. */
export function resetProcessing(): void {
  cancelWorkerAdjustments();
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}
