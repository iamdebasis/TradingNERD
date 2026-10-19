import { fileURLToPath } from 'node:url';
import { GATEWAY_DEFAULT_PORT, WEB_DEV_PORT } from '@tradingnerd/core';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface GatewayConfig {
  /** Always loopback: the gateway must never be reachable from the network. */
  host: '127.0.0.1';
  port: number;
  /** Browser origins allowed to call the gateway (the UI dev server). */
  allowedOrigins: readonly string[];
  logLevel: LogLevel;
  /** Optional endpoint overrides, e.g. for Binance.US: BINANCE_REST_URL / BINANCE_STREAM_URL. */
  binance: { restUrl: string | undefined; streamUrl: string | undefined };
  /**
   * REST endpoints of the exchanges listed in symbol search before their live data arrives:
   * BYBIT_REST_URL, OKX_REST_URL, COINBASE_REST_URL, KRAKEN_REST_URL (tests point them nowhere).
   */
  catalogUrls: {
    bybit: string | undefined;
    okx: string | undefined;
    coinbase: string | undefined;
    kraken: string | undefined;
  };
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
    binance: {
      restUrl: env.BINANCE_REST_URL || undefined,
      streamUrl: env.BINANCE_STREAM_URL || undefined,
    },
    catalogUrls: {
      bybit: env.BYBIT_REST_URL || undefined,
      okx: env.OKX_REST_URL || undefined,
      coinbase: env.COINBASE_REST_URL || undefined,
      kraken: env.KRAKEN_REST_URL || undefined,
    },
    dataDir: env.DATA_DIR || REPO_DATA_DIR,
  };
}
