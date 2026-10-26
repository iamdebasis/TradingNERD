import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { OlderCaps } from '../cryptocap/older.ts';
import type { OlderCoins } from '../cryptocap/olderCoins.ts';

/**
 * Older market caps (M9e) and each coin's older days (M9f): the downloads' status and the Live
 * Coin Watch key (never the key itself), saving and removing it.
 */
export function registerOlderCapsRoutes(
  app: FastifyInstance,
  { older, coins }: { older: OlderCaps; coins: OlderCoins },
): void {
  const withCoins = async <T>(status: T) => ({ ...status, coins: await coins.status() });

  app.get(`${API_PREFIX}/older-caps`, async () => withCoins(await older.status()));

  app.put(`${API_PREFIX}/older-caps/key`, async (request) => {
    const body = (request.body ?? {}) as { key?: unknown };
    const status = await older.saveKey(typeof body.key === 'string' ? body.key : '');
    await coins.restart();
    return withCoins(status);
  });

  app.delete(`${API_PREFIX}/older-caps/key`, async () => {
    const status = await older.removeKey();
    await coins.restart();
    return withCoins(status);
  });
}
