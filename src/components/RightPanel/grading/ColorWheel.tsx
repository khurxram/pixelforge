import { useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import styles from './ColorWheel.module.css';

interface ColorWheelProps {
  label: string;
  /** Wheel offset, -1..1 (red points right). */
  x: number;
  /** Wheel offset, -1..1 (green points up). */
  y: number;
  onChange: (x: number, y: number) => void;
  /** Neutralise the wheel (double-click). */
  onReset: () => void;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * DaVinci-style trackball wheel: drag inside the disc to tint the shadows /
 * midtones / highlights. Double-click or press Home to re-centre.
 */
export function ColorWheel({ label, x, y, onChange, onReset }: ColorWheelProps) {
  const discRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  /** Mirrors `dragging` into render so the marker can skip its snap tween. */
  const [isDragging, setIsDragging] = useState(false);

  const setFromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const disc = discRef.current;
    if (!disc) return;
    const rect = disc.getBoundingClientRect();
    let nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    let ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    const mag = Math.hypot(nx, ny);
    if (mag > 1) {
      nx /= mag;
      ny /= mag;
    }
    onChange(round3(nx), round3(ny));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    setFromPointer(e);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) setFromPointer(e);
  };
  const endDrag = () => {
    dragging.current = false;
    setIsDragging(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    let nx = x;
    let ny = y;
    switch (e.key) {
      case 'ArrowLeft':
        nx -= step;
        break;
      case 'ArrowRight':
        nx += step;
        break;
      case 'ArrowUp':
        ny -= step;
        break;
      case 'ArrowDown':
        ny += step;
        break;
      case 'Home':
        onReset();
        e.preventDefault();
        return;
      default:
        return;
    }
    const mag = Math.hypot(nx, ny);
    if (mag > 1) {
      nx /= mag;
      ny /= mag;
    }
    onChange(round3(nx), round3(ny));
    e.preventDefault();
  };

  return (
    <div className={styles.wheel}>
      <div
        ref={discRef}
        className={styles.disc}
        data-dragging={isDragging || undefined}
        role="application"
        tabIndex={0}
        aria-label={`${label} colour wheel — arrow keys adjust, Home resets`}
        title={`${label}: drag to tint. Double-click to re-centre.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onReset}
        onKeyDown={onKeyDown}
      >
        <div className={styles.crossH} />
        <div className={styles.crossV} />
        <div
          className={styles.marker}
          style={{ left: `${50 + x * 47}%`, top: `${50 + y * 47}%` }}
        />
      </div>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
