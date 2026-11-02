import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import styles from './Splitter.module.css';
import { clampWidth } from './watchlistWidth';

interface SplitterProps {
  /** The panel's current size in px: its width beside the chart, or its height below it. */
  width: number;
  min: number;
  max: number;
  /** Called at most once per frame while dragging; must not trigger a React render. */
  onPreview: (width: number) => void;
  /** Called once when a drag or key press settles on a new width. */
  onCommit: (width: number) => void;
  /** 'y' for a panel below the chart (the Pine Editor moved to the bottom). */
  axis?: 'x' | 'y';
  label?: string;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/**
 * The splitter between the chart and a panel (WAI-ARIA window splitter): vertical beside a panel
 * on the right, horizontal above one below the chart.
 */
export function Splitter({
  width,
  min,
  max,
  onPreview,
  onCommit,
  axis = 'x',
  label = 'Resize watchlist',
}: SplitterProps) {
  const across = axis === 'y';
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = across ? event.clientY : event.clientX;
    let latest = width;
    let frame = 0;
    document.body.dataset.resizing = across ? 'row' : 'col';

    const onMove = (move: PointerEvent) => {
      // The panel sits right of or below the chart: dragging left or up makes it bigger.
      latest = clampWidth(width + start - (across ? move.clientY : move.clientX), min, max);
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
    const grow = across ? 'ArrowUp' : 'ArrowLeft';
    const shrink = across ? 'ArrowDown' : 'ArrowRight';
    let next: number;
    if (event.key === grow) next = clampWidth(width + step, min, max);
    else if (event.key === shrink) next = clampWidth(width - step, min, max);
    else return;
    event.preventDefault();
    onPreview(next);
    onCommit(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable, focusable splitter is a widget; <hr> is a static divider.
    <div
      className={`${styles.splitter} ${across ? styles.across : ''}`}
      role="separator"
      aria-orientation={across ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
