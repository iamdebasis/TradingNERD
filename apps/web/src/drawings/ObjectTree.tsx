import { MAX_DRAWING_NAME, type Resolution, type TreePlace } from '@tradingnerd/core';
import { indicatorTitle, type SymbolContext } from '@tradingnerd/indicators';
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { definitionOf } from '../indicators/definitions';
import { hasSource } from '../indicators/IndicatorLegend';
import { EyeCrossedIcon, EyeIcon, TrashIcon as RowTrashIcon } from '../indicators/icons';
import { indicatorStore, useIndicators } from '../indicators/indicatorStore';
import { pineStore } from '../pine/pineStore';
import { PopupMenu, type PopupMenuEntry } from '../watchlist/PopupMenu';
import { drawingEntries } from './DrawingMenu';
import { drawingStore, useDrawings } from './drawingStore';
import {
  CloneIcon,
  GearIcon,
  HideIcon,
  IndicatorRowIcon,
  RowPadlockIcon,
  SeriesIcon,
  ShowIcon,
  TOOL_ICONS,
  TrashIcon,
} from './icons';
import styles from './ObjectTree.module.css';
import { dropPlace, type TreeIndicator, type TreeRow, treeRows } from './objectTreeModel';
import { objectTreeStore } from './objectTreeStore';
import { useTemplates } from './templateStore';

/**
 * A second click on the row already selected renames it after this long, unless it was a double
 * click, which opens its settings (TradingView's blog, 5 February 2020: "clicking on the selected
 * object again"; the delay is ours, provisional §11).
 */
export const RENAME_DELAY_MS = 500;
/** A press moves this far before it drags rows (ours, provisional §11). */
const DRAG_START_PX = 4;
/** Within this far of the list's top or bottom, a drag scrolls it (ours). */
const SCROLL_EDGE_PX = 24;

type DrawingRow = Extract<TreeRow, { kind: 'drawing' }>;

type Menu =
  | { kind: 'drawings'; x: number; y: number; ids: readonly string[] }
  | { kind: 'indicator'; x: number; y: number; id: string };

interface Drag {
  ids: readonly string[];
  row: DrawingRow;
  /** Where the dragged row's copy is drawn, following the pointer. */
  left: number;
  top: number;
  width: number;
  /** The gap the drawings would go to (before row `gap`), and where that puts them. */
  gap: number;
  place: TreePlace | null;
}

const isShownDrawing = (row: TreeRow): row is DrawingRow =>
  row.kind === 'drawing' && !row.drawing.hidden;

/**
 * TradingView's Object tree (docs/SPEC.md §5.27, D3c), in the right panel: its "Object tree" and
 * "Data window" switch (the Data window comes later), a toolbar with Clone (Create a group of
 * drawings and Manage layout drawings come with D3c2, Move to with I3), then the chart's objects
 * in paint order with the top row at the back (TradingView's own GIF, measured: §4.27): the
 * symbol's row in bold, its indicators and drawings. Selecting rows selects the drawings on the
 * chart, and the chart's selection shows here; under the pointer a drawing's row offers its
 * padlock, eye (Hide or Show) and trash (Remove), an indicator's its eye and trash. Dragging
 * drawings changes their visual order, across the bars too; the selected row clicked again is
 * renamed; a double click opens the settings; a right-click opens the tree's menu.
 */
