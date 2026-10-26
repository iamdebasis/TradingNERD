# tradingNerd architecture

A map of the code for anyone picking up the work. The details, with the reasons behind each choice, are in [SPEC.md](SPEC.md) §6; the rules for working here are in [../AGENTS.md](../AGENTS.md).

## The whole

```
 Browser: React web app (Vite, 127.0.0.1:5173)
 ┌──────────┬───────────────────────────────┬──────────────────────┐
 │ Top bar  │ Chart: Lightweight Charts     │ Watchlists, flags,   │
 │          │ + our gestures and plugins    │ symbol search, logos │
 └──────────┴───────────────┬───────────────┴──────────────────────┘
   REST (history /api/bars, search, lists, keys) + one WebSocket (live bars, quotes, book)
 Local gateway: Node 26 + Fastify (127.0.0.1:5180, loopback only)
 ┌──────────────────────────▼───────────────────────────────────────┐
 │ MarketService: history paging, resampling, the whole-bar rule,   │
 │ live candles, quotes, an in-memory history cache                 │
 │ Exchanges: Binance · Bybit · OKX · Coinbase · Kraken · Bitstamp  │
 │ US stocks: Alpaca (the user's key) · Nasdaq's symbol directory   │
 │ CRYPTOCAP: market caps from CoinGecko's coins × exchange prices; │
 │ older years from Live Coin Watch and ETH Zurich's dataset        │
 │ Formulas (spreads) · symbol catalog and search · logos           │
 │ Storage: JSON files in data/ (gitignored, owner-only)            │
 └──────────────────────────┬───────────────────────────────────────┘
                            ▼ HTTPS and WebSockets to the providers only
```

## Packages

| Package | What it holds |
|---|---|
| `packages/core` | Shared by both sides: the protocol (`protocol.ts`, `market.ts`), resolutions and intervals, the resampler (`resample.ts`), the market clock and status (`clock.ts`, `schedule.ts`, `marketStatus.ts`, `timezone.ts`), formulas (`formula.ts`), watchlists and their TradingView `.txt` files, flags, logos, stocks and older-caps status types |
| `packages/chart` | The chart engine around Lightweight Charts: `ChartController.ts`, zoom and price zoom, the gesture layer (`interaction/`: wheel, keyboard, vertical drag, viewport), plugins (crosshair, last price, extended-hours price, session shading, axis labels), `tuning.ts` for the feel's constants |
| `apps/web` | The screen: `layout/AppShell.tsx`, `chart/` (pane, legend, interval prompt, chart settings), `toolbar/` (intervals), `watchlist/` (lists, sections, flags, row menus, drag), `search/` (symbol search and typed formulas), `logos/`, `stocks/` (the Alpaca key dialog), `olderCaps/` (the Live Coin Watch dialog), `gestures/` (the tuning popup), `theme/` (tokens), `data/` (the gateway connection and REST client) |
| `apps/gateway` | The local server (below) |

## The gateway

| Folder | What it does |
|---|---|
| `main.ts`, `server.ts`, `config.ts`, `security.ts` | Wiring; the Host and Origin checks on every request; settings from the environment |
| `market/` | `MarketService.ts`: bars for any symbol and interval, paged back, resampled from what the source has, only whole bars (A1); live candles (`liveBar.ts`), quotes (`quotes.ts`), the history cache (`historyCache.ts`). `types.ts` defines `ExchangeAdapter` |
| `exchanges/` | One folder per exchange: REST, stream and parsing. An adapter declares its native intervals, how many bars a request gives, whether its history starts at a pair's listing (`historyFromListing`), and whether its bars come gapless |
| `stream/` | `StreamClient.ts`: WebSockets that reconnect and keep themselves alive; after a reconnect, the market service has the tab reload recent history, so nothing is missed |
| `catalog/` | Every exchange's pairs, US listings and CRYPTOCAP symbols, ranked for search (`SymbolCatalog.ts`) |
| `stocks/` | US stocks from Alpaca: REST, stream, minute polling, the market calendar, Nasdaq's listings |
| `cryptocap/` | CRYPTOCAP's symbols: see below |
| `formula/` | `FormulaExchange.ts`: a typed formula (TOTAL2/XRPUSD) as its own exchange, built from its symbols' bars; serves up to a day, and the market service builds longer bars from its days (A6) |
| `logos/` | CoinGecko's coin and exchange logos, cached in `data/logos/`; CoinGecko's client and its monthly call count |
| `storage/` | Watchlists, flags, secrets (`secrets.ts`), atomic JSON files (`jsonFile.ts`) |
| `routes/` | REST: bars, symbols, watchlists, flags, logos, the stock key, older caps |
| `ws/session.ts` | One WebSocket per browser tab: subscriptions to bars, quotes and live candles |

## How data flows

- **A chart's history:**
  1. The web app asks over REST for bars before a time (`GET /api/bars`, `routes/market.ts`; `ChartSession.ts` in the browser).
  2. `MarketService` finds the adapter.
  3. It fetches native bars (cached), resamples them to the interval, and keeps only whole bars.
  4. Scrolling back asks for the next page the same way.
