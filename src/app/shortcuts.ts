/**
 * Global keyboard shortcuts.
 *
 * All shortcuts are suppressed while the user types into inputs, textareas,
 * selects, or contenteditable regions.
 */
import type { ToolId } from '../core/document/types';
import {
  addBlankLayer,
  applyPendingAdjustments,
  beginFreeTransform,
  cancelPendingAdjustments,
  clearActivePixels,
  cropActiveDocument,
  deselect,
  downloadProjectFile,
  fillActivePixels,
  fitToScreen,
  invertActivePixels,
  invertSelection,
  layerViaCopy,
  mergeDown,
  nudgeActiveLayer,
  openImageFile,
  redo,
  resetColors,
  saveProjectToBrowser,
  selectAll,
  setActiveSheetOpacity,
  setBrushSize,
  setTool,
  stepBackward,
  stepZoom,
  swapColors,
  undo,
  zoomToPercent,
} from './actions';
import { getState, setState } from './editorStore';
import { TOOL_GROUP, cycleToolInGroup } from './toolDefs';
import { pickFile } from '../utils/filePicker';

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

export function isModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

export interface ShortcutDefinition {
  id: string;
  /** Display form, e.g. "Ctrl+Z". */
  keys: string;
  group: 'File' | 'Edit' | 'View' | 'Tools' | 'Other';
  description: string;
}

