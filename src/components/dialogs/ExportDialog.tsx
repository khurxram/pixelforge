import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Slider } from '../ui/Slider';
import styles from './Dialogs.module.css';
import { exportActiveImage } from '../../app/actions';
import { setState, useEditorStore } from '../../app/editorStore';
import type { ExportFormat } from '../../imaging/exportImage';

export function ExportDialog() {
  const doc = useEditorStore((s) => s.doc);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState(92);
  const close = () => setState({ dialog: null });
  if (!doc) return null;

  const lossless = format === 'png';

  return (
    <Modal
      title="Export Image"
      onClose={close}
      footer={
        <>
          <button className="pf-btn" onClick={close}>
            Cancel
          </button>
          <button
            className="pf-btn primary"
            data-testid="export-confirm"
            onClick={() => {
              close();
              void exportActiveImage(format, quality / 100);
            }}
          >
            Export {format.toUpperCase()}
          </button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.info}>
          Exports the full-resolution composite at <strong>{doc.width} × {doc.height} px</strong>{' '}
          ({((doc.width * doc.height) / 1e6).toFixed(1)} MP) — never the screen preview. Overlays,
          handles and selection outlines are never included.
        </p>

        <label className={styles.fieldRow}>
          <span className="pf-label">Format</span>
          <select
            className="pf-select"
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
            aria-label="Export format"
          >
            <option value="png">PNG — lossless, keeps transparency</option>
            <option value="jpeg">JPEG — small files, no transparency</option>
            <option value="webp">WebP — lossy, keeps transparency</option>
          </select>
        </label>

        <div className={lossless ? styles.disabled : ''}>
          <Slider
            label="Quality"
            value={quality}
            min={10}
            max={100}
            defaultValue={92}
            suffix="%"
            disabled={lossless}
            onChange={setQuality}
          />
        </div>

        {format === 'jpeg' ? (
          <p className={styles.note}>Transparency is flattened onto a white background for JPEG.</p>
        ) : null}
        {lossless ? <p className={styles.note}>PNG is lossless — quality is not applicable.</p> : null}
      </div>
    </Modal>
  );
}
