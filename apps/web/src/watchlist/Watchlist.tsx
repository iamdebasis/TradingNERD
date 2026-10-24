import {
  fileSymbolCount,
  formatWatchlistFile,
  parseWatchlistFile,
  type SymbolId,
  uniqueListName,
  type Watchlist as WatchlistDoc,
  type WatchlistSection,
  watchlistFileName,
  watchlistFromFile,
} from '@tradingnerd/core';
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, marketApi, watchlistsApi } from '../data/api';
import type { QuoteSource } from '../data/GatewayConnection';
import { isEditable } from '../lib/dom';
import { SymbolSearchDialog } from '../search/SymbolSearchDialog';
import { useStockKeys } from '../stocks/stockKeys';
import { ChevronDownIcon } from '../toolbar/icons';
import { FlagDots } from './FlagDots';
import { FlagPalette } from './FlagPalette';
import {
  flagOf,
  pickFlag,
  pickFlags,
  sharedFlag,
  toggleFlag,
  toggleFlags,
  unflagAll,
} from './flagEdits';
import {
  AddIcon,
  AddSectionIcon,
  AddSymbolIcon,
  AdvancedViewIcon,
  FlagIcon,
  MoreIcon,
  RemoveIcon,
  SectionCaret,
} from './icons';
import { ConfirmDialog, ListNameDialog, OpenListDialog } from './ListDialogs';
import { ListMenu } from './ListMenu';
import {
  addSection,
  addSymbol,
  addTopSection,
  allSymbols,
  dropLine,
  insertSymbol,
  type ListItem,
  moveSection,
  moveSectionHeader,
  moveSymbols,
  neighbor,
  nextItem,
  rangeOf,
  removeSection,
  removeSymbols,
  renameSection,
  sameItem,
  toggleSection,
  visibleSymbols,
} from './model';
import { PopupMenu, type PopupMenuEntry, type PopupMenuItem } from './PopupMenu';
import { QuoteBoard } from './QuoteBoard';
import { SymbolDirectory } from './SymbolDirectory';
import { saveTextFile } from './saveTextFile';
import { useFlags } from './useFlags';
import { useWatchlist } from './useWatchlist';
import { useWatchlists } from './useWatchlists';
import styles from './Watchlist.module.css';
import { type ClickKeys, WatchlistRow } from './WatchlistRow';

export interface WatchlistProps {
  /** The chart's symbol, highlighted in the list. */
  symbol: SymbolId;
  /** A row was chosen: show it on the chart. */
  onChoose(symbol: SymbolId): void;
  quotes: QuoteSource;
  /** Extra items for the ⋯ menu, e.g. coin logo settings. */
  moreItems?: readonly PopupMenuItem[];
  /** A line under the ⋯ menu's items, e.g. a data credit. */
  moreNote?: string;
}

/**
 * What's being dragged: rows (one, or the selection), or a section's header (open, it moves
 * alone; folded, whole).
 */
type Dragged = { symbols: SymbolId[] } | { section: string; folded: boolean };

/** Where a drop lands, and the row or header its line is drawn on. */
type DropTarget = { line: { item: ListItem; edge: 'before' | 'after' } } & (
  | {
      kind: 'symbol';
      sectionId: string;
      /** Index in the section, counted without the dragged symbol. */
      index: number;
    }
  /** An open section's header: above this row or header; null is the end. */
  | { kind: 'header'; before: ListItem | null }
  /** A folded section: above this section; null is the end. */
  | { kind: 'section'; before: string | null }
);

/** The pointer rests this long on a row's flag before its colors show. */
export const FLAG_HOVER_MS = 300;
/** And may leave the flag (for the colors, say) this long before they go. */
export const FLAG_LEAVE_MS = 200;
/** TradingView's shortcut for "Flag/Unflag", as its menu shows it on a Mac. */
const FLAG_SHORTCUT = '⌥ ↵';
/** How long a note under the list (an upload's summary) stays. */
export const NOTICE_MS = 8_000;
/** No watchlist file is this big (1,000 symbols are about 20 KB). */
const MAX_FILE_BYTES = 1_000_000;
/** The overlay of a drag of several rows lists this many tickers at most, then counts the rest. */
export const DRAG_OVERLAY_ROWS = 10;
/** Its rows' height, as measured. */
const DRAG_OVERLAY_ROW_PX = 29;

