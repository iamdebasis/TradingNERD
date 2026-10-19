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
import { SecretStore } from './logos/secrets.ts';
import { MarketService } from './market/MarketService.ts';
import type { ExchangeAdapter } from './market/types.ts';
import { buildServer } from './server.ts';
import { FlagStore } from './storage/FlagStore.ts';
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
const market = new MarketService(exchanges);

// Symbol search lists every exchange's pairs; each one with an adapter here is live.
const catalog = new SymbolCatalog({
  sources: exchanges,
  live: new Set(exchanges.map((exchange) => exchange.id)),
  names,
  dataDir: config.dataDir,
  onWarning: warn('catalog'),
});

const watchlist = new WatchlistStore(config.dataDir, warn('data'));
const flags = new FlagStore(config.dataDir, warn('data'));

const logos = new LogoService({
  client: new CoinGeckoClient(),
  secrets: new SecretStore(config.dataDir),
  dataDir: config.dataDir,
});

const app = await buildServer(config, { market, catalog, watchlist, flags, logos });
app.addHook('onClose', async () => {
  catalog.close();
  await market.close();
});
await app.listen({ host: config.host, port: config.port });
console.log(`tradingNerd gateway listening on http://${config.host}:${config.port}`);
void logos.refreshIfStale(); // the weekly logo refresh, in the background
void catalog.start(); // the saved pair lists, then fresh ones in the background
// Each exchange's pair list, so the first symbol picked on it needn't wait for the download.
for (const exchange of exchanges) void exchange.prepare?.();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
