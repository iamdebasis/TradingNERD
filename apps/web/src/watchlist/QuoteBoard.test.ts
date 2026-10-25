import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteHandlers, QuoteSource } from '../data/GatewayConnection';
import { type Quote, QuoteBoard } from './QuoteBoard';

class FakeQuotes implements QuoteSource {
  readonly handlers = new Map<string, QuoteHandlers>();
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  subscribeQuotes(symbol: string, handlers: QuoteHandlers) {
    this.handlers.set(symbol, handlers);
    this.subscribed.push(symbol);
    return () => {
      this.handlers.delete(symbol);
      this.unsubscribed.push(symbol);
    };
  }
}

let frames: FrameRequestCallback[] = [];
const runFrame = () => {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

function view() {
  const shown: Quote[] = [];
  let missing = false;
  return {
    shown,
    missing: () => missing,
    view: {
      show: (quote: Quote) => shown.push(quote),
      unavailable: () => {
        missing = true;
      },
    },
  };
}

describe('QuoteBoard', () => {
  it('subscribes to exactly the symbols in the list', () => {
    const quotes = new FakeQuotes();
    const board = new QuoteBoard(quotes);
    board.setSymbols(['X:A', 'X:B']);
    board.setSymbols(['X:B', 'X:C']);
    expect(quotes.subscribed).toEqual(['X:A', 'X:B', 'X:C']);
    expect(quotes.unsubscribed).toEqual(['X:A']);
    board.dispose();
    expect(quotes.unsubscribed).toEqual(['X:A', 'X:B', 'X:C']);
  });

  it('paints each row once per frame with its latest quote', () => {
    const quotes = new FakeQuotes();
    const board = new QuoteBoard(quotes);
    board.setSymbols(['X:A']);
    const row = view();
    board.attach('X:A', row.view);
    quotes.handlers.get('X:A')?.onQuote(1, 0.9);
    quotes.handlers.get('X:A')?.onQuote(1.1, 0.9);
    expect(row.shown).toEqual([]);
    runFrame();
    expect(row.shown).toEqual([{ last: 1.1, prevClose: 0.9 }]);
    runFrame();
    expect(row.shown).toHaveLength(1);
  });

  it('catches up a row that appears later, and stops painting one that left', () => {
    const quotes = new FakeQuotes();
    const board = new QuoteBoard(quotes);
    board.setSymbols(['X:A']);
    quotes.handlers.get('X:A')?.onQuote(2, null);
    runFrame();
    const late = view();
    const detach = board.attach('X:A', late.view);
    expect(late.shown).toEqual([{ last: 2, prevClose: null }]);
    detach();
    quotes.handlers.get('X:A')?.onQuote(3, null);
    runFrame();
    expect(late.shown).toHaveLength(1);
  });

  it('marks a symbol the exchange does not list as unavailable', () => {
    const quotes = new FakeQuotes();
    const board = new QuoteBoard(quotes);
    board.setSymbols(['X:GONE']);
    const row = view();
    board.attach('X:GONE', row.view);
    quotes.handlers.get('X:GONE')?.onError('unknown_symbol', 'Not listed');
    expect(row.missing()).toBe(true);
    const later = view();
    board.attach('X:GONE', later.view);
    expect(later.missing()).toBe(true);
  });

  it("quotes a formula of exchanges' symbols, not one of bare tickers", () => {
    const quotes = new FakeQuotes();
    const board = new QuoteBoard(quotes);
    board.setSymbols(['CRYPTOCAP:TOTAL-CRYPTOCAP:TOTAL2', 'BINANCE:XRPUSDT*2', 'TOTAL-TOTAL2']);
    expect(quotes.subscribed).toEqual(['CRYPTOCAP:TOTAL-CRYPTOCAP:TOTAL2', 'BINANCE:XRPUSDT*2']);
    const bare = view();
    board.attach('TOTAL-TOTAL2', bare.view);
    expect(bare.missing()).toBe(true);
  });
});
