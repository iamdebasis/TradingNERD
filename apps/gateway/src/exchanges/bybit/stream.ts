import { parseFrame, type StreamProtocol } from '../../stream/StreamClient.ts';

/**
 * Bybit's v5 public spot stream: topics are Bybit's own ("kline.1.XRPUSDT"), at most 10 per
 * subscribe request, and it wants `{"op":"ping"}` every 20 s.
 */
export function bybitProtocol(): StreamProtocol {
  return {
    name: 'Bybit',
    maxTopicsPerMessage: 10,
    subscribe: (args, id) => [JSON.stringify({ req_id: String(id), op: 'subscribe', args })],
    unsubscribe: (args, id) => [JSON.stringify({ req_id: String(id), op: 'unsubscribe', args })],
    pingMessage: JSON.stringify({ op: 'ping' }),
    route(text, warn) {
      const message = parseFrame(text, 'Bybit', warn);
      if (!message) return [];
      if (typeof message.topic === 'string') return [{ topic: message.topic, data: message }];
      if (message.success === false) warn(`Bybit rejected a request: ${String(message.ret_msg)}`);
      return [];
    },
  };
}
