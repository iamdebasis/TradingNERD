import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { LibrariesStore } from '../storage/LibrariesStore.ts';

const PATH = `${API_PREFIX}/libraries/:publisher/:name/:version`;

/**
 * The Pine libraries the user's scripts import (docs/SPEC.md §5.17): all of them with their code,
 * and adding (or replacing) and removing one by its import path.
 */
export function registerLibraryRoutes(app: FastifyInstance, store: LibrariesStore): void {
  app.get(`${API_PREFIX}/libraries`, () => store.index());
  app.put(PATH, (request) => store.put(request.params, request.body));
  app.delete(PATH, (request) => store.remove(request.params));
}
