import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { OlderCaps } from '../cryptocap/older.ts';

/**
 * Older market caps (M9e): the download's status and the Live Coin Watch key (never the key
 * itself), saving and removing it.
 */
export function registerOlderCapsRoutes(app: FastifyInstance, older: OlderCaps): void {
  app.get(`${API_PREFIX}/older-caps`, () => older.status());

  app.put(`${API_PREFIX}/older-caps/key`, (request) => {
    const body = (request.body ?? {}) as { key?: unknown };
    return older.saveKey(typeof body.key === 'string' ? body.key : '');
  });

  app.delete(`${API_PREFIX}/older-caps/key`, () => older.removeKey());
}
