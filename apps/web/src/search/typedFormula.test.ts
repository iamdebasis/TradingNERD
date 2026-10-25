import { parseFormula, type SymbolMatch, type SymbolSearchResponse } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '../data/api';
import { SymbolFinder } from './typedFormula';

const match = (ticker: string, ...ids: [string, boolean][]): SymbolMatch => ({
  ticker,
  base: ticker,
  quote: '',
  description: ticker,
  type: 'spot',
  listings: ids.map(([id, live]) => ({ id, exchange: id.split(':')[0] as string, live })),
});

/** A search answering from `pages`, keeping each query it's asked. */
function searching(pages: Record<string, SymbolMatch[]>) {
  const asked: string[] = [];
  const api = {
    async search(request: SearchRequest): Promise<SymbolSearchResponse> {
      asked.push(request.query);
      const matches = pages[request.query];
      if (!matches) throw new Error('offline');
      return { matches, hasMore: false };
    },
  };
  return { api, asked };
}

const typed = (text: string) => {
  const formula = parseFormula(text);
  if (!formula) throw new Error(`not a formula: ${text}`);
  return formula;
};

describe('finding the exchange of symbols typed without one', () => {
  it("takes the search's first listing of the very ticker typed, each looked up once", async () => {
    const { api, asked } = searching({
      TOTAL2: [match('TOTAL2', ['CRYPTOCAP:TOTAL2', true])],
      XRPUSD: [
        match('XRPUSDT', ['BINANCE:XRPUSDT', true]),
        match('XRPUSD', ['COINBASE:XRPUSD', true], ['KRAKEN:XRPUSD', true]),
      ],
    });
    const finder = new SymbolFinder(api);
    const done = await finder.complete(typed('total2 / xrpusd'));
    expect(done).toMatchObject({
      state: 'ready',
      formula: { text: 'CRYPTOCAP:TOTAL2/COINBASE:XRPUSD', name: 'TOTAL2/XRPUSD' },
    });
    await finder.complete(typed('TOTAL2*2/XRPUSD'));
    expect(asked).toEqual(['TOTAL2', 'XRPUSD']);
  });

  it('leaves symbols with their exchange as they are, asking nothing', async () => {
    const { api, asked } = searching({});
    const done = await new SymbolFinder(api).complete(typed('BINANCE:BTCUSDT/BINANCE:ETHUSDT'));
    expect(done).toMatchObject({
      state: 'ready',
      formula: { text: 'BINANCE:BTCUSDT/BINANCE:ETHUSDT' },
    });
    expect(asked).toEqual([]);
  });

  it('takes the first match when none has the very ticker', async () => {
    const { api } = searching({ ETH: [match('ETHUSDT', ['BINANCE:ETHUSDT', true])] });
    const done = await new SymbolFinder(api).complete(typed('BINANCE:BTCUSDT / ETH'));
    expect(done.state === 'ready' && done.formula.text).toBe('BINANCE:BTCUSDT/BINANCE:ETHUSDT');
  });

  it("says which symbol isn't there, or can't be charted yet", async () => {
    const { api } = searching({
      NOPE: [],
      LISTED: [match('LISTED', ['BITSTAMP:LISTED', false])],
    });
    const finder = new SymbolFinder(api);
    expect(await finder.complete(typed('BINANCE:BTCUSDT / NOPE'))).toMatchObject({
      state: 'missing',
      message: 'No symbol NOPE here',
    });
    expect(await finder.complete(typed('LISTED*2'))).toMatchObject({
      state: 'missing',
      message: 'No symbol LISTED here',
    });
  });

  it('says so when the search fails, and asks again next time', async () => {
    const pages: Record<string, SymbolMatch[]> = {};
    const { api, asked } = searching(pages);
    const finder = new SymbolFinder(api);
    expect(await finder.complete(typed('XRP*2'))).toMatchObject({
      state: 'missing',
      message: 'Symbol search failed',
    });
    pages.XRP = [match('XRP', ['CRYPTOCAP:XRP', true])];
    expect((await finder.complete(typed('XRP*2'))).state).toBe('ready');
    expect(asked).toEqual(['XRP', 'XRP']);
  });

  it('refuses a formula that grows past 256 characters with its exchanges', async () => {
    const tickers = Array.from({ length: 10 }, (_, i) => `T${i}${'X'.repeat(14)}`);
    const pages = Object.fromEntries(
      tickers.map((ticker) => [ticker, [match(ticker, [`LONGEXCHANGE:${ticker}`, true])]]),
    );
    const done = await new SymbolFinder(searching(pages).api).complete(typed(tickers.join('+')));
    expect(done).toMatchObject({
      state: 'missing',
      message: 'A formula is at most 256 characters',
    });
  });
});
