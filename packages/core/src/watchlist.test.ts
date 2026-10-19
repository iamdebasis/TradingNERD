import { describe, expect, it } from 'vitest';
import { DEFAULT_WATCHLIST, MAX_WATCHLIST_SYMBOLS, parseWatchlist } from './watchlist.ts';

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

describe('parseWatchlist', () => {
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
