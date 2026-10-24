import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WatchlistsStore } from '../storage/WatchlistsStore.ts';

const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

/**
 * The user's watchlists: the list of lists, one list's sections, and creating, renaming,
 * starring, deleting and opening lists. GET and PUT /api/watchlist still read and save the open
 * list, as before several lists.
 */
export function registerWatchlistRoutes(app: FastifyInstance, store: WatchlistsStore): void {
  app.get(`${API_PREFIX}/watchlists`, () => store.index());
  app.post(`${API_PREFIX}/watchlists`, (request) => store.create(request.body));
  app.get(`${API_PREFIX}/watchlists/:id`, (request) => store.get(idOf(request)));
  app.put(`${API_PREFIX}/watchlists/:id`, (request) => store.save(idOf(request), request.body));
  app.patch(`${API_PREFIX}/watchlists/:id`, (request) => store.update(idOf(request), request.body));
  app.delete(`${API_PREFIX}/watchlists/:id`, (request) => store.remove(idOf(request)));
  app.post(`${API_PREFIX}/watchlists/:id/activate`, (request) => store.activate(idOf(request)));

  app.get(`${API_PREFIX}/watchlist`, () => store.active());
  app.put(`${API_PREFIX}/watchlist`, (request) => store.saveActive(request.body));
}
