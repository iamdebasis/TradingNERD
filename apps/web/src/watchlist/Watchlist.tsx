import type { SymbolId, Watchlist as WatchlistDoc } from '@tradingnerd/core';
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
import { marketApi } from '../data/api';
import type { QuoteSource } from '../data/GatewayConnection';
import { isEditable } from '../lib/dom';
import { SymbolSearchDialog } from '../search/SymbolSearchDialog';
import { ChevronDownIcon } from '../toolbar/icons';
import { FlagDots } from './FlagDots';
import { FlagPalette } from './FlagPalette';
import { flagOf, pickFlag, toggleFlag, unflagAll } from './flagEdits';
import {
  AddIcon,
  AddSectionIcon,
  AddSymbolIcon,
  AdvancedViewIcon,
  FlagIcon,
  MoreIcon,
  SectionCaret,
} from './icons';
import {
  addSection,
  addSymbol,
  allSymbols,
  insertSymbol,
  moveSymbol,
  neighbor,
  removeSymbol,
  renameSection,
  toggleSection,
} from './model';
import { PopupMenu, type PopupMenuEntry, type PopupMenuItem } from './PopupMenu';
import { QuoteBoard } from './QuoteBoard';
import { SymbolDirectory } from './SymbolDirectory';
import { useFlags } from './useFlags';
import { useWatchlist, type WatchlistApi } from './useWatchlist';
import styles from './Watchlist.module.css';
import { WatchlistRow } from './WatchlistRow';

export interface WatchlistProps {
  /** The chart's symbol, highlighted in the list. */
  symbol: SymbolId;
  /** A row was chosen: show it on the chart. */
  onChoose(symbol: SymbolId): void;
  quotes: QuoteSource;
  api?: WatchlistApi;
  /** Extra items for the ⋯ menu, e.g. coin logo settings. */
  moreItems?: readonly PopupMenuItem[];
  /** A line under the ⋯ menu's items, e.g. a data credit. */
  moreNote?: string;
}

interface DropTarget {
  sectionId: string;
  /** Index in the section, counted without the dragged symbol. */
  index: number;
  /** The row the indicator is drawn on, and on which edge. */
  symbol: SymbolId | null;
  edge: 'before' | 'after';
}

/** The pointer rests this long on a row's flag before its colors show. */
export const FLAG_HOVER_MS = 300;
/** And may leave the flag (for the colors, say) this long before they go. */
export const FLAG_LEAVE_MS = 200;
/** TradingView's shortcut for "Flag/Unflag", as its menu shows it on a Mac. */
const FLAG_SHORTCUT = '⌥ ↵';

/**
 * The right-hand watchlist (docs/reference/01-chart-layout.png): sections of symbols with
 * live Last, Chg and Chg%. Click or ↑/↓ shows a symbol on the chart; Delete or a row's remove
 * button removes it; rows drag to a new place; sections fold. Symbols carry TradingView's flags
 * (docs/reference/06-watchlist-flags.png, 07-watchlist-row-menu.png). Every change is saved by
 * the gateway: the list in data/watchlist.json, the flags in data/flags.json.
 */
