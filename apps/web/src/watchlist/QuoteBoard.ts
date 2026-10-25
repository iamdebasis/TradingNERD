import { isChartable, type SymbolId } from '@tradingnerd/core';
import type { QuoteSource } from '../data/GatewayConnection';

export interface Quote {
  last: number;
  prevClose: number | null;
}

/** A row's view of its symbol's quote. */
export interface QuoteView {
  /** The latest quote; called at most once per frame. */
  show(quote: Quote): void;
  /** The exchange doesn't list the symbol. */
  unavailable(): void;
}

/**
 * Live quotes for every symbol in the watchlist, one gateway subscription each. Quotes are
 * painted straight into the rows' DOM, all of them in one animation frame, so a full list
 * ticking costs one batch of text updates per frame and no React renders.
 */
export class QuoteBoard {
  private readonly source: QuoteSource;
  private readonly subscriptions = new Map<SymbolId, () => void>();
  private readonly quotes = new Map<SymbolId, Quote>();
  private readonly missing = new Set<SymbolId>();
  private readonly views = new Map<SymbolId, Set<QuoteView>>();
  private readonly dirty = new Set<SymbolId>();
  private frame = 0;

  constructor(source: QuoteSource) {
    this.source = source;
  }

  /** Keeps quotes flowing for exactly these symbols. */
  setSymbols(symbols: readonly SymbolId[]): void {
    const wanted = new Set(symbols);
    for (const [symbol, unsubscribe] of this.subscriptions) {
      if (wanted.has(symbol)) continue;
      unsubscribe();
      this.subscriptions.delete(symbol);
      this.quotes.delete(symbol);
      this.missing.delete(symbol);
    }
    for (const symbol of wanted) {
      if (this.subscriptions.has(symbol)) continue;
      // Symbols of shapes we don't chart (a formula of tickers without their exchanges, from a
      // TradingView list) have no quotes.
      if (!isChartable(symbol)) {
        this.subscriptions.set(symbol, () => {});
        this.missing.add(symbol);
        for (const view of this.views.get(symbol) ?? []) view.unavailable();
        continue;
      }
      this.subscriptions.set(
        symbol,
        this.source.subscribeQuotes(symbol, {
          onQuote: (last, prevClose) => {
            this.quotes.set(symbol, { last, prevClose });
            this.markDirty(symbol);
          },
          onState: () => {},
          onError: (code) => {
            if (code !== 'unknown_symbol') return;
            this.missing.add(symbol);
            for (const view of this.views.get(symbol) ?? []) view.unavailable();
          },
        }),
      );
    }
  }

  /** Shows `symbol`'s quotes in `view` until the returned function is called. */
  attach(symbol: SymbolId, view: QuoteView): () => void {
    let views = this.views.get(symbol);
    if (!views) {
      views = new Set();
      this.views.set(symbol, views);
    }
    views.add(view);
    if (this.missing.has(symbol)) view.unavailable();
    const quote = this.quotes.get(symbol);
    if (quote) view.show(quote);
    return () => {
      views.delete(view);
      if (views.size === 0) this.views.delete(symbol);
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.views.clear();
  }

  private markDirty(symbol: SymbolId): void {
    this.dirty.add(symbol);
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      for (const dirty of this.dirty) {
        const quote = this.quotes.get(dirty);
        if (!quote) continue;
        for (const view of this.views.get(dirty) ?? []) view.show(quote);
      }
      this.dirty.clear();
    });
  }
}
