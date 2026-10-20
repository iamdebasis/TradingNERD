import type { StockKeyStatus } from '@tradingnerd/core';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { type StocksApi, stocksApi } from '../data/api';
import { StockKeyDialog } from './StockKeyDialog';
import { StockKeyContext } from './stockKeys';

/**
 * US stock data needs the user's Alpaca key, which only the gateway keeps (docs/SPEC.md §5.7):
 * its status, and the dialog that asks for it, for the whole app.
 */
export function StockKeyProvider({
  api = stocksApi,
  children,
}: {
  api?: StocksApi;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<StockKeyStatus | null>(null);
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api.status().then(
      (loaded) => {
        if (alive) setStatus(loaded);
      },
      () => {
        // The gateway will say again when a stock is asked for.
      },
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const update = useCallback((next: StockKeyStatus) => {
    setStatus(next);
    if (next.configured) setVersion((current) => current + 1);
  }, []);
  const prompt = useCallback(() => setOpen(true), []);

  const value = useMemo(
    () => ({ status, version, api, update, prompt }),
    [api, status, version, update, prompt],
  );
  return (
    <StockKeyContext.Provider value={value}>
      {children}
      {open && <StockKeyDialog onClose={() => setOpen(false)} />}
    </StockKeyContext.Provider>
  );
}
