import { MAX_WATCHLIST_NAME, sortedLists, type WatchlistsIndex } from '@tradingnerd/core';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../toolbar/icons';
import { RemoveIcon } from './icons';
import styles from './ListDialogs.module.css';
import { ListStarIcon } from './listIcons';

/** Closes on Escape, unless something inside (a confirmation) took it. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
}

function Dialog({
  title,
  onClose,
  onSubmit,
  wide,
  children,
}: {
  title: string;
  onClose(): void;
  onSubmit?: (event: FormEvent) => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  useEscape(onClose);
  return createPortal(
    <div className={styles.backdrop}>
      <form
        className={styles.dialog}
        data-wide={wide || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.(event);
        }}
      >
        <div className={styles.titleRow}>
          <h2 id={`${id}-title`} className={styles.title}>
            {title}
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {children}
      </form>
    </div>,
    document.body,
  );
}

/**
 * "Create new list…" and "Make a copy…": a name for the list (provisional look, docs/SPEC.md
 * §11). A name another list has gets " (1)" after it, as TradingView's do.
 */
export function ListNameDialog({
  title,
  action,
  initialName,
  onSubmit,
  onClose,
}: {
  title: string;
  /** The button: "Create", "Copy". */
  action: string;
  initialName: string;
  onSubmit(name: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const ready = name.trim().length > 0;
  return (
    <Dialog title={title} onClose={onClose} onSubmit={() => ready && onSubmit(name.trim())}>
      <label className={styles.field}>
        <span className={styles.label}>List name</span>
        <input
          className={styles.input}
          value={name}
          maxLength={MAX_WATCHLIST_NAME}
          placeholder="List name"
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className={styles.submit} disabled={!ready}>
          {action}
        </button>
      </div>
    </Dialog>
  );
}

/** "Clear list" and deleting a list: a question and its answer (provisional look). */
export function ConfirmDialog({
  title,
  message,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  action: string;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <Dialog title={title} onClose={onClose} onSubmit={onConfirm}>
      <p className={styles.message}>{message}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onClose}>
          Cancel
        </button>
        {/* biome-ignore lint/a11y/noAutofocus: Enter answers the question asked */}
        <button type="submit" className={styles.danger} autoFocus>
          {action}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * "Open list…" (⇧W): every list, found by name; a click opens one, and a list under the mouse
 * shows its remove button, as TradingView's (its help center). The last list can't go.
 */
export function OpenListDialog({
  index,
  onOpen,
  onDelete,
  onClose,
}: {
  index: WatchlistsIndex;
  onOpen(id: string): void;
  onDelete(id: string, name: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const shown = sortedLists(index.lists).filter((list) =>
    list.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Dialog title="Open list" onClose={onClose} wide>
      <input
        className={styles.input}
        type="search"
        aria-label="Search lists"
        placeholder="Search"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className={styles.lists} aria-label="Your watchlists">
        {shown.map((list) => (
          <li
            key={list.id}
            className={styles.list}
            data-active={list.id === index.activeId || undefined}
          >
            <button type="button" className={styles.open} onClick={() => onOpen(list.id)}>
              <span className={styles.name}>{list.name}</span>
              {list.favorite && (
                <span className={styles.starred} title="Favorite">
                  <ListStarIcon filled />
                </span>
              )}
              <span className={styles.count}>
                {list.count} {list.count === 1 ? 'symbol' : 'symbols'}
              </span>
            </button>
            {index.lists.length > 1 && (
              <button
                type="button"
                className={styles.remove}
                aria-label={`Delete ${list.name}`}
                title="Delete list"
                onClick={() => onDelete(list.id, list.name)}
              >
                <RemoveIcon />
              </button>
            )}
          </li>
        ))}
        {shown.length === 0 && <li className={styles.empty}>No lists match</li>}
      </ul>
    </Dialog>
  );
}
