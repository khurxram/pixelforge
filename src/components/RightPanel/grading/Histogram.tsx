import { useCallback, useEffect, useRef } from 'react';
import styles from './Histogram.module.css';
import { useEditorStore } from '../../../app/editorStore';

const SRC_W = 160;
const SRC_H = 100;
const HIST_W = 318;
const HIST_H = 96;

/**
 * Live histogram: per-channel distributions (R/G/B overlaid additively) plus
 * a luma outline, sampled from the on-screen canvas at low resolution — the
 * same feed as the parade scope, refreshed on grade changes and a slow tick.
 */
export function Histogram() {
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

    const img = ctx.createImageData(HIST_W, HIST_H);
    const out = img.data;
    for (let i = 0; i < out.length; i += 4) {
      out[i] = 7;
      out[i + 1] = 8;
      out[i + 2] = 7;
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
          const hist = [
            new Uint32Array(256),
            new Uint32Array(256),
            new Uint32Array(256),
            new Uint32Array(256), // luma
          ];
          for (let px = 0; px < SRC_W * SRC_H; px++) {
            const o = px * 4;
            if (data[o + 3] === 0) continue;
            const r = data[o];
            const g = data[o + 1];
            const b = data[o + 2];
            hist[0][r]++;
            hist[1][g]++;
            hist[2][b]++;
            hist[3][(0.2126 * r + 0.7152 * g + 0.0722 * b) | 0]++;
          }
          // Normalize: scale so the tallest bucket fills the graph.
          let max = 1;
          for (let c = 0; c < 4; c++) {
            for (let v = 0; v < 256; v++) if (hist[c][v] > max) max = hist[c][v];
          }
          for (let v = 0; v < 256; v++) {
            const x0 = Math.round((v / 256) * HIST_W);
            const x1 = Math.max(x0 + 1, Math.round(((v + 1) / 256) * HIST_W));
            const rs = Math.round((hist[0][v] / max) * (HIST_H - 1));
            const gs = Math.round((hist[1][v] / max) * (HIST_H - 1));
            const bs = Math.round((hist[2][v] / max) * (HIST_H - 1));
            for (let x = x0; x < x1 && x < HIST_W; x++) {
              for (let y = 0; y < HIST_H; y++) {
                const fromBottom = HIST_H - 1 - y;
                const o = (y * HIST_W + x) * 4;
                // Additive overlay: red + green + blue make magenta/white where
                // they stack — the classic RGB histogram look.
                if (fromBottom < rs) out[o] = Math.min(255, out[o] + 150);
                if (fromBottom < gs) out[o + 1] = Math.min(255, out[o + 1] + 150);
                if (fromBottom < bs) out[o + 2] = Math.min(255, out[o + 2] + 170);
              }
            }
            // Luma outline drawn as a distinct bright trace on top.
            const ls = Math.round((hist[3][v] / max) * (HIST_H - 1));
            for (let x = x0; x < x1 && x < HIST_W; x++) {
              const y = HIST_H - 1 - ls;
              const o = (y * HIST_W + x) * 4;
              out[o] = Math.min(255, out[o] + 90);
              out[o + 1] = Math.min(255, out[o + 1] + 90);
              out[o + 2] = Math.min(255, out[o + 2] + 90);
            }
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);

    // Graticule on top.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((HIST_H * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(HIST_W, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('0', 3, HIST_H - 3);
    ctx.textAlign = 'right';
    ctx.fillText('255', HIST_W - 3, HIST_H - 3);
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
        <span>Histogram</span>
        <span className={styles.keys}>
          <i className={styles.kR} /> R
          <i className={styles.kG} /> G
          <i className={styles.kB} /> B
          <i className={styles.kL} /> Luma
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={HIST_W}
        height={HIST_H}
        className={styles.canvas}
        data-testid="grade-histogram"
        aria-label="Live RGB and luma histogram"
      />
    </div>
  );
}
