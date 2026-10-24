import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * A stand-in for an exchange's WebSocket endpoint: records every frame the client sends
 * (parsed as JSON when it is) and the path each connection asked for, greets new connections
 * with `greeting` when given, answers with `reply`, and lets a test push frames or drop the
 * connection.
 */
export async function mockStreamServer(
  reply: (frame: unknown, send: (data: unknown) => void) => void = () => {},
  greeting?: unknown,
) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const connections: WebSocket[] = [];
  const received: unknown[] = [];
  const paths: string[] = [];
  let refusing = false;
  wss.on('connection', (socket, request) => {
    if (refusing) {
      socket.terminate();
      return;
    }
    connections.push(socket);
    paths.push(request.url ?? '');
    if (greeting !== undefined) socket.send(JSON.stringify(greeting));
    socket.on('message', (data) => {
      const text = String(data);
      let frame: unknown = text;
      try {
        frame = JSON.parse(text);
      } catch {
        // plain text, like OKX's "ping"
      }
      received.push(frame);
      reply(frame, (answer) =>
        socket.send(typeof answer === 'string' ? answer : JSON.stringify(answer)),
      );
    });
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    connections,
    received,
    paths,
    /** Sends a frame to every open connection. */
    push(data: unknown) {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      for (const socket of connections) if (socket.readyState === socket.OPEN) socket.send(text);
    },
    dropAll() {
      for (const socket of connections) socket.terminate();
    },
    /** While true, new connections are cut at once, like an exchange that can't be reached. */
    refuse(value: boolean) {
      refusing = value;
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

export type MockStreamServer = Awaited<ReturnType<typeof mockStreamServer>>;
