import { type Bar, barOpenTime } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { BINANCE_DEFAULTS, BinanceExchange } from '../../src/exchanges/binance/BinanceExchange.ts';
import {
  BITSTAMP_DEFAULTS,
  BitstampExchange,
} from '../../src/exchanges/bitstamp/BitstampExchange.ts';
import { BYBIT_DEFAULTS, BybitExchange } from '../../src/exchanges/bybit/BybitExchange.ts';
import {
  COINBASE_DEFAULTS,
  CoinbaseExchange,
} from '../../src/exchanges/coinbase/CoinbaseExchange.ts';
import { KRAKEN_DEFAULTS, KrakenExchange } from '../../src/exchanges/kraken/KrakenExchange.ts';
import { OKX_DEFAULTS, OkxExchange } from '../../src/exchanges/okx/OkxExchange.ts';
import { MarketService } from '../../src/market/MarketService.ts';
import type { ExchangeAdapter } from '../../src/market/types.ts';
import { streamRelay } from '../helpers/StreamRelay.ts';

// docs/SPEC.md §8, M5: "30 s offline recovers with no missing candles", against the real
// exchanges. Skipped unless LIVE=1 (`pnpm test:live`). Production reconnect timings throughout.
const LIVE = process.env.LIVE === '1';
const OUTAGE_MS = 30_000;
const MINUTE = { count: 1, unit: 'minute' } as const;

interface Case {
  name: string;
  symbol: string;
  upstreams: string[];
  adapter(relays: string[]): ExchangeAdapter;
}

const CASES: Case[] = [
  {
    name: 'Binance',
    symbol: 'BINANCE:XRPUSDT',
    upstreams: [BINANCE_DEFAULTS.streamUrl],
    adapter: ([url]) => new BinanceExchange({ streamUrl: url }),
  },
  {
    name: 'Bybit',
    symbol: 'BYBIT:XRPUSDT',
    upstreams: [BYBIT_DEFAULTS.streamUrl],
    adapter: ([url]) => new BybitExchange({ streamUrl: url }),
  },
  {
    name: 'OKX',
    symbol: 'OKX:XRPUSDT',
    upstreams: [OKX_DEFAULTS.streamUrl, OKX_DEFAULTS.businessStreamUrl],
    adapter: ([url, business]) => new OkxExchange({ streamUrl: url, businessStreamUrl: business }),
  },
  {
    name: 'Coinbase',
    symbol: 'COINBASE:XRPUSD',
    upstreams: [COINBASE_DEFAULTS.streamUrl],
    adapter: ([url]) => new CoinbaseExchange({ streamUrl: url }),
  },
  {
    name: 'Kraken',
    symbol: 'KRAKEN:XBTUSD',
    upstreams: [KRAKEN_DEFAULTS.streamUrl],
    adapter: ([url]) => new KrakenExchange({ streamUrl: url }),
  },
  {
    name: 'Bitstamp',
    symbol: 'BITSTAMP:BTCUSD',
    upstreams: [BITSTAMP_DEFAULTS.streamUrl],
    adapter: ([url]) => new BitstampExchange({ streamUrl: url }),
  },
];

async function until(done: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 250));
}

async function outage(c: Case) {
  const relays = await Promise.all(c.upstreams.map((url) => streamRelay(url)));
  const market = new MarketService([c.adapter(relays.map((relay) => relay.url))]);
  const states: string[] = [];
  const bars: Bar[] = [];
  const stop = market.subscribeBars(c.symbol, '1', {
    onBar: (bar) => bars.push(bar),
    onState: (state) => states.push(state),
    onError: (error) => states.push(`error: ${error.message}`),
  });
  try {
    await until(() => states.at(-1) === 'live' && bars.length > 0, 30_000);
    expect(states.at(-1), `${c.name} went live`).toBe('live');

    const before = states.length;
    await Promise.all(relays.map((relay) => relay.cut(OUTAGE_MS)));
    const during = states.slice(before);
    expect(during, `${c.name} noticed the outage`).toContain('reconnecting');
    expect(during, `${c.name} never claimed to be live while cut off`).not.toContain('live');
    const restored = Date.now();
    await until(() => states.at(-1) === 'live', 60_000);
    expect(states.at(-1), `${c.name} recovered`).toBe('live');
    const recoveredMs = Date.now() - restored;

    // No candle missing: every minute through the outage, up to the live one.
    const nowMinute = barOpenTime(MINUTE, Date.now()) / 1000;
    const { bars: history } = await market.getBars(c.symbol, '1', null, 15);
    const missing = history
      .slice(1)
      .filter((bar, i) => bar.time - (history[i] as Bar).time !== 60)
      .map((bar) => new Date(bar.time * 1000).toISOString());
    expect(missing, `${c.name} minutes missing`).toEqual([]);
    expect(history.at(-1)?.time).toBe(nowMinute);
    expect(history[0]?.time).toBeLessThanOrEqual(nowMinute - 14 * 60);
    // And the live bar is the current minute again.
    await until(() => (bars.at(-1)?.time ?? 0) >= nowMinute, 15_000);
    expect(bars.at(-1)?.time, `${c.name} live bar`).toBeGreaterThanOrEqual(nowMinute);
    return { name: c.name, recoveredMs };
  } finally {
    stop();
    await market.close();
    await Promise.all(relays.map((relay) => relay.close()));
  }
}

describe.runIf(LIVE)('30 s offline', () => {
  it('every exchange recovers on its own, with no missing candles', async () => {
    const results = await Promise.all(CASES.map(outage));
    console.log(
      results
        .map(({ name, recoveredMs }) => `${name} live ${recoveredMs} ms after the outage`)
        .join('\n'),
    );
  }, 180_000);
});
