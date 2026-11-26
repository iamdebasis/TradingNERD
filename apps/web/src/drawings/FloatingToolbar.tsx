import {
  type Drawing,
  type DrawingLineStyle,
  recolorDrawing,
  TOOL_OPTIONS,
} from '@tradingnerd/core';
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { readJson, writeJson } from '../lib/storage';
import { ColorEditor, LineStyles, LineWidths } from './ColorEditor';
import styles from './Drawings.module.css';
import { drawingStore } from './drawingStore';
import { GearIcon, GripIcon, LineColorIcon, LineStyleIcon, PadlockIcon, TrashIcon } from './icons';

/** Where the floating toolbar was dragged to, kept in this browser. */
export const FLOATING_TOOLBAR_KEY = 'tn.drawings.floatingToolbar';
/** Its first place: centred, below the legend's first rows (provisional, §11). */
const DEFAULT_TOP = 52;

type Popup = 'color' | 'width' | 'style';

interface Place {
  x: number;
  y: number;
}

function readPlace(): Place | null {
  const value = readJson(FLOATING_TOOLBAR_KEY) as Partial<Place> | null;
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: value.x as number, y: value.y as number }
    : null;
}

/**
 * TradingView's floating toolbar for a selected drawing (docs/SPEC.md §5.27): moved by its grip
 * and left where it's put; the line's color, thickness and style, the settings, Lock and Remove.
 * Its buttons and look are provisional until measured from a screenshot (§11).
 */
export function FloatingToolbar({ drawing, onSettings }: { drawing: Drawing; onSettings(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(readPlace);
  const [popup, setPopup] = useState<Popup | null>(null);
  /** The drawings before the color editor opened: its changes are one undo step. */
  const before = useRef<readonly Drawing[] | null>(null);
  const { style } = drawing;
  const options = TOOL_OPTIONS[drawing.tool];
  // A drawing has a line to style unless it's only text (later milestones).
  const hasLine =
    options.extend ||
    options.extendMenu ||
    options.extendLines ||
    options.showPrice ||
    options.showTime ||
    options.stats;

  // Gone while its color was being changed (deselected, removed): what was chosen stays.
  useEffect(
    () => () => {
      if (before.current) drawingStore.finishPreview(before.current, true);
      before.current = null;
    },
    [],
  );

  // Kept inside the chart when it gets smaller.
  useLayoutEffect(() => {
    const element = box.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const maxX = Math.max(0, parent.clientWidth - element.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - element.offsetHeight);
    const at = place ?? { x: Math.round(maxX / 2), y: DEFAULT_TOP };
    const kept = { x: Math.min(maxX, Math.max(0, at.x)), y: Math.min(maxY, Math.max(0, at.y)) };
    if (!place || kept.x !== place.x || kept.y !== place.y) setPlace(kept);
  }, [place]);

  const grab = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const element = box.current;
    const parent = element?.parentElement;
    if (!element || !parent || !place) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, place };
    let last = place;
    const move = (moveEvent: PointerEvent) => {
      const maxX = Math.max(0, parent.clientWidth - element.offsetWidth);
      const maxY = Math.max(0, parent.clientHeight - element.offsetHeight);
      last = {
        x: Math.min(maxX, Math.max(0, start.place.x + moveEvent.clientX - start.x)),
        y: Math.min(maxY, Math.max(0, start.place.y + moveEvent.clientY - start.y)),
      };
      setPlace(last);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      writeJson(FLOATING_TOOLBAR_KEY, last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const change = (next: Partial<Drawing['style']>) =>
    drawingStore.update(drawing.id, (current) => ({
      ...current,
      style: { ...current.style, ...next },
    }));

  const openColor = () => {
    if (popup === 'color') {
      closeColor();
      return;
    }
    before.current = drawingStore.get().drawings;
    setPopup('color');
  };
  const closeColor = () => {
    if (before.current) drawingStore.finishPreview(before.current, true);
    before.current = null;
    setPopup(null);
  };

  return (
    <div
      ref={box}
      className={styles.floating}
      role="toolbar"
      aria-label="Drawing toolbar"
      style={place ? { left: place.x, top: place.y } : { visibility: 'hidden' }}
    >
      <span className={styles.grip} title="Drag" onPointerDown={grab}>
        <GripIcon />
      </span>
      {hasLine && (
        <>
          <button
            type="button"
            className={styles.tool}
            data-color-opener
            aria-label="Line color"
            title="Line color"
            aria-expanded={popup === 'color'}
            onClick={openColor}
          >
            <LineColorIcon color={style.color} />
          </button>
          <button
            type="button"
            className={styles.tool}
            aria-label="Line thickness"
            title="Line thickness"
            aria-expanded={popup === 'width'}
            onClick={() => setPopup(popup === 'width' ? null : 'width')}
          >
            {style.width}px
          </button>
          <button
            type="button"
            className={styles.tool}
            aria-label="Line style"
            title="Line style"
            aria-expanded={popup === 'style'}
            onClick={() => setPopup(popup === 'style' ? null : 'style')}
          >
            <LineStyleIcon style={style.lineStyle} />
          </button>
          <span className={styles.toolSeparator} />
        </>
      )}
      <button
        type="button"
        className={styles.tool}
        aria-label="Settings"
        title="Settings"
        onClick={onSettings}
      >
        <GearIcon />
      </button>
      <button
        type="button"
        className={styles.tool}
        aria-label={drawing.locked ? 'Unlock' : 'Lock'}
        title={drawing.locked ? 'Unlock' : 'Lock'}
        aria-pressed={drawing.locked}
        onClick={() =>
          drawingStore.update(drawing.id, (current) => ({ ...current, locked: !current.locked }))
        }
      >
        <PadlockIcon locked={drawing.locked} />
      </button>
      <button
        type="button"
        className={styles.tool}
        aria-label="Remove"
        title="Remove"
        onClick={() => drawingStore.remove([drawing.id])}
      >
        <TrashIcon />
      </button>
      {popup === 'color' && (
        <ColorEditor
          label="Line color"
          color={style.color}
          // The whole drawing takes the color: a channel's levels and background, a
          // pitchfork's levels, a regression's bands too (core's recolorDrawing; §11).
          onChange={(color) => drawingStore.preview(recolorDrawing(drawing, color))}
          onClose={closeColor}
          style={{ top: 42, left: 0 }}
        />
      )}
      {popup === 'width' && (
        <Choices onClose={() => setPopup(null)}>
          <LineWidths
            width={style.width}
            onWidth={(width) => {
              setPopup(null);
              change({ width });
            }}
          />
        </Choices>
      )}
      {popup === 'style' && (
        <Choices onClose={() => setPopup(null)}>
          <LineStyles
            lineStyle={style.lineStyle}
            onStyle={(lineStyle: DrawingLineStyle) => {
              setPopup(null);
              change({ lineStyle });
            }}
          />
        </Choices>
      )}
    </div>
  );
}

/** A small list under the toolbar (thickness, style). */
function Choices({ onClose, children }: { onClose(): void; children: ReactNode }) {
  return (
    <ColorlessPopup onClose={onClose}>
      <div className={styles.editorRow}>{children}</div>
    </ColorlessPopup>
  );
}

function ColorlessPopup({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || box.current?.parentElement?.contains(target)) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return (
    <div ref={box} className={styles.editor} style={{ top: 42, left: 0, width: 'auto' }}>
      {children}
    </div>
  );
}
