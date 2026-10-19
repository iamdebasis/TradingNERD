import { parseFrame, type StreamProtocol } from '../../stream/StreamClient.ts';

/** A topic for OKX's stream: "candle1m:XRP-USDT", "trades:XRP-USDT". */
export const okxTopic = (channel: string, instId: string) => `${channel}:${instId}`;

function args(topics: readonly string[]) {
  return topics.map((topic) => {
    const at = topic.indexOf(':');
    return { channel: topic.slice(0, at), instId: topic.slice(at + 1) };
  });
}

/**
 * OKX's v5 stream (the public and business endpoints speak the same way): subscribe with
 * `{channel, instId}` arguments; it wants the text "ping" within every 30 s and answers "pong".
 */
export function okxProtocol(): StreamProtocol {
  return {
    name: 'OKX',
    maxTopicsPerMessage: 50,
    subscribe: (topics) => [JSON.stringify({ op: 'subscribe', args: args(topics) })],
    unsubscribe: (topics) => [JSON.stringify({ op: 'unsubscribe', args: args(topics) })],
    pingMessage: 'ping',
    route(text, warn) {
      if (text === 'pong') return [];
      const message = parseFrame(text, 'OKX', warn);
      if (!message) return [];
      const { arg, data, event } = message;
      if (event === 'error') warn(`OKX rejected a request: ${String(message.msg)}`);
      if (event !== undefined || !Array.isArray(data)) return [];
      if (typeof arg !== 'object' || arg === null) return [];
      const { channel, instId } = arg as Record<string, unknown>;
      if (typeof channel !== 'string' || typeof instId !== 'string') return [];
      return [{ topic: okxTopic(channel, instId), data: message }];
    },
  };
}
