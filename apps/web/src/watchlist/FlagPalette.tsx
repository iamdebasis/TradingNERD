import type { FlagColor } from '@tradingnerd/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FlagDots } from './FlagDots';
import styles from './FlagPalette.module.css';

export interface FlagPaletteProps {
  /** The row's flag button; the bubble points at it. */
  anchor: HTMLElement;
  /** The symbol's color now, shown as a ring. */
  current: FlagColor | null;
  onPick(color: FlagColor): void;
  onClose(): void;
  /** The pointer is over the bubble (true) or has left it (false): it stays while it's there. */
  onHover(over: boolean): void;
}

/**
 * The flag colors that appear while the pointer rests on a row's flag
 * (docs/reference/06-watchlist-flags.png): a bubble pointing at the flag, centered on its row.
 * Escape or a press anywhere else closes it.
 */
export function FlagPalette({ anchor, current, onPick, onClose, onHover }: FlagPaletteProps) {
  const palette = useRef<HTMLFieldSetElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // The arrow's tip just inside the flag button's right edge, the bubble centered on its row.
  useLayoutEffect(() => {
    const flag = anchor.getBoundingClientRect();
    setPlace({ left: flag.right - 0.5, top: flag.top + flag.height / 2 });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (palette.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [anchor, onClose]);

  return createPortal(
    <fieldset
      ref={palette}
      className={styles.palette}
      aria-label="Flag color"
      style={place ?? { visibility: 'hidden' }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <span className={styles.arrow} />
      <div className={styles.body}>
        <FlagDots current={current} gap={8} onPick={onPick} />
      </div>
    </fieldset>,
    document.body,
  );
}
