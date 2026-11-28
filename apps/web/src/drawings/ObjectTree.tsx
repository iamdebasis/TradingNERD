import {
  type Drawing,
  type GroupItem,
  groupMembers,
  groupState,
  MAX_DRAWING_NAME,
  type Resolution,
  topItems,
  visibleOn,
} from '@tradingnerd/core';
import { indicatorTitle, type SymbolContext } from '@tradingnerd/indicators';
import {
  type CSSProperties,
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
import { drawingEntries, groupEntries } from './DrawingMenu';
import { drawingStore, useDrawings } from './drawingStore';
import {
  CloneIcon,
  FolderIcon,
  FolderPlusIcon,
  FoldIcon,
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
import {
  type GroupRow,
  gapDrop,
  headerDrop,
  type ItemRow,
  isItemRow,
  itemOf,
  type TreeDrag,
  type TreeDrop,
  type TreeIndicator,
  type TreeRow,
  treeRows,
} from './objectTreeModel';
import { objectTreeStore, useObjectTree } from './objectTreeStore';
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
/** Each level of groups indents the rows this much (TradingView's blog image, October 2026). */
export const LEVEL_INDENT_PX = 36;

type Menu =
  | { kind: 'items'; x: number; y: number; items: readonly GroupItem[] }
  | { kind: 'group'; x: number; y: number; id: string }
  | { kind: 'indicator'; x: number; y: number; id: string };

interface Drag {
  items: readonly GroupItem[];
  row: ItemRow;
  /** Where the dragged row's copy is drawn, following the pointer. */
  left: number;
  top: number;
  width: number;
  drop: TreeDrop | null;
}

const itemKey = (item: GroupItem) => `${item.kind === 'group' ? 'g' : 'd'}:${item.id}`;
const sameItem = (a: GroupItem, b: GroupItem) => a.kind === b.kind && a.id === b.id;

/** A hidden drawing: the chart can't select it, so the tree selects it alone. */
const isHiddenDrawing = (row: TreeRow) => row.kind === 'drawing' && row.drawing.hidden;

/** The groups around a row (a group's own left out). */
const groupsAround = (row: ItemRow) => (row.kind === 'group' ? row.path.slice(0, -1) : row.path);

/**
 * TradingView's Object tree (docs/SPEC.md §5.27, D3c, D3c2), in the right panel: its "Object
 * tree" and "Data window" switch (the Data window comes later), a toolbar with Create a group of
 * drawings and Clone (Manage layout drawings comes with D3c3, Move to with I3), then the chart's
 * objects in paint order with the top row at the back (TradingView's own GIF, measured: §4.27):
 * the symbol's row in bold, its indicators and drawings, and the groups of drawings, each folding
 * at its ⌄. Selecting rows selects the drawings on the chart, and the chart's selection shows
 * here; a group picked selects every drawing in it, its row in the selected blue and the rows
 * inside it lighter (TradingView's blog images, 2021 and 2026). Under the pointer a row offers
 * its padlock, eye (Hide or Show) and trash (Remove); a drawing hidden on the chart's interval by
 * its Visibility tab shows an orange crossed eye. Dragging rows changes their visual order, across
 * the bars too, into groups and out of them; the selected row clicked again is renamed; a double
 * click opens the settings; a right-click opens the tree's menu.
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
  /** The chart's interval, for Visibility on intervals and the rows hidden on it. */
  resolution: Resolution | null;
}) {
  const { drawings, selection, picked, prefs } = useDrawings();
  const { folded } = useObjectTree();
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
    () => treeRows(drawings, indicators, symbolLabel, folded),
    [drawings, indicators, symbolLabel, folded],
  );
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  /**
   * A row selected in the tree alone, its key: the symbol's, an indicator's or a hidden
   * drawing's, which the chart can't select.
   */
  const [only, setOnly] = useState<string | null>(null);
  /** The row a Shift-click's range starts from. */
  const anchor = useRef<string | null>(null);
  /** The row being renamed: its key. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Ctrl or ⌘ held with something selected: the rows that can't join it dim (TradingView's). */
  const [held, setHeld] = useState(false);
  const renameTimer = useRef(0);
  /** A drag just ended: the click it ends with isn't a click on its row. */
  const dragged = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);

  // The chart's selection and the tree's own one row are one or the other.
  useEffect(() => {
    if (selection.length > 0 || picked.length > 0) setOnly(null);
  }, [selection, picked]);
  useEffect(() => {
    if (only !== null && !rows.some((row) => row.key === only)) setOnly(null);
  }, [only, rows]);
  // A rename waits for its row to stay selected: another selection meanwhile drops it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of selection is the cue
  useEffect(() => () => window.clearTimeout(renameTimer.current), [selection, picked, only]);

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
  /**
   * Picks drawings and groups: the chart selects every drawing of them it can show, the groups
   * staying picked while it does (D3c2).
   */
  const pick = (items: readonly GroupItem[]) => {
    const current = drawingStore.get().drawings;
    const tops = topItems(current, items);
    const groups = tops.filter((item) => item.kind === 'group').map((item) => item.id);
    const ids = drawingStore
      .itemDrawings(tops)
      .filter((drawing) => !drawing.hidden)
      .map((drawing) => drawing.id);
    setOnly(null);
    drawingStore.pick(groups, ids);
    select(ids);
  };
  const selectOnly = (row: TreeRow) => {
    setOnly(row.key);
    drawingStore.pick([], []);
    if (selection.length > 0) select([]);
  };
  const insidePicked = (row: ItemRow) => groupsAround(row).some((id) => pickedSet.has(id));
  /** A row selected itself, inside a group picked, or neither. */
  const rowState = (row: TreeRow): 'self' | 'inside' | null => {
    if (row.key === only) return 'self';
    if (!isItemRow(row)) return null;
    if (insidePicked(row)) return 'inside';
    if (row.kind === 'group') return pickedSet.has(row.id) ? 'self' : null;
    return selectedSet.has(row.id) ? 'self' : null;
  };
  /** What's picked now: the groups and the drawings outside them, or the hidden drawing alone. */
  const pickedNow = (): GroupItem[] => {
    const items = drawingStore.pickedItems();
    if (items.length > 0 || only === null || !only.startsWith('d:')) return items;
    return [{ kind: 'drawing', id: only.slice(2) }];
  };
  const offInterval = (drawing: Drawing) =>
    resolution !== null && !visibleOn(drawing.visibility, resolution);

  const renameLater = (key: string) => {
    window.clearTimeout(renameTimer.current);
    renameTimer.current = window.setTimeout(() => setRenaming(key), RENAME_DELAY_MS);
  };

  /** "Create a group of drawings": the new group picked, open. */
  const makeGroup = (items: readonly GroupItem[]) => {
    const id = drawingStore.group(items);
    if (!id) return;
    objectTreeStore.setFolded(id, false);
    pick([{ kind: 'group', id }]);
  };

  /** The rows from the anchor to this one, as items: a group's row stands for what's in it. */
  const rangeTo = (row: ItemRow): GroupItem[] | null => {
    const from = anchor.current === null ? -1 : rows.findIndex((r) => r.key === anchor.current);
    if (from < 0) return null;
    const to = rows.indexOf(row);
    return rows
      .slice(Math.min(from, to), Math.max(from, to) + 1)
      .filter((r): r is ItemRow => isItemRow(r) && !isHiddenDrawing(r))
      .map(itemOf);
  };

  const onClick = (row: TreeRow, event: ReactMouseEvent) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    // A double click's second click: the double click opens the settings.
    if (event.detail > 1) return;
    if (isItemRow(row) && !isHiddenDrawing(row)) {
      const item = itemOf(row);
      const current = drawingStore.pickedItems();
      if (event.ctrlKey || event.metaKey) {
        anchor.current = row.key;
        if (current.some((other) => sameItem(other, item))) {
          pick(current.filter((other) => !sameItem(other, item)));
          return;
        }
        // Inside a group picked: the group gives way to its other drawings.
        const outer = groupsAround(row).find((id) => pickedSet.has(id));
        if (outer) {
          const leaving = new Set(drawingStore.itemDrawings([item]).map((drawing) => drawing.id));
          pick([
            ...current.filter((other) => !(other.kind === 'group' && other.id === outer)),
            ...groupMembers(drawings, outer)
              .filter((drawing) => !leaving.has(drawing.id))
              .map((drawing): GroupItem => ({ kind: 'drawing', id: drawing.id })),
          ]);
          return;
        }
        pick([...current, item]);
        return;
      }
      const range = event.shiftKey ? rangeTo(row) : null;
      if (range) {
        pick(range);
        return;
      }
      anchor.current = row.key;
      const alone = current.length === 1 && current[0] !== undefined && sameItem(current[0], item);
      if (alone && rowState(row) === 'self') {
        renameLater(row.key);
        return;
      }
      pick([item]);
      return;
    }
    anchor.current = row.key;
    if (row.kind === 'drawing' && only === row.key) {
      renameLater(row.key);
      return;
    }
    selectOnly(row);
  };

  const onDoubleClick = (row: TreeRow) => {
    window.clearTimeout(renameTimer.current);
    if (row.kind === 'drawing') objectTreeStore.ask({ kind: 'drawing-settings', ids: [row.id] });
    else if (row.kind === 'group') {
      objectTreeStore.ask({
        kind: 'drawing-settings',
        ids: row.members.map((drawing) => drawing.id),
        group: row.id,
      });
    } else if (row.kind === 'indicator') {
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
    const current = pickedNow();
    if (rowState(row) === 'self' && current.length > 1) {
      setMenu({ kind: 'items', ...at, items: current });
      return;
    }
    const item = itemOf(row);
    // Picked on the chart already, or to be: a drawing selected in the tree alone while it was
    // hidden is picked again now it shows.
    const stored = drawingStore.pickedItems();
    if (isHiddenDrawing(row)) selectOnly(row);
    else if (!(stored.length === 1 && stored[0] && sameItem(stored[0], item))) pick([item]);
    setMenu(
      row.kind === 'group'
        ? { kind: 'group', ...at, id: row.id }
        : { kind: 'items', ...at, items: [item] },
    );
  };

  const onPointerDown = (row: TreeRow, event: ReactPointerEvent) => {
    dragged.current = false;
    if (event.button !== 0 || !isItemRow(row) || renaming !== null) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const list = listRef.current;
    const element = event.currentTarget as HTMLElement;
    if (!list) return;
    const start = { x: event.clientX, y: event.clientY };
    const box = element.getBoundingClientRect();
    const shown = rows;
    const chosen = rowState(row) !== null;
    const paneOf = (item: GroupItem) => drawingStore.itemDrawings([item])[0]?.pane;
    const items = (chosen ? pickedNow() : [itemOf(row)]).filter(
      (item) => paneOf(item) === row.pane,
    );
    const info: TreeDrag = {
      pane: row.pane,
      items: new Set(items.map(itemKey)),
      groups: new Set(items.filter((item) => item.kind === 'group').map((item) => item.id)),
    };
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
        if (!chosen) {
          if (isHiddenDrawing(row)) selectOnly(row);
          else pick([itemOf(row)]);
        }
      }
      const area = list.getBoundingClientRect();
      if (moveEvent.clientY < area.top + SCROLL_EDGE_PX) list.scrollTop -= 8;
      else if (moveEvent.clientY > area.bottom - SCROLL_EDGE_PX) list.scrollTop += 8;
      latest = {
        items,
        row,
        left: box.left + dx,
        top: box.top + dy,
        width: box.width,
        drop: dropAt(list, shown, moveEvent.clientX - area.left, moveEvent.clientY, info),
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
      if (drop && latest?.drop) drawingStore.moveItems(latest.items, latest.drop.target);
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

  const finishRename = (row: ItemRow, name: string | null) => {
    setRenaming(null);
    if (name === null) return;
    if (row.kind === 'group') drawingStore.renameGroup(row.id, name);
    else drawingStore.rename(row.id, name);
  };

  const settingsOf = (items: readonly GroupItem[]) => {
    const group = items.length === 1 && items[0]?.kind === 'group' ? items[0].id : null;
    objectTreeStore.ask({
      kind: 'drawing-settings',
      ids: drawingStore.itemDrawings(items).map((drawing) => drawing.id),
      group,
    });
  };

  const menuItems = (): PopupMenuEntry[] => {
    if (!menu) return [];
    if (menu.kind === 'items') {
      const tops = topItems(drawings, menu.items);
      const chosen = drawingStore.itemDrawings(tops);
      const only1 = tops.length === 1 ? tops[0] : undefined;
      return drawingEntries({
        chosen,
        items: tops,
        prefs,
        templates,
        resolution,
        onSelect: (ids) => pick(ids.map((id): GroupItem => ({ kind: 'drawing', id }))),
        onSettings: () => settingsOf(tops),
        onRename: only1 ? () => setRenaming(itemKey(only1)) : undefined,
        onGroup: () => makeGroup(tops),
      });
    }
    if (menu.kind === 'group') {
      const members = groupMembers(drawings, menu.id);
      if (members.length === 0) return [];
      const { id } = menu;
      return groupEntries({
        members,
        prefs,
        onRename: () => setRenaming(`g:${id}`),
        onLock: (locked) => drawingStore.setGroupLocked(id, locked),
        onHide: (hidden) => drawingStore.setGroupHidden(id, hidden),
        onRemove: () => drawingStore.removeItems([{ kind: 'group', id }]),
        onSettings: () => settingsOf([{ kind: 'group', id }]),
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

  const toolbarItems = pickedNow();
  const dim = held && (selection.length > 0 || picked.length > 0);
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
          aria-label="Create a group of drawings"
          title="Create a group of drawings"
          disabled={toolbarItems.length === 0}
          onClick={() => makeGroup(toolbarItems)}
        >
          <FolderPlusIcon />
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="Clone"
          title="Clone"
          // A group isn't cloned: TradingView's Clone greys out with one picked (its blog images).
          disabled={selection.length === 0 || picked.length > 0}
          onClick={() =>
            pick(
              drawingStore
                .clone(drawings.filter((d) => selectedSet.has(d.id)).map((d) => d.id))
                .map((id): GroupItem => ({ kind: 'drawing', id })),
            )
          }
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
          const state = rowState(row);
          const hidden =
            row.kind === 'drawing'
              ? row.drawing.hidden
              : row.kind === 'group'
                ? groupState(row.members).visibility === 'invisible'
                : row.kind === 'indicator' && row.hidden;
          const off =
            row.kind === 'drawing'
              ? offInterval(row.drawing)
              : row.kind === 'group' && row.members.every(offInterval);
          const drop = drag?.drop;
          const line =
            drop?.kind === 'gap' && drop.gap === index
              ? 'before'
              : drop?.kind === 'gap' && index === rows.length - 1 && drop.gap === rows.length
                ? 'after'
                : undefined;
          const style = {
            '--depth': row.depth,
            '--drop-depth': drop?.kind === 'gap' ? drop.depth : 0,
          } as CSSProperties;
          return (
            <div
              key={row.key}
              className={styles.row}
              style={style}
              role="treeitem"
              tabIndex={-1}
              aria-level={row.depth + 1}
              aria-selected={state !== null}
              aria-expanded={row.kind === 'group' ? !row.folded : undefined}
              data-row={row.key}
              data-kind={row.kind}
              data-selected={state ?? undefined}
              data-hidden={hidden || undefined}
              data-off={(off && !hidden) || undefined}
              data-dim={(dim && !(isItemRow(row) && !isHiddenDrawing(row))) || undefined}
              data-drop={line}
              data-into={(drop?.kind === 'header' && drop.row === row.key) || undefined}
              onClick={(event) => onClick(row, event)}
              onDoubleClick={() => onDoubleClick(row)}
              onContextMenu={(event) => onContextMenu(row, event)}
              onPointerDown={(event) => onPointerDown(row, event)}
              onKeyDown={(event) => {
                // F2 renames a drawing or a group (ours, as other trees do; provisional §11).
                if (event.key === 'F2' && isItemRow(row)) setRenaming(row.key);
                if (event.key !== 'Delete' && event.key !== 'Backspace') return;
                // A group picked goes whole by the chart's own Delete, which this reaches too.
                // A hidden drawing selected here alone: the chart's Delete can't reach it (a
                // locked one stays, as with Delete).
                if (row.kind === 'drawing' && only === row.key) {
                  event.preventDefault();
                  drawingStore.removeUnlocked([row.id]);
                }
              }}
            >
              {row.kind === 'group' && renaming !== row.key && <FoldButton row={row} />}
              {isItemRow(row) && renaming === row.key ? (
                <RenameField initial={row.label} onDone={(name) => finishRename(row, name)} />
              ) : (
                <>
                  <span className={styles.icon}>
                    <RowIcon row={row} />
                  </span>
                  <span className={styles.label}>{row.label}</span>
                  {row.kind !== 'symbol' && (
                    <RowButtons
                      row={row}
                      lockAll={prefs.lockAll}
                      removeLocked={prefs.removeLocked}
                      off={off}
                    />
                  )}
                </>
              )}
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
            {drag.items.length > 1 ? `${drag.row.label} +${drag.items.length - 1}` : drag.row.label}
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

/**
 * Where a drag over the list would drop: onto a group's row, in its middle half (into the group),
 * else in the gap the pointer is nearest, as deep as its distance from the left says.
 */
function dropAt(
  list: HTMLElement,
  rows: readonly TreeRow[],
  x: number,
  y: number,
  drag: TreeDrag,
): TreeDrop | null {
  const elements = list.querySelectorAll<HTMLElement>('[data-row]');
  let gap = rows.length;
  for (let i = 0; i < elements.length; i++) {
    const box = (elements[i] as HTMLElement).getBoundingClientRect();
    const row = rows[i];
    if (y >= box.top && y < box.bottom && row?.kind === 'group') {
      const quarter = box.height / 4;
      if (y >= box.top + quarter && y < box.bottom - quarter) {
        const into = headerDrop(row, drag);
        if (into) return into;
      }
    }
    if (y < box.top + box.height / 2) {
      gap = i;
      break;
    }
  }
  const wanted = Math.max(0, Math.floor((x - 4) / LEVEL_INDENT_PX));
  return gapDrop(rows, gap, wanted, drag);
}

/** A group row's ⌄ or ›: folds it, or opens it (kept in this browser). */
function FoldButton({ row }: { row: GroupRow }) {
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    <button
      type="button"
      className={styles.fold}
      aria-label={row.folded ? 'Expand group' : 'Collapse group'}
      onPointerDown={stop}
      onDoubleClick={stop}
      onClick={(event) => {
        stop(event);
        objectTreeStore.setFolded(row.id, !row.folded);
      }}
    >
      <FoldIcon open={!row.folded} />
    </button>
  );
}

function RowIcon({ row }: { row: TreeRow }) {
  if (row.kind === 'symbol') return <SeriesIcon />;
  if (row.kind === 'indicator') return <IndicatorRowIcon />;
  if (row.kind === 'group') return <FolderIcon />;
  const Icon = TOOL_ICONS[row.drawing.tool];
  return <Icon />;
}

/**
 * A row's buttons, at its right in fixed places: a drawing's or a group's padlock, then the eye
 * and the trash (an indicator's place for a padlock stays empty, as TradingView's). They show
 * under the pointer; a locked drawing's padlock and a hidden row's crossed eye always show (ours,
 * provisional §11), and so does the orange crossed eye of a drawing hidden on this interval by
 * its Visibility tab (TradingView's Help Center GIFs, 43000660419, and blog GIFs, December 2021;
 * a group's when every drawing in it is). A group's padlock is shut only when every drawing in it
 * is locked, its eye open unless every one is hidden (TradingView's 2019 GIF: a partly hidden
 * group's eye is open; a click hides them all): partial states, provisional §11.
 */
function RowButtons({
  row,
  lockAll,
  removeLocked,
  off,
}: {
  row: Exclude<TreeRow, { kind: 'symbol' }>;
  lockAll: boolean;
  removeLocked: boolean;
  off: boolean;
}) {
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  let locked: boolean | null = null;
  let hidden: boolean;
  let removable: boolean;
  let onLock = () => {};
  let onEye: () => void;
  let onRemove: () => void;
  if (row.kind === 'drawing') {
    const { drawing } = row;
    locked = drawing.locked;
    hidden = drawing.hidden;
    // A locked drawing stays, as with Remove and the Delete key (TradingView's lock).
    removable = !drawing.locked && !lockAll;
    onLock = () => drawingStore.update(drawing.id, (d) => ({ ...d, locked: !d.locked }));
    onEye = () => drawingStore.setHidden([drawing.id], !hidden);
    onRemove = () => drawingStore.removeUnlocked([drawing.id]);
  } else if (row.kind === 'group') {
    const state = groupState(row.members);
    const shut = state.lock === 'locked';
    locked = shut;
    hidden = state.visibility === 'invisible';
    removable =
      (removeLocked || !lockAll) && row.members.some((drawing) => removeLocked || !drawing.locked);
    onLock = () => drawingStore.setGroupLocked(row.id, !shut);
    onEye = () => drawingStore.setGroupHidden(row.id, !hidden);
    onRemove = () => drawingStore.removeItems([{ kind: 'group', id: row.id }]);
  } else {
    hidden = row.hidden;
    removable = true;
    onEye = () => indicatorStore.setHidden(row.id, !hidden);
    onRemove = () => indicatorStore.remove(row.id);
  }
  const orange = off && !hidden;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only keeps its buttons' presses from the row
    <span className={styles.buttons} onPointerDown={stop} onDoubleClick={stop}>
      {locked === null ? (
        <span className={styles.slot} />
      ) : (
        <button
          type="button"
          className={styles.button}
          data-on={locked || undefined}
          aria-label={locked ? 'Unlock' : 'Lock'}
          title={locked ? 'Unlock' : 'Lock'}
          onClick={(event) => {
            stop(event);
            onLock();
          }}
        >
          <RowPadlockIcon locked={locked} />
        </button>
      )}
      <button
        type="button"
        className={styles.button}
        data-on={hidden || orange || undefined}
        data-interval={orange || undefined}
        aria-label={hidden ? 'Show' : 'Hide'}
        title={hidden ? 'Show' : 'Hide'}
        onClick={(event) => {
          stop(event);
          onEye();
        }}
      >
        {hidden || orange ? <EyeCrossedIcon /> : <EyeIcon />}
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Remove"
        title="Remove"
        disabled={!removable}
        onClick={(event) => {
          stop(event);
          onRemove();
        }}
      >
        <RowTrashIcon />
      </button>
    </span>
  );
}

/**
 * A drawing's or a group's name, edited in its row as TradingView's 2020 GIF shows it: a field
 * over the row's icon and name to its end, the name chosen; Enter or leaving it keeps the name,
 * Escape doesn't.
 */
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
