import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import styles from './Menu.module.css';

export interface MenuActionItem {
  type?: 'item';
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** Shown dimmed when `disabled` explains why. */
  disabledHint?: string;
  danger?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  type: 'separator';
}

export interface MenuNote {
  type: 'note';
  label: string;
}

export type MenuItem = MenuActionItem | MenuSeparator | MenuNote;

export interface MenuDefinition {
  id: string;
  label: string;
  items: MenuItem[];
}

/** Classic desktop menu bar with keyboard navigation and outside-click close. */
export function MenuBar({ menus }: { menus: MenuDefinition[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenId(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  useEffect(() => {
    if (openId) {
      const idx = menus.findIndex((m) => m.id === openId);
      requestAnimationFrame(() => itemRefs.current[idx]?.focus());
    }
  }, [openId, menus]);

  const onMenuKeyDown = (e: ReactKeyboardEvent, menuIdx: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = (menuIdx + dir + menus.length) % menus.length;
      setOpenId(menus[next].id);
      requestAnimationFrame(() => {
        const btn = barRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-button]')[next];
        btn?.focus();
      });
    }
  };

  const openMenu = (m: MenuDefinition) => setOpenId((cur) => (cur === m.id ? null : m.id));

  const selectItem = (item: MenuActionItem) => {
    setOpenId(null);
    // Defer so the click doesn't immediately re-open something.
    setTimeout(() => item.onSelect(), 0);
  };

  return (
    <div className={styles.bar} ref={barRef} role="menubar" aria-label="Main menu">
      {menus.map((menu, mIdx) => (
        <div className={styles.root} key={menu.id}>
          <button
            type="button"
            data-menu-button
            className={`${styles.trigger} ${openId === menu.id ? styles.triggerOpen : ''}`}
            aria-haspopup="menu"
            aria-expanded={openId === menu.id}
            onClick={() => openMenu(menu)}
            onMouseEnter={() => openId && setOpenId(menu.id)}
            onKeyDown={(e) => onMenuKeyDown(e, mIdx)}
          >
            {menu.label}
          </button>
          {openId === menu.id && (
            <div className={styles.dropdown} role="menu" aria-label={menu.label}>
              {menu.items.map((item, i) => {
                if ('type' in item && item.type === 'separator') {
                  return <div className={styles.separator} key={`sep-${i}`} role="separator" />;
                }
                if ('type' in item && item.type === 'note') {
                  return (
                    <div className={styles.note} key={`note-${i}`}>
                      {item.label}
                    </div>
                  );
                }
                const action = item as MenuActionItem;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    key={`${action.label}-${i}`}
                    className={`${styles.item} ${action.disabled ? styles.itemDisabled : ''} ${
                      action.danger ? styles.itemDanger : ''
                    }`}
                    disabled={action.disabled}
                    title={action.disabled ? action.disabledHint : undefined}
                    onClick={() => selectItem(action)}
                    onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).focus()}
                  >
                    <span className={styles.itemLabel}>{action.label}</span>
                    {action.shortcut ? <span className={styles.shortcut}>{action.shortcut}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
