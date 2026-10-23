import { Modal } from '../ui/Modal';
import styles from './Dialogs.module.css';
import { SHORTCUTS } from '../../app/shortcuts';
import { setState } from '../../app/editorStore';

const GROUPS = ['File', 'Edit', 'View', 'Tools'] as const;

export function ShortcutsDialog() {
  return (
    <Modal title="Keyboard Shortcuts" onClose={() => setState({ dialog: null })} width={520}>
      <div className={styles.stack}>
        {GROUPS.map((group) => {
          const items = SHORTCUTS.filter((s) => s.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <h3 className={styles.groupTitle}>{group}</h3>
              <table className={styles.table}>
                <tbody>
                  {items.map((s) => (
                    <tr key={s.id}>
                      <td className={styles.tableDesc}>{s.description}</td>
                      <td className={styles.tableKeys}>
                        <kbd className="pf-kbd">{s.keys}</kbd>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        <p className={styles.note}>
          Shortcuts are ignored while typing in text fields. Hold <kbd className="pf-kbd">Space</kbd>{' '}
          with any tool to pan.
        </p>
      </div>
    </Modal>
  );
}

export function AboutDialog() {
  return (
    <Modal title="About PixelForge" onClose={() => setState({ dialog: null })} width={480}>
      <div className={styles.stack}>
        <p className={styles.info}>
          <strong>PixelForge 0.1</strong> — a local-first, browser-based photo editor.
        </p>
        <ul className={styles.bullets}>
          <li>Runs entirely on your device: no backend, no database, no accounts.</li>
          <li>No external APIs, no telemetry, no runtime CDN requests.</li>
          <li>Images are decoded, processed and exported locally in your browser.</li>
          <li>Projects are stored in your browser (IndexedDB) and as portable <code>.pixelforge</code> files.</li>
        </ul>
        <p className={styles.note}>
          Built with React, TypeScript, Canvas 2D, Web Workers and Astro/Vite. Browser storage can be
          cleared at any time by you or by your browser — keep project file copies for anything
          important.
        </p>
      </div>
    </Modal>
  );
}
