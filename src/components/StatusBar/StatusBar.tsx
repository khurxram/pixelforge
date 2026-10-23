import { LoaderCircle } from 'lucide-react';
import styles from './StatusBar.module.css';
import { useEditorStore } from '../../app/editorStore';

const TOOL_LABELS: Record<string, string> = {
  move: 'Move',
  marquee: 'Marquee',
  'marquee-ellipse': 'Ellipse Marquee',
  'marquee-row': 'Row Marquee',
  'marquee-col': 'Column Marquee',
  lasso: 'Lasso',
  'lasso-poly': 'Polygonal Lasso',
  wand: 'Magic Wand',
  crop: 'Crop',
  brush: 'Brush',
  eraser: 'Eraser',
  clone: 'Clone Stamp',
  healing: 'Healing',
  bucket: 'Paint Bucket',
  gradient: 'Gradient',
  blur: 'Blur',
  sharpen: 'Sharpen',
  dodge: 'Dodge',
  burn: 'Burn',
  text: 'Text',
  shape: 'Shape',
  hand: 'Hand',
  zoom: 'Zoom',
  eyedropper: 'Eyedropper',
};

export function StatusBar() {
  const doc = useEditorStore((s) => s.doc);
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const cursor = useEditorStore((s) => s.cursor);
  const tool = useEditorStore((s) => s.tool);
  const status = useEditorStore((s) => s.status);
  const busy = useEditorStore((s) => s.busy);
  const dirty = useEditorStore((s) => s.dirty);
  const historyIndex = useEditorStore((s) => s.history.index);
  const lastAutosave = useEditorStore((s) => s.lastAutosave);

  return (
    <footer className={styles.bar} role="status" aria-label="Status bar">
      <span className={styles.item} title="Document name and save state">
        {doc ? `${doc.name}${dirty ? ' •' : ''}` : 'No document'}
      </span>

      <span className={styles.divider} />

      <span className={styles.item} title="Document pixel dimensions">
        {doc ? `${doc.width} × ${doc.height} px` : '— × —'}
      </span>

      <span className={styles.divider} />

      <span className={styles.item} title="Zoom level">
        {Math.round(zoom * 100)}%
      </span>

      <span className={styles.divider} />

      <span className={styles.itemMono} title="Cursor position in document coordinates">
        {cursor ? `${cursor.x}, ${cursor.y}` : '—, —'}
      </span>

      <span className={styles.divider} />

      <span className={styles.item} title="Active tool">
        {TOOL_LABELS[tool] ?? tool}
      </span>

      <span className={styles.divider} />

      <span className={styles.item} title="Undo history position">
        History {historyIndex}
      </span>

      <span className={styles.grow} />

      {busy ? (
        <span className={`${styles.item} ${styles.busy}`}>
          <LoaderCircle size={12} className={styles.spin} />
          {busy}
        </span>
      ) : (
        <span className={styles.item} title={status}>
          {status}
        </span>
      )}

      <span className={styles.divider} />

      <span className={styles.itemDim} title="Background autosave timestamp">
        {lastAutosave ? `Autosaved ${new Date(lastAutosave).toLocaleTimeString()}` : 'Autosave idle'}
      </span>
    </footer>
  );
}
