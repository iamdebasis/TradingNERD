import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { UsStocksMarket } from '../stocks/UsStocksMarket.ts';

/** The Alpaca key for US stocks: its status (never the key), saving and removing it. */
export function registerStockRoutes(app: FastifyInstance, stocks: UsStocksMarket): void {
  app.get(`${API_PREFIX}/stocks/key`, () => stocks.status());

  app.put(`${API_PREFIX}/stocks/key`, (request) => {
    const body = (request.body ?? {}) as { keyId?: unknown; secret?: unknown };
    return stocks.saveKey(
      typeof body.keyId === 'string' ? body.keyId : '',
      typeof body.secret === 'string' ? body.secret : '',
    );
  });

  app.delete(`${API_PREFIX}/stocks/key`, () => stocks.removeKey());
}
