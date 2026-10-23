import { useCallback, useEffect, useRef } from 'react';
import styles from './GradeScope.module.css';
import { useEditorStore } from '../../../app/editorStore';

const SRC_W = 160;
const SRC_H = 100;
const SCOPE_W = 318; // divisible by 3 → equal parade panels
const SCOPE_H = 96;
const PANEL_W = SCOPE_W / 3;

/**
 * Live RGB parade scope (Resolve-style): samples the on-screen canvas at low
 * resolution and plots per-column channel intensity, red | green | blue.
 * Refreshes whenever the grade changes, plus a slow tick to follow painting.
 */
export function GradeScope() {
  const adj = useEditorStore((s) => s.adjustments);
  const doc = useEditorStore((s) => s.doc);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  /** Reused downscale target — one canvas instead of one per refresh. */
  const offRef = useRef<HTMLCanvasElement | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Background tab: nothing is on screen, so skip the sample + repaint (the
    // [adj, doc] effect repaints the moment the tab becomes visible again).
    if (document.hidden) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Compose the scope into an ImageData: black graticule background,
    // then traces; the grid lines are stroked on top afterwards.
    const img = ctx.createImageData(SCOPE_W, SCOPE_H);
    const out = img.data;
    for (let i = 0; i < out.length; i += 4) {
      out[i] = 5;
      out[i + 1] = 9;
      out[i + 2] = 6;
      out[i + 3] = 255;
    }

    const src = document.querySelector<HTMLCanvasElement>('canvas[data-testid="editor-canvas"]');
    if (src && src.width > 0 && src.height > 0) {
      const off = (offRef.current ??= document.createElement('canvas'));
      if (off.width !== SRC_W || off.height !== SRC_H) {
        off.width = SRC_W;
        off.height = SRC_H;
      }
      const octx = off.getContext('2d', { willReadFrequently: true });
      if (octx) {
        octx.drawImage(src, 0, 0, SRC_W, SRC_H);
        let data: Uint8ClampedArray;
        try {
          data = octx.getImageData(0, 0, SRC_W, SRC_H).data;
        } catch {
          data = new Uint8ClampedArray(0);
        }
        if (data.length > 0) {
          const tallies = [
            new Uint16Array(256),
            new Uint16Array(256),
            new Uint16Array(256),
          ];
          for (let px = 0; px < PANEL_W; px++) {
            tallies[0].fill(0);
            tallies[1].fill(0);
            tallies[2].fill(0);
            const sx = Math.min(SRC_W - 1, Math.floor((px / PANEL_W) * SRC_W));
            for (let sy = 0; sy < SRC_H; sy++) {
              const o = (sy * SRC_W + sx) * 4;
              tallies[0][data[o]]++;
              tallies[1][data[o + 1]]++;
              tallies[2][data[o + 2]]++;
            }
            for (let panel = 0; panel < 3; panel++) {
              const counts = tallies[panel];
              const colX = panel * PANEL_W + px;
              for (let v = 0; v < 256; v++) {
                const n = counts[v];
                if (n === 0) continue;
                const bright = n * 5 > 255 ? 255 : n * 5;
                const y = SCOPE_H - 1 - ((v * (SCOPE_H - 1)) / 255 | 0);
                const o = (y * SCOPE_W + colX) * 4;
                if (panel === 0) {
                  out[o] = bright;
                  out[o + 1] = bright * 0.18;
                  out[o + 2] = bright * 0.18;
                } else if (panel === 1) {
                  out[o] = bright * 0.18;
                  out[o + 1] = bright;
                  out[o + 2] = bright * 0.18;
                } else {
                  out[o] = bright * 0.18;
                  out[o + 1] = bright * 0.3;
                  out[o + 2] = bright;
                }
              }
            }
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);

    // Green graticule + panel labels on top (scope look).
    ctx.strokeStyle = 'rgba(80, 255, 140, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((SCOPE_H * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(SCOPE_W, y);
      ctx.stroke();
    }
    for (let i = 1; i < 3; i++) {
      const x = Math.round(PANEL_W * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, SCOPE_H);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(140, 255, 180, 0.75)';
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('R', 4, 10);
    ctx.fillText('G', PANEL_W + 4, 10);
    ctx.fillText('B', PANEL_W * 2 + 4, 10);
  }, []);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [adj, doc, draw]);

  useEffect(() => {
    const tick = () => {
      rafRef.current = requestAnimationFrame(draw);
    };
    const id = window.setInterval(tick, 700);
    // Coming back to a hidden tab repaints immediately instead of waiting out
    // the remainder of the tick.
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [draw]);

  return (
    <div className={styles.wrap}>
      <div className={styles.caption}>
        <span>RGB Parade</span>
        <span className={styles.live}>live</span>
      </div>
      <canvas
        ref={canvasRef}
        width={SCOPE_W}
        height={SCOPE_H}
        className={styles.scope}
        data-testid="grade-scope"
        aria-label="Live RGB parade scope"
      />
    </div>
  );
}
