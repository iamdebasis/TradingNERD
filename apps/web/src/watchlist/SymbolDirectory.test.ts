import type { SymbolInfo } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../data/api';
import { SymbolDirectory } from './SymbolDirectory';

const INFO = { id: 'BINANCE:LINKUSDT', pricePrecision: 3 } as SymbolInfo;

describe('SymbolDirectory', () => {
  it('looks each symbol up once', async () => {
    let calls = 0;
    const directory = new SymbolDirectory({
      resolveSymbol: async () => {
        calls++;
        return INFO;
      },
    });
    await Promise.all([directory.lookup(INFO.id), directory.lookup(INFO.id)]);
    expect(await directory.lookup(INFO.id)).toEqual({ state: 'ready', info: INFO });
    expect(calls).toBe(1);
  });

  it('remembers a symbol the exchange does not list', async () => {
    let calls = 0;
    const directory = new SymbolDirectory({
      resolveSymbol: async () => {
        calls++;
        throw new ApiError('unknown_symbol', 'Binance does not list this symbol');
      },
    });
    expect(await directory.lookup('BINANCE:XCHUSDT')).toEqual({
      state: 'unavailable',
      message: 'Binance does not list this symbol',
    });
    await directory.lookup('BINANCE:XCHUSDT');
    expect(calls).toBe(1);
  });

  it('tries again after a lookup that merely failed', async () => {
    let calls = 0;
    const directory = new SymbolDirectory({
      resolveSymbol: async () => {
        calls++;
        if (calls === 1) throw new ApiError('network', 'The local gateway is not reachable');
        return INFO;
      },
    });
    await expect(directory.lookup(INFO.id)).rejects.toThrow('not reachable');
    expect(await directory.lookup(INFO.id)).toEqual({ state: 'ready', info: INFO });
  });
});
