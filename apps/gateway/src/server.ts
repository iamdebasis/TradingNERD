import websocket from '@fastify/websocket';
import {
  API_PREFIX,
  type ApiErrorBody,
  type HealthResponse,
  PROTOCOL_VERSION,
  WS_PATH,
} from '@tradingnerd/core';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import type { SymbolCatalog } from './catalog/SymbolCatalog.ts';
import type { GatewayConfig } from './config.ts';
import type { LogoService } from './logos/LogoService.ts';
import type { MarketService } from './market/MarketService.ts';
import { MarketError } from './market/types.ts';
import { registerFlagRoutes } from './routes/flags.ts';
import { registerLogoRoutes } from './routes/logos.ts';
import { registerMarketRoutes } from './routes/market.ts';
import { registerSymbolRoutes } from './routes/symbols.ts';
import { registerWatchlistRoutes } from './routes/watchlist.ts';
import { isAllowedOrigin, isLoopbackHost } from './security.ts';
import type { FlagStore } from './storage/FlagStore.ts';
import type { WatchlistStore } from './storage/WatchlistStore.ts';
import { attachSession } from './ws/session.ts';

export interface GatewayDeps {
  market: MarketService;
  catalog: SymbolCatalog;
  watchlist: WatchlistStore;
  flags: FlagStore;
  logos: LogoService;
}

export async function buildServer(
  config: GatewayConfig,
  deps: GatewayDeps,
): Promise<FastifyInstance> {
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MarketError) {
      const body: ApiErrorBody = { error: error.code, message: error.message };
      return reply.code(error.httpStatus).send(body);
    }
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const body: ApiErrorBody = { error: 'bad_request', message: (error as Error).message };
      return reply.code(status).send(body);
    }
    request.log.error(error);
    const body: ApiErrorBody = { error: 'internal_error', message: 'Unexpected gateway error' };
    return reply.code(500).send(body);
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

  registerMarketRoutes(app, deps.market);
  registerSymbolRoutes(app, deps.catalog);
  registerWatchlistRoutes(app, deps.watchlist);
  registerFlagRoutes(app, deps.flags);
  registerLogoRoutes(app, deps.logos);

  app.get(WS_PATH, { websocket: true }, (socket) => attachSession(socket, deps.market));

  return app;
}
