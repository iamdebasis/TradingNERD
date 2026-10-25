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

  it('asks the gateway about a formula once each of its symbols has its exchange', async () => {
    const asked: string[] = [];
    const directory = new SymbolDirectory({
      resolveSymbol: async (symbol) => {
        asked.push(symbol);
        return { ...INFO, id: symbol };
      },
    });
    expect((await directory.lookup('CRYPTOCAP:BTC.D+CRYPTOCAP:ETH.D')).state).toBe('ready');
    expect(await directory.lookup('BTC.D+ETH.D')).toEqual({
      state: 'unavailable',
      message: 'Each symbol of BTC.D+ETH.D needs its exchange, like BINANCE:XRPUSDT',
    });
    expect(asked).toEqual(['CRYPTOCAP:BTC.D+CRYPTOCAP:ETH.D']);
  });

  it("keeps the gateway's suggestion for a formula it can't show, known at once after", async () => {
    const fixed = 'CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-CRYPTOCAP:USDC';
    const directory = new SymbolDirectory({
      resolveSymbol: async () => {
        throw new ApiError('unknown_symbol', "EURONEXT:USDC isn't available here", fixed);
      },
    });
    const symbol = 'CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-EURONEXT:USDC';
    expect(directory.known(symbol)).toBeUndefined();
    const lookup = await directory.lookup(symbol);
    expect(lookup).toEqual({
      state: 'unavailable',
      message: "EURONEXT:USDC isn't available here",
      suggestion: fixed,
    });
    expect(directory.known(symbol)).toEqual(lookup);
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
