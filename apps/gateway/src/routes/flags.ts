import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { FlagStore } from '../storage/FlagStore.ts';

export function registerFlagRoutes(app: FastifyInstance, store: FlagStore): void {
  app.get(`${API_PREFIX}/flags`, () => store.get());
  app.put(`${API_PREFIX}/flags`, (request) => store.put(request.body));
}
