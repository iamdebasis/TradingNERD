import { isObject } from '../../catalog/http.ts';
import { parseFrame, type StreamProtocol, type StreamUpdate } from '../../stream/StreamClient.ts';

/** Topics for Kraken's v2 stream: "ohlc:1440:XRP/USD", "trade:XRP/USD", "ticker:XRP/USD". */
export const krakenTopic = {
  ohlc: (interval: string, symbol: string) => `ohlc:${interval}:${symbol}`,
  trade: (symbol: string) => `trade:${symbol}`,
  ticker: (symbol: string) => `ticker:${symbol}`,
};

/** Subscriptions grouped as Kraken takes them: one channel (and candle interval) a message. */
function groups(topics: readonly string[]): Map<string, { params: Json; symbols: string[] }> {
  const byKey = new Map<string, { params: Json; symbols: string[] }>();
  for (const topic of topics) {
    const parts = topic.split(':');
    const channel = parts[0] ?? '';
    const symbol = parts.at(-1) ?? '';
    const key = parts.slice(0, -1).join(':');
    const params: Json = channel === 'ohlc' ? { channel, interval: Number(parts[1]) } : { channel };
    const group = byKey.get(key) ?? { params, symbols: [] };
    group.symbols.push(symbol);
    byKey.set(key, group);
  }
  return byKey;
}

type Json = Record<string, unknown>;

/**
 * Kraken's WebSocket v2: subscribe per channel with a list of symbols. Candle and trade
 * snapshots are turned off (REST history covers them); the ticker fires on every change of
 * the best bid or ask. It sends a heartbeat every second and answers `{"method":"ping"}`.
 */
export function krakenProtocol(): StreamProtocol {
  return {
    name: 'Kraken',
    maxTopicsPerMessage: 50,
    subscribe: (topics, id) =>
      [...groups(topics).values()].map(({ params, symbols }) =>
        JSON.stringify({
          method: 'subscribe',
          params: {
            ...params,
            symbol: symbols,
            ...(params.channel === 'ticker' ? { event_trigger: 'bbo' } : { snapshot: false }),
          },
          req_id: id,
        }),
      ),
    unsubscribe: (topics, id) =>
      [...groups(topics).values()].map(({ params, symbols }) =>
        JSON.stringify({
          method: 'unsubscribe',
          params: { ...params, symbol: symbols },
          req_id: id,
        }),
      ),
    pingMessage: JSON.stringify({ method: 'ping' }),
    route(text, warn) {
      const message = parseFrame(text, 'Kraken', warn);
      if (!message) return [];
      if (message.method !== undefined) {
        if (message.success === false) warn(`Kraken rejected a request: ${String(message.error)}`);
        return [];
      }
      const { channel, data, timestamp } = message;
      if (!Array.isArray(data)) return [];
      const updates: StreamUpdate[] = [];
      for (const item of data) {
        if (!isObject(item) || typeof item.symbol !== 'string') continue;
        if (channel === 'ohlc' && typeof item.interval === 'number') {
          updates.push({
            topic: krakenTopic.ohlc(String(item.interval), item.symbol),
            data: { item, timestamp },
          });
        } else if (channel === 'trade') {
          updates.push({ topic: krakenTopic.trade(item.symbol), data: item });
        } else if (channel === 'ticker') {
          updates.push({ topic: krakenTopic.ticker(item.symbol), data: item });
        }
      }
      return updates;
    },
  };
}
