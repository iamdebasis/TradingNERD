import { PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@tradingnerd/core';
import type { RawData, WebSocket } from 'ws';
import type { MarketService } from '../market/MarketService.ts';
import type { MarketError, Unsubscribe } from '../market/types.ts';

export interface SessionOptions {
  /** Most live subscriptions one UI connection may hold. */
  maxSubscriptions?: number;
}

/** Serves one UI WebSocket: greets it, routes its subscriptions, and cleans up when it closes. */
export function attachSession(
  socket: WebSocket,
  market: MarketService,
  options: SessionOptions = {},
): void {
  // A full watchlist plus the chart's own feeds.
  const maxSubscriptions = options.maxSubscriptions ?? 200;
  const subscriptions = new Map<string, Unsubscribe>();

  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, serverTime: Date.now() });

  socket.on('message', (data) => {
    const message = parseClientMessage(rawToText(data));
    if (!message) {
      send({ type: 'error', id: null, code: 'bad_request', message: 'Malformed message' });
      return;
    }
    switch (message.type) {
      case 'ping':
        send({ type: 'pong', t: message.t });
        return;
      case 'unsubscribe':
        subscriptions.get(message.id)?.();
        subscriptions.delete(message.id);
        return;
      case 'subscribe': {
        const { id } = message;
        if (subscriptions.has(id)) {
          send({ type: 'error', id, code: 'bad_request', message: `Subscription "${id}" exists` });
          return;
        }
        if (subscriptions.size >= maxSubscriptions) {
          send({
            type: 'error',
            id,
            code: 'too_many_subscriptions',
            message: `At most ${maxSubscriptions} live subscriptions per connection`,
          });
          return;
        }
        const handlers = {
          onState: (state: 'live' | 'reconnecting') => send({ type: 'status', id, state }),
          onError: (error: MarketError) => {
            subscriptions.get(id)?.();
            subscriptions.delete(id);
            send({ type: 'error', id, code: error.code, message: error.message });
          },
        };
        let unsubscribe: Unsubscribe;
        switch (message.channel) {
          case 'bars':
            unsubscribe = market.subscribeBars(message.symbol, message.resolution, {
              ...handlers,
              onBar: (bar, historical) => send({ type: 'bar', id, bar, historical }),
            });
            break;
          case 'book':
            unsubscribe = market.subscribeBook(message.symbol, {
              ...handlers,
              onBook: ({ bid, ask }) => send({ type: 'book', id, bid, ask }),
            });
            break;
          case 'quotes':
            unsubscribe = market.subscribeQuote(message.symbol, {
              ...handlers,
              onQuote: (last, prevClose) => send({ type: 'quote', id, last, prevClose }),
            });
            break;
        }
        subscriptions.set(id, unsubscribe);
        return;
      }
    }
  });

  socket.on('close', () => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });
}

function rawToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
