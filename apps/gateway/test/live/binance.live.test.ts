import { afterAll, describe, expect, it } from 'vitest';
import { BinanceExchange } from '../../src/exchanges/binance/BinanceExchange.ts';
import { MarketService } from '../../src/market/MarketService.ts';

// Talks to the real Binance API. Skipped unless LIVE=1 (run with `pnpm test:live`), so normal
// test runs stay offline and deterministic.
const LIVE = process.env.LIVE === '1';

describe.runIf(LIVE)('Binance, live', () => {
  const market = new MarketService([new BinanceExchange()]);
  afterAll(() => market.close());

  it('resolves XRPUSDT the way TradingView names it', async () => {
    const info = await market.resolveSymbol('BINANCE:XRPUSDT');
    expect(info).toMatchObject({
      id: 'BINANCE:XRPUSDT',
      description: 'XRP / TetherUS',
      pricePrecision: 4,
      tickSize: 0.0001,
    });
  });

  it("serves today's daily bar", async () => {
    const { bars } = await market.getBars('BINANCE:XRPUSDT', '1D', null, 2);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
    expect(bars.at(-1)?.time).toBe(today);
  });

  it('pages all the way back to the 2018 listing', async () => {
    const { bars, hasMore } = await market.getBars('BINANCE:XRPUSDT', '1D', null, 5_000);
    expect(hasMore).toBe(false);
    expect(new Date((bars[0]?.time ?? 0) * 1000).toISOString().slice(0, 10)).toBe('2018-05-04');
    const gaps = bars.slice(1).filter((bar, i) => bar.time - (bars[i]?.time ?? 0) !== 86_400);
    expect(gaps).toEqual([]);
  });

  it('streams a live 1-minute bar and the order book top', async () => {
    const states: string[] = [];
    const closes: number[] = [];
    const quotes: { bid: number; ask: number }[] = [];
    const stopBars = market.subscribeBars('BINANCE:XRPUSDT', '1', {
      onBar: (bar) => closes.push(bar.close),
      onState: (state) => states.push(state),
      onError: (error) => {
        throw error;
      },
    });
    const stopBook = market.subscribeBook('BINANCE:XRPUSDT', {
      onBook: (top) => quotes.push(top),
      onState: () => {},
      onError: (error) => {
        throw error;
      },
    });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && (closes.length < 3 || quotes.length < 3)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stopBars();
    stopBook();
    expect(states).toContain('live');
    expect(closes.length).toBeGreaterThanOrEqual(3);
    expect(quotes.length).toBeGreaterThanOrEqual(3);
    for (const { bid, ask } of quotes) expect(ask).toBeGreaterThanOrEqual(bid);
  }, 30_000);
});
