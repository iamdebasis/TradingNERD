import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_STATE, FLAG_COLORS, MAX_FLAGS, parseFlagState } from './flags.ts';

describe('flags', () => {
  it("come in TradingView's seven colors, in its palette's order, red first", () => {
    expect(FLAG_COLORS).toEqual(['red', 'blue', 'green', 'yellow', 'purple', 'cyan', 'pink']);
    expect(DEFAULT_FLAG_STATE).toEqual({ flags: {}, lastColor: 'red' });
  });

  it('keep canonical symbols in known colors, and the last color picked', () => {
    expect(
      parseFlagState({
        flags: {
          'binance:xrpusdt': 'blue',
          'KRAKEN:XBTUSD': 'cyan',
          'BINANCE:LINKUSDT': 'orange', // no such color
          nonsense: 'green',
        },
        lastColor: 'cyan',
      }),
    ).toEqual({ flags: { 'BINANCE:XRPUSDT': 'blue', 'KRAKEN:XBTUSD': 'cyan' }, lastColor: 'cyan' });
    expect(parseFlagState({ flags: {}, lastColor: 'magenta' })).toEqual(DEFAULT_FLAG_STATE);
  });

  it.each([
    ['nothing', null],
    ['no flags', { lastColor: 'red' }],
    ['a list of flags', { flags: ['red'] }],
    [
      'too many flags',
      {
        flags: Object.fromEntries(
          Array.from({ length: MAX_FLAGS + 1 }, (_, i) => [`BINANCE:C${i}USDT`, 'red']),
        ),
      },
    ],
  ])('reject %s', (_label, value) => {
    expect(parseFlagState(value)).toBeNull();
  });
});
