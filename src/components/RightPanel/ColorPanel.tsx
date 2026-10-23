import { Section } from './Section';
import styles from './ColorPanel.module.css';
import { setBackground, setForeground, swapColors } from '../../app/actions';
import { useEditorStore } from '../../app/editorStore';

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const commitHex = (text: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
    if (m) onChange(`#${m[1].toLowerCase()}`);
  };
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <label className={styles.swatch} style={{ background: value }} title={`${label} — click to change`}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={styles.input}
          aria-label={`${label} color`}
        />
      </label>
      <input
        className={`pf-input ${styles.hex}`}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          const text = e.target.value;
          if (/^#?[0-9a-f]{0,6}$/i.test(text)) commitHex(text);
        }}
        aria-label={`${label} hex value`}
      />
    </div>
  );
}

export function ColorPanel() {
  const foreground = useEditorStore((s) => s.foreground);
  const background = useEditorStore((s) => s.background);
  const tool = useEditorStore((s) => s.tool);

  return (
    <Section title="Color" defaultOpen={false}>
      <ColorRow label="Foreground" value={foreground} onChange={setForeground} />
      <ColorRow label="Background" value={background} onChange={setBackground} />
      <div className={styles.actions}>
        <button className="pf-btn" onClick={swapColors} title="Swap (X)">
          Swap
        </button>
        <button
          className="pf-btn"
          onClick={() => {
            setForeground('#000000');
            setBackground('#ffffff');
          }}
          title="Reset to default colors (D)"
        >
          Default
        </button>
      </div>
      <p className={styles.hint}>
        {tool === 'eyedropper'
          ? 'Click on the canvas to sample a color.'
          : 'Pick with the Eyedropper (I) — brush painting arrives in a later stage.'}
      </p>
    </Section>
  );
}
