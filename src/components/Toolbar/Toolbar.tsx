import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { resetColors, setBackground, setForeground, setTool, swapColors } from '../../app/actions';
import { TOOL_BY_ID, TOOL_SLOTS } from '../../app/toolDefs';
import { useEditorStore } from '../../app/editorStore';
import type { ToolId } from '../../core/document/types';
import styles from './Toolbar.module.css';

/** Hover dwell before a group flyout opens (ms) — long enough to slide across. */
const FLYOUT_HOVER_MS = 240;
/** Grace period before closing once the pointer leaves button + menu (ms). */
const FLYOUT_CLOSE_MS = 220;
/** Long-press (touch) duration before a flyout opens (ms). */
const FLYOUT_HOLD_MS = 380;
/** Hover-capable pointers close on leave; touch devices keep the menu open
   (lifting a finger fires a compatibility pointerleave that would otherwise
   slam the menu shut before it can be tapped). Outside taps still close it. */
const CAN_HOVER =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: hover)').matches
    : true;

interface FlyoutAnchor {
  id: ToolId;
  top: number;
  left: number;
}

export function Toolbar() {
  const activeTool = useEditorStore((s) => s.tool);
  const foreground = useEditorStore((s) => s.foreground);
  const background = useEditorStore((s) => s.background);
  /** Open group flyout + its viewport anchor, or null. */
  const [flyout, setFlyout] = useState<FlyoutAnchor | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);

  const clearTimer = (t: { current: number | null }) => {
    if (t.current !== null) window.clearTimeout(t.current);
    t.current = null;
  };

  /* Close on outside pointer presses and Escape. */
  useEffect(() => {
    if (!flyout) return;
    const close = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const inside =
        t.closest?.('[data-flyout-portal]') || t.closest?.('[data-flyout-btn]');
      if (!inside) setFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFlyout(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [flyout]);

  useEffect(
    () => () => {
      clearTimer(hoverTimer);
      clearTimer(closeTimer);
      clearTimer(holdTimer);
    },
    [],
  );

  /** Open the flyout to the right of a toolbar button, clamped to the viewport. */
  const openFlyout = (id: ToolId, el: HTMLElement, itemCount: number) => {
    const r = el.getBoundingClientRect();
    const est = itemCount * 30 + 12;
    const top = Math.max(8, Math.min(r.top - 3, window.innerHeight - est - 8));
    setFlyout({ id, top, left: r.right + 6 });
  };

  const onButtonEnter = (slot: ToolId[], el: HTMLElement) => {
    clearTimer(closeTimer);
    if (slot.length <= 1 || flyout?.id === slot[0]) return;
    clearTimer(hoverTimer);
    hoverTimer.current = window.setTimeout(() => {
      openFlyout(slot[0], el, slot.length);
    }, FLYOUT_HOVER_MS);
  };
  const onButtonLeave = () => {
    if (!CAN_HOVER) return;
    clearTimer(hoverTimer);
    closeTimer.current = window.setTimeout(() => setFlyout(null), FLYOUT_CLOSE_MS);
  };
  const onMenuEnter = () => clearTimer(closeTimer);
  const onMenuLeave = () => {
    if (!CAN_HOVER) return;
    closeTimer.current = window.setTimeout(() => setFlyout(null), FLYOUT_CLOSE_MS);
  };

  const startHold = (slot: ToolId[], el: HTMLElement) => {
    clearTimer(hoverTimer); // a press supersedes the hover intent
    holdFired.current = false;
    holdTimer.current = window.setTimeout(() => {
      holdFired.current = true;
      openFlyout(slot[0], el, slot.length);
    }, FLYOUT_HOLD_MS);
  };
  const endHold = () => clearTimer(holdTimer);

  let lastGroup = 0;

  return (
    <nav className={styles.rail} aria-label="Tools">
      <div className={styles.tools}>
        {TOOL_SLOTS.map((slot) => {
          const primary = TOOL_BY_ID[slot[0]];
          const showDivider = primary.group !== lastGroup;
          lastGroup = primary.group;
          // Show the active subtool, or the slot's primary when inactive.
          const shownId: ToolId = slot.includes(activeTool) ? activeTool : slot[0];
          const shown = TOOL_BY_ID[shownId];
          const hasFlyout = slot.length > 1;
          const activeHere = slot.includes(activeTool);
          const open = flyout?.id === slot[0];
          const title = hasFlyout
            ? `${shown.label} (${shown.shortcut}) — hover for more tools`
            : `${shown.label} (${shown.shortcut})`;
          return (
            <div key={slot[0]} className={styles.slot}>
              {showDivider ? <div className={styles.divider} /> : null}
              <button
                type="button"
                className={`${styles.tool} ${activeHere ? styles.active : ''}`}
                aria-label={title}
                aria-pressed={activeHere}
                aria-haspopup={hasFlyout ? 'menu' : undefined}
                aria-expanded={hasFlyout ? open : undefined}
                title={title}
                data-flyout-btn={open || undefined}
                ref={(el) => {
                  if (el) el.dataset.slotRef = slot[0];
                }}
                onContextMenu={(e) => {
                  if (!hasFlyout) return;
                  e.preventDefault();
                  clearTimer(hoverTimer);
                  openFlyout(slot[0], e.currentTarget, slot.length);
                }}
                onPointerDown={(e) => startHold(slot, e.currentTarget)}
                onPointerUp={endHold}
                onPointerLeave={onButtonLeave}
                onMouseEnter={(e) => onButtonEnter(slot, e.currentTarget)}
                onClick={(e) => {
                  clearTimer(hoverTimer);
                  if (hasFlyout && holdFired.current) {
                    // Long-press already revealed the flyout; swallow the click.
                    holdFired.current = false;
                    return;
                  }
                  // Clicking the already-active group toggles its flyout (PS-style).
                  if (hasFlyout && activeHere) {
                    if (open) setFlyout(null);
                    else openFlyout(slot[0], e.currentTarget, slot.length);
                    return;
                  }
                  setTool(shownId);
                }}
              >
                <shown.Icon size={16} strokeWidth={1.7} />
                {hasFlyout ? <span className={styles.flyoutMark} aria-hidden="true" /> : null}
              </button>
            </div>
          );
        })}
      </div>

      {flyout
        ? createPortal(
            <div
              className={styles.flyout}
              role="menu"
              aria-label={`${TOOL_BY_ID[flyout.id].label} tools`}
              data-flyout-portal
              style={{ top: flyout.top, left: flyout.left }}
              onMouseEnter={onMenuEnter}
              onMouseLeave={onMenuLeave}
            >
              {TOOL_SLOTS.find((s) => s[0] === flyout.id)?.map((id, i) => {
                const def = TOOL_BY_ID[id];
                const isActive = activeTool === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    className={styles.flyoutItem}
                    data-active={isActive}
                    style={{ animationDelay: `${i * 26}ms` }}
                    onClick={() => {
                      setTool(id);
                      setFlyout(null);
                    }}
                  >
                    <def.Icon size={14} strokeWidth={1.7} />
                    <span className={styles.flyoutLabel}>{def.label}</span>
                    <kbd className="pf-kbd">{def.shortcut}</kbd>
                    {isActive ? <Check size={12} className={styles.flyoutCheck} /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}

      <div className={styles.colors} title="Foreground / background colors (X to swap, D to reset)">
        <div className={styles.swatchBox}>
          <label
            className={styles.swatchFg}
            style={{ background: foreground }}
            title={`Foreground color ${foreground} — click to change`}
          >
            <input
              type="color"
              value={foreground}
              onChange={(e) => setForeground(e.target.value)}
              className={styles.colorInput}
              aria-label="Foreground color"
            />
          </label>
          <label
            className={styles.swatchBg}
            style={{ background: background }}
            title={`Background color ${background} — click to change`}
          >
            <input
              type="color"
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              className={styles.colorInput}
              aria-label="Background color"
            />
          </label>
        </div>
        <div className={styles.miniRow}>
          <button
            type="button"
            className={styles.swap}
            onClick={swapColors}
            title="Swap colors (X)"
            aria-label="Swap foreground and background colors"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2 4h6.5M6.5 2l2 2-2 2M10 8H3.5M5.5 6l-2 2 2 2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className={styles.reset}
            onClick={resetColors}
            title="Default colors (D)"
            aria-label="Reset to default colors"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="1.5" y="1.5" width="6" height="6" fill="currentColor" />
              <rect
                x="4.5"
                y="4.5"
                width="6"
                height="6"
                fill="var(--bg-panel-alt)"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          </button>
        </div>
      </div>
    </nav>
  );
}
