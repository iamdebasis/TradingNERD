import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { WatchlistStore } from '../storage/WatchlistStore.ts';

export function registerWatchlistRoutes(app: FastifyInstance, store: WatchlistStore): void {
  app.get(`${API_PREFIX}/watchlist`, () => store.get());
  app.put(`${API_PREFIX}/watchlist`, (request) => store.put(request.body));
}
