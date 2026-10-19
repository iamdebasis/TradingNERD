import {
  descriptionMatches,
  MAX_QUERY_LENGTH,
  type MatchRange,
  type SymbolId,
  type SymbolListing,
  type SymbolMatch,
  tickerMatch,
} from '@tradingnerd/core';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { type SearchApi, searchApi } from '../data/api';
import { CoinLogo } from '../logos/CoinLogo';
import { ExchangeLogo } from '../logos/ExchangeLogo';
import { ChevronDownIcon, PlusIcon } from '../toolbar/icons';
import {
  CheckIcon,
  ClearIcon,
  CloseLargeIcon,
  ExpandIcon,
  LocateIcon,
  SearchIcon,
  ShiftIcon,
  TrashIcon,
} from './icons';
import styles from './SymbolSearchDialog.module.css';
import { loadSearchTab, type SearchTab, saveSearchTab } from './searchPrefs';
import { useExchanges, useSymbolSearch } from './useSymbolSearch';

/** `add`: TradingView's "Add symbol" for the watchlist; `search`: the chart's symbol search. */
export type SearchMode = 'add' | 'search';

export interface SymbolSearchDialogProps {
  mode: SearchMode;
  /** What was typed to open it, e.g. the letter pressed on the chart. */
  initialQuery?: string;
  /** Add mode: symbols already in the watchlist; their rows offer remove and locate. */
  added?: ReadonlySet<SymbolId>;
  onAdd?(symbol: SymbolId): void;
  onRemove?(symbol: SymbolId): void;
  /** Add mode: show the symbol's watchlist row (and close). */
  onLocate?(symbol: SymbolId): void;
  /** Search mode: show the symbol on the chart (and close). */
  onChoose?(symbol: SymbolId): void;
  onClose(): void;
  api?: SearchApi;
}

/** One line of the list: a pair (acting on its first listing), or one exchange's listing. */
interface Row {
  key: string;
  match: SymbolMatch;
  listing: SymbolListing;
  /** A listing shown under its expanded pair. */
  child: boolean;
}

type FilterId = 'source' | 'type' | 'exchangeType';
type TypeFilter = 'all' | 'spot';
type ExchangeTypeFilter = 'all' | 'cex';

/** How many exchange logos a row stacks before "+N". */
const STACKED_LOGOS = 5;
/** Start fetching the next page this close to the bottom of the list (CSS px). */
const LOAD_MORE_MARGIN = 240;

const EMPTY_SET: ReadonlySet<SymbolId> = new Set();

/**
 * TradingView's "Add symbol" dialog (docs/reference/04-add-symbol.png), also the chart's symbol
 * search: every listed pair on the five exchanges, ranked by the gateway, one row per pair with
 * the exchanges that list it. Typing stays in the search field: ↑/↓ move, Enter adds (or shows
 * the symbol), Shift+Enter and Shift+click add and close, Escape closes.
 */