/**
 * TradingView's overlay while several rows are dragged (measured from its screenshot): their
 * tickers in list order, built off-screen and handed to the browser as the drag image, with the
 * pointer where it grabbed its row; taken out of the page once the browser has it.
 */
function setDragOverlay(event: DragEvent, symbols: readonly SymbolId[]) {
  const overlay = document.createElement('div');
  overlay.className = styles.dragOverlay ?? '';
  const lines = symbols
    .slice(0, DRAG_OVERLAY_ROWS)
    .map((symbol) => symbol.slice(symbol.indexOf(':') + 1));
  const more = symbols.length - lines.length;
  const rows = lines.map((text) => [text, styles.dragOverlayRow]);
  if (more > 0) rows.push([`+${more} more`, `${styles.dragOverlayRow} ${styles.dragOverlayMore}`]);
  for (const [text, className] of rows) {
    const line = document.createElement('div');
    line.className = className ?? '';
    line.textContent = text ?? '';
    overlay.append(line);
  }
  document.body.append(overlay);
  const box = event.currentTarget.getBoundingClientRect();
  const x = Math.min(Math.max(event.clientX - box.left, 0), overlay.offsetWidth);
  const y = Math.min(Math.max(event.clientY - box.top, 0), DRAG_OVERLAY_ROW_PX);
  event.dataTransfer.setDragImage(overlay, x, y);
  setTimeout(() => overlay.remove(), 0);
}

type ListDialog =
  | { kind: 'create' | 'copy' | 'clear' | 'open' }
  | { kind: 'delete'; id: string; name: string };

/**
 * The right-hand watchlist (docs/reference/01-chart-layout.png): sections of symbols with
 * live Last, Chg and Chg%. Click or ↑/↓ shows a symbol on the chart; Delete or a row's remove
 * button removes it; rows drag to a new place; sections fold, a section's header drags (an open
 * one alone, a folded one with its symbols), and its trash deletes it but keeps its symbols.
 * Symbols carry TradingView's flags
 * (docs/reference/06-watchlist-flags.png, 07-watchlist-row-menu.png). The list's name opens
 * TradingView's list menu: several lists, uploaded from and downloaded to TradingView's .txt
 * (docs/SPEC.md §5.9). Every change is saved by the gateway: the lists in
 * data/watchlists.json, the flags in data/flags.json.
 */