export function ObjectTree({
  symbolLabel,
  symbol,
  resolution,
}: {
  /** The symbol's row: "XRPUSDT · BINANCE, 1D". */
  symbolLabel: string;
  /** For the indicators' names ("Vol · XRP"). */
  symbol: SymbolContext;
  /** The chart's interval, for Visibility on intervals. */
  resolution: Resolution | null;
}) {
  const { drawings, selection, prefs } = useDrawings();
  const indicatorList = useIndicators().list;
  const templates = useTemplates();
  const indicators = useMemo(
    (): TreeIndicator[] =>
      indicatorList.map((indicator) => {
        const definition = definitionOf(indicator);
        return {
          id: indicator.id,
          label: indicatorTitle(definition, indicator.settings.inputs, symbol),
          hidden: indicator.hidden,
          overlay: definition.placement !== 'pane',
        };
      }),
    [indicatorList, symbol],
  );
  const rows = useMemo(
    () => treeRows(drawings, indicators, symbolLabel),
    [drawings, indicators, symbolLabel],
  );
  /**
   * A row selected in the tree alone, its key: the symbol's, an indicator's or a hidden
   * drawing's, which the chart can't select.
   */
  const [only, setOnly] = useState<string | null>(null);
  /** The row a Shift-click's range starts from. */
  const anchor = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Ctrl or ⌘ held with drawings selected: the rows that can't join them dim (TradingView's). */
  const [held, setHeld] = useState(false);
  const renameTimer = useRef(0);
  /** A drag just ended: the click it ends with isn't a click on its row. */
  const dragged = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);

  // The chart's selection and the tree's own one row are one or the other.
  useEffect(() => {
    if (selection.length > 0) setOnly(null);
  }, [selection]);
  useEffect(() => {
    if (only !== null && !rows.some((row) => row.key === only)) setOnly(null);
  }, [only, rows]);
  // A rename waits for its row to stay selected: another selection meanwhile drops it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of selection is the cue
  useEffect(() => () => window.clearTimeout(renameTimer.current), [selection, only]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => setHeld(event.ctrlKey || event.metaKey);
    const onBlur = () => setHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      window.clearTimeout(renameTimer.current);
      stopDrag.current?.();
    };
  }, []);

  const select = (ids: readonly string[]) => objectTreeStore.ask({ kind: 'select', ids });
  const selectOnly = (row: TreeRow) => {
    setOnly(row.key);
    if (selection.length > 0) select([]);
  };
  const isSelected = (row: TreeRow) =>
    row.key === only || (row.kind === 'drawing' && selection.includes(row.id));
  /** The selected drawings, in drawing order. */
  const selectedIds = () =>
    drawings.filter((drawing) => selection.includes(drawing.id)).map((drawing) => drawing.id);

  const renameLater = (id: string) => {
    window.clearTimeout(renameTimer.current);
    renameTimer.current = window.setTimeout(() => setRenaming(id), RENAME_DELAY_MS);
  };

  const onClick = (row: TreeRow, event: ReactMouseEvent) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    // A double click's second click: the double click opens the settings.
    if (event.detail > 1) return;
    if (row.kind === 'drawing' && !row.drawing.hidden) {
      if (event.ctrlKey || event.metaKey) {
        anchor.current = row.key;
        setOnly(null);
        select(
          selection.includes(row.id)
            ? selection.filter((id) => id !== row.id)
            : [...selection, row.id],
        );
        return;
      }
      const from = anchor.current === null ? -1 : rows.findIndex((r) => r.key === anchor.current);
      if (event.shiftKey && from >= 0) {
        const to = rows.indexOf(row);
        const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1);
        setOnly(null);
        select(range.filter(isShownDrawing).map((r) => r.id));
        return;
      }
      anchor.current = row.key;
      if (selection.length === 1 && selection[0] === row.id) {
        renameLater(row.id);
        return;
      }
      setOnly(null);
      select([row.id]);
      return;
    }
    anchor.current = row.key;
    if (row.kind === 'drawing' && only === row.key) {
      renameLater(row.id);
      return;
    }
    selectOnly(row);
  };

  const onDoubleClick = (row: TreeRow) => {
    window.clearTimeout(renameTimer.current);
    if (row.kind === 'drawing') objectTreeStore.ask({ kind: 'drawing-settings', ids: [row.id] });
    else if (row.kind === 'indicator') {
      objectTreeStore.ask({ kind: 'indicator-settings', id: row.id });
    }
  };

  const onContextMenu = (row: TreeRow, event: ReactMouseEvent) => {
    event.preventDefault();
    window.clearTimeout(renameTimer.current);
    const at = { x: event.clientX, y: event.clientY };
    anchor.current = row.key;
    if (row.kind === 'symbol') {
      // TradingView's menu for it isn't documented: none yet (provisional, §11).
      selectOnly(row);
      return;
    }
    if (row.kind === 'indicator') {
      selectOnly(row);
      setMenu({ kind: 'indicator', ...at, id: row.id });
      return;
    }
    if (selection.includes(row.id)) {
      setMenu({ kind: 'drawings', ...at, ids: selectedIds() });
      return;
    }
    if (row.drawing.hidden) selectOnly(row);
    else {
      setOnly(null);
      select([row.id]);
    }
    setMenu({ kind: 'drawings', ...at, ids: [row.id] });
  };

  const onPointerDown = (row: TreeRow, event: ReactPointerEvent) => {
    dragged.current = false;
    if (event.button !== 0 || row.kind !== 'drawing' || renaming !== null) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const list = listRef.current;
    const element = event.currentTarget as HTMLElement;
    if (!list) return;
    const start = { x: event.clientX, y: event.clientY };
    const box = element.getBoundingClientRect();
    const shown = rows;
    const ids = selection.includes(row.id)
      ? drawings
          .filter((drawing) => selection.includes(drawing.id) && drawing.pane === row.pane)
          .map((drawing) => drawing.id)
      : [row.id];
    let moving = false;
    let latest: Drag | null = null;
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      if (!moving) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        moving = true;
        window.clearTimeout(renameTimer.current);
        // The row dragged is selected, as TradingView's is.
        if (!selection.includes(row.id)) {
          if (row.drawing.hidden) selectOnly(row);
          else {
            setOnly(null);
            select([row.id]);
          }
        }
      }
      const area = list.getBoundingClientRect();
      if (moveEvent.clientY < area.top + SCROLL_EDGE_PX) list.scrollTop -= 8;
      else if (moveEvent.clientY > area.bottom - SCROLL_EDGE_PX) list.scrollTop += 8;
      const gap = gapAt(list, moveEvent.clientY, shown.length);
      latest = {
        ids,
        row,
        left: box.left + dx,
        top: box.top + dy,
        width: box.width,
        gap,
        place: dropPlace(shown, gap, row.pane),
      };
      setDrag(latest);
    };
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onEscape, true);
      stopDrag.current = null;
      if (!moving) return;
      dragged.current = true;
      setDrag(null);
      if (drop && latest?.place) drawingStore.place(latest.ids, latest.place);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const onEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape' || !moving) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onEscape, true);
    stopDrag.current = cancel;
  };

  const finishRename = (id: string, name: string | null) => {
    setRenaming(null);
    if (name !== null) drawingStore.rename(id, name);
  };

  const menuItems = (): PopupMenuEntry[] => {
    if (!menu) return [];
    if (menu.kind === 'drawings') {
      const chosen = drawings.filter((drawing) => menu.ids.includes(drawing.id));
      const first = chosen[0];
      return drawingEntries({
        chosen,
        prefs,
        templates,
        resolution,
        onSelect: select,
        onSettings: () =>
          objectTreeStore.ask({ kind: 'drawing-settings', ids: chosen.map((d) => d.id) }),
        onRename: first ? () => setRenaming(first.id) : undefined,
      });
    }
    const indicator = indicatorList.find((item) => item.id === menu.id);
    if (!indicator) return [];
    return [
      ...(hasSource(indicator)
        ? [
            { label: 'Source code…', onSelect: () => pineStore.openIndicator(indicator) },
            'separator' as const,
          ]
        : []),
      {
        label: indicator.hidden ? 'Show' : 'Hide',
        icon: indicator.hidden ? <ShowIcon /> : <HideIcon />,
        onSelect: () => indicatorStore.setHidden(indicator.id, !indicator.hidden),
      },
      {
        label: 'Remove',
        icon: <TrashIcon />,
        onSelect: () => indicatorStore.remove(indicator.id),
      },
      'separator',
      {
        label: 'Settings…',
        icon: <GearIcon />,
        onSelect: () => objectTreeStore.ask({ kind: 'indicator-settings', id: indicator.id }),
      },
    ];
  };
  const items = menuItems();
  // Its drawings gone while it's open (Delete, another tab): it closes, not to come back on undo.
  const menuEmpty = menu !== null && items.length === 0;
  useEffect(() => {
    if (menuEmpty) setMenu(null);
  }, [menuEmpty]);

  const dim = held && selection.length > 0;
  return (
    <section className={styles.panel} aria-label="Object tree">
      <div className={styles.tabs} role="tablist" aria-label="Object tree and data window">
        <button type="button" role="tab" className={styles.tab} aria-selected="true">
          Object tree
        </button>
        <button type="button" role="tab" className={styles.tab} aria-selected="false" disabled>
          Data window
        </button>
      </div>
      <div className={styles.toolbar} role="toolbar" aria-label="Object tree tools">
        <button
          type="button"
          className={styles.tool}
          aria-label="Clone"
          title="Clone"
          disabled={selection.length === 0}
          onClick={() => select(drawingStore.clone(selectedIds()))}
        >
          <CloneIcon />
        </button>
      </div>
      <div
        ref={listRef}
        className={styles.list}
        role="tree"
        aria-label="Objects"
        aria-multiselectable="true"
        data-dragging={drag ? '' : undefined}
      >
        {rows.map((row, index) => {
          const hidden =
            row.kind !== 'symbol' && (row.kind === 'drawing' ? row.drawing.hidden : row.hidden);
          const drop =
            drag?.place && drag.gap === index
              ? 'before'
              : drag?.place && index === rows.length - 1 && drag.gap === rows.length
                ? 'after'
                : undefined;
          return (
            <div
              key={row.key}
              className={styles.row}
              role="treeitem"
              tabIndex={-1}
              aria-level={1}
              aria-selected={isSelected(row)}
              data-row={row.key}
              data-kind={row.kind}
              data-hidden={hidden || undefined}
              data-dim={(dim && !isShownDrawing(row)) || undefined}
              data-drop={drop}
              onClick={(event) => onClick(row, event)}
              onDoubleClick={() => onDoubleClick(row)}
              onContextMenu={(event) => onContextMenu(row, event)}
              onPointerDown={(event) => onPointerDown(row, event)}
              onKeyDown={(event) => {
                // F2 renames a drawing (ours, as other trees do; provisional §11).
                if (event.key === 'F2' && row.kind === 'drawing') setRenaming(row.id);
                // Delete for a hidden drawing selected here alone: the chart's Delete can't
                // reach it (a locked one stays, as with Delete).
                if (
                  (event.key === 'Delete' || event.key === 'Backspace') &&
                  row.kind === 'drawing' &&
                  only === row.key
                ) {
                  event.preventDefault();
                  drawingStore.removeUnlocked([row.id]);
                }
              }}
            >
              <span className={styles.icon}>
                <RowIcon row={row} />
              </span>
              {row.kind === 'drawing' && renaming === row.id ? (
                <RenameField initial={row.label} onDone={(name) => finishRename(row.id, name)} />
              ) : (
                <span className={styles.label}>{row.label}</span>
              )}
              {row.kind !== 'symbol' && <RowButtons row={row} lockAll={prefs.lockAll} />}
            </div>
          );
        })}
      </div>
      {drag && (
        <div
          className={styles.ghost}
          style={{ left: drag.left, top: drag.top, width: drag.width }}
          aria-hidden
        >
          <span className={styles.icon}>
            <RowIcon row={drag.row} />
          </span>
          <span className={styles.label}>
            {drag.ids.length > 1 ? `${drag.row.label} +${drag.ids.length - 1}` : drag.row.label}
          </span>
        </div>
      )}
      {menu && items.length > 0 && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label="Object tree"
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

/** The gap before row `gap` a pointer at `y` is nearest: the rows' middles divide them. */
function gapAt(list: HTMLElement, y: number, count: number): number {
  const elements = list.querySelectorAll<HTMLElement>('[data-row]');
  for (let i = 0; i < elements.length; i++) {
    const box = (elements[i] as HTMLElement).getBoundingClientRect();
    if (y < box.top + box.height / 2) return i;
  }
  return count;
}

function RowIcon({ row }: { row: TreeRow }) {
  if (row.kind === 'symbol') return <SeriesIcon />;
  if (row.kind === 'indicator') return <IndicatorRowIcon />;
  const Icon = TOOL_ICONS[row.drawing.tool];
  return <Icon />;
}

/**
 * A row's buttons, at its right in fixed places: a drawing's padlock, then the eye and the trash
 * (an indicator's place for a padlock stays empty, as TradingView's). They show under the
 * pointer; a locked drawing's padlock and a hidden row's crossed eye always show (ours,
 * provisional §11).
 */
function RowButtons({
  row,
  lockAll,
}: {
  row: Exclude<TreeRow, { kind: 'symbol' }>;
  lockAll: boolean;
}) {
  const drawing = row.kind === 'drawing' ? row.drawing : null;
  const hidden = drawing ? drawing.hidden : row.kind === 'indicator' && row.hidden;
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only keeps its buttons' presses from the row
    <span className={styles.buttons} onPointerDown={stop} onDoubleClick={stop}>
      {drawing ? (
        <button
          type="button"
          className={styles.button}
          data-on={drawing.locked || undefined}
          aria-label={drawing.locked ? 'Unlock' : 'Lock'}
          title={drawing.locked ? 'Unlock' : 'Lock'}
          onClick={(event) => {
            stop(event);
            drawingStore.update(drawing.id, (d) => ({ ...d, locked: !d.locked }));
          }}
        >
          <RowPadlockIcon locked={drawing.locked} />
        </button>
      ) : (
        <span className={styles.slot} />
      )}
      <button
        type="button"
        className={styles.button}
        data-on={hidden || undefined}
        aria-label={hidden ? 'Show' : 'Hide'}
        title={hidden ? 'Show' : 'Hide'}
        onClick={(event) => {
          stop(event);
          if (drawing) drawingStore.setHidden([drawing.id], !hidden);
          else indicatorStore.setHidden(row.id, !hidden);
        }}
      >
        {hidden ? <EyeCrossedIcon /> : <EyeIcon />}
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Remove"
        title="Remove"
        // A locked drawing stays, as with Remove and the Delete key (TradingView's lock).
        disabled={drawing !== null && (drawing.locked || lockAll)}
        onClick={(event) => {
          stop(event);
          if (drawing) drawingStore.removeUnlocked([drawing.id]);
          else indicatorStore.remove(row.id);
        }}
      >
        <RowTrashIcon />
      </button>
    </span>
  );
}

/** A drawing's name, edited in its row: Enter or leaving keeps it, Escape doesn't. */
function RenameField({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    <input
      ref={input}
      className={styles.rename}
      aria-label="Name"
      value={value}
      maxLength={MAX_DRAWING_NAME}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
      onClick={stop}
      onPointerDown={stop}
      onDoubleClick={stop}
    />
  );
}
