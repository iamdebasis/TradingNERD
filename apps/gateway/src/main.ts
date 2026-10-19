import { SymbolCatalog } from './catalog/SymbolCatalog.ts';
import { loadConfig } from './config.ts';
import { BinanceExchange } from './exchanges/binance/BinanceExchange.ts';
import { BybitCatalog } from './exchanges/bybit/catalog.ts';
import { CoinbaseCatalog } from './exchanges/coinbase/catalog.ts';
import { KrakenCatalog } from './exchanges/kraken/catalog.ts';
import { OkxCatalog } from './exchanges/okx/catalog.ts';
import { CoinGeckoClient } from './logos/coingecko.ts';
import { LogoService } from './logos/LogoService.ts';
import { SecretStore } from './logos/secrets.ts';
import { MarketService } from './market/MarketService.ts';
import { buildServer } from './server.ts';
import { WatchlistStore } from './storage/WatchlistStore.ts';

const config = loadConfig();
const binance = new BinanceExchange({
  ...(config.binance.restUrl ? { restUrl: config.binance.restUrl } : {}),
  ...(config.binance.streamUrl ? { streamUrl: config.binance.streamUrl } : {}),
  onWarning: (message) => console.warn(`[binance] ${message}`),
});
const market = new MarketService([binance]);

// Symbol search lists every exchange's pairs; only Binance has live data until M5.
const catalog = new SymbolCatalog({
  sources: [
    binance,
    new BybitCatalog({ restUrl: config.catalogUrls.bybit }),
    new OkxCatalog({ restUrl: config.catalogUrls.okx }),
    new CoinbaseCatalog({ restUrl: config.catalogUrls.coinbase }),
    new KrakenCatalog({ restUrl: config.catalogUrls.kraken }),
  ],
  live: new Set([binance.id]),
  dataDir: config.dataDir,
  onWarning: (message) => console.warn(`[catalog] ${message}`),
});

const watchlist = new WatchlistStore(config.dataDir, (message) =>
  console.warn(`[data] ${message}`),
);

const logos = new LogoService({
  client: new CoinGeckoClient(),
  secrets: new SecretStore(config.dataDir),
  dataDir: config.dataDir,
});

const app = await buildServer(config, { market, catalog, watchlist, logos });
app.addHook('onClose', async () => {
  catalog.close();
  await market.close();
});
await app.listen({ host: config.host, port: config.port });
console.log(`tradingNerd gateway listening on http://${config.host}:${config.port}`);
void logos.refreshIfStale(); // the weekly logo refresh, in the background
void catalog.start(); // the saved pair lists, then fresh ones in the background

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
