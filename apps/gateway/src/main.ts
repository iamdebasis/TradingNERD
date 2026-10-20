import { AssetNames } from './catalog/names.ts';
import { SymbolCatalog } from './catalog/SymbolCatalog.ts';
import type { CatalogSource } from './catalog/types.ts';
import { loadConfig } from './config.ts';
import { BinanceExchange } from './exchanges/binance/BinanceExchange.ts';
import { BybitExchange } from './exchanges/bybit/BybitExchange.ts';
import { CoinbaseExchange } from './exchanges/coinbase/CoinbaseExchange.ts';
import { KrakenExchange } from './exchanges/kraken/KrakenExchange.ts';
import { OkxExchange } from './exchanges/okx/OkxExchange.ts';
import { CoinGeckoClient } from './logos/coingecko.ts';
import { LogoService } from './logos/LogoService.ts';
import { MarketService } from './market/MarketService.ts';
import type { ExchangeAdapter } from './market/types.ts';
import { buildServer } from './server.ts';
import { DIRECTORY_URLS, UsListings } from './stocks/UsListings.ts';
import { UsStocksMarket } from './stocks/UsStocksMarket.ts';
import { FlagStore } from './storage/FlagStore.ts';
import { SecretStore } from './storage/secrets.ts';
import { WatchlistStore } from './storage/WatchlistStore.ts';

const config = loadConfig();
const warn = (exchange: string) => (message: string) => console.warn(`[${exchange}] ${message}`);
/** Asset names for symbol descriptions, filled in by the search catalog. */
const names = new AssetNames();

const binance = new BinanceExchange({
  ...(config.binance.restUrl ? { restUrl: config.binance.restUrl } : {}),
  ...(config.binance.streamUrl ? { streamUrl: config.binance.streamUrl } : {}),
  onWarning: warn('binance'),
});
const exchanges: (ExchangeAdapter & CatalogSource)[] = [
  binance,
  new BybitExchange({ ...config.bybit, names, onWarning: warn('bybit') }),
  new OkxExchange({ ...config.okx, names, onWarning: warn('okx') }),
  new CoinbaseExchange({ ...config.coinbase, names, onWarning: warn('coinbase') }),
  new KrakenExchange({ ...config.kraken, names, onWarning: warn('kraken') }),
];
const secrets = new SecretStore(config.dataDir);

// US stocks and funds: Nasdaq's symbol directory, and Alpaca's data with the user's key.
const listingsBase = config.usListingsUrl?.replace(/\/?$/, '/');
const usListings = new UsListings({
  dataDir: config.dataDir,
  ...(listingsBase
    ? {
        urls: {
          nasdaq: new URL('nasdaqlisted.txt', listingsBase).href,
          other: new URL('otherlisted.txt', listingsBase).href,
        },
      }
    : { urls: DIRECTORY_URLS }),
  onWarning: warn('stocks'),
});
const stocks = new UsStocksMarket({
  dataDir: config.dataDir,
  secrets,
  listings: usListings,
  dataUrl: config.alpaca.dataUrl,
  tradingUrls: config.alpaca.tradingUrl ? [config.alpaca.tradingUrl] : undefined,
  onWarning: warn('stocks'),
});

const market = new MarketService([...exchanges, ...stocks.exchanges()]);

// Symbol search lists every exchange's pairs (each with an adapter here is live), and every
// US-listed stock and fund.
const catalog = new SymbolCatalog({
  sources: exchanges,
  extra: usListings,
  live: new Set(exchanges.map((exchange) => exchange.id)),
  names,
  dataDir: config.dataDir,
  onWarning: warn('catalog'),
});

const watchlist = new WatchlistStore(config.dataDir, warn('data'));
const flags = new FlagStore(config.dataDir, warn('data'));

const logos = new LogoService({
  client: new CoinGeckoClient(),
  secrets,
  dataDir: config.dataDir,
});

const app = await buildServer(config, { market, catalog, watchlist, flags, logos, stocks });
app.addHook('onClose', async () => {
  catalog.close();
  await market.close();
});
await app.listen({ host: config.host, port: config.port });
console.log(`tradingNerd gateway listening on http://${config.host}:${config.port}`);
void logos.refreshIfStale(); // the weekly logo refresh, in the background
void catalog.start(); // the saved pair lists, then fresh ones in the background
void usListings.start(); // the saved US listings, then a fresh directory daily
void stocks.prepare(); // with a key: its plan, the calendar, and the listings' ranking
// Each exchange's pair list, so the first symbol picked on it needn't wait for the download.
for (const exchange of exchanges) void exchange.prepare?.();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
