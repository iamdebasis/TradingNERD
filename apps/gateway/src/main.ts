import { AssetNames } from './catalog/names.ts';
import { SymbolCatalog } from './catalog/SymbolCatalog.ts';
import type { CatalogSource } from './catalog/types.ts';
import { loadConfig } from './config.ts';
import { CryptoCapExchange } from './cryptocap/CryptoCapExchange.ts';
import { BinanceExchange } from './exchanges/binance/BinanceExchange.ts';
import { BitstampExchange } from './exchanges/bitstamp/BitstampExchange.ts';
import { BybitExchange } from './exchanges/bybit/BybitExchange.ts';
import { CoinbaseExchange } from './exchanges/coinbase/CoinbaseExchange.ts';
import { KrakenExchange } from './exchanges/kraken/KrakenExchange.ts';
import { OkxExchange } from './exchanges/okx/OkxExchange.ts';
import { CoinGeckoClient } from './logos/coingecko.ts';
import { LogoService } from './logos/LogoService.ts';
import { CoinGeckoUsage } from './logos/usage.ts';
import { MarketService } from './market/MarketService.ts';
import type { ExchangeAdapter } from './market/types.ts';
import { buildServer } from './server.ts';
import { DIRECTORY_URLS, UsListings } from './stocks/UsListings.ts';
import { UsStocksMarket } from './stocks/UsStocksMarket.ts';
import { FlagStore } from './storage/FlagStore.ts';
import { SecretStore } from './storage/secrets.ts';
import { WatchlistsStore } from './storage/WatchlistsStore.ts';

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
  // Last: its asset names ("U.S. dollar") fill in only what the others don't name.
  new BitstampExchange({ ...config.bitstamp, names, onWarning: warn('bitstamp') }),
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
  streamUrl: config.alpaca.streamUrl,
  onWarning: warn('stocks'),
});

// CoinGecko, for logos and market caps; every call counts against the plan's monthly allowance.
const coingeckoUsage = new CoinGeckoUsage(config.dataDir);
const coingecko = new CoinGeckoClient({ onCall: () => coingeckoUsage.record() });

// CRYPTOCAP's market caps and dominance: coins' prices from the exchanges, their supply from
// CoinGecko. The search catalog (below) says which pairs each exchange trades.
const cryptocap = new CryptoCapExchange({
  client: coingecko,
  secrets,
  usage: coingeckoUsage,
  dataDir: config.dataDir,
  adapters: exchanges,
  pairs: () => catalog.pairs(),
  waitForPairs: () => catalog.ready(10_000),
  livecoinwatch: { url: config.livecoinwatchUrl },
  onWarning: warn('cryptocap'),
});

const market = new MarketService([...exchanges, ...stocks.exchanges(), cryptocap]);

// Symbol search lists every exchange's pairs (each with an adapter here is live), every
// US-listed stock and fund, and CRYPTOCAP's symbols.
const catalog = new SymbolCatalog({
  sources: exchanges,
  extra: [usListings, cryptocap],
  live: new Set(exchanges.map((exchange) => exchange.id)),
  names,
  dataDir: config.dataDir,
  onWarning: warn('catalog'),
});

const watchlist = new WatchlistsStore(config.dataDir, warn('data'));
const flags = new FlagStore(config.dataDir, warn('data'));

const logos = new LogoService({
  client: coingecko,
  secrets,
  dataDir: config.dataDir,
});

const app = await buildServer(config, {
  market,
  catalog,
  watchlist,
  flags,
  logos,
  stocks,
  olderCaps: cryptocap.older,
});
app.addHook('onClose', async () => {
  catalog.close();
  await market.close();
  await coingeckoUsage.flush();
});
await app.listen({ host: config.host, port: config.port });
console.log(`tradingNerd gateway listening on http://${config.host}:${config.port}`);
void logos.refreshIfStale(); // the weekly logo refresh, in the background
void catalog.start(); // the saved pair lists, then fresh ones in the background
void usListings.start(); // the saved US listings, then a fresh directory daily
void stocks.prepare(); // with a key: its plan, the calendar, and the listings' ranking
void cryptocap.prepare(); // the saved coins and their history; nothing is fetched until it's used
// Each exchange's pair list, so the first symbol picked on it needn't wait for the download.
for (const exchange of exchanges) void exchange.prepare?.();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