export function SymbolSearchDialog({
  mode,
  initialQuery = '',
  added = EMPTY_SET,
  onAdd,
  onRemove,
  onLocate,
  onChoose,
  onClose,
  api = searchApi,
}: SymbolSearchDialogProps) {
  const id = useId();
  const [text, setText] = useState(initialQuery);
  const [tab, setTab] = useState<SearchTab>(loadSearchTab);
  const [source, setSource] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>('all');
  const [exchangeType, setExchangeType] = useState<ExchangeTypeFilter>('all');
  const [openFilter, setOpenFilter] = useState<FilterId | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** The highlighted row: none until ↑/↓ or the mouse picks one; Enter then takes the first. */
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<number, HTMLDivElement>());
  const exchanges = useExchanges(api);
  const search = useSymbolSearch(api, text.trim(), source);

  const names = useMemo(
    () => new Map(exchanges.map((exchange) => [exchange.id, exchange.name])),
    [exchanges],
  );
  const nameOf = (exchange: string) => names.get(exchange) ?? exchange;

  const rows = useMemo(() => {
    const visible: Row[] = [];
    for (const match of search.matches) {
      const [first, ...others] = match.listings;
      if (!first) continue;
      visible.push({ key: match.ticker, match, listing: first, child: false });
      if (expanded.has(match.ticker)) {
        for (const listing of others)
          visible.push({ key: listing.id, match, listing, child: true });
      }
    }
    return visible;
  }, [search.matches, expanded]);

  // New results start unhighlighted, scrolled to the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the results change
  useEffect(() => {
    setActive(-1);
    list.current?.scrollTo({ top: 0 });
  }, [search.query, source]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  // Escape closes an open filter first, then the dialog, wherever the focus is.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (openFilter) setOpenFilter(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openFilter, onClose]);

  const moveTo = (index: number) => {
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActive(next);
    rowElements.current.get(next)?.scrollIntoView({ block: 'nearest' });
  };

  /** A row's main action: add it (add mode) or show it (search mode); `close` as with Shift. */
  const activate = (row: Row, close: boolean) => {
    const { listing } = row;
    if (mode === 'search') {
      if (!listing.live) return;
      onChoose?.(listing.id);
      onClose();
      return;
    }
    if (listing.live && !added.has(listing.id)) onAdd?.(listing.id);
    if (close) onClose();
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveTo(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active] ?? rows[0];
      if (row) activate(row, event.shiftKey);
    }
  };

  const toggle = (ticker: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(ticker)) next.add(ticker);
      return next;
    });

  const onScroll = () => {
    const element = list.current;
    if (!element) return;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - LOAD_MORE_MARGIN) {
      search.loadMore();
    }
  };

  const typeOptions: FilterOption<TypeFilter>[] = [
    { value: 'all', label: 'All types' },
    { value: 'spot', label: 'Spot' },
  ];
  const exchangeTypeOptions: FilterOption<ExchangeTypeFilter>[] = [
    { value: 'all', label: 'All exchange types' },
    { value: 'cex', label: 'Centralized exchanges' },
  ];
  const sourceOptions: FilterOption<string | null>[] = [
    { value: null, label: 'All sources' },
    ...exchanges.map((exchange) => ({
      value: exchange.id,
      label: exchange.name,
      icon: (
        <ExchangeLogo exchange={exchange.id} name={exchange.name} className={styles.menuLogo} />
      ),
    })),
  ];
  const activeRow = rows[active];
  const title = mode === 'add' ? 'Add symbol' : 'Symbol search';

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: a press outside the dialog closes it
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-mode={mode}
        onMouseDown={(event) => {
          // A press anywhere but an open filter menu closes it.
          if (openFilter && !(event.target as Element).closest('[data-filter]')) {
            setOpenFilter(null);
          }
        }}
      >
        <div className={styles.titleRow}>
          <h2 id={`${id}-title`} className={styles.title}>
            {title}
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseLargeIcon />
          </button>
        </div>

        <div className={styles.searchField}>
          <span className={styles.searchIcon}>
            <SearchIcon />
          </span>
          <input
            ref={input}
            className={styles.input}
            value={text}
            maxLength={MAX_QUERY_LENGTH}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-label="Symbol, e.g. XRP or BINANCE:XRPUSDT"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={activeRow ? `${id}-row-${active}` : undefined}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onInputKey}
          />
          {text !== '' && (
            <button
              type="button"
              className={styles.clear}
              aria-label="Clear"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setText('');
                input.current?.focus();
              }}
            >
              <ClearIcon />
            </button>
          )}
        </div>

        <div className={styles.tabs} role="tablist" aria-label="Categories">
          {(['all', 'crypto'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={tab === value}
              onClick={() => {
                setTab(value);
                saveSearchTab(value);
                input.current?.focus();
              }}
            >
              {value === 'all' ? 'All' : 'Crypto'}
            </button>
          ))}
        </div>

        <div className={styles.filters}>
          <Filter<string | null>
            name="source"
            options={sourceOptions}
            value={source}
            open={openFilter === 'source'}
            onOpen={setOpenFilter}
            onChange={(value) => setSource(value)}
          />
          <Filter<TypeFilter>
            name="type"
            options={typeOptions}
            value={type}
            open={openFilter === 'type'}
            onOpen={setOpenFilter}
            onChange={setType}
          />
          <Filter<ExchangeTypeFilter>
            name="exchangeType"
            options={exchangeTypeOptions}
            value={exchangeType}
            open={openFilter === 'exchangeType'}
            onOpen={setOpenFilter}
            onChange={setExchangeType}
          />
        </div>

        <div
          ref={list}
          id={`${id}-list`}
          className={styles.list}
          role="listbox"
          aria-label={title}
          onScroll={onScroll}
        >
          {rows.map((row, index) => (
            <ResultRow
              key={row.key}
              id={`${id}-row-${index}`}
              row={row}
              mode={mode}
              query={search.query}
              active={index === active}
              added={added.has(row.listing.id)}
              expanded={expanded.has(row.match.ticker)}
              nameOf={nameOf}
              elementRef={(element) => {
                if (element) rowElements.current.set(index, element);
                else rowElements.current.delete(index);
              }}
              onHover={() => setActive(index)}
              onActivate={(close) => activate(row, close)}
              onToggle={() => toggle(row.match.ticker)}
              onRemove={() => onRemove?.(row.listing.id)}
              onLocate={() => onLocate?.(row.listing.id)}
            />
          ))}
          {!search.loading && rows.length === 0 && (
            <p className={styles.empty} role="status">
              {search.error ?? 'No symbols match your criteria'}
            </p>
          )}
        </div>

        {mode === 'add' && (
          <div className={styles.footer}>
            <kbd className={styles.key} aria-label="Shift">
              <ShiftIcon />
            </kbd>
            <span>+</span>
            <kbd className={styles.key}>Click</kbd>
            <span className={styles.or}>or</span>
            <kbd className={styles.key} aria-label="Shift">
              <ShiftIcon />
            </kbd>
            <span>+</span>
            <kbd className={styles.key}>Enter</kbd>
            <span className={styles.hint}>to add symbol and close dialog</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface ResultRowProps {
  id: string;
  row: Row;
  mode: SearchMode;
  query: string;
  active: boolean;
  added: boolean;
  expanded: boolean;
  nameOf(exchange: string): string;
  elementRef(element: HTMLDivElement | null): void;
  onHover(): void;
  onActivate(close: boolean): void;
  onToggle(): void;
  onRemove(): void;
  onLocate(): void;
}

/** Buttons inside a row act on their own and keep the typing focus in the search field. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

function ResultRow({
  id,
  row,
  mode,
  query,
  active,
  added,
  expanded,
  nameOf,
  elementRef,
  onHover,
  onActivate,
  onToggle,
  onRemove,
  onLocate,
}: ResultRowProps) {
  const { match, listing, child } = row;
  const exchangeName = nameOf(listing.exchange);
  const grouped = !child && match.listings.length > 1;
  const unavailable = listing.live
    ? undefined
    : `Live data from ${exchangeName} isn't available yet`;
  const stop = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    action();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys reach rows through the search field, as in a combobox
    <div
      ref={elementRef}
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={!listing.live || undefined}
      className={styles.row}
      data-symbol={listing.id}
      data-active={active || undefined}
      data-child={child || undefined}
      title={unavailable}
      onMouseDown={keepFocus}
      onMouseMove={active ? undefined : onHover}
      onClick={(event) => onActivate(event.shiftKey)}
    >
      <CoinLogo
        symbol={listing.id}
        base={match.base}
        letter={match.base.charAt(0)}
        className={styles.logo}
      />
      <span className={styles.ticker}>
        <Highlighted text={match.ticker} ranges={tickerMatch(match.ticker, query)} />
      </span>
      <span className={styles.description}>
        <Highlighted
          text={match.description}
          ranges={descriptionMatches(match.description, query)}
        />
      </span>
      <span className={styles.source}>
        <span className={styles.type}>spot crypto</span>
        <span className={styles.exchange}>{exchangeName}</span>
        {grouped ? (
          <span className={styles.stack}>
            {match.listings.slice(0, STACKED_LOGOS).map((item, index) => (
              <ExchangeLogo
                key={item.id}
                exchange={item.exchange}
                name={nameOf(item.exchange)}
                className={styles.stackLogo}
                style={{ zIndex: STACKED_LOGOS - index }}
              />
            ))}
            {match.listings.length > STACKED_LOGOS && (
              <span className={styles.more}>+{match.listings.length - STACKED_LOGOS}</span>
            )}
          </span>
        ) : (
          <ExchangeLogo
            exchange={listing.exchange}
            name={exchangeName}
            className={styles.exchangeLogo}
          />
        )}
        {grouped && (
          <button
            type="button"
            className={styles.expand}
            aria-label={`${expanded ? 'Hide' : 'Show'} the exchanges that list ${match.ticker}`}
            aria-expanded={expanded}
            onMouseDown={keepFocus}
            onClick={stop(onToggle)}
          >
            <ExpandIcon open={expanded} />
          </button>
        )}
      </span>
      {mode === 'add' && (
        <span className={styles.actions}>
          {added ? (
            <>
              <button
                type="button"
                className={styles.action}
                aria-label="Remove from watchlist"
                onMouseDown={keepFocus}
                onClick={stop(onRemove)}
              >
                <TrashIcon />
              </button>
              <button
                type="button"
                className={styles.action}
                aria-label="Show in watchlist"
                onMouseDown={keepFocus}
                onClick={stop(onLocate)}
              >
                <LocateIcon />
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.action}
              aria-label="Add to watchlist"
              disabled={!listing.live}
              onMouseDown={keepFocus}
              onClick={(event) => {
                event.stopPropagation();
                onActivate(event.shiftKey);
              }}
            >
              <PlusIcon />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** Text with the parts that matched the query in the accent color. */
function Highlighted({ text, ranges }: { text: string; ranges: readonly MatchRange[] }) {
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className={styles.match}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

interface FilterOption<T> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/** A filter above the list: its current choice and ⌄, opening a menu of the choices. */
function Filter<T extends string | null>({
  name,
  options,
  value,
  open,
  onOpen,
  onChange,
}: {
  name: FilterId;
  options: readonly FilterOption<T>[];
  value: T;
  open: boolean;
  onOpen(filter: FilterId | null): void;
  onChange(value: T): void;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <div className={styles.filterWrap} data-filter>
      <button
        type="button"
        className={styles.filter}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => onOpen(open ? null : name)}
      >
        <span>{current?.label}</span>
        <span className={styles.filterChevron}>
          <ChevronDownIcon />
        </span>
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label={options[0]?.label}>
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={styles.menuItem}
              onClick={() => {
                onChange(option.value);
                onOpen(null);
              }}
            >
              {option.icon}
              <span className={styles.menuLabel}>{option.label}</span>
              {option.value === value && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
