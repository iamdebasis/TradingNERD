import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { type RawData, WebSocketServer } from 'ws';

/**
 * A local stand-in in front of an exchange's real stream, relaying frames both ways, that can
 * cut like a network outage: open links drop, and new connections are refused (the handshake
 * fails, so no connection ever opens) until it's restored.
 */
export async function streamRelay(upstreamUrl: string) {
  let down = false;
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, accept) => accept(!down, 503),
  });
  await once(wss, 'listening');
  const links = new Set<WebSocket>();
  const frame = (data: RawData, binary: boolean) => (binary ? data : data.toString());

  wss.on('connection', (client) => {
    const upstream = new WebSocket(upstreamUrl);
    const waiting: (string | RawData)[] = [];
    links.add(client).add(upstream);
    const end = () => {
      links.delete(client);
      links.delete(upstream);
      client.terminate();
      upstream.terminate();
    };
    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame(data, binary));
      else waiting.push(frame(data, binary));
    });
    upstream.on('open', () => {
      for (const queued of waiting.splice(0)) upstream.send(queued);
    });
    upstream.on('message', (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(frame(data, binary));
    });
    for (const socket of [client, upstream]) {
      socket.on('close', end);
      socket.on('error', end);
    }
  });

  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    /** Drops every link and refuses new ones for `ms`; resolves when it's back. */
    async cut(ms: number): Promise<void> {
      down = true;
      for (const socket of [...links]) socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, ms));
      down = false;
    },
    async close() {
      for (const socket of [...links]) socket.terminate();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
