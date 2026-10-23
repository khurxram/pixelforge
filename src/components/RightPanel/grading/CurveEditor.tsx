import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './CurveEditor.module.css';
import { useEditorStore } from '../../../app/editorStore';
import { setAdjustment } from '../../../app/actions';
import { buildCurveLut, type CurvePoint, type CurveSet } from '../../../imaging/adjustments';

type Channel = 'rgb' | 'r' | 'g' | 'b';

const W = 240;
const H = 150;
const CHANNELS: Array<{ id: Channel; label: string }> = [
  { id: 'rgb', label: 'RGB' },
  { id: 'r', label: 'R' },
  { id: 'g', label: 'G' },
  { id: 'b', label: 'B' },
];
const COLOR: Record<Channel, string> = {
  rgb: '#d8d5cd',
  r: '#e2695e',
  g: '#78c26a',
  b: '#5f8fe2',
};

/**
 * Photoshop-style tone-curve editor: a draggable per-channel graph wired into
 * the adjustment pipeline's monotone-cubic LUTs. The black (0,0) and white
 * (1,1) points are pinned; interior points are added by clicking the graph,
 * dragged freely (x stays ordered), and removed by double-clicking.
 */
export function CurveEditor({ disabled }: { disabled: boolean }) {
  const curve = useEditorStore((s) => s.adjustments.curve);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const [channel, setChannel] = useState<Channel>('rgb');
  const points = curve[channel];

  const commit = useCallback(
    (ch: Channel, next: CurvePoint[]) => {
      const set: CurveSet = { ...curve, [ch]: next };
      setAdjustment('curve', set);
    },
    [curve],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    // Background + graticule.
    ctx.fillStyle = '#111310';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = Math.round((W * i) / 4) + 0.5;
      const gy = Math.round((H * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, H);
      ctx.moveTo(0, gy);
      ctx.lineTo(W, gy);
      ctx.stroke();
    }

    // Identity reference diagonal.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(W, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // The curve itself (sampled through the real pipeline LUT).
    const lut = buildCurveLut(points);
    ctx.strokeStyle = COLOR[channel];
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const v = Math.round((i / 64) * 255);
      const y = H - ((lut ? lut[v] : v) / 255) * H;
      const x = (i / 64) * W;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Control points (interior only — endpoints stay pinned at the corners).
    for (const p of points) {
      const px = p.x * W;
      const py = H - p.y * H;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, [points, channel]);

  useEffect(() => {
    draw();
  }, [draw]);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    // The canvas is drawn at a fixed internal size but displayed fluidly.
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };

  const hitPoint = (x: number, y: number): number => {
    for (let i = 0; i < points.length; i++) {
      const px = points[i].x * W;
      const py = H - points[i].y * H;
      if ((px - x) ** 2 + (py - y) ** 2 <= 81) return i; // 9 px radius
    }
    return -1;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const p = local(e);
    const hit = hitPoint(p.x, p.y);
    if (hit >= 0) {
      dragRef.current = hit;
      canvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    // Click empty space: insert a new control point at that position.
    const nx = Math.min(0.99, Math.max(0.01, p.x / W));
    const ny = Math.min(1, Math.max(0, 1 - p.y / H));
    const next = [...points, { x: nx, y: ny }].sort((a, b) => a.x - b.x);
    commit(channel, next);
    const idx = next.findIndex((q) => q.x === nx && q.y === ny);
    dragRef.current = idx >= 0 ? idx : null;
    canvasRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const idx = dragRef.current;
    if (idx === null || idx === undefined || disabled) return;
    const p = local(e);
    const prevX = idx > 0 ? points[idx - 1].x + 0.01 : 0;
    const nextX = idx < points.length - 1 ? points[idx + 1].x - 0.01 : 1;
    const nx = Math.min(nextX, Math.max(prevX, p.x / W));
    const ny = Math.min(1, Math.max(0, 1 - p.y / H));
    const next = points.slice();
    next[idx] = { x: nx, y: ny };
    commit(channel, next);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const p = local(e);
    const idx = hitPoint(p.x, p.y);
    if (idx >= 0) {
      const next = points.slice();
      next.splice(idx, 1);
      commit(channel, next);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs} role="group" aria-label="Curve channel">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={channel === c.id ? styles.tabActive : styles.tab}
            aria-pressed={channel === c.id}
            disabled={disabled}
            onClick={() => setChannel(c.id)}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className={styles.reset}
          disabled={disabled || points.length === 0}
          title="Reset this channel's curve"
          onClick={() => commit(channel, [])}
        >
          Reset
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className={styles.canvas}
        data-testid="curve-editor"
        data-curve-channel={channel}
        aria-label={`Tone curve editor, ${channel.toUpperCase()} channel — click to add a point, drag to shape, double-click a point to remove`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
