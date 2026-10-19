import { API_PREFIX, type LogoStatus, type SymbolId } from '@tradingnerd/core';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { type LogosApi, logosApi } from '../data/api';

/** While a logo refresh runs, the status is asked for this often. */
export const SYNC_POLL_MS = 2_000;

interface Logos {
  status: LogoStatus | null;
  /** Changes when the logo list is refreshed, so images are fetched again; null: no logos yet. */
  version: number | null;
  api: LogosApi;
  update(status: LogoStatus): void;
}

const LogoContext = createContext<Logos>({
  status: null,
  version: null,
  api: logosApi,
  update: () => {},
});

export function LogoProvider({
  api = logosApi,
  children,
}: {
  api?: LogosApi;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<LogoStatus | null>(null);

  useEffect(() => {
    let alive = true;
    api.status().then(
      (loaded) => {
        if (alive) setStatus(loaded);
      },
      () => {
        // No logos this session; letter avatars everywhere.
      },
    );
    return () => {
      alive = false;
    };
  }, [api]);

  // New logos show up as soon as a refresh finishes.
  useEffect(() => {
    if (!status?.syncing) return;
    const timer = setTimeout(() => {
      api.status().then(setStatus, () => {});
    }, SYNC_POLL_MS);
    return () => clearTimeout(timer);
  }, [api, status]);

  const value = useMemo(
    () => ({ status, version: status?.syncedAt ?? null, api, update: setStatus }),
    [api, status],
  );
  return <LogoContext.Provider value={value}>{children}</LogoContext.Provider>;
}

export function useLogos(): Logos {
  return useContext(LogoContext);
}

/** Where an exchange's logo is served: the gateway's cache of CoinGecko's image. */
export function exchangeLogoUrl(exchange: string, version: number): string {
  return `${API_PREFIX}/logos/exchange/${encodeURIComponent(exchange)}?v=${version}`;
}

/** Where a coin's logo is served: the gateway's cache of CoinGecko's 50 px image. */
export function logoUrl(symbol: SymbolId, base: string, version: number): string {
  const exchange = symbol.slice(0, symbol.indexOf(':'));
  return `${API_PREFIX}/logos/coin/${exchange}/${encodeURIComponent(base)}?v=${version}`;
}
