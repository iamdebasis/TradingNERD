import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './PopupMenu.module.css';

export interface PopupMenuItem {
  label: string;
  /** A 28 px icon in the column left of the labels. */
  icon?: ReactNode;
  /** Shown at the right, e.g. "⌥ ↵". */
  shortcut?: string;
  /** Shown greyed out, and not chosen. */
  disabled?: boolean;
  /** A submenu, opening beside the item (a › marks it); the item itself then does nothing. */
  items?: readonly PopupMenuEntry[];
  onSelect?(): void;
  /**
   * A ✕ at the row's right, shown while the mouse is over it (as TradingView's lists of saved
   * things have, D3b): it closes the menu and calls this. Delete or Backspace on the row too.
   */
  onRemove?(): void;
  /** The ✕'s label, "Remove" and the item's label by default. */
  removeLabel?: string;
}

/** An item, a dividing line, or a row of its own (e.g. flag colors). */
export type PopupMenuEntry = PopupMenuItem | 'separator' | { key: string; custom: ReactNode };

const isItem = (entry: PopupMenuEntry): entry is PopupMenuItem =>
  entry !== 'separator' && !('custom' in entry);

/** A submenu sits this far from its item's row: its rows level with the item's (ours, §11). */
const SUBMENU_INSET = 6;

/** A level's items: its rows, and those inside a removable row's wrapper. */
const ROWS = ':scope > [role="menuitem"], :scope > [data-removable] > [role="menuitem"]';

/**
 * A menu at a point (right-click) or under a button: 32 px rows and full-width dividers. With
 * icons it is TradingView's row menu (docs/reference/07-watchlist-row-menu.png), labels 42 px in
 * and icons 12 px in; an item with a › opens a submenu beside it, as its "Add to watchlist" does.
 * A press outside it, Escape, or choosing an item closes it; ↑ and ↓ move through its items, →
 * opens a submenu and ← closes it.
 */
