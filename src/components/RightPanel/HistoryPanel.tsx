import { Section } from './Section';
import styles from './HistoryPanel.module.css';
import { jumpHistory } from '../../app/actions';
import { useEditorStore } from '../../app/editorStore';

export function HistoryPanel() {
  const entries = useEditorStore((s) => s.history.entries);
  const index = useEditorStore((s) => s.history.index);

  return (
    <Section title="History" defaultOpen={false}>
      <ul className={styles.list} aria-label="History states">
        <li
          className={`${styles.item} ${index === 0 ? styles.current : ''}`}
          onClick={() => jumpHistory(0)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && jumpHistory(0)}
        >
          <span className={styles.dot} />
          Open
        </li>
        {entries.map((entry, i) => (
          <li
            key={`${i}-${entry.label}`}
            className={`${styles.item} ${i === index - 1 ? styles.current : ''} ${
              i >= index ? styles.undone : ''
            }`}
            onClick={() => jumpHistory(i + 1)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && jumpHistory(i + 1)}
            title="Click to return to this state"
          >
            <span className={styles.dot} />
            {entry.label}
          </li>
        ))}
      </ul>
      <p className={styles.hint}>
        {entries.length} step{entries.length === 1 ? '' : 's'} recorded · click any state to jump.
      </p>
    </Section>
  );
}
