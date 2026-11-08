# tradingNerd architecture

A map of the code for anyone picking up the work. The details, with the reasons behind each choice, are in [SPEC.md](SPEC.md) §6; the rules for working here are in [../AGENTS.md](../AGENTS.md).

## The whole

```
 Browser: React web app (Vite, 127.0.0.1:5173)
 ┌──────────┬───────────────────────────────┬──────────────────────┬──────┐
 │ Top bar, │ Chart: Lightweight Charts     │ Right panel: the     │ Right│
 │ Indica-  │ + our gestures and plugins,   │ watchlists (flags,   │ tool-│
 │ tors     │ indicators, Pine scripts and  │ search, logos) or    │ bar  │
 │          │ their panes                   │ the Pine Editor      │      │
 └──────────┴───────────────┬───────────────┴──────────────────────┴──────┘
   REST (history /api/bars, search, lists, scripts, keys) + one WebSocket (live bars, quotes, book)
 Local gateway: Node 26 + Fastify (127.0.0.1:5180, loopback only)
 ┌──────────────────────────▼───────────────────────────────────────┐
 │ MarketService: history paging, resampling, the whole-bar rule,   │
 │ live candles, quotes, an in-memory history cache                 │
 │ Exchanges: Binance · Bybit · OKX · Coinbase · Kraken · Bitstamp  │
 │ US stocks: Alpaca (the user's key) · Nasdaq's symbol directory   │
 │ CRYPTOCAP: market caps from CoinGecko's coins × exchange prices; │
 │ older years from Live Coin Watch and ETH Zurich's dataset        │
 │ Formulas (spreads) · symbol catalog and search · logos           │
│ Open interest (_OI): Binance's archive and APIs, Bybit, OKX      │
 │ My scripts: the Pine Editor's saved scripts and their versions   │
 │ Storage: JSON files in data/ (gitignored, owner-only)            │
 └──────────────────────────┬───────────────────────────────────────┘
                            ▼ HTTPS and WebSockets to the providers only
```

## Packages

