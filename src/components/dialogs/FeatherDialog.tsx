import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import styles from './Dialogs.module.css';
import { featherBy } from '../../app/actions';
import { setState, useEditorStore } from '../../app/editorStore';

/** Feather the active selection with an explicit radius (Select → Feather…). */
export function FeatherDialog() {
  const selection = useEditorStore((s) => s.selection);
  const featherPx = useEditorStore((s) => s.featherPx);
  const [radius, setRadius] = useState(5);
  const close = () => setState({ dialog: null });

  useEffect(() => {
    setRadius(Math.max(1, featherPx || 5));
  }, [featherPx]);

  if (!selection) return null;
  const valid = radius >= 0.1 && radius <= 100;

  return (
    <Modal
      title="Feather Selection"
      onClose={close}
      footer={
        <>
          <button className="pf-btn" onClick={close}>
            Cancel
          </button>
          <button
            className="pf-btn primary"
            disabled={!valid}
            data-testid="feather-apply"
            onClick={() => {
              close();
              featherBy(radius);
            }}
          >
            Feather
          </button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.info}>
          Softens the selection edge with a smooth falloff over the given radius, so cut-outs and
          fills blend gradually instead of stepping. Undoable.
        </p>
        <label className={styles.fieldRow}>
          <span className="pf-label">Radius (px)</span>
          <input
            className="pf-input"
            type="number"
            min={0.1}
            max={100}
            step={0.5}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value) || 0)}
            aria-label="Feather radius"
            data-testid="feather-radius"
          />
        </label>
        {!valid ? (
          <p className={styles.error}>Radius must be between 0.1 and 100 px.</p>
        ) : null}
      </div>
    </Modal>
  );
}
