import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './PopupMenu.module.css';

export interface PopupMenuItem {
  label: string;
  /** A 28 px icon in the column left of the labels. */
  icon?: ReactNode;
  /** Shown at the right, e.g. "⌥ ↵". */
  shortcut?: string;
  onSelect(): void;
}

/** An item, a dividing line, or a row of its own (e.g. flag colors). */
export type PopupMenuEntry = PopupMenuItem | 'separator' | { key: string; custom: ReactNode };

/**
 * A menu at a point (right-click) or under a button: 32 px rows and full-width dividers. With
 * icons it is TradingView's row menu (docs/reference/07-watchlist-row-menu.png), labels 42 px in
 * and icons 12 px in. A press outside it, Escape, or choosing an item closes it.
 */
export function PopupMenu({
  x,
  y,
  label,
  items,
  note,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: readonly PopupMenuEntry[];
  /** A line of text under the items, e.g. a data credit. */
  note?: string | undefined;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep it inside the window, on whole pixels so its text stays sharp.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.round(Math.max(4, Math.min(x, window.innerWidth - box.width - 4))),
      top: Math.round(Math.max(4, Math.min(y, window.innerHeight - box.height - 4))),
    });
  }, [x, y]);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // As in TradingView, a menu with icons keeps a column for them, labels or not.
  const icons = items.some(
    (item) => item !== 'separator' && ('custom' in item || item.icon !== undefined),
  );

  return createPortal(
    <div
      ref={menu}
      className={styles.menu}
      role="menu"
      aria-label={label}
      data-icons={icons ? '' : undefined}
      style={position}
    >
      {items.map((item, i) => {
        if (item === 'separator') {
          // biome-ignore lint/suspicious/noArrayIndexKey: dividers have no identity of their own
          return <hr key={`separator-${i}`} className={styles.separator} />;
        }
        if ('custom' in item) {
          return (
            <div key={item.key} className={styles.custom}>
              {item.custom}
            </div>
          );
        }
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon && <span className={styles.icon}>{item.icon}</span>}
            <span>{item.label}</span>
            {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
          </button>
        );
      })}
      {note && <p className={styles.note}>{note}</p>}
    </div>,
    document.body,
  );
}
