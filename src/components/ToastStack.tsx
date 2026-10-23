import { useEffect } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import styles from './ToastStack.module.css';
import { clearToast } from '../app/actions';
import { useEditorStore } from '../app/editorStore';

/** Transient notifications (bottom-right), auto-dismissed. */
export function ToastStack() {
  const toast = useEditorStore((s) => s.toast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, toast.kind === 'error' ? 9000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  const Icon = toast.kind === 'error' ? X : toast.kind === 'warning' ? AlertTriangle : Check;

  return (
    <div className={styles.stack} role="status" aria-live="polite">
      <div className={`${styles.toast} ${styles[toast.kind]}`} data-testid="toast">
        <Icon size={14} className={styles.icon} />
        <span className={styles.message}>{toast.message}</span>
        <button className={styles.close} onClick={clearToast} aria-label="Dismiss notification">
          ×
        </button>
      </div>
    </div>
  );
}
