import {
  type Drawing,
  type DrawingLineStyle,
  type DrawingTool,
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
import { PopupMenu } from '../watchlist/PopupMenu';
import { ColorEditor, LineStyles, LineWidths } from './ColorEditor';
import styles from './Drawings.module.css';
import { drawingStore } from './drawingStore';
import {
  GearIcon,
  GripIcon,
  LineColorIcon,
  LineStyleIcon,
  MoreIcon,
  PadlockIcon,
  TemplatesIcon,
  TrashIcon,
} from './icons';
import { templateEntries } from './TemplateMenu';
import { useTemplates } from './templateStore';

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

/** A drawing has a line to style unless it's only text (later milestones). */
function hasLine(tool: DrawingTool): boolean {
  const options = TOOL_OPTIONS[tool];
  return (
    options.extend ||
    options.extendMenu ||
    options.extendLines ||
    options.showPrice ||
    options.showTime ||
    options.stats
  );
}

/**
 * TradingView's floating toolbar for the drawings selected (docs/SPEC.md §5.27): moved by its
 * grip and left where it's put; the line's color, thickness and style, the settings, Lock and
 * Remove, and More (⋯), the drawings' menu (D3a). With several selected each button sets every
 * one of them (TradingView's blog, Change the color of multiple tools at once), showing the
 * first's; Remove leaves the locked ones, as the Delete key does. Templates (D3b), first after
 * the grip, shows while they're all of one tool (Help Center, How to apply a template to several
 * tools of the same type at once?). Its buttons and look are provisional until measured from a
 * screenshot (§11).
 */
export function FloatingToolbar({
  drawings,
  lockAll,
  onSettings,
  onMore,
}: {
  /** The drawings selected, in drawing order: one at least. */
  drawings: readonly Drawing[];
  /** Lock all drawings is on: none can be removed. */
  lockAll: boolean;
  onSettings(): void;
  /** More (⋯): the drawings' menu, opening at this place in the window. */
  onMore(at: { x: number; y: number }): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(readPlace);
  const [popup, setPopup] = useState<Popup | null>(null);
  /** The Templates menu, open at this place in the window. */
  const [templatesAt, setTemplatesAt] = useState<Place | null>(null);
  const templatesButton = useRef<HTMLButtonElement>(null);
  const templates = useTemplates();
  /** The drawings before the color editor opened: its changes are one undo step. */
  const before = useRef<readonly Drawing[] | null>(null);
  const drawing = drawings[0] as Drawing;
  const ids = drawings.map((item) => item.id);
  const { style } = drawing;
  const lined = drawings.some((item) => hasLine(item.tool));
  const allLocked = drawings.every((item) => item.locked);
  const removable = !lockAll && !allLocked;
  const { tool } = drawing;
  const oneTool = drawings.every((item) => item.tool === tool);

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
    drawingStore.updateMany(ids, (current) => ({
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
      {oneTool && (
        <button
          ref={templatesButton}
          type="button"
          className={styles.tool}
          aria-label="Templates"
          title="Templates"
          aria-haspopup="menu"
          aria-expanded={templatesAt !== null}
          onClick={(event) => {
            if (templatesAt) {
              setTemplatesAt(null);
              return;
            }
            const at = event.currentTarget.getBoundingClientRect();
            setTemplatesAt({ x: Math.round(at.left), y: Math.round(at.bottom + 4) });
          }}
        >
          <TemplatesIcon />
        </button>
      )}
      {lined && (
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
        aria-label={allLocked ? 'Unlock' : 'Lock'}
        title={allLocked ? 'Unlock' : 'Lock'}
        aria-pressed={allLocked}
        onClick={() =>
          drawingStore.updateMany(ids, (current) =>
            current.locked === !allLocked ? current : { ...current, locked: !allLocked },
          )
        }
      >
        <PadlockIcon locked={allLocked} />
      </button>
      <button
        type="button"
        className={styles.tool}
        aria-label="Remove"
        title="Remove"
        disabled={!removable}
        onClick={() => drawingStore.removeUnlocked(ids)}
      >
        <TrashIcon />
      </button>
      <button
        type="button"
        className={styles.tool}
        aria-label="More"
        title="More"
        aria-haspopup="menu"
        onClick={(event) => {
          const at = event.currentTarget.getBoundingClientRect();
          onMore({ x: Math.round(at.left), y: Math.round(at.bottom + 4) });
        }}
      >
        <MoreIcon />
      </button>
      {templatesAt && oneTool && (
        <PopupMenu
          x={templatesAt.x}
          y={templatesAt.y}
          label="Templates"
          anchor={templatesButton.current}
          items={templateEntries({
            tool,
            state: templates,
            style: () => drawing.style,
            onApply: (style) => drawingStore.applyStyle(ids, tool, style),
          })}
          onClose={() => setTemplatesAt(null)}
        />
      )}
      {popup === 'color' && (
        <ColorEditor
          label="Line color"
          color={style.color}
          // Each drawing takes the color whole: a channel's levels and background, a
          // pitchfork's levels, a regression's bands too (core's recolorDrawing; §11).
          onChange={(color) =>
            drawingStore.previewMany(drawings.map((item) => recolorDrawing(item, color)))
          }
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
