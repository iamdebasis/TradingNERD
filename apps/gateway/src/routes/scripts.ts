import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MarketError } from '../market/types.ts';
import type { ScriptsStore } from '../storage/ScriptsStore.ts';

const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

function versionOf(request: FastifyRequest): number {
  const text = (request.params as { version: string }).version;
  const version = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
  if (!(version >= 1)) throw new MarketError('bad_request', 'A version is a number from 1');
  return version;
}

/**
 * The user's Pine scripts (docs/SPEC.md §5.16): My scripts, one script's latest code and its
 * versions, one version's code, and saving, renaming and deleting.
 */
export function registerScriptRoutes(app: FastifyInstance, store: ScriptsStore): void {
  app.get(`${API_PREFIX}/scripts`, () => store.index());
  app.post(`${API_PREFIX}/scripts`, (request) => store.create(request.body));
  app.get(`${API_PREFIX}/scripts/:id`, (request) => store.get(idOf(request)));
  app.put(`${API_PREFIX}/scripts/:id`, (request) => store.save(idOf(request), request.body));
  app.patch(`${API_PREFIX}/scripts/:id`, (request) => store.rename(idOf(request), request.body));
  app.delete(`${API_PREFIX}/scripts/:id`, (request) => store.remove(idOf(request)));
  app.get(`${API_PREFIX}/scripts/:id/versions/:version`, (request) =>
    store.version(idOf(request), versionOf(request)),
  );
}