/** Canonical list rendered in the Help → Keyboard Shortcuts dialog. */
export const SHORTCUTS: ShortcutDefinition[] = [
  { id: 'open', keys: 'Ctrl+O', group: 'File', description: 'Open image' },
  { id: 'save', keys: 'Ctrl+S', group: 'File', description: 'Save project to browser storage' },
  { id: 'export', keys: 'Ctrl+Shift+S', group: 'File', description: 'Export image (PNG/JPEG/WebP)' },
  { id: 'downloadProject', keys: 'Ctrl+Shift+P', group: 'File', description: 'Download project file (.pixelforge)' },
  { id: 'undo', keys: 'Ctrl+Z', group: 'Edit', description: 'Undo' },
  { id: 'redo', keys: 'Ctrl+Shift+Z', group: 'Edit', description: 'Redo' },
  { id: 'redo2', keys: 'Ctrl+Y', group: 'Edit', description: 'Redo (alternative)' },
  { id: 'applyAdjust', keys: 'Enter', group: 'Edit', description: 'Apply pending adjustments / crop' },
  { id: 'cancelAdjust', keys: 'Esc', group: 'Edit', description: 'Cancel pending adjustments / crop / dialog / selection' },
  { id: 'selectAll', keys: 'Ctrl+A', group: 'Edit', description: 'Select all' },
  { id: 'deselect', keys: 'Ctrl+D', group: 'Edit', description: 'Deselect' },
  { id: 'inverse', keys: 'Ctrl+Shift+I', group: 'Edit', description: 'Inverse selection' },
  { id: 'deletePixels', keys: 'Delete', group: 'Edit', description: 'Clear selection (or layer)' },
  { id: 'fillFg', keys: 'Alt+Backspace', group: 'Edit', description: 'Fill with foreground color' },
  { id: 'fillBg', keys: 'Ctrl+Backspace', group: 'Edit', description: 'Fill with background color' },
  { id: 'invertPixels', keys: 'Ctrl+I', group: 'Edit', description: 'Invert colors (selection or layer)' },
  { id: 'newLayer', keys: 'Ctrl+Shift+N', group: 'Edit', description: 'New layer' },
  { id: 'transform', keys: 'Ctrl+T', group: 'Edit', description: 'Free Transform the active layer (move / scale / rotate)' },
  { id: 'layerViaCopy', keys: 'Ctrl+J', group: 'Edit', description: 'Layer via copy (no selection: duplicate the layer)' },
  { id: 'layerViaCut', keys: 'Ctrl+Shift+J', group: 'Edit', description: 'Layer via cut' },
  { id: 'mergeDown', keys: 'Ctrl+E', group: 'Edit', description: 'Merge the layer down' },
  { id: 'stepBack', keys: 'Alt+Ctrl+Z', group: 'Edit', description: 'Step backward through history' },
  { id: 'feather', keys: 'Shift+F6', group: 'Edit', description: 'Feather the selection…' },
  { id: 'opacity', keys: '0–9', group: 'Edit', description: 'Set layer opacity (1 = 10 % … 0 = 100 %)' },
  { id: 'fit', keys: 'Ctrl+0', group: 'View', description: 'Fit image to screen' },
  { id: 'actual', keys: 'Ctrl+1', group: 'View', description: 'Zoom to 100%' },
  { id: 'zoomIn', keys: '+ / Ctrl+=', group: 'View', description: 'Zoom in' },
  { id: 'zoomOut', keys: '- / Ctrl+-', group: 'View', description: 'Zoom out' },
  { id: 'tool-move', keys: 'V', group: 'Tools', description: 'Move tool (arrow keys nudge, Shift = 10 px; options bar toggles Auto-Select and Transform controls)' },
  { id: 'tool-marquee', keys: 'M', group: 'Tools', description: 'Marquee selection (repeat M to cycle ellipse/row/column)' },
  { id: 'tool-lasso', keys: 'L', group: 'Tools', description: 'Lasso selection (repeat L for polygonal, magnetic lasso)' },
  { id: 'tool-wand', keys: 'W', group: 'Tools', description: 'Magic wand (repeat W for Quick Selection, then Object Selection)' },
  { id: 'tool-brush', keys: 'B', group: 'Tools', description: 'Brush tool (repeat B for pencil, color replacement)' },
  { id: 'tool-eraser', keys: 'E', group: 'Tools', description: 'Eraser (repeat E for magic eraser, background eraser)' },
  { id: 'tool-clone', keys: 'S', group: 'Tools', description: 'Clone stamp (Alt-click sets the source)' },
  { id: 'tool-healing', keys: 'J', group: 'Tools', description: 'Healing brush (repeat J for spot healing, patch, red eye)' },
  { id: 'tool-crop', keys: 'C', group: 'Tools', description: 'Crop tool' },
  { id: 'tool-text', keys: 'T', group: 'Tools', description: 'Text tool' },
  { id: 'tool-shape', keys: 'U', group: 'Tools', description: 'Shape tool (repeat U for rounded rectangle, ellipse, polygon, line)' },
  { id: 'tool-gradient', keys: 'G', group: 'Tools', description: 'Gradient tool — linear/radial/angle/reflected/diamond (Shift+G for Paint Bucket)' },
  { id: 'tool-bucket', keys: 'Shift+G', group: 'Tools', description: 'Paint bucket — flood fill with the foreground color' },
  { id: 'tool-blur', keys: 'R', group: 'Tools', description: 'Blur tool (repeat R for sharpen, smudge)' },
  { id: 'tool-sharpen', keys: 'Y', group: 'Tools', description: 'Sharpen tool' },
  { id: 'tool-dodge', keys: 'O', group: 'Tools', description: 'Dodge tool (Shift+O for Burn; repeat O for sponge)' },
  { id: 'tool-hand', keys: 'H', group: 'Tools', description: 'Hand tool (hold Space to pan)' },
  { id: 'tool-zoom', keys: 'Z', group: 'Tools', description: 'Zoom tool' },
  { id: 'tool-eyedropper', keys: 'I', group: 'Tools', description: 'Eyedropper tool' },
  { id: 'swapColors', keys: 'X', group: 'Tools', description: 'Swap foreground/background colors' },
  { id: 'defaultColors', keys: 'D', group: 'Tools', description: 'Default foreground/background colors' },
  { id: 'brushSmaller', keys: '[', group: 'Tools', description: 'Decrease brush size (Shift = 10× step)' },
  { id: 'brushLarger', keys: ']', group: 'Tools', description: 'Increase brush size (Shift = 10× step)' },
];

const TOOL_BY_KEY: Record<string, ToolId> = {
  v: 'move',
  m: 'marquee',
  l: 'lasso',
  w: 'wand',
  c: 'crop',
  b: 'brush',
  e: 'eraser',
  s: 'clone',
  j: 'healing',
  g: 'gradient',
  r: 'blur',
  y: 'sharpen',
  o: 'dodge',
  h: 'hand',
  z: 'zoom',
  i: 'eyedropper',
  t: 'text',
  u: 'shape',
};

