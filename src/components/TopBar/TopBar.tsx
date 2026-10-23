import { useMemo, useState } from 'react';
import {
  Download,
  FolderOpen,
  Maximize2,
  Moon,
  Redo2,
  Save,
  Sun,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { MenuBar, type MenuDefinition } from '../ui/Menu';
import styles from './TopBar.module.css';
import {
  addBlankLayer,
  applyAuto,
  beginFreeTransform,
  deselect,
  downloadProjectFile,
  fillActivePixels,
  fitToScreen,
  growSelectionBy,
  invertActivePixels,
  invertSelection,
  layerViaCopy,
  mergeDown,
  openImageFile,
  openProjectFromFile,
  redo,
  saveProjectToBrowser,
  selectAll,
  shrinkSelectionBy,
  smoothSelectionBy,
  stepZoom,
  transformActiveDocument,
  undo,
  zoomToPercent,
} from '../../app/actions';
import { getState, setState, useEditorStore } from '../../app/editorStore';
import { pickFile } from '../../utils/filePicker';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp';

/** Light/dark switch. Clicks are handled by the Layout's delegated
 *  [data-theme-toggle] listener, which runs the animated theme transition. */
function ThemeToggle() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      className={styles.themeBtn}
      data-theme-toggle="1"
      data-testid="theme-toggle"
      aria-label={label}
      title={label}
    >
      <Sun size={9} className={styles.themeIcon} data-icon="sun" aria-hidden="true" />
      <Moon size={9} className={styles.themeIcon} data-icon="moon" aria-hidden="true" />
      <span className={styles.themeKnob} aria-hidden="true" />
    </button>
  );
}

function Brand() {
  return (
    <a
      className={styles.brand}
      href="/"
      title="PixelForge — back to the home page"
      data-testid="brand-home"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1l6 3.5v7L8 15l-6-3.5v-7L8 1z" fill="none" stroke="var(--accent)" strokeWidth="1.6" />
        <path d="M8 4.6l3 1.75v3.5L8 11.6 5 9.85v-3.5L8 4.6z" fill="var(--accent)" opacity="0.85" />
      </svg>
      <span className={styles.brandName}>PixelForge</span>
    </a>
  );
}

