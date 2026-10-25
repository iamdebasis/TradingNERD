import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATCHLIST,
  MAX_WATCHLIST_SYMBOL,
  MAX_WATCHLIST_SYMBOLS,
  parseWatchlist,
  parseWatchlistSymbol,
} from './watchlist.ts';

const section = (symbols: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'crypto',
  title: 'Crypto',
  collapsed: false,
  symbols,
  ...extra,
});

describe('the default watchlist', () => {
  it("holds the user's TradingView coins on Binance, XRP first", () => {
    const [crypto] = DEFAULT_WATCHLIST.sections;
    expect(crypto?.title).toBe('Crypto');
    expect(crypto?.symbols[0]).toBe('BINANCE:XRPUSDT');
    expect(crypto?.symbols).toHaveLength(22);
    expect(crypto?.symbols).not.toContain('BINANCE:XCHUSDT'); // not listed on Binance
  });

  it('is valid and already normalized', () => {
    expect(parseWatchlist(DEFAULT_WATCHLIST)).toEqual(DEFAULT_WATCHLIST);
  });
});

describe('a watchlist symbol', () => {
  it('is canonical when it has our shape, and kept as written when it is TradingView-only', () => {
    expect(parseWatchlistSymbol(' binance:xrpusdt ')).toBe('BINANCE:XRPUSDT');
    expect(parseWatchlistSymbol('GLASSNODE:BTC_HASHRATE')).toBe('GLASSNODE:BTC_HASHRATE');
    expect(parseWatchlistSymbol('CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD')).toBe(
      'CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD',
    );
    expect(parseWatchlistSymbol('CME_MINI:ES1!')).toBe('CME_MINI:ES1!');
  });

  it("keeps a formula of TradingView's 10 symbols", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `CRYPTOCAP:COIN${i}.D`).join('+');
    expect(ten.length).toBeGreaterThan(128);
    expect(parseWatchlistSymbol(ten)).toBe(ten);
  });

  it.each([
    ['no exchange prefix', 'XRPUSDT'],
    ['an empty symbol', 'BINANCE:'],
    ['a comma', 'A:B,C'],
    ['a line break', 'A:B\nC'],
    ['a section marker', '###A:B'],
    ['too long', `X:${'Y'.repeat(MAX_WATCHLIST_SYMBOL - 1)}`],
  ])('refuses %s', (_label, value) => {
    expect(parseWatchlistSymbol(value)).toBeNull();
  });
});

describe('parseWatchlist', () => {
  it("keeps TradingView's symbols that we don't chart, and an untitled first section", () => {
    const list = parseWatchlist({
      sections: [section(['CRYPTOCAP:BTC.D', 'OTC:NTDOY', 'cboe:sixt'], { title: '' })],
    });
    expect(list?.sections[0]).toMatchObject({
      title: '',
      symbols: ['CRYPTOCAP:BTC.D', 'OTC:NTDOY', 'CBOE:SIXT'],
    });
  });

  it('canonicalizes symbol ids and keeps each symbol once, in its first place', () => {
    const list = parseWatchlist({
      sections: [
        section(['binance:xrpusdt', 'BINANCE:LINKUSDT', 'BINANCE:XRPUSDT']),
        section(['BINANCE:LINKUSDT', 'BINANCE:OPUSDT'], { id: 'more', title: '  Alts  ' }),
      ],
    });
    expect(list?.sections.map((s) => [s.title, s.symbols])).toEqual([
      ['Crypto', ['BINANCE:XRPUSDT', 'BINANCE:LINKUSDT']],
      ['Alts', ['BINANCE:OPUSDT']],
    ]);
  });

  it.each([
    ['nothing', null],
    ['no sections', {}],
    ['a section without symbols', { sections: [{ id: 'a', title: 'A', collapsed: false }] }],
    ['a bad symbol', { sections: [section(['XRPUSDT'])] }],
    ['a duplicate section id', { sections: [section([]), section([])] }],
    ['a non-boolean collapsed flag', { sections: [section([], { collapsed: 'yes' })] }],
    ['a huge title', { sections: [section([], { title: 'x'.repeat(65) })] }],
    [
      'too many symbols',
      {
        sections: [
          section(Array.from({ length: MAX_WATCHLIST_SYMBOLS + 1 }, (_, i) => `BINANCE:C${i}USDT`)),
        ],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseWatchlist(value)).toBeNull();
  });
});
