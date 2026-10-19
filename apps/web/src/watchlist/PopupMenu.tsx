import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './PopupMenu.module.css';

export interface PopupMenuItem {
  label: string;
  /** Shown at the right, e.g. "Del". */
  shortcut?: string;
  onSelect(): void;
}

/**
 * A small menu at a point (right-click) or under a button, in the interval menu's style. A
 * press outside it, Escape, or choosing an item closes it.
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
  items: readonly PopupMenuItem[];
  /** A line of text under the items, e.g. a data credit. */
  note?: string | undefined;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep it inside the window.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
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

  return createPortal(
    <div ref={menu} className={styles.menu} role="menu" aria-label={label} style={position}>
      {items.map((item) => (
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
          <span>{item.label}</span>
          {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
        </button>
      ))}
      {note && <p className={styles.note}>{note}</p>}
    </div>,
    document.body,
  );
}
