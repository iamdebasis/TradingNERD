import { isObject } from '../../catalog/http.ts';
import { parseFrame, type StreamProtocol, type StreamUpdate } from '../../stream/StreamClient.ts';

/** A topic for Coinbase's stream: "market_trades:XRP-USD", "ticker:XRP-USD". */
export const coinbaseTopic = (channel: string, productId: string) => `${channel}:${productId}`;

/** Topics grouped by channel: Coinbase subscribes one channel at a time, for many products. */
function byChannel(topics: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const topic of topics) {
    const at = topic.indexOf(':');
    const channel = topic.slice(0, at);
    groups.set(channel, [...(groups.get(channel) ?? []), topic.slice(at + 1)]);
  }
  return groups;
}

const messages = (type: 'subscribe' | 'unsubscribe', topics: readonly string[]) =>
  [...byChannel(topics)].map(([channel, products]) =>
    JSON.stringify({ type, channel, product_ids: products }),
  );

/**
 * Coinbase Advanced Trade's public stream. One frame can carry several products' updates, so
 * frames are split per product. The heartbeats channel keeps a quiet connection open.
 */
export function coinbaseProtocol(): StreamProtocol {
  return {
    name: 'Coinbase',
    maxTopicsPerMessage: 50,
    subscribe: (topics) => messages('subscribe', topics),
    unsubscribe: (topics) => messages('unsubscribe', topics),
    pingMessage: null,
    onOpen: () => [JSON.stringify({ type: 'subscribe', channel: 'heartbeats' })],
    route(text, warn) {
      const message = parseFrame(text, 'Coinbase', warn);
      if (!message) return [];
      if (message.type === 'error') {
        warn(`Coinbase rejected a request: ${String(message.message)}`);
        return [];
      }
      const { channel, events } = message;
      if (!Array.isArray(events)) return [];
      const updates: StreamUpdate[] = [];
      for (const event of events) {
        if (!isObject(event)) continue;
        if (channel === 'market_trades' && Array.isArray(event.trades)) {
          // One update per product, with that product's trades only.
          const byProduct = new Map<string, unknown[]>();
          for (const trade of event.trades) {
            if (!isObject(trade) || typeof trade.product_id !== 'string') continue;
            byProduct.set(trade.product_id, [...(byProduct.get(trade.product_id) ?? []), trade]);
          }
          for (const [product, trades] of byProduct) {
            updates.push({
              topic: coinbaseTopic('market_trades', product),
              data: { type: event.type, trades },
            });
          }
        } else if (channel === 'ticker' && Array.isArray(event.tickers)) {
          for (const ticker of event.tickers) {
            if (isObject(ticker) && typeof ticker.product_id === 'string') {
              updates.push({ topic: coinbaseTopic('ticker', ticker.product_id), data: ticker });
            }
          }
        }
      }
      return updates;
    },
  };
}
