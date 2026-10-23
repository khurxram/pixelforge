import { useEffect, useState } from 'react';
import styles from './Slider.module.css';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Numeric field suffix, e.g. "px", "°", "%". */
  suffix?: string;
  /** Decimals shown in the numeric field. */
  precision?: number;
  /** Double-click the label resets to this value (when provided). */
  defaultValue?: number;
  disabled?: boolean;
}

/**
 * Compact labeled slider with an editable numeric field —
 * the standard control used across the inspector panels.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix = '',
  precision = 0,
  defaultValue,
  disabled = false,
}: SliderProps) {
  const [text, setText] = useState(value.toFixed(precision));

  useEffect(() => {
    setText(value.toFixed(precision));
  }, [value, precision]);

  const commitText = () => {
    const parsed = Number.parseFloat(text.replace(/[^\d.+-]/g, ''));
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(max, Math.max(min, parsed));
      onChange(Number(clamped.toFixed(precision)));
    } else {
      setText(value.toFixed(precision));
    }
  };

  return (
    <div className={styles.row} data-disabled={disabled || undefined}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.label}
          disabled={disabled || defaultValue === undefined}
          title={
            defaultValue === undefined
              ? label
              : `Double-click to reset ${label} to ${defaultValue}${suffix}`
          }
          onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
          onClick={(e) => e.preventDefault()}
        >
          {label}
        </button>
        <div className={styles.valueBox}>
          <input
            className={styles.number}
            type="number"
            value={Number.isFinite(value) ? Number(value.toFixed(precision)) : 0}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-label={label}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
            }}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText();
            }}
          />
          {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
        </div>
      </div>
      <input
        className={`pf-range ${styles.range}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={`${label} slider`}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      />
    </div>
  );
}
