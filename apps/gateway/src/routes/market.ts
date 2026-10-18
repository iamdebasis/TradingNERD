import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { MarketService } from '../market/MarketService.ts';
import { MarketError } from '../market/types.ts';

const DEFAULT_COUNT_BACK = 300;

export function registerMarketRoutes(app: FastifyInstance, market: MarketService): void {
  app.get(`${API_PREFIX}/symbols/resolve`, async (request) => {
    const query = request.query as Record<string, unknown>;
    return market.resolveSymbol(requiredString(query, 'symbol'));
  });

  app.get(`${API_PREFIX}/bars`, async (request) => {
    const query = request.query as Record<string, unknown>;
    const symbol = requiredString(query, 'symbol');
    const resolution = requiredString(query, 'resolution');
    const to = optionalInteger(query, 'to', 1, Number.MAX_SAFE_INTEGER);
    const countBack = optionalInteger(query, 'countBack', 1, Number.MAX_SAFE_INTEGER);
    return market.getBars(symbol, resolution, to, countBack ?? DEFAULT_COUNT_BACK);
  });
}

function requiredString(query: Record<string, unknown>, name: string): string {
  const value = query[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MarketError('bad_request', `Query parameter "${name}" is required`);
  }
  return value;
}

function optionalInteger(
  query: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
): number | null {
  const value = query[name];
  if (value === undefined) return null;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new MarketError(
      'bad_request',
      `Query parameter "${name}" must be a whole number ≥ ${min}`,
    );
  }
  return n;
}