export function Watchlist({ symbol, onChoose, quotes, moreItems = [], moreNote }: WatchlistProps) {
  const lists = useWatchlists();
  const activeId = lists.index?.activeId ?? null;
  const active = lists.index?.lists.find((item) => item.id === activeId) ?? null;
  const { list, edit } = useWatchlist(activeId);
  const { flags, editFlags } = useFlags();
  // A saved Alpaca key looks the stocks up and subscribes to them again.
  const { version: stockKeyVersion } = useStockKeys();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key starts over
  const directory = useMemo(() => new SymbolDirectory(marketApi), [stockKeyVersion]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key starts over
  const board = useMemo(() => new QuoteBoard(quotes), [quotes, stockKeyVersion]);
  const [selected, setSelected] = useState<SymbolId | null>(symbol);
  /**
   * The rows selected together, as TradingView's Shift and ⌘ (Ctrl) select them. A plain click,
   * the arrows and the chart's own symbol leave just the active row (`selected`).
   */
  const [selection, setSelection] = useState<ReadonlySet<SymbolId>>(() => new Set([symbol]));
  /** Where a Shift range starts: the row last clicked alone or with ⌘. */
  const anchor = useRef<SymbolId | null>(symbol);
  const [menu, setMenu] = useState<{ x: number; y: number; symbol: SymbolId | null } | null>(null);
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  /** Each section's element, for the edge nearer the pointer when a folded one is dragged. */
  const sectionBoxes = useRef(new Map<string, HTMLElement>());
  const [adding, setAdding] = useState(false);
  /** Where "Add symbol" from a row's menu puts the next symbol: after this one. */
  const [addAfter, setAddAfter] = useState<SymbolId | null>(null);
  /** The section whose name is being typed. */
  const [naming, setNaming] = useState<string | null>(null);
  /** The row whose flag colors show, and its flag button. */
  const [bubble, setBubble] = useState<{ symbol: SymbolId; button: HTMLElement } | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const added = useMemo(() => new Set(list ? allSymbols(list) : []), [list]);
  const rows = useRef(new Map<SymbolId, HTMLButtonElement>());
  const more = useRef<HTMLButtonElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [listMenu, setListMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<ListDialog | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /** Just this row selected (or none), as a plain click leaves it. */
  const selectOnly = useCallback((target: SymbolId | null) => {
    setSelected(target);
    setSelection(new Set(target ? [target] : []));
    anchor.current = target;
  }, []);

  useEffect(() => () => board.dispose(), [board]);
  useEffect(() => {
    if (list) board.setSymbols(list.sections.flatMap((section) => section.symbols));
  }, [board, list]);
  // The chart's symbol is the selected row.
  useEffect(() => selectOnly(symbol), [symbol, selectOnly]);
  // Rows selected together that go out of sight (removed, folded away, another list) leave it.
  useEffect(() => {
    if (!list) return;
    const shown = new Set(visibleSymbols(list));
    setSelection((current) =>
      current.size <= 1 || [...current].every((item) => shown.has(item))
        ? current
        : new Set([...current].filter((item) => shown.has(item))),
    );
  }, [list]);
  useEffect(() => () => clearTimeout(bubbleTimer.current), []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // ⇧W, TradingView's shortcut for "Open list…".
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'w' || !event.shiftKey) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      setDialog({ kind: 'open' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** A note under the list for a while (an upload's summary, a failure). */
  const notify = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  const failed = useCallback(
    (error: unknown) =>
      notify(error instanceof ApiError ? error.message : 'The gateway could not do that'),
    [notify],
  );

  // ⌥↵ (Alt+Enter), as in TradingView: flags or unflags the selected symbols.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || !event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const several = selectionRef.current;
      const active = selectedRef.current;
      const targets = several.size > 1 ? [...several] : active ? [active] : [];
      if (targets.length === 0) return;
      event.preventDefault();
      editFlags((current) => toggleFlags(current, targets));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editFlags]);

  const choose = useCallback(
    (next: SymbolId, focus = true) => {
      selectOnly(next);
      onChoose(next);
      const row = rows.current.get(next);
      if (focus) row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
    },
    [onChoose, selectOnly],
  );

  /** The row made active by ⌘ or Shift, which leave the chart as it is. */
  const activate = (target: SymbolId) => {
    setSelected(target);
    const row = rows.current.get(target);
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  };

  /**
   * A row clicked. Alone, it shows on the chart and is the only one selected; with ⌘ (Ctrl
   * elsewhere) it joins or leaves the selection; with Shift, every row shown from the last one
   * clicked to it is selected, across sections. Neither moves the chart.
   */
  const onRowClick = (target: SymbolId, keys: ClickKeys) => {
    if (!list) return;
    if (keys.range) {
      setSelection(new Set(rangeOf(list, anchor.current ?? selected ?? target, target)));
    } else if (keys.toggle) {
      const next = new Set(selection);
      if (!next.delete(target)) next.add(target);
      setSelection(next);
      anchor.current = target;
    } else {
      choose(target);
      return;
    }
    activate(target);
  };

  /**
   * Removes rows: the selection's, or one. If the active row goes, the row shown after them (else
   * before) is the active and selected one, focused when asked.
   */
  const removeRows = useCallback(
    (targets: readonly SymbolId[], focus = true) => {
      if (!list || targets.length === 0) return;
      const gone = new Set(targets);
      if (selected !== null && gone.has(selected)) {
        const shown = visibleSymbols(list);
        const last = Math.max(...targets.map((item) => shown.indexOf(item)));
        const next =
          shown.slice(last + 1).find((item) => !gone.has(item)) ??
          shown
            .slice(0, Math.max(last, 0))
            .reverse()
            .find((item) => !gone.has(item)) ??
          null;
        selectOnly(next);
        if (focus && next) rows.current.get(next)?.focus();
      } else {
        setSelection((current) => new Set([...current].filter((item) => !gone.has(item))));
      }
      edit((current) => removeSymbols(current, targets));
    },
    [edit, list, selected, selectOnly],
  );
  /** A row's remove button: the whole selection when the row is one of several, else the row. */
  const removeRow = (target: SymbolId) =>
    removeRows(selection.size > 1 && selection.has(target) ? [...selection] : [target], false);

  /**
   * The list's keys, as TradingView's: ↓ or Space and ↑ or Shift+Space switch the chart to the
   * next or previous symbol; Shift+↓/↑ select the next or previous one too; ⌘A (Ctrl+A) selects
   * every row shown; Escape goes back to just the chart's symbol; Delete or Backspace removes the
   * selected rows. Not while a section's name is typed, and ⌘↑/↓ stay the chart's zoom.
   */
  const onKeyDown = (event: KeyboardEvent) => {
    if (!list || event.altKey || isEditable(event.target)) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'a' && !event.shiftKey) {
        event.preventDefault();
        setSelection(new Set(visibleSymbols(list)));
      }
      return;
    }
    // Space is a row's own key; on a section's header it folds it.
    const onRow = event.target instanceof HTMLElement && event.target.dataset.symbol !== undefined;
    const space = event.key === ' ' && onRow;
    const step =
      event.key === 'ArrowDown' || (space && !event.shiftKey)
        ? 1
        : event.key === 'ArrowUp' || (space && event.shiftKey)
          ? -1
          : 0;
    if (step !== 0 && event.shiftKey && !space) {
      event.preventDefault();
      const next = neighbor(list, selected, step);
      if (!next) return;
      setSelection(new Set(rangeOf(list, anchor.current ?? selected ?? next, next)));
      activate(next);
    } else if (step !== 0) {
      event.preventDefault();
      const next = neighbor(list, selected, step);
      if (next && next !== selected) choose(next);
    } else if (event.key === 'Escape' && selection.size > 1) {
      event.preventDefault();
      selectOnly(symbol);
      rows.current.get(symbol)?.focus();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeRows(selection.size > 0 ? [...selection] : selected ? [selected] : []);
    }
  };

  // ---- flags: a click toggles; resting on a flag shows its colors ----
  const showColors = (target: SymbolId, button: HTMLElement | null) => {
    clearTimeout(bubbleTimer.current);
    if (button) {
      bubbleTimer.current = setTimeout(() => setBubble({ symbol: target, button }), FLAG_HOVER_MS);
    } else {
      bubbleTimer.current = setTimeout(() => setBubble(null), FLAG_LEAVE_MS);
    }
  };
  const keepColors = (over: boolean) => {
    clearTimeout(bubbleTimer.current);
    if (!over) bubbleTimer.current = setTimeout(() => setBubble(null), FLAG_LEAVE_MS);
  };
  const closeColors = useCallback(() => {
    clearTimeout(bubbleTimer.current);
    setBubble(null);
  }, []);

  // ---- sections ----
  const startSection = (above: SymbolId) => {
    let created = '';
    edit((current) => {
      const next = addSection(current, above);
      created = next.id;
      return next.list;
    });
    if (created) setNaming(created);
  };
  const finishNaming = (sectionId: string, title: string) => {
    edit((current) => renameSection(current, sectionId, title));
    setNaming(null);
  };

  // ---- drag and drop: rows, and section headers as TradingView moves them ----
  const startDrag = (event: DragEvent, dragged: Dragged, text: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', text);
    setDragging(dragged);
  };
  /**
   * A row of several selected carries them all, in their list order, under TradingView's overlay
   * of their tickers; another row, itself, as the browser draws it.
   */
  const onDragStart = (event: DragEvent, dragged: SymbolId) => {
    const symbols =
      list && selection.size > 1 && selection.has(dragged)
        ? allSymbols(list).filter((item) => selection.has(item))
        : [dragged];
    startDrag(event, { symbols }, symbols.join(','));
    if (symbols.length > 1) setDragOverlay(event, symbols);
  };
  const onHeaderDragStart = (event: DragEvent, section: WatchlistSection) =>
    startDrag(event, { section: section.id, folded: section.collapsed }, section.title);
  /** The half of the row or header under the pointer. */
  const halfOf = (event: DragEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
  };
  /**
   * Where a dragged header lands over `over`, a row or a header. An open section's lands above
   * or under it, anywhere; a folded one only between sections, at the nearer edge of the one
   * under the pointer (as in TradingView's screenshot), never above the symbols with no header.
   */
  const headerDrop = (event: DragEvent, over: ListItem): DropTarget | null => {
    if (!list || !dragging || !('section' in dragging)) return null;
    if (!dragging.folded) {
      const before = halfOf(event) === 'before' ? over : nextItem(list, over);
      const line = dropLine(list, before);
      return line && { kind: 'header', before, line };
    }
    const at = list.sections.findIndex((section) =>
      'section' in over ? section.id === over.section : section.symbols.includes(over.symbol),
    );
    const host = list.sections[at];
    const box = host && sectionBoxes.current.get(host.id)?.getBoundingClientRect();
    if (!host || !box) return null;
    const upper = host.title !== '' && event.clientY < box.top + box.height / 2;
    const before = upper ? host.id : (list.sections[at + 1]?.id ?? null);
    const line = dropLine(list, before === null ? null : { section: before });
    return line && { kind: 'section', before, line };
  };
  const onRowDragOver = (event: DragEvent, over: SymbolId) => {
    if (!dragging || !list) return;
    event.preventDefault();
    if ('section' in dragging) {
      setDrop(headerDrop(event, { symbol: over }));
      return;
    }
    // Over a dragged row: nowhere new.
    if (dragging.symbols.includes(over)) {
      setDrop(null);
      return;
    }
    const edge = halfOf(event);
    const section = list.sections.find((item) => item.symbols.includes(over));
    if (!section) return;
    const others = section.symbols.filter((item) => !dragging.symbols.includes(item));
    setDrop({
      kind: 'symbol',
      sectionId: section.id,
      index: others.indexOf(over) + (edge === 'after' ? 1 : 0),
      line: { item: { symbol: over }, edge },
    });
  };
  const onHeaderDragOver = (event: DragEvent, sectionId: string) => {
    if (!dragging) return;
    event.preventDefault();
    if ('section' in dragging) {
      setDrop(headerDrop(event, { section: sectionId }));
      return;
    }
    // A row dropped on a header goes first in its section.
    const line = { item: { section: sectionId }, edge: 'after' } as const;
    setDrop({ kind: 'symbol', sectionId, index: 0, line });
  };
  /** Over the list itself: between sections nothing changes; under the last row, the end. */
  const onListDragOver = (event: DragEvent) => {
    if (!dragging || !list) return;
    event.preventDefault();
    if (event.target !== event.currentTarget || !('section' in dragging)) return;
    const last = list.sections.at(-1);
    const box = last && sectionBoxes.current.get(last.id)?.getBoundingClientRect();
    const line = dropLine(list, null);
    if (!box || event.clientY < box.bottom || !line) return;
    setDrop(
      dragging.folded
        ? { kind: 'section', before: null, line }
        : { kind: 'header', before: null, line },
    );
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (dragging && drop) {
      if ('symbols' in dragging && drop.kind === 'symbol') {
        edit((current) => moveSymbols(current, dragging.symbols, drop.sectionId, drop.index));
      } else if ('section' in dragging && drop.kind === 'header') {
        edit((current) => moveSectionHeader(current, dragging.section, drop.before));
      } else if ('section' in dragging && drop.kind === 'section') {
        edit((current) => moveSection(current, dragging.section, drop.before));
      }
    }
    setDragging(null);
    setDrop(null);
  };
  const onDragEnd = () => {
    setDragging(null);
    setDrop(null);
  };
  /** The edge of a row or header the drop's line is drawn on, if it's this one. */
  const lineOn = (item: ListItem) =>
    drop && sameItem(drop.line.item, item) ? drop.line.edge : undefined;

  /** On a row of several selected, the menu is for them all; on another row, for it alone. */
  const openRowMenu = (event: MouseEvent, target: SymbolId) => {
    event.preventDefault();
    closeColors();
    if (selection.size > 1 && selection.has(target)) setSelected(target);
    else selectOnly(target);
    setMenu({ x: event.clientX, y: event.clientY, symbol: target });
  };

  /**
   * TradingView's row menu (docs/reference/07-watchlist-row-menu.png), without its items for
   * other lists, compare and notes. For several selected rows, its flag and colors are for all
   * of them, as TradingView's "Flag All Selected".
   */
  const rowMenu = (target: SymbolId): PopupMenuEntry[] => {
    const targets = selection.size > 1 && selection.has(target) ? [...selection] : [target];
    const name =
      targets.length > 1 ? `${targets.length} symbols` : target.slice(target.indexOf(':') + 1);
    return [
      {
        label: `Flag/Unflag ${name}`,
        shortcut: FLAG_SHORTCUT,
        onSelect: () => editFlags((current) => toggleFlags(current, targets)),
      },
      {
        key: 'flag-colors',
        custom: (
          <FlagDots
            current={sharedFlag(flags, targets)}
            gap={12}
            onPick={(color) => {
              editFlags((current) => pickFlags(current, targets, color));
              setMenu(null);
            }}
          />
        ),
      },
      { label: 'Unflag all symbols', onSelect: () => editFlags(unflagAll) },
      'separator',
      { label: 'Add section', icon: <AddSectionIcon />, onSelect: () => startSection(target) },
      {
        label: 'Add symbol',
        icon: <AddSymbolIcon />,
        onSelect: () => {
          setAddAfter(target);
          setAdding(true);
        },
      },
    ];
  };

  const menuItems: PopupMenuEntry[] = menu?.symbol != null ? rowMenu(menu.symbol) : [...moreItems];

  // ---- the list menu: several lists, uploads and downloads ----
  const openListMenu = () => {
    const box = titleButton.current?.getBoundingClientRect();
    if (!box || !lists.index) return;
    void lists.refresh().catch(() => {}); // the open list's count changes as it's edited
    setListMenu({ x: box.left - 4, y: box.bottom + 2 });
  };
  const names = () => lists.index?.lists.map((item) => item.name) ?? [];

  /** "Add section" from the list menu: above the selected row, or at the top. */
  const addSectionFromMenu = () => {
    if (selected && added.has(selected)) {
      startSection(selected);
      return;
    }
    let created = '';
    edit((current) => {
      const next = addTopSection(current);
      created = next.id;
      return next.list;
    });
    if (created) setNaming(created);
  };

  const finishRenaming = (name: string) => {
    setRenaming(false);
    const trimmed = name.trim();
    if (!active || trimmed === '' || trimmed === active.name) return;
    lists.update(active.id, { name: trimmed }).catch(failed);
  };

  /** "Upload list…": a TradingView .txt becomes a new list named after the file, opened. */
  const upload = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      notify('That file is too big to be a watchlist');
      return;
    }
    const parsed = parseWatchlistFile(await file.text());
    const symbols = fileSymbolCount(parsed);
    if (parsed.sections.length === 0) {
      notify(`${file.name} has no symbols in it`);
      return;
    }
    try {
      const created = await lists.create({
        name: file.name.replace(/\.txt$/i, ''),
        sections: watchlistFromFile(parsed).sections,
      });
      const titled = parsed.sections.filter((section) => section.title !== '').length;
      const parts = [
        `Uploaded “${created.name}”: ${symbols} ${symbols === 1 ? 'symbol' : 'symbols'}` +
          (titled > 0 ? ` in ${titled} ${titled === 1 ? 'section' : 'sections'}` : ''),
      ];
      if (parsed.skipped > 0) parts.push(`${parsed.skipped} left out (repeats or no exchange)`);
      if (parsed.overLimit > 0) parts.push(`${parsed.overLimit} past the 1,000 a list holds`);
      notify(parts.join('; '));
    } catch (error) {
      failed(error);
    }
  };

  /** A list as TradingView's .txt, saved to the computer (the open one as it is now). */
  const download = async (id: string) => {
    const meta = lists.index?.lists.find((item) => item.id === id);
    if (!meta) return;
    try {
      const sections = id === activeId && list ? list : await watchlistsApi.get(id);
      saveTextFile(watchlistFileName(meta.name), formatWatchlistFile(sections));
    } catch (error) {
      failed(error);
    }
  };

  return (
    <div className={styles.watchlist}>
      <div className={styles.titleRow}>
        {renaming && active ? (
          <input
            className={styles.titleInput}
            aria-label="List name"
            defaultValue={active.name}
            maxLength={64}
            // biome-ignore lint/a11y/noAutofocus: "Rename" types the name at once
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishRenaming(event.currentTarget.value);
              else if (event.key === 'Escape') {
                event.preventDefault();
                setRenaming(false);
              }
            }}
            onBlur={(event) => finishRenaming(event.currentTarget.value)}
          />
        ) : (
          // TradingView's list name: it opens the list menu.
          <button
            ref={titleButton}
            type="button"
            className={styles.title}
            aria-haspopup="menu"
            aria-expanded={listMenu !== null}
            aria-label={`${active?.name ?? 'Watchlist'}: list menu`}
            disabled={!lists.index}
            onClick={openListMenu}
          >
            <span className={styles.titleText}>{active?.name ?? 'Watchlist'}</span>
            <ChevronDownIcon />
          </button>
        )}
        <span className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            aria-label="Add symbol"
            disabled={!list}
            onClick={() => {
              setAddAfter(null);
              setAdding(true);
            }}
          >
            <AddIcon />
          </button>
          <button type="button" className={styles.action} aria-label="Advanced view" disabled>
            <AdvancedViewIcon />
          </button>
          <button
            ref={more}
            type="button"
            className={styles.action}
            aria-label="More"
            aria-expanded={menu !== null && menu.symbol === null}
            disabled={moreItems.length === 0}
            onClick={() => {
              const box = more.current?.getBoundingClientRect();
              if (box) setMenu({ x: box.right - 220, y: box.bottom + 2, symbol: null });
            }}
          >
            <MoreIcon />
          </button>
        </span>
      </div>
      <div className={styles.columns} aria-hidden>
        <span className={styles.headerFlag}>
          <FlagIcon />
        </span>
        <span>Symbol</span>
        <span className={styles.columnLast}>Last</span>
        <span className={styles.columnChange}>Chg</span>
        <span className={styles.columnPercent}>Chg%</span>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys and Delete for the rows inside */}
      <div
        className={styles.list}
        data-dragging={dragging ? '' : undefined}
        onKeyDown={onKeyDown}
        onScroll={closeColors}
        onDragOver={onListDragOver}
        onDrop={onDrop}
      >
        {list?.sections.map((section) => (
          <section
            key={section.id}
            ref={(element) => {
              if (element) sectionBoxes.current.set(section.id, element);
              else sectionBoxes.current.delete(section.id);
            }}
            aria-label={section.title || 'Symbols'}
            className={styles.section}
          >
            {/* An untitled section (an uploaded list's symbols above its first section) has no
                header, as on TradingView. */}
            {section.title === '' && naming !== section.id ? null : (
              <div className={styles.sectionHead}>
                {naming === section.id ? (
                  <div className={styles.sectionHeader}>
                    <SectionCaret open={!section.collapsed} />
                    <input
                      className={styles.sectionName}
                      aria-label="Section name"
                      defaultValue={section.title}
                      maxLength={64}
                      // biome-ignore lint/a11y/noAutofocus: a new section's name is typed at once
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          finishNaming(section.id, event.currentTarget.value);
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setNaming(null);
                        }
                      }}
                      onBlur={(event) => finishNaming(section.id, event.currentTarget.value)}
                    />
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.sectionHeader}
                      aria-expanded={!section.collapsed}
                      draggable
                      data-drop={lineOn({ section: section.id })}
                      data-dragged={
                        dragging && 'section' in dragging && dragging.section === section.id
                          ? ''
                          : undefined
                      }
                      onClick={() =>
                        edit((current: WatchlistDoc) => toggleSection(current, section.id))
                      }
                      // As in TradingView, a double-click renames it. Its two clicks folded and
                      // unfolded it, so it stays as it was.
                      onDoubleClick={() => setNaming(section.id)}
                      onDragStart={(event) => onHeaderDragStart(event, section)}
                      onDragOver={(event) => onHeaderDragOver(event, section.id)}
                      onDragEnd={onDragEnd}
                    >
                      <SectionCaret open={!section.collapsed} />
                      <span>{section.title}</span>
                    </button>
                    {/* TradingView's trash on a header: the section goes, its symbols stay. A
                        folded section has none. */}
                    {!section.collapsed && (
                      <button
                        type="button"
                        className={styles.sectionRemove}
                        aria-label={`Delete section ${section.title}`}
                        onClick={() =>
                          edit((current: WatchlistDoc) => removeSection(current, section.id))
                        }
                      >
                        <RemoveIcon />
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {!section.collapsed &&
              section.symbols.map((item) => (
                <WatchlistRow
                  key={item}
                  symbol={item}
                  selected={item === selected}
                  inSelection={selection.has(item)}
                  directory={directory}
                  board={board}
                  dropEdge={
                    dragging && 'symbols' in dragging && dragging.symbols.includes(item)
                      ? null
                      : (lineOn({ symbol: item }) ?? null)
                  }
                  flag={flagOf(flags, item)}
                  flagging={bubble?.symbol === item}
                  onFlagClick={(target) => editFlags((current) => toggleFlag(current, target))}
                  onFlagHover={showColors}
                  buttonRef={(element) => {
                    if (element) rows.current.set(item, element);
                    else rows.current.delete(item);
                  }}
                  onChoose={onRowClick}
                  onRemove={removeRow}
                  onMenu={openRowMenu}
                  onDragStart={onDragStart}
                  onDragOver={onRowDragOver}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                />
              ))}
          </section>
        ))}
        {list?.sections.every((section) => section.symbols.length === 0) && (
          <p className={styles.empty}>This list is empty. Add symbols with +.</p>
        )}
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".txt,text/plain"
        aria-label="Upload list"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = ''; // the same file can be picked again
          if (file) void upload(file);
        }}
      />
      {listMenu && lists.index && (
        <ListMenu
          x={listMenu.x}
          y={listMenu.y}
          index={lists.index}
          onCopy={() => setDialog({ kind: 'copy' })}
          onRename={() => setRenaming(true)}
          onAddSection={addSectionFromMenu}
          onClear={() => setDialog({ kind: 'clear' })}
          onCreate={() => setDialog({ kind: 'create' })}
          onUpload={() => fileInput.current?.click()}
          onOpenDialog={() => setDialog({ kind: 'open' })}
          onOpen={(id) => void lists.open(id).catch(failed)}
          onStar={(id, favorite) => void lists.update(id, { favorite }).catch(failed)}
          onDownload={(id) => void download(id)}
          onClose={() => setListMenu(null)}
        />
      )}
      {dialog?.kind === 'create' && (
        <ListNameDialog
          title="Create new list"
          action="Create"
          initialName=""
          onSubmit={(name) => {
            setDialog(null);
            lists.create({ name }).catch(failed);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'copy' && active && (
        <ListNameDialog
          title="Make a copy"
          action="Copy"
          initialName={uniqueListName(active.name, names())}
          onSubmit={(name) => {
            setDialog(null);
            lists.create({ name, copyOf: active.id }).catch(failed);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'clear' && active && (
        <ConfirmDialog
          title="Clear list"
          message={`Remove every symbol and section from “${active.name}”?`}
          action="Clear"
          onConfirm={() => {
            setDialog(null);
            edit(() => ({ sections: [] }));
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'open' && lists.index && (
        <OpenListDialog
          index={lists.index}
          onOpen={(id) => {
            setDialog(null);
            if (id !== activeId) lists.open(id).catch(failed);
          }}
          onDelete={(id, name) => setDialog({ kind: 'delete', id, name })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete list"
          message={`Delete “${dialog.name}” and its sections? Flags stay with their symbols.`}
          action="Delete"
          onConfirm={() => {
            const { id } = dialog;
            setDialog({ kind: 'open' });
            lists.remove(id).catch(failed);
          }}
          onClose={() => setDialog({ kind: 'open' })}
        />
      )}
      {bubble && flags && (
        <FlagPalette
          anchor={bubble.button}
          current={flagOf(flags, bubble.symbol)}
          onPick={(color) => {
            editFlags((current) => pickFlag(current, bubble.symbol, color));
            closeColors();
          }}
          onHover={keepColors}
          onClose={closeColors}
        />
      )}
      {adding && (
        <SymbolSearchDialog
          mode="add"
          added={added}
          onAdd={(next) => {
            if (addAfter) {
              const after = addAfter;
              edit((current) => insertSymbol(current, next, after));
              setAddAfter(next); // the next one goes after this one
            } else {
              edit((current) => addSymbol(current, next, selected));
            }
          }}
          onRemove={(target) => removeRows([target], false)}
          onLocate={(target) => {
            setAdding(false);
            setAddAfter(null);
            choose(target);
          }}
          onClose={() => {
            setAdding(false);
            setAddAfter(null);
          }}
        />
      )}
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={menu.symbol ? 'Symbol actions' : 'Watchlist options'}
          items={menuItems}
          note={menu.symbol ? undefined : moreNote}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
