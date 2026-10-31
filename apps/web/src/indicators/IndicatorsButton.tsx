import { type IndicatorKind, indicatorDefinition } from '@tradingnerd/indicators';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, StarIcon } from '../toolbar/icons';
import styles from './IndicatorsButton.module.css';
import { IndicatorsIcon } from './icons';
import { useFavoriteIndicators } from './indicatorStore';

/**
 * TradingView's top-bar Indicators button and the ⌄ after it, measured from
 * docs/reference/01-chart-layout.png at 2×: the 17 × 18 icon 10 px before the word, the ⌄
 * 19 px after it. The ⌄ lists the starred indicators; one click adds one (Help Center,
 * "How to favorite Indicators…").
 */
export function IndicatorsButton({
  onOpen,
  onAdd,
}: {
  /** The button itself: open the Indicators dialog. */
  onOpen(): void;
  onAdd(kind: IndicatorKind): void;
}) {
  const favorites = useFavoriteIndicators();
  const [open, setOpen] = useState(false);
  const arrow = useRef<HTMLButtonElement>(null);

  return (
    <div className={styles.group}>
      <button type="button" className={styles.button} onClick={onOpen} title="Indicators (/)">
        <IndicatorsIcon />
        Indicators
      </button>
      <button
        ref={arrow}
        type="button"
        className={styles.arrow}
        aria-label="Favorite indicators"
        aria-expanded={open}
        data-open={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon />
      </button>
      {open && (
        <FavoritesMenu
          anchor={arrow.current}
          favorites={favorites}
          onAdd={(kind) => {
            setOpen(false);
            onAdd(kind);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function FavoritesMenu({
  anchor,
  favorites,
  onAdd,
  onClose,
}: {
  anchor: HTMLElement | null;
  favorites: readonly IndicatorKind[];
  onAdd(kind: IndicatorKind): void;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: 0, top: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const box = anchor?.getBoundingClientRect();
    const width = menu.current?.offsetWidth ?? 0;
    if (!box) return;
    setPlace({
      left: Math.max(4, Math.min(box.left, window.innerWidth - width - 4)),
      top: box.bottom + 2,
    });
  }, [anchor]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !anchor?.contains(target)) onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCloseRef.current();
      anchor?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={menu}
      className={styles.menu}
      role="menu"
      aria-label="Favorite indicators"
      style={{ left: place.left, top: place.top }}
    >
      {favorites.length === 0 ? (
        <div className={styles.empty}>No favorites yet: star one in the Indicators dialog</div>
      ) : (
        favorites.map((kind) => (
          <button
            key={kind}
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => onAdd(kind)}
          >
            <span className={styles.itemStar}>
              <StarIcon filled />
            </span>
            {indicatorDefinition(kind).name}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
