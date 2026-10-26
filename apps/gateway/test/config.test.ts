import { GATEWAY_DEFAULT_PORT } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('defaults to loopback, the default port and warn-level logs', () => {
    expect(loadConfig({})).toMatchObject({
      host: '127.0.0.1',
      port: GATEWAY_DEFAULT_PORT,
      logLevel: 'warn',
    });
  });

  it('allows only the UI dev server origins', () => {
    expect(loadConfig({}).allowedOrigins).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
  });

  it('reads GATEWAY_PORT and treats an empty value as unset', () => {
    expect(loadConfig({ GATEWAY_PORT: '6001' }).port).toBe(6001);
    expect(loadConfig({ GATEWAY_PORT: '' }).port).toBe(GATEWAY_DEFAULT_PORT);
  });

  it("keeps each coin's older days out of the charts unless CRYPTOCAP_OLDER_COINS is 1", () => {
    expect(loadConfig({}).olderCoinsInCharts).toBe(false);
    expect(loadConfig({ CRYPTOCAP_OLDER_COINS: 'yes' }).olderCoinsInCharts).toBe(false);
    expect(loadConfig({ CRYPTOCAP_OLDER_COINS: '1' }).olderCoinsInCharts).toBe(true);
  });

  it.each(['abc', '-1', '65536', '80.5'])('rejects GATEWAY_PORT=%s', (port) => {
    expect(() => loadConfig({ GATEWAY_PORT: port })).toThrow(/Invalid GATEWAY_PORT/);
  });

  it("reads each exchange's endpoint overrides, unset when empty", () => {
    const config = loadConfig({
      KRAKEN_REST_URL: 'http://127.0.0.1:9',
      KRAKEN_STREAM_URL: 'ws://127.0.0.1:9',
      BITSTAMP_REST_URL: 'http://127.0.0.1:9',
      OKX_BUSINESS_STREAM_URL: 'ws://127.0.0.1:9',
      BYBIT_REST_URL: '',
    });
    expect(config.kraken).toEqual({ restUrl: 'http://127.0.0.1:9', streamUrl: 'ws://127.0.0.1:9' });
    expect(config.bitstamp).toEqual({ restUrl: 'http://127.0.0.1:9', streamUrl: undefined });
    expect(config.okx.businessStreamUrl).toBe('ws://127.0.0.1:9');
    expect(config.bybit).toEqual({ restUrl: undefined, streamUrl: undefined });
  });

  it('reads the US stock overrides, unset when empty', () => {
    const config = loadConfig({
      ALPACA_DATA_URL: 'http://127.0.0.1:9',
      ALPACA_TRADING_URL: '',
      ALPACA_STREAM_URL: 'ws://127.0.0.1:9',
      US_LISTINGS_URL: 'http://127.0.0.1:9/directory/',
    });
    expect(config.alpaca).toEqual({
      dataUrl: 'http://127.0.0.1:9',
      tradingUrl: undefined,
      streamUrl: 'ws://127.0.0.1:9',
    });
    expect(config.usListingsUrl).toBe('http://127.0.0.1:9/directory/');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/Invalid LOG_LEVEL/);
  });
});