export function TopBar() {
  const hasDoc = useEditorStore((s) => s.doc !== null);
  const canUndo = useEditorStore((s) => s.history.index > 0);
  const canRedo = useEditorStore((s) => s.history.index < s.history.entries.length);
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const checkerboard = useEditorStore((s) => s.showCheckerboard);
  const [zoomText, setZoomText] = useState<string | null>(null);

  const openImage = async () => {
    const file = await pickFile(IMAGE_ACCEPT);
    if (file) await openImageFile(file);
  };
  const openProject = async () => {
    const file = await pickFile('.pixelforge,application/octet-stream');
    if (file) await openProjectFromFile(file);
  };

  const commitZoomText = () => {
    if (zoomText === null) return;
    const parsed = Number.parseFloat(zoomText.replace(/[^\d.]/g, ''));
    setZoomText(null);
    if (Number.isFinite(parsed) && parsed > 0) zoomToPercent(parsed);
  };

  const menus = useMemo<MenuDefinition[]>(() => {
    const noDoc = !hasDoc;

    return [
      {
        id: 'file',
        label: 'File',
        items: [
          { label: 'Open Image…', shortcut: 'Ctrl+O', onSelect: () => void openImage() },
          { label: 'Open Project File…', shortcut: '', onSelect: () => void openProject() },
          {
            label: 'Open Saved Project from Browser…',
            disabled: noDoc,
            disabledHint: 'Open a document first',
            onSelect: () => setState({ dialog: 'openProject' }),
          },
          { type: 'separator' },
          {
            label: 'Save Project to Browser',
            shortcut: 'Ctrl+S',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => void saveProjectToBrowser(),
          },
          {
            label: 'Download Project (.pixelforge)',
            shortcut: 'Ctrl+Shift+P',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => void downloadProjectFile(),
          },
          { type: 'separator' },
          {
            label: 'Export Image…',
            shortcut: 'Ctrl+Shift+S',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => setState({ dialog: 'export' }),
          },
          { type: 'separator' },
          {
            label: 'Storage & Privacy…',
            onSelect: () => setState({ dialog: 'storage' }),
          },
        ],
      },
      {
        id: 'edit',
        label: 'Edit',
        items: [
          {
            label: 'Undo',
            shortcut: 'Ctrl+Z',
            disabled: !canUndo,
            disabledHint: 'Nothing to undo',
            onSelect: undo,
          },
          {
            label: 'Redo',
            shortcut: 'Ctrl+Shift+Z',
            disabled: !canRedo,
            disabledHint: 'Nothing to redo',
            onSelect: redo,
          },
          { type: 'separator' },
          {
            label: 'Fill with Foreground',
            shortcut: 'Alt+Backspace',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => fillActivePixels('fg'),
          },
          {
            label: 'Fill with Background',
            shortcut: 'Ctrl+Backspace',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => fillActivePixels('bg'),
          },
          {
            label: 'Invert Colors',
            shortcut: 'Ctrl+I',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: invertActivePixels,
          },
          { type: 'separator' },
          {
            label: 'Free Transform',
            shortcut: 'Ctrl+T',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: beginFreeTransform,
          },
          { type: 'separator' },
          {
            label: 'Copy',
            shortcut: 'Ctrl+C',
            disabled: true,
            disabledHint: 'Arrives with the selection stage',
            onSelect: () => {},
          },
          {
            label: 'Paste',
            shortcut: 'Ctrl+V',
            disabled: true,
            disabledHint: 'Arrives with the selection stage',
            onSelect: () => {},
          },
        ],
      },
      {
        id: 'image',
        label: 'Image',
        items: [
          {
            label: 'Image Size…',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => setState({ dialog: 'imageSize' }),
          },
          { type: 'separator' },
          {
            label: 'Auto Tone',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => applyAuto('tone'),
          },
          {
            label: 'Auto Contrast',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => applyAuto('contrast'),
          },
          {
            label: 'Auto Color',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => applyAuto('color'),
          },
          { type: 'separator' },
          {
            label: 'Rotate 90° Clockwise',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => transformActiveDocument('rotate-cw'),
          },
          {
            label: 'Rotate 90° Counter-clockwise',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => transformActiveDocument('rotate-ccw'),
          },
          {
            label: 'Rotate 180°',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => transformActiveDocument('rotate-180'),
          },
          { type: 'separator' },
          {
            label: 'Flip Horizontal',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => transformActiveDocument('flip-h'),
          },
          {
            label: 'Flip Vertical',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => transformActiveDocument('flip-v'),
          },
        ],
      },
      {
        id: 'layer',
        label: 'Layer',
        items: [
          {
            label: 'New Layer',
            shortcut: 'Ctrl+Shift+N',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: addBlankLayer,
          },
          {
            label: 'Layer via Copy',
            shortcut: 'Ctrl+J',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => layerViaCopy(false),
          },
          {
            label: 'Layer via Cut',
            shortcut: 'Ctrl+Shift+J',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => layerViaCopy(true),
          },
          {
            label: 'Merge Down',
            shortcut: 'Ctrl+E',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: mergeDown,
          },
          {
            label: 'Layer Group',
            disabled: true,
            disabledHint: 'Arrives with the advanced layer stage',
            onSelect: () => {},
          },
          {
            label: 'Layer Mask',
            disabled: true,
            disabledHint: 'Arrives with the selection & masking stage',
            onSelect: () => {},
          },
        ],
      },
      {
        id: 'select',
        label: 'Select',
        items: [
          { label: 'All', shortcut: 'Ctrl+A', disabled: noDoc, disabledHint: 'No document open', onSelect: selectAll },
          {
            label: 'Deselect',
            shortcut: 'Ctrl+D',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: deselect,
          },
          {
            label: 'Inverse',
            shortcut: 'Ctrl+Shift+I',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: invertSelection,
          },
          {
            label: 'Feather…',
            shortcut: 'Shift+F6',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => setState({ dialog: 'feather' }),
          },
          { type: 'separator' },
          {
            label: 'Grow 1 px',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => growSelectionBy(1),
          },
          {
            label: 'Contract 1 px',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => shrinkSelectionBy(1),
          },
          {
            label: 'Smooth 2 px',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => smoothSelectionBy(2),
          },
        ],
      },
      {
        id: 'filter',
        label: 'Filter',
        items: [
          { type: 'note', label: 'Blur, Sharpen, Grayscale & Sepia live in the Color Grading panel (Beginner style).' },
          { type: 'separator' },
          { label: 'Levels…', disabled: true, disabledHint: 'Arrives with the advanced color stage', onSelect: () => {} },
          { label: 'Curves…', disabled: true, disabledHint: 'Use the Curves editor in the Color Grading panel (Pro style)', onSelect: () => {} },
          { label: 'Gaussian Blur…', disabled: true, disabledHint: 'Use the Blur slider in the Color Grading panel (Beginner style)', onSelect: () => {} },
          { label: 'Unsharp Mask…', disabled: true, disabledHint: 'Use the Sharpen slider in the Color Grading panel (Beginner style)', onSelect: () => {} },
          { label: 'Vignette…', disabled: true, disabledHint: 'Arrives with the filter stage', onSelect: () => {} },
        ],
      },
      {
        id: 'view',
        label: 'View',
        items: [
          {
            label: 'Fit to Screen',
            shortcut: 'Ctrl+0',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: fitToScreen,
          },
          {
            label: 'Zoom to 100%',
            shortcut: 'Ctrl+1',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => zoomToPercent(100),
          },
          { type: 'separator' },
          { label: 'Zoom In', shortcut: '+', disabled: noDoc, disabledHint: 'No document open', onSelect: () => stepZoom(1) },
          { label: 'Zoom Out', shortcut: '-', disabled: noDoc, disabledHint: 'No document open', onSelect: () => stepZoom(-1) },
          { type: 'separator' },
          {
            label: 'Transparency Checkerboard',
            shortcut: checkerboard ? '✓' : '',
            disabled: noDoc,
            disabledHint: 'No document open',
            onSelect: () => setState({ showCheckerboard: !getState().showCheckerboard }),
          },
          {
            label: 'Rulers',
            disabled: true,
            disabledHint: 'Arrives with the guides & rulers stage',
            onSelect: () => {},
          },
        ],
      },
      {
        id: 'help',
        label: 'Help',
        items: [
          { label: 'Keyboard Shortcuts', onSelect: () => setState({ dialog: 'shortcuts' }) },
          { label: 'About PixelForge', onSelect: () => setState({ dialog: 'about' }) },
        ],
      },
    ];
  }, [hasDoc, canUndo, canRedo, checkerboard]);

  return (
    <header className={styles.wrap}>
      <div className={styles.row1}>
        <Brand />
        <MenuBar menus={menus} />
        <div className={styles.spacer} />
        <ThemeToggle />
        <div
          className={styles.privacy}
          title="All processing happens on this device. No uploads, no accounts, no external APIs."
        >
          <span className={styles.dot} aria-hidden="true" />
          Local · private
        </div>
      </div>

      <div className={styles.row2} role="toolbar" aria-label="Main toolbar">
        <button className="pf-btn" onClick={() => void openImage()} title="Open image (Ctrl+O)" disabled={false}>
          <FolderOpen size={14} />
          <span>Open</span>
        </button>
        <button
          className="pf-btn"
          onClick={() => void saveProjectToBrowser()}
          title="Save project to browser storage (Ctrl+S)"
          disabled={!hasDoc}
        >
          <Save size={14} />
          <span>Save</span>
        </button>
        <button
          className="pf-btn"
          onClick={() => setState({ dialog: 'export' })}
          title="Export PNG / JPEG / WebP (Ctrl+Shift+S)"
          disabled={!hasDoc}
        >
          <Download size={14} />
          <span>Export</span>
        </button>

        <div className={styles.divider} />

        <button className="pf-btn ghost" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 size={14} />
        </button>
        <button className="pf-btn ghost" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={14} />
        </button>

        <div className={styles.divider} />

        <div className={styles.zoomGroup}>
          <button
            className="pf-btn ghost"
            onClick={() => stepZoom(-1)}
            disabled={!hasDoc}
            title="Zoom out (-)"
            aria-label="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          <input
            className={`pf-input ${styles.zoomField}`}
            value={zoomText ?? `${Math.round(zoom * 100)}%`}
            onChange={(e) => setZoomText(e.target.value)}
            onBlur={commitZoomText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            aria-label="Zoom level"
            disabled={!hasDoc}
          />
          <button
            className="pf-btn ghost"
            onClick={() => stepZoom(1)}
            disabled={!hasDoc}
            title="Zoom in (+)"
            aria-label="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
          <button
            className="pf-btn ghost"
            onClick={fitToScreen}
            disabled={!hasDoc}
            title="Fit to screen (Ctrl+0)"
            aria-label="Fit to screen"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}
