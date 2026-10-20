import type { StockKeyStatus } from '@tradingnerd/core';
import { createContext, useContext } from 'react';
import { type StocksApi, stocksApi } from '../data/api';

/** The Alpaca key's status for the app (see StockKeyProvider). */
export interface StockKeys {
  status: StockKeyStatus | null;
  /** Changes when a key is saved, so stock symbols are looked up and subscribed again. */
  version: number;
  api: StocksApi;
  update(status: StockKeyStatus): void;
  /** Opens the key dialog (a stock needs it, or the ⋯ menu). */
  prompt(): void;
}

export const StockKeyContext = createContext<StockKeys>({
  status: null,
  version: 0,
  api: stocksApi,
  update: () => {},
  prompt: () => {},
});

export function useStockKeys(): StockKeys {
  return useContext(StockKeyContext);
}