/**
 * Map a keydown event to a shortcut id (or null).
 * Pure enough to unit test with synthetic events.
 */
export function shortcutFor(e: KeyboardEvent): string | null {
  if (isTypingTarget(e.target)) return null;
  const mod = isModifier(e);
  const key = e.key;

  if (mod) {
    const lower = key.toLowerCase();
    if (lower === 'o' && !e.shiftKey) return 'open';
    if (lower === 's') return e.shiftKey ? 'export' : 'save';
    if (lower === 'p' && e.shiftKey) return 'downloadProject';
    if (lower === 'z') {
      if (e.shiftKey) return 'redo';
      if (e.altKey) return 'stepBack'; // Alt+Ctrl+Z steps backward
      return 'undo';
    }
    if (lower === 'y') return 'redo2';
    if (lower === '0') return 'fit';
    if (lower === '1') return 'actual';
    if (lower === 'a') return 'selectAll';
    if (lower === 'd') return 'deselect';
    if (lower === 'i' && e.shiftKey) return 'inverse';
    if (lower === 'i') return 'invertPixels';
    if (lower === 'n' && e.shiftKey) return 'newLayer';
    if (lower === 'j') return e.shiftKey ? 'layerViaCut' : 'layerViaCopy';
    if (lower === 'e') return 'mergeDown';
    if (lower === 't') return 'transform';
    if (key === '=' || key === '+') return 'zoomIn';
    if (key === '-') return 'zoomOut';
    if (key === 'Backspace') return 'fillBg';
    return null;
  }

  if (e.altKey && key === 'Backspace') return 'fillFg';
  if (e.shiftKey && key.toLowerCase() === 'f6') return 'feather';
  if (key === 'Enter') return 'applyAdjust';
  if (key === 'Escape') return 'cancelAdjust';
  if (key === 'Delete' || key === 'Backspace') return 'deletePixels';
  if (key === '[') return e.shiftKey ? 'brushSmallerBig' : 'brushSmaller';
  if (key === ']') return e.shiftKey ? 'brushLargerBig' : 'brushLarger';
  if (key === '+' || key === '=') return 'zoomIn';
  if (key === '-' || key === '_') return 'zoomOut';
  if (key === 'ArrowLeft') return e.shiftKey ? 'nudge-left-big' : 'nudge-left';
  if (key === 'ArrowRight') return e.shiftKey ? 'nudge-right-big' : 'nudge-right';
  if (key === 'ArrowUp') return e.shiftKey ? 'nudge-up-big' : 'nudge-up';
  if (key === 'ArrowDown') return e.shiftKey ? 'nudge-down-big' : 'nudge-down';
  // Digits set the active layer's opacity (0 → 100 %), classic-editor style.
  if (!e.altKey && !e.shiftKey && key >= '0' && key <= '9') return `opacity-${key}`;
  if (key.toLowerCase() === 'd' && !e.altKey) return 'defaultColors';
  if (key === ' ') return null; // Space is handled locally by the canvas (hold to pan).

  if (key.toLowerCase() === 'x' && !e.altKey) return 'swapColors';
  const tool = TOOL_BY_KEY[key.toLowerCase()];
  if (tool && !e.altKey) {
    if (e.shiftKey && tool === 'dodge') return 'tool-burn'; // Photoshop dodge/burn toggle
    if (e.shiftKey && tool === 'gradient') return 'tool-bucket'; // gradient/bucket toggle
    return `tool-${tool}`;
  }
  return null;
}