export function PopupMenu({
  x,
  y,
  label,
  items,
  note,
  anchor,
  layer,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: readonly PopupMenuEntry[];
  /** A line of text under the items, e.g. a data credit. */
  note?: string | undefined;
  /** The button it opened from: a press on it leaves the menu to the button, which toggles it. */
  anchor?: HTMLElement | null | undefined;
  /** Its z-index, over a dialog it's opened in (the dialogs' 200); the page's menus' 150 else. */
  layer?: number | undefined;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  /** The item whose submenu is open, by its place in `items`, and where the submenu sits. */
  const [open, setOpen] = useState<number | null>(null);
  const [subAt, setSubAt] = useState<{ left: number; top: number } | null>(null);
  /** The submenu opened from the keyboard: its first item takes the focus. */
  const focusSub = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // Keep it inside the window, on whole pixels so its text stays sharp. Opened under a button
  // with no room left below it, it goes above the button rather than over it.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    const button = anchorRef.current?.getBoundingClientRect();
    const roomBelow = y + box.height <= window.innerHeight - 4;
    const top = button && !roomBelow ? button.top - 4 - box.height : y;
    setPosition({
      left: Math.round(Math.max(4, Math.min(x, window.innerWidth - box.width - 4))),
      top: Math.round(Math.max(4, Math.min(top, window.innerHeight - box.height - 4))),
    });
  }, [x, y]);

  // A submenu beside its item, on the side with room for it.
  useLayoutEffect(() => {
    if (open === null) {
      setSubAt(null);
      return;
    }
    const row = menu.current?.querySelector<HTMLElement>(`[data-entry="${open}"]`);
    const box = menu.current?.getBoundingClientRect();
    const own = submenu.current?.getBoundingClientRect();
    if (!row || !box || !own) return;
    const at = row.getBoundingClientRect();
    const right = box.right;
    const left = right + own.width + 4 <= window.innerWidth ? right : box.left - own.width;
    const top = Math.max(4, Math.min(at.top - SUBMENU_INSET, window.innerHeight - own.height - 4));
    setSubAt({ left: Math.round(Math.max(4, left)), top: Math.round(top) });
  }, [open]);

  // Opened from the keyboard, its first item takes the focus once it shows (a hidden one can't).
  useEffect(() => {
    if (!subAt || !focusSub.current) return;
    focusSub.current = false;
    firstItem(submenu.current)?.focus();
  }, [subAt]);

  useEffect(() => {
    firstItem(menu.current)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // A submenu closes first, its item keeping the focus.
      const at = openRef.current;
      if (at !== null) {
        setOpen(null);
        menu.current?.querySelector<HTMLElement>(`[data-entry="${at}"]`)?.focus();
        return;
      }
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const choose = (item: PopupMenuItem) => {
    if (item.disabled || item.items) return;
    onClose();
    item.onSelect?.();
  };

  const remove = (item: PopupMenuItem) => {
    if (!item.onRemove) return;
    onClose();
    item.onRemove();
  };

  const opened = open === null ? undefined : items[open];
  const subItems = opened !== undefined && isItem(opened) ? opened.items : undefined;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const level = target.closest<HTMLElement>('[role="menu"]');
    if (!level) return;
    const inSub = level === submenu.current;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const rows = [...level.querySelectorAll<HTMLElement>(ROWS)].filter(
          (row) => !(row as HTMLButtonElement).disabled,
        );
        if (rows.length === 0) return;
        const at = rows.indexOf(target);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        rows[(at + step + rows.length) % rows.length]?.focus();
        return;
      }
      case 'ArrowRight': {
        // The menu's own keys: never the chart's under it.
        event.preventDefault();
        if (inSub) return;
        const entry = Number(target.dataset.entry);
        const item = items[entry];
        if (item === undefined || !isItem(item) || !item.items || item.disabled) return;
        focusSub.current = true;
        if (open === entry) firstItem(submenu.current)?.focus();
        else setOpen(entry);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (!inSub || open === null) return;
        const at = open;
        setOpen(null);
        menu.current?.querySelector<HTMLElement>(`[data-entry="${at}"]`)?.focus();
        return;
      }
      case 'Delete':
      case 'Backspace': {
        // A removable row's ✕ from the keyboard; never the chart's Delete under the menu.
        const list = inSub ? subItems : items;
        const item = list?.[Number(target.dataset.entry)];
        if (item === undefined || !isItem(item) || !item.onRemove) return;
        event.preventDefault();
        remove(item);
        return;
      }
    }
  };

  return createPortal(
    <div
      ref={menu}
      className={styles.menu}
      role="menu"
      aria-label={label}
      data-icons={hasIcons(items) ? '' : undefined}
      style={layer === undefined ? position : { ...position, zIndex: layer }}
      onKeyDown={onKeyDown}
    >
      {items.map((entry, i) => (
        <Entry
          // biome-ignore lint/suspicious/noArrayIndexKey: a menu's entries keep their places
          key={`${i}`}
          entry={entry}
          index={i}
          open={open === i}
          onHover={() => setOpen(isItem(entry) && entry.items && !entry.disabled ? i : null)}
          onOpen={() => setOpen(open === i ? null : i)}
          onChoose={choose}
          onRemove={remove}
        />
      ))}
      {note && <p className={styles.note}>{note}</p>}
      {subItems && opened !== undefined && isItem(opened) && (
        <div
          ref={submenu}
          className={`${styles.menu} ${styles.submenu}`}
          role="menu"
          aria-label={opened.label}
          data-icons={hasIcons(subItems) ? '' : undefined}
          style={subAt ?? { visibility: 'hidden', left: 0, top: 0 }}
        >
          {subItems.map((entry, i) => (
            <Entry
              // biome-ignore lint/suspicious/noArrayIndexKey: a menu's entries keep their places
              key={`${i}`}
              entry={entry}
              index={i}
              open={false}
              onHover={() => {}}
              onOpen={() => {}}
              onChoose={choose}
              onRemove={remove}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function Entry({
  entry,
  index,
  open,
  onHover,
  onOpen,
  onChoose,
  onRemove,
}: {
  entry: PopupMenuEntry;
  index: number;
  open: boolean;
  onHover(): void;
  onOpen(): void;
  onChoose(item: PopupMenuItem): void;
  onRemove(item: PopupMenuItem): void;
}) {
  if (entry === 'separator') return <hr className={styles.separator} />;
  if ('custom' in entry) return <div className={styles.custom}>{entry.custom}</div>;
  const parent = entry.items !== undefined;
  const row = (
    <button
      type="button"
      role="menuitem"
      className={styles.item}
      data-entry={index}
      disabled={entry.disabled}
      aria-haspopup={parent ? 'menu' : undefined}
      aria-expanded={parent ? open : undefined}
      onPointerEnter={onHover}
      onClick={() => (parent ? onOpen() : onChoose(entry))}
    >
      {entry.icon && <span className={styles.icon}>{entry.icon}</span>}
      <span>{entry.label}</span>
      {entry.shortcut && <span className={styles.shortcut}>{entry.shortcut}</span>}
      {parent && <ChevronIcon />}
    </button>
  );
  if (!entry.onRemove) return row;
  return (
    <div className={styles.removable} data-removable="">
      {row}
      <button
        type="button"
        className={styles.remove}
        tabIndex={-1}
        aria-label={entry.removeLabel ?? `Remove ${entry.label}`}
        title="Remove"
        onClick={() => onRemove(entry)}
      >
        <RemoveIcon />
      </button>
    </div>
  );
}

/** As in TradingView, a menu with icons keeps a column for them, labels or not. */
const hasIcons = (items: readonly PopupMenuEntry[]) =>
  items.some((item) => item !== 'separator' && ('custom' in item || item.icon !== undefined));

const firstItem = (level: HTMLElement | null) =>
  [...(level?.querySelectorAll<HTMLButtonElement>(ROWS) ?? [])].find((row) => !row.disabled) ??
  null;

/** The › of an item with a submenu, as the row menu's "Add to watchlist" (traced, §11). */
function ChevronIcon() {
  return (
    <svg
      className={styles.chevron}
      width="8"
      height="14"
      viewBox="0 0 8 14"
      fill="none"
      aria-hidden="true"
    >
      <path d="M1.5 1.5 6.5 7l-5 5.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** The ✕ of a removable row (the size of the watchlist's remove crosses; ours, §11). */
function RemoveIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="m1.5 1.5 7 7m0-7-7 7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