export function Watchlist({
  symbol,
  onChoose,
  quotes,
  api,
  moreItems = [],
  moreNote,
}: WatchlistProps) {
  const { list, edit } = useWatchlist(api);
  const { flags, editFlags } = useFlags();
  const directory = useMemo(() => new SymbolDirectory(marketApi), []);
  const board = useMemo(() => new QuoteBoard(quotes), [quotes]);
  const [selected, setSelected] = useState<SymbolId | null>(symbol);
  const [menu, setMenu] = useState<{ x: number; y: number; symbol: SymbolId | null } | null>(null);
  const [dragging, setDragging] = useState<SymbolId | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
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
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => () => board.dispose(), [board]);
  useEffect(() => {
    if (list) board.setSymbols(list.sections.flatMap((section) => section.symbols));
  }, [board, list]);
  // The chart's symbol is the selected row.
  useEffect(() => setSelected(symbol), [symbol]);
  useEffect(() => () => clearTimeout(bubbleTimer.current), []);

  // ⌥↵ (Alt+Enter), as in TradingView: flags or unflags the selected symbol.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || !event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = selectedRef.current;
      if (!target) return;
      event.preventDefault();
      editFlags((current) => toggleFlag(current, target));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editFlags]);

  const choose = useCallback(
    (next: SymbolId, focus = true) => {
      setSelected(next);
      onChoose(next);
      const row = rows.current.get(next);
      if (focus) row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
    },
    [onChoose],
  );

  /** Removes a row; if it was the selected one, its neighbor is selected (and focused). */
  const remove = useCallback(
    (target: SymbolId, focus = true) => {
      if (!list) return;
      if (target === selected) {
        const after = neighbor(list, target, 1);
        const next = after === target ? neighbor(list, target, -1) : after;
        setSelected(next === target ? null : next);
        if (focus && next && next !== target) rows.current.get(next)?.focus();
      }
      edit((current) => removeSymbol(current, target));
    },
    [edit, list, selected],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if (!list || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = neighbor(list, selected, event.key === 'ArrowDown' ? 1 : -1);
      if (next && next !== selected) choose(next);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault();
      remove(selected);
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

  // ---- drag and drop ----
  const onDragStart = (event: DragEvent, dragged: SymbolId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged);
    setDragging(dragged);
  };
  const onRowDragOver = (event: DragEvent, over: SymbolId) => {
    if (!dragging || !list) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
    const section = list.sections.find((item) => item.symbols.includes(over));
    if (!section) return;
    const others = section.symbols.filter((item) => item !== dragging);
    const at = others.indexOf(over);
    const index =
      over === dragging ? section.symbols.indexOf(dragging) : at + (edge === 'after' ? 1 : 0);
    setDrop({ sectionId: section.id, index, symbol: over, edge });
  };
  const onHeaderDragOver = (event: DragEvent, sectionId: string) => {
    if (!dragging) return;
    event.preventDefault();
    setDrop({ sectionId, index: 0, symbol: null, edge: 'before' });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (dragging && drop) {
      edit((current) => moveSymbol(current, dragging, drop.sectionId, drop.index));
    }
    setDragging(null);
    setDrop(null);
  };
  const onDragEnd = () => {
    setDragging(null);
    setDrop(null);
  };

  const openRowMenu = (event: MouseEvent, target: SymbolId) => {
    event.preventDefault();
    closeColors();
    setSelected(target);
    setMenu({ x: event.clientX, y: event.clientY, symbol: target });
  };

  /**
   * TradingView's row menu (docs/reference/07-watchlist-row-menu.png), without its items for
   * other lists, compare and notes.
   */
  const rowMenu = (target: SymbolId): PopupMenuEntry[] => [
    {
      label: `Flag/Unflag ${target.slice(target.indexOf(':') + 1)}`,
      shortcut: FLAG_SHORTCUT,
      onSelect: () => editFlags((current) => toggleFlag(current, target)),
    },
    {
      key: 'flag-colors',
      custom: (
        <FlagDots
          current={flagOf(flags, target)}
          gap={12}
          onPick={(color) => {
            editFlags((current) => pickFlag(current, target, color));
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

  const menuItems: PopupMenuEntry[] = menu?.symbol != null ? rowMenu(menu.symbol) : [...moreItems];

  return (
    <div className={styles.watchlist}>
      <div className={styles.titleRow}>
        {/* One list in v1: TradingView's list switcher has nothing to switch between. */}
        <span className={styles.title}>
          Watchlist
          <ChevronDownIcon />
        </span>
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
        onDragOver={(event) => dragging && event.preventDefault()}
        onDrop={onDrop}
      >
        {list?.sections.map((section) => (
          <section key={section.id} aria-label={section.title} className={styles.section}>
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
                    if (event.key === 'Enter') finishNaming(section.id, event.currentTarget.value);
                    else if (event.key === 'Escape') {
                      event.preventDefault();
                      setNaming(null);
                    }
                  }}
                  onBlur={(event) => finishNaming(section.id, event.currentTarget.value)}
                />
              </div>
            ) : (
              <button
                type="button"
                className={styles.sectionHeader}
                aria-expanded={!section.collapsed}
                data-drop={
                  drop?.sectionId === section.id && drop.symbol === null ? 'before' : undefined
                }
                onClick={() => edit((current: WatchlistDoc) => toggleSection(current, section.id))}
                // As in TradingView, a double-click renames it. Its two clicks folded and
                // unfolded it, so it stays as it was.
                onDoubleClick={() => setNaming(section.id)}
                onDragOver={(event) => onHeaderDragOver(event, section.id)}
              >
                <SectionCaret open={!section.collapsed} />
                <span>{section.title}</span>
              </button>
            )}
            {!section.collapsed &&
              section.symbols.map((item) => (
                <WatchlistRow
                  key={item}
                  symbol={item}
                  selected={item === selected}
                  directory={directory}
                  board={board}
                  dropEdge={drop?.symbol === item && item !== dragging ? drop.edge : null}
                  flag={flagOf(flags, item)}
                  flagging={bubble?.symbol === item}
                  onFlagClick={(target) => editFlags((current) => toggleFlag(current, target))}
                  onFlagHover={showColors}
                  buttonRef={(element) => {
                    if (element) rows.current.set(item, element);
                    else rows.current.delete(item);
                  }}
                  onChoose={(next) => choose(next)}
                  onRemove={(target) => remove(target, false)}
                  onMenu={openRowMenu}
                  onDragStart={onDragStart}
                  onDragOver={onRowDragOver}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                />
              ))}
          </section>
        ))}
      </div>
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
          onRemove={(target) => remove(target, false)}
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
