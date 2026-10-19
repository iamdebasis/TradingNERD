import {
  API_PREFIX,
  type ExchangeList,
  MAX_QUERY_LENGTH,
  SEARCH_PAGE_SIZE,
  type SymbolSearchResponse,
} from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { SymbolCatalog } from '../catalog/SymbolCatalog.ts';
import { MarketError } from '../market/types.ts';

/** Longest a search waits for the catalog's first exchange list after a fresh start. */
const READY_WAIT_MS = 5_000;
const MAX_OFFSET = 10_000;
const MAX_LIMIT = 100;

export function registerSymbolRoutes(app: FastifyInstance, catalog: SymbolCatalog): void {
  app.get(`${API_PREFIX}/symbols/search`, async (request): Promise<SymbolSearchResponse> => {
    const query = request.query as Record<string, unknown>;
    const text = optionalString(query, 'query', MAX_QUERY_LENGTH) ?? '';
    const exchange = optionalString(query, 'exchange', 16)?.toUpperCase() ?? null;
    if (exchange !== null && !/^[A-Z]+$/.test(exchange)) {
      throw new MarketError('bad_request', 'Query parameter "exchange" must be an exchange code');
    }
    const type = optionalString(query, 'type', 16);
    if (type !== null && type !== 'spot') {
      throw new MarketError('bad_request', 'Query parameter "type" must be "spot"');
    }
    const offset = optionalInteger(query, 'offset', 0, MAX_OFFSET) ?? 0;
    const limit = optionalInteger(query, 'limit', 1, MAX_LIMIT) ?? SEARCH_PAGE_SIZE;
    await catalog.ready(READY_WAIT_MS);
    return catalog.search({ query: text, exchange, offset, limit });
  });

  app.get(
    `${API_PREFIX}/exchanges`,
    async (): Promise<ExchangeList> => ({ exchanges: catalog.exchanges() }),
  );
}

function optionalString(
  query: Record<string, unknown>,
  name: string,
  maxLength: number,
): string | null {
  const value = query[name];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new MarketError('bad_request', `Query parameter "${name}" is too long or malformed`);
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
    throw new MarketError('bad_request', `Query parameter "${name}" must be ${min}–${max}`);
  }
  return n;
}
