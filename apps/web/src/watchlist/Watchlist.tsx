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
import { SymbolSearchDialog } from '../search/SymbolSearchDialog';
import { ChevronDownIcon } from '../toolbar/icons';
import { AddIcon, AdvancedViewIcon, MoreIcon, SectionCaret } from './icons';
import { addSymbol, allSymbols, moveSymbol, neighbor, removeSymbol, toggleSection } from './model';
import { PopupMenu, type PopupMenuItem } from './PopupMenu';
import { QuoteBoard } from './QuoteBoard';
import { SymbolDirectory } from './SymbolDirectory';
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

/**
 * The right-hand watchlist (docs/reference/01-chart-layout.png): sections of symbols with
 * live Last, Chg and Chg%. Click or ↑/↓ shows a symbol on the chart; Delete or the right-click
 * menu removes it; rows drag to a new place; sections fold. Every change is saved by the
 * gateway.
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
  const directory = useMemo(() => new SymbolDirectory(marketApi), []);
  const board = useMemo(() => new QuoteBoard(quotes), [quotes]);
  const [selected, setSelected] = useState<SymbolId | null>(symbol);
  const [menu, setMenu] = useState<{ x: number; y: number; symbol: SymbolId | null } | null>(null);
  const [dragging, setDragging] = useState<SymbolId | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const added = useMemo(() => new Set(list ? allSymbols(list) : []), [list]);
  const rows = useRef(new Map<SymbolId, HTMLButtonElement>());
  const more = useRef<HTMLButtonElement>(null);

  useEffect(() => () => board.dispose(), [board]);
  useEffect(() => {
    if (list) board.setSymbols(list.sections.flatMap((section) => section.symbols));
  }, [board, list]);
  // The chart's symbol is the selected row.
  useEffect(() => setSelected(symbol), [symbol]);

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
    setSelected(target);
    setMenu({ x: event.clientX, y: event.clientY, symbol: target });
  };

  const menuItems: PopupMenuItem[] =
    menu?.symbol != null
      ? [
          {
            label: 'Remove from watchlist',
            shortcut: 'Del',
            onSelect: () => remove(menu.symbol as SymbolId),
          },
        ]
      : [...moreItems];

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
            onClick={() => setAdding(true)}
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
        onDragOver={(event) => dragging && event.preventDefault()}
        onDrop={onDrop}
      >
        {list?.sections.map((section) => (
          <section key={section.id} aria-label={section.title} className={styles.section}>
            <button
              type="button"
              className={styles.sectionHeader}
              aria-expanded={!section.collapsed}
              data-drop={
                drop?.sectionId === section.id && drop.symbol === null ? 'before' : undefined
              }
              onClick={() => edit((current: WatchlistDoc) => toggleSection(current, section.id))}
              onDragOver={(event) => onHeaderDragOver(event, section.id)}
            >
              <SectionCaret open={!section.collapsed} />
              <span>{section.title}</span>
            </button>
            {!section.collapsed &&
              section.symbols.map((item) => (
                <WatchlistRow
                  key={item}
                  symbol={item}
                  selected={item === selected}
                  directory={directory}
                  board={board}
                  dropEdge={drop?.symbol === item && item !== dragging ? drop.edge : null}
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
      {adding && (
        <SymbolSearchDialog
          mode="add"
          added={added}
          onAdd={(symbol) => edit((current) => addSymbol(current, symbol, selected))}
          onRemove={(symbol) => remove(symbol, false)}
          onLocate={(symbol) => {
            setAdding(false);
            choose(symbol);
          }}
          onClose={() => setAdding(false)}
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