| Package | What it holds |
|---|---|
| `packages/core` | Shared by both sides: the protocol (`protocol.ts`, `market.ts`), resolutions and intervals, the resampler (`resample.ts`), the market clock and status (`clock.ts`, `schedule.ts`, `marketStatus.ts`, `timezone.ts`), formulas (`formula.ts`), watchlists and their TradingView `.txt` files, flags, logos, stocks and older-caps status types, My scripts' types and checks (`scripts.ts`, P1), the Pine libraries' paths and checks (`libraries.ts`, P2) |
| `packages/pine` | **P1:** Pine Script® v6 from text to values (SPEC §6.17). `lexer.ts`, `parser.ts`, `ast.ts` read the code; `compiler.ts`, `types.ts`, `builtins.ts` check its types and qualifiers and turn it into closures over a `Runtime` (`runtime.ts`: each variable's history, the live bar rolled back and committed, outputs in typed arrays, the 500 ms loop limit); `ta.ts` holds each `ta.*` call's state; `script.ts` has `compileScript`, `ScriptProgram` (inputs, `describe`) and `ScriptRun` (the script over the chart's bars, ticks, new bars and corrections); `warmup.ts` is the warm-up rule for scripts. **P2:** every version through `dialect.ts`; collections and objects (`collections.ts`); `catalog.ts` for the editor's help; `convert.ts` and `edits.ts` for Convert code to v6. No DOM **P4:** requests to other symbols and timeframes (`requests.ts`: contexts, merging; `requestCalls.ts`, `tickers.ts`, `execution.ts`; the compiler's slices), SPEC §6.18 **P3:** drawings (`drawings.ts`: labels, lines, boxes, tables, polylines, linefills, `chart.point`; each run's `DrawingStore`, rolled back with the live bar), SPEC §6.19 **P5:** strategies (`strategy.ts`: `strategy()`'s properties, the `Broker` emulator, the `strategy.*` namespace), SPEC §6.20 |
| `packages/indicators` | TradingView's built-in indicators as Pine computes them (I1: Volume and RSI): the `ta.*` kernels (`kernels.ts`), the definitions (`volume.ts`, `rsi.ts`: inputs, plots, levels, fills, defaults), `IndicatorRun` (`run.ts`: closed bars committed, the live bar tentative, a correction redone), the warm-up rule (`warmup.ts`), settings and the registry; RSI's own Pine code for the Pine Editor (`rsi.pine.ts`). No DOM |
| `packages/chart` | The chart engine around Lightweight Charts: `ChartController.ts`, zoom and price zoom, the gesture layer (`interaction/`: wheel, keyboard, vertical drag, viewport), plugins (crosshair, last price, extended-hours price, session shading, axis labels, fills, backgrounds, value labels, a script's marks), `indicators/` (`IndicatorLayer.ts`: the indicators' series, panes, levels and labels; `script.ts`: a Pine script read as an indicator and run), `tuning.ts` for the feel's constants **P4:** a built-in on another timeframe (`indicators/timeframed.ts`), the request feed through `IndicatorLayer` and `ChartController` **P3:** a script's drawings (`plugins/DrawingsPrimitive.ts`), their prices placed through a series with values on the same scale **P5:** a strategy's fills on the candles (`plugins/TradesPrimitive.ts`), `IndicatorLayer.strategies()` |
| `apps/web` | The screen: `layout/` (`AppShell.tsx`, the right toolbar `RightToolbar.tsx`, the panels' widths), `chart/` (pane, legend, interval prompt, chart settings), `toolbar/` (intervals), `indicators/` (the store, the Indicators button and dialog, legend rows, the settings dialog, `definitions.ts`), `pine/` (the Pine Editor: the panel, Monaco and Pine's colors, the open script, Save script; Pine Logs, `PineLogs.tsx`), `watchlist/` (lists, sections, flags, row menus, drag), `search/` (symbol search and typed formulas), `logos/`, `stocks/` (the Alpaca key dialog), `olderCaps/` (the Live Coin Watch dialog), `gestures/` (the tuning popup), `theme/` (tokens), `data/` (the gateway connection and REST client) **P4:** `chart/requestLoader.ts`, the data scripts' requests ask for, from the gateway |
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
| `openinterest/` | **P4:** TradingView's `_OI` symbols as an exchange of their own, one adapter per exchange (`OpenInterestExchange.ts`): names and units (`symbols.ts`), Binance's archive and APIs, Bybit and OKX (`sources.ts`, `zip.ts`), the points kept by month in `data/oi/` (`series.ts`), bars from points and live polls (`bars.ts`). `MarketService` sends a ticker ending `_OI` there |
| `formula/` | `FormulaExchange.ts`: a typed formula (TOTAL2/XRPUSD) as its own exchange, built from its symbols' bars; serves up to a day, and the market service builds longer bars from its days (A6) |
| `logos/` | CoinGecko's coin and exchange logos, cached in `data/logos/`; CoinGecko's client and its monthly call count |
| `storage/` | Watchlists, flags, My scripts (`ScriptsStore.ts`, P1), the Pine libraries (`LibrariesStore.ts`, P2), secrets (`secrets.ts`), atomic JSON files (`jsonFile.ts`) |
| `routes/` | REST: bars, symbols, watchlists, flags, scripts (`scripts.ts`), libraries (`libraries.ts`), logos, the stock key, older caps |
| `ws/session.ts` | One WebSocket per browser tab: subscriptions to bars, quotes and live candles |

## How data flows

- **A chart's history:**
  1. The web app asks over REST for bars before a time (`GET /api/bars`, `routes/market.ts`; `ChartSession.ts` in the browser).
  2. `MarketService` finds the adapter.
  3. It fetches native bars (cached), resamples them to the interval, and keeps only whole bars.
  4. Scrolling back asks for the next page the same way.
- **Live:** once history is on the chart, the tab subscribes over the WebSocket (`ws/session.ts`: bars, book and quotes). The adapter's candles and trades stream in, `liveBar.ts` merges them into the forming candle, and the session pushes it to the tab.
- **Quotes** (the watchlist's Last, Chg and Chg%) come from the same feeds, throttled.
- **Indicators** (I1) are computed in the browser from the chart's own bars:
  1. The app's indicator store (`apps/web/src/indicators/indicatorStore.ts`, kept in this browser) hands its list to `ChartController.setIndicators`.
  2. `IndicatorLayer` runs each one over the chart's bars (`IndicatorRun`) and draws it: Volume at the bottom of the price pane, the others in panes below.
  3. Every change to the bars reaches it: a page of history (computed afresh), a live tick (the last bar again), a new bar, an exchange's correction.
  4. The legend reads the values on the bar it shows (`indicatorValues`), written at the Style tab's Precision; its "Output values" and "Input values" (`DisplaySettings` in `settings.ts`) only change how values show, so they apply in place, the series and values kept.
  5. The warm-up rule: a value that still depends on bars not loaded isn't drawn; the chart asks for older pages until it's settled, or the gateway says the history starts at the listing (`fromListing` on a page, protocol v10).
- **Pine scripts** (P1) run in the browser the same way:
  1. The Pine Editor (`apps/web/src/pine/`) keeps the open script and its unsaved code in this browser (`pineStore.ts`). A built-in's code opens editable, its original kept for Reset to original.
  2. Add to chart puts the code itself in the indicator store as an indicator of kind `script` (`addScript`); Update on chart replaces it (`updateScript`), and inputs left at the old code's defaults take the new ones.
  3. `IndicatorLayer` reads the compiled script as a definition (`packages/chart/src/indicators/script.ts`: inputs `in_0…`, outputs `plot_0…`, `hline_0…`, `fill_0…`, `bg_0…`), so the legend, the settings dialog and the panes treat it as any indicator, and runs it with `ScriptRun` (`packages/pine`).
  4. The editor's menu and help (P2): the script menu's dialogs (`OpenScriptDialog.tsx`, `VersionHistoryDialog.tsx`), and help while typing (`help.ts`) from the engine's catalog of built-ins (`packages/pine/src/catalog.ts`).
  5. Libraries (P2): a script's `import` is resolved from My libraries (`apps/web/src/pine/librariesStore.ts`, loaded at start from `GET /api/libraries`; the gateway keeps them in `data/libraries.json`). Their revision makes scripts that import compile again, on the chart (`setLibraries`) and in the editor; the console's "Add library…" opens `LibrariesDialog.tsx`.
  6. Pine Logs (P2): each script's log entries (`ScriptRun.logs`, counted by `logsWritten`) go from the chart (`ChartController.scriptLogs()`) through `ChartPane` to `apps/web/src/pine/logsStore.ts` on each update; `PineLogs.tsx` shows them (timestamps and filters in `logFormat.ts`). An entry's Scroll to bar goes back through the store to `ChartController.scrollToBar()`; its Source code to `pineStore.showLine()`.
  7. Convert code to v6 (P2): `packages/pine/src/convert.ts` compiles v5 code collecting the changes the compiler and the dialect find (`edits.ts`), applies them and checks the result as v6.
  8. Where the editor sits (P2): `pineStore`'s `dock`, right or bottom; `AppShell` lays it out under the chart with a horizontal `Splitter`, or as the right panel, Pine Logs being a right panel of its own.
  6. The plotshape family (P2): marks (plotshape, plotchar, plotarrow) are drawn by `plugins/MarksPrimitive.ts` over a clear series that carries the prices they stand at; plotcandle and plotbar by Lightweight Charts' candles and bars, their high, low and close kept in hidden parts (`partOf`); barcolor() colors the chart's own candles' bodies (`ChartController.recolorBars`).
  6b. Drawings (P3): a run keeps its labels, lines, boxes, tables, polylines and linefills (`ScriptRun.drawings`, a copy made when they change); `IndicatorLayer` hands them to each script's `DrawingsPrimitive` with the chart's bar times, and an overlay's prices go through the candles' series.
  6c. Strategies (P5): the run's `Broker` fills orders on each bar before the script and on its close after it; `ScriptRun.strategy` carries its trades and figures to `TradesPrimitive` (markers on the candles) and, through `ChartController.scriptStrategies()` and `ChartPane`, to `apps/web/src/strategy/` (the store, the figures in `report.ts`, the `StrategyTester` panel below the chart).
  7. The warm-up rule for scripts: beside the script's own run, three check runs (one bar later; bar 0 one percent higher; bars 0 and 1 a thousand times apart) show where a value still depends on bars not loaded (`warmup.ts`, SPEC §6.17).
  8. Save script sends the code to the gateway (`POST /api/scripts`, then `PUT` for each new version), which keeps it in `data/scripts.json`. My scripts are listed in the Indicators dialog and the editor's menu.
- **Requests** (P4): a script that asks for another symbol or timeframe gets it the way the chart gets its own:
  1. The engine lists the contexts a run needs and those it lacks (`ScriptRun.requested`, `missing`); `IndicatorLayer.requests()` gathers them for every script, and a built-in on another timeframe's.
  2. `ChartPane` hands them to `apps/web/src/chart/requestLoader.ts` on each update: it loads each from `GET /api/bars` (pages back to 300 bars before the chart's first) and follows it on the WebSocket, and drops what no script asks for.
  3. Each context's bars reach the engine through the loader (a `RequestFeed`); when one comes in, the scripts run afresh, and on its live updates only their live bar.
  4. Open interest symbols (`BINANCE:BTCUSDT.P_OI`) are just symbols to all this: the gateway's `openinterest/` adapters make their bars.
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
- `scripts.json`: My scripts and every saved version of each (P1).
- `cryptocap/anchors.json`: the kept days, which can't be downloaded again.
- `cryptocap/older-coins/`: M9f's downloads, a few days of free requests.
- `oi/`: open interest (P4). Binance's archive can be downloaded again; the points recorded beyond Bybit's and OKX's own windows can't.

## Configuration (environment)

| Variable | Use |
|---|---|
| `GATEWAY_PORT`, `DATA_DIR`, `LOG_LEVEL` | Port (5180), data folder (`data/`), log level (warn) |
| `COINGECKO_API_KEY`, `COINGECKO_PLAN` | CoinGecko key instead of the saved one (demo or pro) |
| `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` | Alpaca key pair instead of the saved one |
| `LIVECOINWATCH_API_KEY` | Live Coin Watch key instead of the saved one |
| `CRYPTOCAP_OLDER_COINS=1` | M9f's older days in the charts (off by default) |
| `<EXCHANGE>_REST_URL`, `<EXCHANGE>_STREAM_URL`, `OKX_BUSINESS_STREAM_URL`, `BINANCE_FUTURES_URL`, `BINANCE_COINM_URL`, `BINANCE_ARCHIVE_URL`, `ALPACA_*_URL`, `US_LISTINGS_URL`, `LIVECOINWATCH_URL` | Endpoints instead of the real ones (the browser tests point them nowhere) |

## Invariants and gotchas

- **Only whole bars (A1).** A week or month that our data covers only in part is left out, unless the exchange's history starts at the pair's listing (`historyFromListing`).
- **Resampled bars need volume.** Days without volume would be skipped when building weeks, so CRYPTOCAP's, the older days and open interest's bars count as traded (volume 1); the symbols say they have no real volume (an index), so charts and scripts read none.
- **A request's data is the chart's own path:** scripts never name a host; the gateway answers for every symbol, open interest included. A history request for open interest waits until its range has downloaded (the first BTCUSDT daily chart, about 2.5 minutes).
- **Exchanges differ:**
  - Kraken gives the last 720 bars only.
  - OKX stops at its own cut-offs.
  - Bitstamp's front door takes one request at a time.
  - CoinGecko's free plan gives 10,000 calls a month and a year of history.
  - Live Coin Watch allows about 0.4 requests a second after a burst, and 10,000 a day; a 429 means "slow down" unless `/credits` says 0.
- **The user's `pnpm dev` restarts the gateway on every edit** of its files (`node --watch`).
- **Visual baselines** (`apps/web/tests/e2e/visual.spec.ts-snapshots/`) change only after looking at the new image.
- **Each price scale formats its own numbers.** The symbol's format is the candle series' own (`priceFormat: custom`), not the chart's localization, which would override every pane's. Indicator panes format theirs.
- **The library lays out a new pane a frame later:** read a pane's height from the pane (`getHeight()`), not `chart.paneSize(i)`, which throws until then.
- **Fills go under plots, levels over them** (Pine's z-order). A gradient fill is a canvas gradient placed at its two prices each frame, so it follows the pane's scale; beyond those prices it keeps its end colors.
- **Monaco is imported by its exports map** (`monaco-editor/editor/editor.api.js`, `…/editor.worker.js?worker`), loaded the first time the Pine Editor opens, and bundled: nothing comes from a CDN. Its codicon CSS is imported by relative path, and its side-effect imports are declared in `pine/monaco-features.d.ts`.
- **Code Node runs as it is** (the gateway, or a benchmark run with `node` on `packages/pine`) must be erasable TypeScript: no enums or parameter properties (`erasableSyntaxOnly`). Node's type stripping also reads `private declare(` as a declaration, not a method (checked on Node 26, 2026-10-31), hence the compiler's `define`.
- **A script's outputs are numbered by kind and place** (`plot_0`, `hline_0`…, inputs `in_0`…). Its settings follow those ids, so an edit that reorders plots or inputs moves the settings along with the places, not the titles.

## Adding things

- **An exchange:**
  1. Add `exchanges/<name>/` with `rest.ts`, `stream.ts` and `parse.ts`, and an adapter implementing `ExchangeAdapter`.
  2. Register it in `main.ts`, its logo id in `logos/`, and its endpoints in `config.ts`.
  3. Add tests with a fake server, and a live test in `test/live/`.
  4. Measure its history depth and limits first (SPEC §4.3, core value 5).
- **A CRYPTOCAP symbol:** add it to `symbols.ts` and `indices.ts`, with TradingView's definition from its help center (SPEC §4.11), and check it against the user's screenshots.
- **A chart integration of any kind:** go through core value 5 (compare providers on depth and accuracy) before building.
- **A built-in indicator:**
  1. Research it first (core value 3): TradingView's formula and defaults, from its Help Center, Pine's reference and the built-in's source.
  2. Add its definition to `packages/indicators` (inputs, plots, levels, fills with their edges and any gradient, format, `legendName` and `legendInputs`, `settledFrom`) with any new kernels, and register it.
  3. Test it against published values and hand-built cases, bar by bar against one pass (`run.test.ts`).
  4. Hand-check it against TradingView on the user's screenshots (SPEC §9).
  5. Write its Pine code (our own, as `rsi.pine.ts`), add it to `BUILTIN_CODE` in `apps/web/src/indicators/definitions.ts` and the editor's Create new menu, and test the code against the TypeScript definition bar by bar (`packages/pine/src/rsi.test.ts`).
- **A Pine built-in** (`packages/pine/src/builtins.ts`): its signature and qualifiers from Pine's v6 reference, a test of its values and its errors, and its removal from the `LATER` list, which names what isn't built yet.
