import { useState, type ReactNode } from 'react';
import styles from './Section.module.css';

interface SectionProps {
  title: string;
  /** Sections start closed — Photoshop-style panels are collapsed until opened. */
  defaultOpen?: boolean;
  children: ReactNode;
  /** Right-aligned controls in the section header (outside the toggle). */
  actions?: ReactNode;
}

/** Collapsible inspector section header used by every right-panel panel. */
export function Section({ title, defaultOpen = false, children, actions }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.section}>
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.header}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${title} panel`}
        >
          <span className={styles.chev} data-open={open} aria-hidden="true" />
          <span className={styles.title}>{title}</span>
        </button>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {open ? <div className={styles.body}>{children}</div> : null}
    </section>
  );
}
