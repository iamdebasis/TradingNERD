import { parseFrame, type StreamProtocol, type StreamUpdate } from '../../stream/StreamClient.ts';

/** Bitstamp's channels, which are the client's topics: "live_trades_xrpusd". */
export const bitstampChannel = {
  trades: (pair: string) => `live_trades_${pair}`,
  book: (pair: string) => `order_book_${pair}`,
};

const frames = (event: string, channels: readonly string[]) =>
  channels.map((channel) => JSON.stringify({ event, data: { channel } }));

/**
 * Bitstamp's public stream, WebSocket API v2: a channel a message, each update naming its
 * channel. Bitstamp answers a subscription to a pair it doesn't list as if it did, so pairs are
 * looked up before they're streamed. Its own heartbeat keeps a quiet connection open. When it
 * asks for a reconnect (before maintenance) it then closes the connection, which reconnects.
 */
export function bitstampProtocol(): StreamProtocol {
  return {
    name: 'Bitstamp',
    maxTopicsPerMessage: 20,
    subscribe: (topics) => frames('bts:subscribe', topics),
    unsubscribe: (topics) => frames('bts:unsubscribe', topics),
    pingMessage: JSON.stringify({ event: 'bts:heartbeat' }),
    route(text, warn): StreamUpdate[] {
      const message = parseFrame(text, 'Bitstamp', warn);
      if (!message) return [];
      const { event, channel, data } = message;
      if ((event === 'trade' || event === 'data') && typeof channel === 'string') {
        return [{ topic: channel, data }];
      }
      if (event === 'bts:error') {
        const detail = typeof data === 'object' && data !== null ? JSON.stringify(data) : '';
        warn(`Bitstamp rejected a request ${detail}`.trim());
      } else if (event === 'bts:request_reconnect') {
        warn('Bitstamp asked for a reconnect (maintenance); it reconnects when Bitstamp closes');
      }
      return [];
    },
  };
}
