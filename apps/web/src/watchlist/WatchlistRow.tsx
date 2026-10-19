import type { SymbolId } from '@tradingnerd/core';
import { type DragEvent, type MouseEvent, type Ref, useEffect, useRef, useState } from 'react';
import { CoinLogo } from '../logos/CoinLogo';
import { RemoveIcon } from './icons';
import { directionOf, flashSplit, formatChange, formatChangePercent, formatLast } from './numbers';
import type { QuoteBoard } from './QuoteBoard';
import type { SymbolDirectory, SymbolLookup } from './SymbolDirectory';
import styles from './Watchlist.module.css';

export interface WatchlistRowProps {
  symbol: SymbolId;
  selected: boolean;
  directory: SymbolDirectory;
  board: QuoteBoard;
  /** Where a dragged row would land: before or after this one. */
  dropEdge: 'before' | 'after' | null;
  buttonRef?: Ref<HTMLButtonElement>;
  onChoose(symbol: SymbolId): void;
  onRemove(symbol: SymbolId): void;
  onMenu(event: MouseEvent, symbol: SymbolId): void;
  onDragStart(event: DragEvent, symbol: SymbolId): void;
  onDragOver(event: DragEvent, symbol: SymbolId): void;
  onDrop(event: DragEvent): void;
  onDragEnd(): void;
}

/**
 * One watchlist row: avatar, symbol, Last, Chg, Chg%. The numbers are painted straight into
 * the DOM by the QuoteBoard, with the digits that changed in the tick's color. Under the
 * mouse, a remove button covers the row's right end, as in TradingView.
 */
export function WatchlistRow(props: WatchlistRowProps) {
  const { symbol, directory, board } = props;
  const ticker = symbol.slice(symbol.indexOf(':') + 1);
  const [lookup, setLookup] = useState<SymbolLookup | null>(null);
  const [missing, setMissing] = useState(false);
  const same = useRef<HTMLSpanElement>(null);
  const changed = useRef<HTMLSpanElement>(null);
  const change = useRef<HTMLSpanElement>(null);
  const percent = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ text: string; value: number } | null>(null);

  useEffect(() => {
    let alive = true;
    directory.lookup(symbol).then(
      (result) => {
        if (alive) setLookup(result);
      },
      () => {
        // Unreachable for now; shown without prices until the next lookup succeeds.
      },
    );
    return () => {
      alive = false;
    };
  }, [directory, symbol]);

  const precision = lookup?.state === 'ready' ? lookup.info.pricePrecision : null;

  useEffect(() => {
    if (precision === null) return;
    return board.attach(symbol, {
      show: ({ last, prevClose }) => {
        const text = formatLast(last, precision);
        // The same price again keeps the last change's colored digits, as in the reference,
        // where nearly every row shows some.
        if (text !== previous.current?.text) {
          const split = flashSplit(
            previous.current?.text ?? null,
            text,
            last - (previous.current?.value ?? last),
          );
          previous.current = { text, value: last };
          setText(same.current, split.same);
          setText(changed.current, split.changed);
          if (changed.current && split.direction !== 'flat') {
            changed.current.dataset.direction = split.direction;
          }
        }
        if (prevClose === null || prevClose === 0) {
          setText(change.current, '');
          setText(percent.current, '');
          return;
        }
        const delta = last - prevClose;
        const direction = directionOf(delta, precision);
        setText(change.current, formatChange(delta, precision));
        setText(percent.current, formatChangePercent((delta / prevClose) * 100));
        if (change.current) change.current.dataset.direction = direction;
        if (percent.current) percent.current.dataset.direction = direction;
      },
      unavailable: () => setMissing(true),
    });
  }, [board, symbol, precision]);

  const unavailable = missing || lookup?.state === 'unavailable';
  const letter = (lookup?.state === 'ready' ? lookup.info.base : ticker).charAt(0);

  return (
    <div className={styles.rowWrap}>
      <button
        ref={props.buttonRef}
        type="button"
        className={styles.row}
        aria-label={ticker}
        aria-current={props.selected ? 'true' : undefined}
        tabIndex={props.selected ? 0 : -1}
        data-symbol={symbol}
        data-unavailable={unavailable || undefined}
        data-drop={props.dropEdge ?? undefined}
        draggable
        onClick={() => props.onChoose(symbol)}
        onContextMenu={(event) => props.onMenu(event, symbol)}
        onDragStart={(event) => props.onDragStart(event, symbol)}
        onDragOver={(event) => props.onDragOver(event, symbol)}
        onDrop={props.onDrop}
        onDragEnd={props.onDragEnd}
      >
        <span className={styles.symbolCell}>
          <CoinLogo
            symbol={symbol}
            base={!unavailable && lookup?.state === 'ready' ? lookup.info.base : null}
            letter={letter}
            className={styles.avatar}
          />
          <span className={styles.ticker}>{ticker}</span>
        </span>
        <span className={styles.number}>
          {!unavailable && (
            <>
              <span ref={same} />
              <span ref={changed} className={styles.flash} />
            </>
          )}
        </span>
        <span ref={change} className={`${styles.number} ${styles.change}`} />
        <span ref={percent} className={`${styles.number} ${styles.change}`} />
      </button>
      {/* Out of the tab order: Delete removes the focused row. */}
      <button
        type="button"
        className={styles.remove}
        aria-label="Remove from watchlist"
        tabIndex={-1}
        onClick={() => props.onRemove(symbol)}
      >
        <RemoveIcon />
      </button>
    </div>
  );
}

function setText(element: HTMLElement | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}