async function runShortcut(id: string): Promise<void> {
  const s = getState();
  const hasDoc = s.doc !== null;
  switch (id) {
    case 'open': {
      const file = await pickFile('image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp');
      if (file) await openImageFile(file);
      break;
    }
    case 'save':
      if (hasDoc) await saveProjectToBrowser();
      break;
    case 'export':
      if (hasDoc) setState({ dialog: 'export' });
      break;
    case 'downloadProject':
      if (hasDoc) await downloadProjectFile();
      break;
    case 'undo':
      undo();
      break;
    case 'redo':
    case 'redo2':
      redo();
      break;
    case 'applyAdjust':
      if (s.cropRect && s.doc) {
        cropActiveDocument(s.cropRect);
      } else if (s.adjustmentsLayerId) {
        await applyPendingAdjustments();
      }
      break;
    case 'cancelAdjust':
      if (s.dialog) setState({ dialog: null });
      else if (s.cropRect) setState({ cropRect: null });
      else if (s.adjustmentsLayerId) cancelPendingAdjustments();
      else deselect();
      break;
    case 'selectAll':
      if (hasDoc) selectAll();
      break;
    case 'deselect':
      deselect();
      break;
    case 'inverse':
      if (hasDoc) invertSelection();
      break;
    case 'deletePixels':
      if (hasDoc) clearActivePixels();
      break;
    case 'fillFg':
      if (hasDoc) fillActivePixels('fg');
      break;
    case 'fillBg':
      if (hasDoc) fillActivePixels('bg');
      break;
    case 'invertPixels':
      if (hasDoc) invertActivePixels();
      break;
    case 'newLayer':
      if (hasDoc) addBlankLayer();
      break;
    case 'transform':
      if (hasDoc) beginFreeTransform();
      break;
    case 'layerViaCopy':
      if (hasDoc) layerViaCopy(false);
      break;
    case 'layerViaCut':
      if (hasDoc) layerViaCopy(true);
      break;
    case 'mergeDown':
      if (hasDoc) mergeDown();
      break;
    case 'stepBack':
      stepBackward();
      break;
    case 'feather':
      if (hasDoc && s.selection) setState({ dialog: 'feather' });
      break;
    case 'brushSmaller':
      setBrushSize(s.brushSize - 5);
      break;
    case 'brushSmallerBig':
      setBrushSize(s.brushSize - 20);
      break;
    case 'brushLarger':
      setBrushSize(s.brushSize + 5);
      break;
    case 'brushLargerBig':
      setBrushSize(s.brushSize + 20);
      break;
    case 'fit':
      if (hasDoc) fitToScreen();
      break;
    case 'actual':
      if (hasDoc) zoomToPercent(100);
      break;
    case 'zoomIn':
      if (hasDoc) stepZoom(1);
      break;
    case 'zoomOut':
      if (hasDoc) stepZoom(-1);
      break;
    case 'swapColors':
      swapColors();
      break;
    case 'defaultColors':
      resetColors();
      break;
    case 'nudge-left':
      nudgeIfMove(-1, 0);
      break;
    case 'nudge-right':
      nudgeIfMove(1, 0);
      break;
    case 'nudge-up':
      nudgeIfMove(0, -1);
      break;
    case 'nudge-down':
      nudgeIfMove(0, 1);
      break;
    case 'nudge-left-big':
      nudgeIfMove(-10, 0);
      break;
    case 'nudge-right-big':
      nudgeIfMove(10, 0);
      break;
    case 'nudge-up-big':
      nudgeIfMove(0, -10);
      break;
    case 'nudge-down-big':
      nudgeIfMove(0, 10);
      break;
    default:
      if (id.startsWith('opacity-')) {
        const n = Number(id.slice(8));
        if (hasDoc) setActiveSheetOpacity(n === 0 ? 100 : n * 10);
      } else if (id.startsWith('tool-')) {
        const requested = id.slice(5) as ToolId;
        // Grouped tools cycle through their flyout family on repeat presses.
        const group = TOOL_GROUP[requested];
        const current = getState().tool;
        if (group && group.length > 1 && group.includes(current)) {
          setTool(cycleToolInGroup(current, group));
        } else {
          setTool(requested);
        }
      }
      break;
  }
}

/** Arrow-key nudge, active only with the move tool and no open dialog. */
function nudgeIfMove(dx: number, dy: number): void {
  const s = getState();
  if (s.dialog || !s.doc || s.tool !== 'move') return;
  nudgeActiveLayer(dx, dy);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const id = shortcutFor(e);
  if (!id) return;
  e.preventDefault();
  void runShortcut(id);
}

export function bindShortcuts(): () => void {
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

export { runShortcut };
