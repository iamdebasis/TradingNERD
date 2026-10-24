import { sortedLists, type WatchlistsIndex } from '@tradingnerd/core';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AddSectionIcon } from './icons';
import styles from './ListMenu.module.css';
import {
  ClearIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  ListStarIcon,
  NewListIcon,
  RenameIcon,
  UploadIcon,
} from './listIcons';

export interface ListMenuProps {
  /** Where it opens: under the list's name. */
  x: number;
  y: number;
  index: WatchlistsIndex;
  onCopy(): void;
  onRename(): void;
  onAddSection(): void;
  onClear(): void;
  onCreate(): void;
  onUpload(): void;
  /** "Open list…": the dialog with every list. */
  onOpenDialog(): void;
  onOpen(id: string): void;
  onStar(id: string, favorite: boolean): void;
  onDownload(id: string): void;
  onClose(): void;
}

/**
 * TradingView's list menu, opened from the list's name (docs/SPEC.md §5.9): the open list's
 * actions, new and uploaded lists, then MY WATCHLISTS (every list, starred ones first: the
 * open one highlighted, each with its star and a download button), and "Open list…" (⇧W).
 * Share list, Copy link and alerts are left out: they need TradingView's accounts. Measured
 * from a screenshot of it: 210 px wide, 32 px rows, labels 43 px in, separators inset 6 px.
 */
export function ListMenu(props: ListMenuProps) {
  const { x, y, index, onClose } = props;
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.round(Math.max(4, Math.min(x, window.innerWidth - box.width - 4))),
      top: Math.round(Math.max(4, Math.min(y, window.innerHeight - box.height - 4))),
    });
  }, [x, y]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[data-item]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // ↑ and ↓ move between the items (the lists' own buttons are reached with Tab).
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[data-item]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const act = (run: () => void) => () => {
    onClose();
    run();
  };

  const item = (label: string, icon: ReactNode, run: () => void, shortcut?: string) => (
    <button type="button" role="menuitem" className={styles.item} data-item onClick={act(run)}>
      <span className={styles.icon}>{icon}</span>
      {label}
      {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
    </button>
  );

  return createPortal(
    <div
      ref={menu}
      className={styles.menu}
      role="menu"
      aria-label="Watchlist menu"
      style={position}
      onKeyDown={onKeyDown}
    >
      {item('Make a copy…', <CopyIcon />, props.onCopy)}
      {item('Rename', <RenameIcon />, props.onRename)}
      {item('Add section', <AddSectionIcon />, props.onAddSection)}
      {item('Clear list', <ClearIcon />, props.onClear)}
      <hr className={styles.separator} />
      {item('Create new list…', <NewListIcon />, props.onCreate)}
      {item('Upload list…', <UploadIcon />, props.onUpload)}
      <hr className={styles.separator} />
      <div className={styles.heading} role="presentation">
        My watchlists
      </div>
      <div className={styles.lists}>
        {sortedLists(index.lists).map((list) => {
          const active = list.id === index.activeId;
          return (
            <div key={list.id} className={styles.listRow} data-active={active || undefined}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={styles.listName}
                data-item
                title={list.name}
                onClick={act(() => {
                  if (!active) props.onOpen(list.id);
                })}
              >
                {list.name}
              </button>
              <button
                type="button"
                className={styles.rowIcon}
                aria-label={`Download ${list.name}`}
                title="Download list"
                onClick={act(() => props.onDownload(list.id))}
              >
                <DownloadIcon />
              </button>
              <button
                type="button"
                className={`${styles.rowIcon} ${styles.star}`}
                aria-label={`Star ${list.name}`}
                aria-pressed={list.favorite}
                title={list.favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => props.onStar(list.id, !list.favorite)}
              >
                <ListStarIcon filled={list.favorite} />
              </button>
            </div>
          );
        })}
      </div>
      <hr className={styles.separator} />
      {item('Open list…', <FolderIcon />, props.onOpenDialog, '⇧ W')}
    </div>,
    document.body,
  );
}
