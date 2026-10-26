import { fileURLToPath } from 'node:url';
import { GATEWAY_DEFAULT_PORT, WEB_DEV_PORT } from '@tradingnerd/core';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** Where to reach one exchange instead of its public endpoints (tests point them nowhere). */
export interface Endpoints {
  restUrl: string | undefined;
  streamUrl: string | undefined;
}

export interface GatewayConfig {
  /** Always loopback: the gateway must never be reachable from the network. */
  host: '127.0.0.1';
  port: number;
  /** Browser origins allowed to call the gateway (the UI dev server). */
  allowedOrigins: readonly string[];
  logLevel: LogLevel;
  /**
   * Endpoint overrides: <EXCHANGE>_REST_URL and <EXCHANGE>_STREAM_URL (for Binance.US, say), and
   * OKX_BUSINESS_STREAM_URL for OKX's candle stream.
   */
  binance: Endpoints;
  bybit: Endpoints;
  okx: Endpoints & { businessStreamUrl: string | undefined };
  coinbase: Endpoints;
  kraken: Endpoints;
  bitstamp: Endpoints;
  /**
   * US stocks: ALPACA_DATA_URL, ALPACA_TRADING_URL and ALPACA_STREAM_URL instead of Alpaca's
   * hosts, and US_LISTINGS_URL instead of Nasdaq's symbol directory (a folder holding its two
   * files).
   */
  alpaca: {
    dataUrl: string | undefined;
    tradingUrl: string | undefined;
    streamUrl: string | undefined;
  };
  usListingsUrl: string | undefined;
  /** LIVECOINWATCH_URL instead of Live Coin Watch's API, for older market caps. */
  livecoinwatchUrl: string | undefined;
  /** CRYPTOCAP_OLDER_COINS=1: each coin's older days in the charts (M9f; off until checked). */
  olderCoinsInCharts: boolean;
  /** Where local data lives (watchlist, secrets, logo cache): DATA_DIR, or the repo's data/. */
  dataDir: string;
}

/** The repository's data/ folder, which .gitignore keeps out of git. */
const REPO_DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));

const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = env.GATEWAY_PORT ? Number(env.GATEWAY_PORT) : GATEWAY_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid GATEWAY_PORT "${env.GATEWAY_PORT}"`);
  }
  const logLevel = (env.LOG_LEVEL ?? 'warn') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL "${env.LOG_LEVEL}" (expected one of ${LOG_LEVELS.join(', ')})`,
    );
  }
  return {
    host: '127.0.0.1',
    port,
    allowedOrigins: [`http://127.0.0.1:${WEB_DEV_PORT}`, `http://localhost:${WEB_DEV_PORT}`],
    logLevel,
    binance: endpoints(env, 'BINANCE'),
    bybit: endpoints(env, 'BYBIT'),
    okx: { ...endpoints(env, 'OKX'), businessStreamUrl: env.OKX_BUSINESS_STREAM_URL || undefined },
    coinbase: endpoints(env, 'COINBASE'),
    kraken: endpoints(env, 'KRAKEN'),
    bitstamp: endpoints(env, 'BITSTAMP'),
    alpaca: {
      dataUrl: env.ALPACA_DATA_URL || undefined,
      tradingUrl: env.ALPACA_TRADING_URL || undefined,
      streamUrl: env.ALPACA_STREAM_URL || undefined,
    },
    usListingsUrl: env.US_LISTINGS_URL || undefined,
    livecoinwatchUrl: env.LIVECOINWATCH_URL || undefined,
    olderCoinsInCharts: env.CRYPTOCAP_OLDER_COINS === '1',
    dataDir: env.DATA_DIR || REPO_DATA_DIR,
  };
}

function endpoints(env: NodeJS.ProcessEnv, exchange: string): Endpoints {
  return {
    restUrl: env[`${exchange}_REST_URL`] || undefined,
    streamUrl: env[`${exchange}_STREAM_URL`] || undefined,
  };
}
