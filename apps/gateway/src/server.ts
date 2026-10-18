import websocket from '@fastify/websocket';
import {
  API_PREFIX,
  type HealthResponse,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
  WS_PATH,
} from '@tradingnerd/core';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import type { GatewayConfig } from './config.ts';
import { isAllowedOrigin, isLoopbackHost } from './security.ts';

interface MessageSink {
  send(data: string): void;
}

export async function buildServer(config: GatewayConfig): Promise<FastifyInstance> {
  const startedAt = Date.now();
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Must be registered before the guard below: the plugin's own onRequest hook marks WebSocket
  // handshakes, which is what makes it close the socket after the guard rejects one. In the
  // other order a rejected handshake would leave its connection open.
  await app.register(websocket);

  // Runs before routing, so it covers REST calls and WebSocket handshakes alike.
  app.addHook('onRequest', async (request, reply) => {
    if (!isLoopbackHost(request.headers.host)) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    if (!isAllowedOrigin(request.headers.origin, config.allowedOrigins)) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
  });

  app.get(
    `${API_PREFIX}/health`,
    async (): Promise<HealthResponse> => ({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      serverTime: Date.now(),
    }),
  );

  app.get(WS_PATH, { websocket: true }, (socket) => {
    send(socket, { type: 'hello', protocolVersion: PROTOCOL_VERSION, serverTime: Date.now() });
    socket.on('message', (data) => {
      const msg = parseClientMessage(rawToText(data));
      if (msg?.type === 'ping') send(socket, { type: 'pong', t: msg.t });
    });
  });

  return app;
}

function send(socket: MessageSink, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function rawToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
