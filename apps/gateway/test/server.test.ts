import type { AddressInfo } from 'node:net';
import { parseServerMessage, type ServerMessage } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { GatewayConfig } from '../src/config.ts';
import { buildServer } from '../src/server.ts';

const UI_ORIGIN = 'http://127.0.0.1:5173';
const config: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  allowedOrigins: [UI_ORIGIN],
  logLevel: 'silent',
};

describe('gateway HTTP', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer(config);
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5180', ...headers },
    });

  it('reports health', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', protocolVersion: 1 });
    expect(Math.abs(res.json().serverTime - Date.now())).toBeLessThan(5_000);
  });

  it('accepts the UI origin', async () => {
    expect((await get({ origin: UI_ORIGIN })).statusCode).toBe(200);
  });

  it('rejects a foreign origin', async () => {
    const res = await get({ origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_origin' });
  });

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const res = await get({ host: 'evil.example:5180' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_host' });
  });

  it('sends no CORS headers', async () => {
    const res = await get({ origin: UI_ORIGIN });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('gateway WebSocket', () => {
  let app: FastifyInstance;
  let url: string;
  beforeAll(async () => {
    app = await buildServer(config);
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });
  afterAll(async () => {
    await app.close();
  });

  /** Opens a socket and returns a reader that yields the next parsed server message. */
  function connect(origin: string) {
    const ws = new WebSocket(url, { origin });
    const queue: ServerMessage[] = [];
    const waiters: ((m: ServerMessage) => void)[] = [];
    ws.on('message', (data) => {
      const msg = parseServerMessage(String(data));
      if (!msg) return;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    const next = () =>
      new Promise<ServerMessage>((resolve) => {
        const queued = queue.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      });
    return { ws, next };
  }

  it('greets with hello and answers ping with pong', async () => {
    const { ws, next } = connect(UI_ORIGIN);
    const hello = await next();
    expect(hello).toMatchObject({ type: 'hello', protocolVersion: 1 });

    ws.send(JSON.stringify({ type: 'ping', t: 42 }));
    expect(await next()).toEqual({ type: 'pong', t: 42 });

    ws.close();
  });

  it('ignores malformed client messages', async () => {
    const { ws, next } = connect(UI_ORIGIN);
    await next(); // hello
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'ping', t: 7 }));
    expect(await next()).toEqual({ type: 'pong', t: 7 });
    ws.close();
  });

  it('refuses the handshake from a foreign origin and hangs up', async () => {
    const ws = new WebSocket(url, { origin: 'https://evil.example' });
    ws.on('error', () => {}); // the aborted handshake is expected
    const result = await new Promise<{ status: number | undefined; closed: boolean }>((resolve) => {
      ws.on('open', () => resolve({ status: 101, closed: false }));
      ws.on('unexpected-response', (_req, res) => {
        // The gateway must close the connection after the 403. If it leaked the socket,
        // 'close' would never fire and this test would time out.
        const done = () => resolve({ status: res.statusCode, closed: true });
        if (res.socket.destroyed) done();
        else res.socket.once('close', done);
        res.resume();
      });
    });
    expect(result).toEqual({ status: 403, closed: true });
  });
});
