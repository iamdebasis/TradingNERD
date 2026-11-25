import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { DrawingsStore } from '../storage/DrawingsStore.ts';

/** A symbol's drawings can run past Fastify's 1 MiB default (5,000 at about 1 kB each). */
const BODY_LIMIT = 16 * 1024 * 1024;

/** The user's drawings, a symbol's at a time (docs/SPEC.md §5.27). */
export function registerDrawingRoutes(app: FastifyInstance, store: DrawingsStore): void {
  app.get(`${API_PREFIX}/drawings`, (request) =>
    store.get((request.query as { symbol?: unknown }).symbol),
  );
  app.put(`${API_PREFIX}/drawings`, { bodyLimit: BODY_LIMIT }, (request) =>
    store.put(request.body),
  );
}
