import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import styles from './Splitter.module.css';
import { clampWidth } from './watchlistWidth';

interface SplitterProps {
  /** Current watchlist width in px. */
  width: number;
  min: number;
  max: number;
  /** Called at most once per frame while dragging; must not trigger a React render. */
  onPreview: (width: number) => void;
  /** Called once when a drag or key press settles on a new width. */
  onCommit: (width: number) => void;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** Vertical splitter between the chart and the watchlist (WAI-ARIA window splitter). */
export function Splitter({ width, min, max, onPreview, onCommit }: SplitterProps) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    let latest = width;
    let frame = 0;
    document.body.dataset.resizing = 'col';

    const onMove = (move: PointerEvent) => {
      // The watchlist sits on the right, so dragging left makes it wider.
      latest = clampWidth(width + startX - move.clientX, min, max);
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          onPreview(latest);
        });
      }
    };
    const onEnd = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      delete document.body.dataset.resizing;
      onPreview(latest);
      onCommit(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number;
    if (event.key === 'ArrowLeft') next = clampWidth(width + step, min, max);
    else if (event.key === 'ArrowRight') next = clampWidth(width - step, min, max);
    else return;
    event.preventDefault();
    onPreview(next);
    onCommit(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable, focusable splitter is a widget; <hr> is a static divider.
    <div
      className={styles.splitter}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize watchlist"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
