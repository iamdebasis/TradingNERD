import { loadConfig } from './config.ts';
import { BinanceExchange } from './exchanges/binance/BinanceExchange.ts';
import { MarketService } from './market/MarketService.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const binance = new BinanceExchange({
  ...(config.binance.restUrl ? { restUrl: config.binance.restUrl } : {}),
  ...(config.binance.streamUrl ? { streamUrl: config.binance.streamUrl } : {}),
  onWarning: (message) => console.warn(`[binance] ${message}`),
});
const market = new MarketService([binance]);

const app = await buildServer(config, { market });
app.addHook('onClose', async () => {
  await market.close();
});
await app.listen({ host: config.host, port: config.port });
console.log(`tradingNerd gateway listening on http://${config.host}:${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