- **Live:** once history is on the chart, the tab subscribes over the WebSocket (`ws/session.ts`: bars, book and quotes). The adapter's candles and trades stream in, `liveBar.ts` merges them into the forming candle, and the session pushes it to the tab.
- **Quotes** (the watchlist's Last, Chg and Chg%) come from the same feeds, throttled.
- **US stocks:** Alpaca's free plan, 15 minutes delayed, under the market clock (sessions, holidays, extended hours).

## CRYPTOCAP (`apps/gateway/src/cryptocap/`)

TradingView's crypto market caps (TOTAL, TOTAL2, TOTAL3, OTHERS, the ES ones, TOTALE50 and TOTALE100, STABLE.C), every coin's own cap, the dominances (.D) and the ratios. SPEC §4.11 and §5.10 have the definitions as TradingView gives them.

| File | Role |
|---|---|
| `universe.ts` | CoinGecko's 250 largest coins and its stablecoins (the user's key), refreshed every 15 minutes while in use; `EXCLUDED_COINS` (what TradingView doesn't list) |
| `anchors.ts` | Each coin's market cap and price, a point a day, every day kept (`data/cryptocap/anchors.json`): CoinGecko's free year, then each day's snapshot. **This file can't be downloaded again: back it up** |
| `pairs.ts` | Each coin's exchange pair, used for its price |
| `history.ts` | `CapHistory`: a coin's cap is its pair's price × its supply then (from the anchors), or CoinGecko's cap where it has no pair. The composites are added up per bar (`indices.ts`), 1,000 bars a chunk, kept in memory |
| `live.ts` | The live values each second, from the pairs' 1-minute candles |
| `older.ts`, `livecoinwatch.ts` | **M9e:** TOTAL, TOTAL2, TOTAL3 and BTC.D before our own history, from Live Coin Watch's whole market (`data/cryptocap/older.json`), at a day and longer. These are in the charts now |
| `ethzurich.ts`, `olderCoins.ts`, `olderBook.ts` | **M9f:** each coin's older days, for every symbol: the ETH Zurich dataset to February 2018, then Live Coin Watch per coin. Downloaded in the background (`data/cryptocap/older-coins/`), matched by price, each source's own market caps, supplies scaled to meet at the joins. **In the charts only with `CRYPTOCAP_OLDER_COINS=1`**, until the accuracy test passes and the user says YES |
| `CryptoCapExchange.ts` | The adapter: symbols, bars, live, search entries; it owns everything above |

**Joins.** Our own history starts on our first day (`CapHistory.firstBarMs(D1, false)`): where M9e's and M9f's older days end, and where intraday history begins. Older days serve a day and longer only.

## Storage (`data/`, gitignored, owner-only)

SPEC §6.8 lists every file. The ones to protect:
- `secrets.json`: the keys.
- `watchlists.json` and `flags.json`: the user's own lists.
- `cryptocap/anchors.json`: the kept days, which can't be downloaded again.
- `cryptocap/older-coins/`: M9f's downloads, a few days of free requests.

## Configuration (environment)

| Variable | Use |
|---|---|
| `GATEWAY_PORT`, `DATA_DIR`, `LOG_LEVEL` | Port (5180), data folder (`data/`), log level (warn) |
| `COINGECKO_API_KEY`, `COINGECKO_PLAN` | CoinGecko key instead of the saved one (demo or pro) |
| `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` | Alpaca key pair instead of the saved one |
| `LIVECOINWATCH_API_KEY` | Live Coin Watch key instead of the saved one |
| `CRYPTOCAP_OLDER_COINS=1` | M9f's older days in the charts (off by default) |
| `<EXCHANGE>_REST_URL`, `<EXCHANGE>_STREAM_URL`, `OKX_BUSINESS_STREAM_URL`, `ALPACA_*_URL`, `US_LISTINGS_URL`, `LIVECOINWATCH_URL` | Endpoints instead of the real ones (the browser tests point them nowhere) |

## Invariants and gotchas

- **Only whole bars (A1).** A week or month that our data covers only in part is left out, unless the exchange's history starts at the pair's listing (`historyFromListing`).
- **Resampled bars need volume.** Days without volume would be skipped when building weeks, so CRYPTOCAP's and the older days count as traded (volume 1).
- **Exchanges differ:**
  - Kraken gives the last 720 bars only.
  - OKX stops at its own cut-offs.
  - Bitstamp's front door takes one request at a time.
  - CoinGecko's free plan gives 10,000 calls a month and a year of history.
  - Live Coin Watch allows about 0.4 requests a second after a burst, and 10,000 a day; a 429 means "slow down" unless `/credits` says 0.
- **The user's `pnpm dev` restarts the gateway on every edit** of its files (`node --watch`).
- **Visual baselines** (`apps/web/tests/e2e/visual.spec.ts-snapshots/`) change only after looking at the new image.

## Adding things

- **An exchange:**
  1. Add `exchanges/<name>/` with `rest.ts`, `stream.ts` and `parse.ts`, and an adapter implementing `ExchangeAdapter`.
  2. Register it in `main.ts`, its logo id in `logos/`, and its endpoints in `config.ts`.
  3. Add tests with a fake server, and a live test in `test/live/`.
  4. Measure its history depth and limits first (SPEC §4.3, core value 5).
- **A CRYPTOCAP symbol:** add it to `symbols.ts` and `indices.ts`, with TradingView's definition from its help center (SPEC §4.11), and check it against the user's screenshots.
- **A chart integration of any kind:** go through core value 5 (compare providers on depth and accuracy) before building.
