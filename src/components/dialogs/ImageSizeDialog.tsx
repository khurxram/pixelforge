import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import styles from './Dialogs.module.css';
import { resizeActiveDocument } from '../../app/actions';
import { setState, useEditorStore } from '../../app/editorStore';

export function ImageSizeDialog() {
  const doc = useEditorStore((s) => s.doc);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [constrain, setConstrain] = useState(true);
  const close = () => setState({ dialog: null });

  useEffect(() => {
    if (doc) {
      setWidth(doc.width);
      setHeight(doc.height);
    }
  }, [doc]);

  if (!doc) return null;
  const ratio = doc.width / doc.height;

  const onWidth = (w: number) => {
    setWidth(w);
    if (constrain) setHeight(Math.max(1, Math.round(w / ratio)));
  };
  const onHeight = (h: number) => {
    setHeight(h);
    if (constrain) setWidth(Math.max(1, Math.round(h * ratio)));
  };

  const valid = width >= 1 && height >= 1 && width <= 16384 && height <= 16384;

  return (
    <Modal
      title="Image Size"
      onClose={close}
      footer={
        <>
          <button className="pf-btn" onClick={close}>
            Cancel
          </button>
          <button
            className="pf-btn primary"
            disabled={!valid || (width === doc.width && height === doc.height)}
            data-testid="image-size-apply"
            onClick={() => {
              close();
              resizeActiveDocument(width, height);
            }}
          >
            Resize
          </button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.info}>
          Current: {doc.width} × {doc.height} px. Resizing resamples every layer with
          premultiplied-area filtering and is recorded in history (undoable).
        </p>
        <div className={styles.grid2}>
          <label className={styles.fieldRow}>
            <span className="pf-label">Width (px)</span>
            <input
              className="pf-input"
              type="number"
              min={1}
              max={16384}
              value={width}
              onChange={(e) => onWidth(Math.max(1, Number(e.target.value) || 1))}
              aria-label="New width"
            />
          </label>
          <label className={styles.fieldRow}>
            <span className="pf-label">Height (px)</span>
            <input
              className="pf-input"
              type="number"
              min={1}
              max={16384}
              value={height}
              onChange={(e) => onHeight(Math.max(1, Number(e.target.value) || 1))}
              aria-label="New height"
            />
          </label>
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={constrain} onChange={(e) => setConstrain(e.target.checked)} />
          Constrain proportions
        </label>
        {!valid ? <p className={styles.error}>Dimensions must be between 1 and 16384 px.</p> : null}
      </div>
    </Modal>
  );
}
