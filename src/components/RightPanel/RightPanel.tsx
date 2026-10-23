import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronsLeft, ChevronsRight, SlidersHorizontal } from 'lucide-react';
import styles from './RightPanel.module.css';
import { AdjustmentsPanel } from './AdjustmentsPanel';
import { LayersPanel } from './LayersPanel';
import { HistoryPanel } from './HistoryPanel';
import { ColorPanel } from './ColorPanel';
import {
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  setInspectorOpen,
  setInspectorWidth,
} from '../../app/actions';
import { setState, useEditorStore } from '../../app/editorStore';

/**
 * Right inspector: stacked collapsible panels (Photoshop-style).
 * The whole panel can be hidden (« / » chips) and resized by dragging its
 * left edge; double-clicking the edge restores the default width.
 *
 * On narrow screens (see App.module.css) the panel detaches into an overlay
 * and its collapsed rail is hidden, so it starts closed and a floating button
 * in the canvas area reopens it — otherwise it would cover the document on
 * every phone load with no obvious way back.
 */
export function RightPanel() {
  const open = useEditorStore((s) => s.inspectorOpen);
  const width = useEditorStore((s) => s.inspectorWidth);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragStart = useRef<{ x: number; w: number } | null>(null);
  const [narrow, setNarrow] = useState(false);

  // Track the overlay breakpoint. The panel is detached purely by CSS, so the
  // only thing JS needs to know is whether the reopen affordance is required.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const onEdgeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || e.button !== 0) return;
    dragStart.current = { x: e.clientX, w: panel.getBoundingClientRect().width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onEdgeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    const next = start.w - (e.clientX - start.x);
    setState({ inspectorWidth: Math.round(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, next))) });
  };
  const onEdgeUp = () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    const w = panelRef.current?.getBoundingClientRect().width ?? INSPECTOR_DEFAULT;
    setInspectorWidth(w); // clamp + persist
  };

  if (!open) {
    return narrow ? (
      <button
        type="button"
        className={styles.openFab}
        onClick={() => setInspectorOpen(true)}
        aria-label="Show inspector panel"
        title="Show inspector panel"
        data-testid="show-inspector"
      >
        <SlidersHorizontal size={16} />
      </button>
    ) : (
      <aside
        className={styles.collapsedRail}
        aria-label="Inspector panel (hidden)"
        data-pf-inspector-rail=""
      >
        <button
          type="button"
          className={styles.railBtn}
          onClick={() => setInspectorOpen(true)}
          aria-label="Show inspector panel"
          title="Show inspector panel"
          data-testid="show-inspector"
        >
          <ChevronsLeft size={13} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={styles.panel}
      style={{ width, minWidth: width }}
      aria-label="Inspector"
      ref={panelRef}
      data-testid="inspector"
      data-pf-inspector=""
    >
      <div
        className={styles.edge}
        onPointerDown={onEdgeDown}
        onPointerMove={onEdgeMove}
        onPointerUp={onEdgeUp}
        onPointerCancel={onEdgeUp}
        onDoubleClick={() => setInspectorWidth(INSPECTOR_DEFAULT)}
        title="Drag to resize — double-click to reset"
      />
      <div className={styles.panelBar}>
        <span className={styles.panelLabel}>Inspector</span>
        <button
          type="button"
          className={styles.collapseBtn}
          onClick={() => setInspectorOpen(false)}
          aria-label="Hide inspector panel"
          title="Hide inspector panel"
          data-testid="hide-inspector"
        >
          <ChevronsRight size={12} />
        </button>
      </div>
      <div className={styles.scroll}>
        <AdjustmentsPanel />
        <LayersPanel />
        <HistoryPanel />
        <ColorPanel />
      </div>
    </aside>
  );
}
