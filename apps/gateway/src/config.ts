import { GATEWAY_DEFAULT_PORT, WEB_DEV_PORT } from '@tradingnerd/core';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface GatewayConfig {
  /** Always loopback: the gateway must never be reachable from the network. */
  host: '127.0.0.1';
  port: number;
  /** Browser origins allowed to call the gateway (the UI dev server). */
  allowedOrigins: readonly string[];
  logLevel: LogLevel;
}

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
  };
}
