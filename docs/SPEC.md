# tradingNerd — Product & Technical Spec

Living document. Last updated **2026-10-19** (M0–M3 committed; M4 built and verified, awaiting review).
Measured facts carry the date they were measured; exchange and vendor limits can change.

---

## 1. Working agreement

- **No change to this codebase without an explicit YES** to a specific yes/no question. A YES covers only the step it was asked about.
- **Every task runs in four phases:**
  1. **Product Owner:** scope, acceptance criteria.
  2. **Architect / Engineer:** design, then build.
  3. **Testing:** unit, integration, E2E, real verification.
  4. **Delivery:** hand-over with test evidence and an honest status.

## 2. Vision and v1 scope

A local clone of TradingView's chart page. It should match TradingView's look and, above all, its smooth trackpad and mouse feel. Market data comes from free public exchange APIs.

**In v1**

1. **Chart:** candlesticks with deep history that keeps loading as you scroll back, live ticking, and every TradingView gesture (§4.2).
2. **Top bar:** only the symbol pill and the interval controls (favorite intervals + the interval dropdown).
3. **Watchlist:** right-hand panel with live prices, plus TradingView's "Add symbol" dialog. That dialog is where you choose which exchange a symbol's price comes from.
4. **Logos:** coin and exchange logos from CoinGecko (§5.5).

**Not in v1:** drawing tools, indicators, alerts, replay, multi-chart layouts, trading, stocks/forex, perpetual futures, and TradingView's right-hand icon bar.

## 3. Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-10-17 | Chart engine: TradingView **Lightweight Charts v5**, plus our own gesture layer | It's TradingView's own open-source engine (Apache-2.0). Their Advanced Charts library isn't licensed for personal use. |
| 2026-10-18 | Run in the **browser on localhost** now; Electron wrapper later | Fastest iteration. TradingView Desktop is Electron. |
| 2026-10-18 | Exchanges: **Binance first**, then Bybit, OKX, Coinbase, Kraken | All five were reachable with no API key from the dev machine, and most have deep history. |
| 2026-10-18 | **Spot pairs only** in v1; perpetual futures later | Keeps v1 focused. |
| 2026-10-18 | Logos from **CoinGecko**; key entered in a popup and kept by the local gateway | User's choice. |
| 2026-10-18 | Gateway runs TypeScript **directly on Node 26** (no build step) | Verified to work across pnpm workspace packages. |
| 2026-10-18 | **Biome** for lint and format | One tool instead of ESLint + Prettier. |
| 2026-10-18 | pnpm `minimumReleaseAge` = 3 days | Supply-chain guard against freshly compromised releases. |
| 2026-10-18 | Panel corner radius 3.5 px | Best pixel match to the reference (calibrated in M0). |
| 2026-10-18 | Our own wheel handling, computing each step from the range we last set | Lightweight Charts applies view changes on the next frame, so trackpad events arriving within one frame would otherwise be lost. |
| 2026-10-18 | Last-price and crosshair labels drawn by our plugins | TradingView's labels are compact, text-sized boxes; the library draws full-width bars. |
| 2026-10-18 | Live candle = exchange candle (every 2 s) + every trade | Binance's candle stream lags trades by up to 2 s; trades make it tick instantly and open new bars on time. |
| 2026-10-18 | Asset names ("TetherUS") from Binance's public asset list, falling back to codes | The exchange's own names are what TradingView shows; the endpoint is unofficial, so it's never required. |
| 2026-10-18 | `?symbol=BINANCE:XRPUSDT&interval=1D` in the URL | TradingView's own URL format; the only way to switch symbol or interval until M2/M4. |
| 2026-10-18 | Browser tests: mock gateway, clock pinned to 16:09:54 UTC, true 2× rendering | Deterministic, offline, and pixel-comparable with the reference (see §9). |
| 2026-10-18 | A wheel or two-finger vertical swipe **over the price axis** stretches the price scale, not time | TradingView does this; Lightweight Charts doesn't ([issue #1237](https://github.com/tradingview/lightweight-charts/issues/1237)). Speed, fixed point and direction aren't published, so they start provisional and are calibrated (§11). |
| 2026-10-18 | Temporary, dev-only **gesture tuning panel** (`?tune` in the URL) | Matches the unpublished gesture constants side by side with TradingView. Not in production builds; deleted once the values are fixed in `packages/chart/src/tuning.ts`. |
| 2026-10-19 | Intervals an exchange lacks are **resampled in the gateway** from its coarsest native interval that nests exactly | The browser asks for any interval the same way; one implementation serves every exchange. Rebuilding Binance's own 1m, 15m, 1h, 4h, 1D, 1W and 1M bars this way matches them exactly (live test). |
| 2026-10-19 | When folding, base bars **without trades are skipped** unless the whole bar had none | They're placeholders at the previous close. Binance builds its own minutes from its seconds exactly this way: 45 of 45 live minutes matched, versus 28 of 45 when folding every second. |
| 2026-10-19 | Resampled history is fetched as **parallel time slices**, at most 12 requests per page | A 45-second chart needs 45 one-second bars per bar; slicing keeps a page under a second. |
| 2026-10-19 | **Tick bars are numbered by trade id** (bar k of an n-tick chart holds trades k·n … k·n + n − 1) and built from Binance's aggregate trades | Bars are identical however history is loaded, scroll back seamlessly, and never collide within a second. Rebuilding a live 100-tick bar from Binance's individual trades matches exactly. |
| 2026-10-19 | Protocol v3: a tick bar's `time` is its number and `start` its first trade's time | Charts need strictly increasing bar times; the axis and crosshair show `start`. |
| 2026-10-19 | Toolbar defaults are **the user's own TradingView favorites**, with 8h and 12h as custom intervals | From `docs/reference/02-toolbar.png`; TradingView's built-in list has no 8- or 12-hour entry. |
| 2026-10-19 | Favorites, added intervals and folded sections kept in `localStorage`; the interval goes in the URL and is remembered for a page opened without one | Survives reloads with no server state; TradingView's own URL format. |
| 2026-10-19 | Switching interval keeps the chart and swaps the data once it has arrived | No flash of an empty chart, and the zoom level carries over. |
| 2026-10-19 | The watchlist, settings and logo list are **JSON files in `data/`**, written atomically; SQLite waits for the candle cache | A few small documents need no database or native module. A file that can't be read is set aside, never silently overwritten. |
| 2026-10-19 | Protocol v4: a **`quotes` channel** carries each symbol's last price and previous daily close, at most every 250 ms and only when one of them changes | Chg and Chg% follow TradingView's definition (§4.3). Quotes ride on the symbol's daily bar feed, so a row and a daily chart always agree. |
| 2026-10-19 | Watchlist prices are **painted straight into the rows**, all in one animation frame, without React | 50 rows all changing in the same frame cost about 1 ms (budget 2 ms, §5.6). |
| 2026-10-19 | Changed digits keep their color **until the price changes again** | In the reference nearly every row shows colored digits at once, even slow-trading coins. |
| 2026-10-19 | Chg shows **at most 5 decimals, cut rather than rounded**, with the real change's sign; Chg% rounds to 2 | Read off the reference: VET at 0.006731 shows −0.00024 at −3.55%, which only a change of −0.000248 gives. SHIB shows −0.00000. XCH's 0.0101 on 1.6051 shows 0.63%. |
| 2026-10-19 | A coin without a logo gets **204 No Content**; images are PNG, JPEG or WebP from CoinGecko's own hosts only, checked by their first bytes | The row keeps its letter with no console error. SVG can carry script, and the gateway serves these files from its own origin. |
| 2026-10-19 | Removing the CoinGecko key **keeps the logos already fetched** | They come from CoinGecko's keyless image CDN; only the weekly refresh needs the key. |
| 2026-10-19 | Performance budgets are tested **on real frames, in their own Playwright project after the rest** | The pinned test clock replaces `requestAnimationFrame` and `performance.now`, and parallel tests skew timing. |
| 2026-10-19 | Symbol search **lists all five exchanges' pairs now**; only Binance's can be picked until M5 | The plan's M4 goal ("typing XRP lists every exchange"); a pair with no live data yet shows a dimmed + saying so, rather than a broken row. |
| 2026-10-19 | **One row per ticker** across exchanges, its exchanges' logos stacked, ⌄ for the rest; live exchanges first, then the most traded | Our form of TradingView's grouped rows (its "CRYPTO" rows stack the sources the same way); this is where you pick the price source. |
| 2026-10-19 | Search runs **in the gateway** over a catalog kept in `data/catalog.json`, refreshed every 12 h, retried every 5 min after a failure | About 5,000 pairs answer in a millisecond over loopback; a restart searches at once, offline too. |
| 2026-10-19 | Ranking: exact ticker, ticker prefix, base asset, description words, anywhere in the ticker; ties by 24 h volume **in dollars** | Volumes come in each quote asset; each exchange's own dollar pairs convert them (BTC by BTCUSDT, TRY by USDTTRY), so XRPBTC and XRPUSDT compare fairly. |
| 2026-10-19 | Descriptions use Binance's asset names, filled in from Coinbase's; Kraken's XBT and XDG count as BTC and DOGE | TradingView shows Binance's names ("XRP / TetherUS"); one name table keeps the same pair described the same everywhere. |
| 2026-10-19 | Binance symbol lookups are answered from the catalog's full pair list (up to 12 h old) | It saves a round trip: measured live, a picked pair shows its price in 0.25–0.4 s instead of 0.95 s. |
| 2026-10-19 | Coins on other exchanges take their logo from Binance's mapping of the same code, then market cap | One CoinGecko ticker list per live exchange keeps the weekly refresh cheap; per-exchange lists can come with M5. |
| 2026-10-19 | One **stream client** for every exchange: reference-counted topics, batched subscribes, reconnect with backoff and resubscribe, keep-alive; a small protocol per exchange | Reconnecting and resubscribing are written and tested once. Binance moved onto it too. |
| 2026-10-19 | Each exchange is reached through **its own public REST and WebSocket APIs**; CCXT isn't used | Each has stream details of its own (OKX's two connections, Coinbase's heartbeats, Kraken's v2 names); small adapters stay readable and fully tested. |
| 2026-10-19 | OKX bars use its **UTC intervals** (`1Dutc`, `1Wutc`, …) | OKX's plain 6-hour and longer bars open at 00:00 Hong Kong time; TradingView's open at 00:00 UTC. |
| 2026-10-19 | Kraken's weeks are **built from its days** | Kraken's weekly bars open on Thursday; TradingView's on Monday. |
| 2026-10-19 | Coinbase's **quiet periods are filled with flat bars** at the last price; its live bar is polled over REST every 30 s and ticked by every trade | Coinbase's REST leaves out periods without trades, and its stream has only 5-minute candles. The other exchanges send such flat bars themselves; what TradingView shows for Coinbase is checked in §11. |
| 2026-10-19 | REST requests are **paced per exchange**: Bybit 50 ms, OKX 110 ms, Coinbase 125 ms, Kraken 200 ms apart | Each stays inside the exchange's public limit (§4.3). |
| 2026-10-19 | Each exchange's **pair list is loaded when the gateway starts**, and refreshed in the background while the old one answers | A first pick on Coinbase waited 0.9 s for its list. Measured live, pick-to-live went from 1.8 s to 0.53–0.61 s. |
| 2026-10-19 | Coinbase's history windows are **fetched side by side**, and a window of closed bars is shared for 30 s | Coinbase serves 350 bars a request at about 0.35 s each. A 1,000-bar chart went from 1.1 s to 0.6–0.8 s (1.0 s for a quiet pair's minutes), and the look back from a quiet window for its last price reuses the window next to it. |
| 2026-10-19 | Kraken is **never asked for bars older than it keeps** | It sends the same latest bars whatever is asked: a weekly chart went from 11 requests (2.0 s) to 3 (0.5 s). |
| 2026-10-19 | The chart asks for the **best bid and ask as soon as the symbol is known**, not after its history | The exchange's stream opens while history loads. Coinbase's Sell/Buy now shows 0.7–0.85 s after opening a chart on an open connection, from about 2 s. |
| 2026-10-19 | Binance lookups cache the **pair, not its description** | A lookup made while the asset names were still loading after a restart read "XRP / USDT" for an hour. |
| 2026-10-19 | `<EXCHANGE>_REST_URL` and `<EXCHANGE>_STREAM_URL` (and `OKX_BUSINESS_STREAM_URL`) override each exchange's endpoints | Tests point every exchange at a mock, or at an unreachable address so no test reaches a real exchange by accident. |
| 2026-10-19 | A watchlist row under the mouse turns `#2E2E2E` and shows a **remove button**: 22 px, `#4A4A4A`, 4 px corners, a 1 px bin, 7 px from the right edge | Measured from `docs/reference/05-watchlist-hover.png`; ours differs from it by 0.8 gray levels on average. The chart's row keeps its selection color. |
| 2026-10-19 | Watchlist numbers **group thousands with commas** ("1,147.903") | The same reference shows ZEC that way. The legend and price axis are left as they are: no reference shows them above 1,000 (§11). |
| 2026-10-19 | The gateway keeps **recent history pages in memory** (64 pages) | Going back to a chart answers from memory: 0.002–0.01 s instead of up to 3 s. A page is answered as it is while only its live bar is out of date (the live feed replaces that bar at once); after that, only the newer bars are fetched. |
| 2026-10-19 | The first subscription after a pause **goes out at once**, subscribes before unsubscribes; an unused exchange connection stays open 10 minutes | Each saved up to 250 ms on a switch; coming back to an exchange within 10 minutes skips its connect (Coinbase 1.1 s, Kraken up to 1.3 s). |
| 2026-10-19 | **Visual regression baselines**: ten screens compared with approved screenshots on every run | Catches unintended changes to anything already matched to TradingView. They're this Mac's renderings; `--update-snapshots` replaces them after an intended change. |
| 2026-10-19 | No Electron app for now | Your call (M6): the browser on localhost is enough. |

## 4. Research findings

### 4.1 How TradingView's chart stays smooth

- **Canvas, not DOM/SVG.**
  - Each pane has two stacked canvases: candles and grid below, crosshair above.
  - Moving the mouse repaints only the top canvas.
- **One frame at a time.** All changes are batched into a single `requestAnimationFrame`, using invalidation levels (cursor → light → full).
- **Bars are positioned by index, not time.**
  - The view is just `barSpacing` + `rightOffset`: zoom changes the spacing, pan changes the offset.
  - Only visible bars are drawn.
- **Cheap frames mean trackpad momentum looks fluid.** The macOS trackpad's own momentum events turn straight into motion.

Source: the Lightweight Charts source (`chart-widget.ts`, `pane-widget.ts`, `time-scale.ts`, `price-scale.ts`).

### 4.2 Gesture map

| Input | TradingView | Lightweight Charts default | Ours (built in M1) |
|---|---|---|---|
| Wheel / two-finger vertical swipe over the chart or time axis | Zoom with the right edge fixed; hold Ctrl/⌘ to zoom toward the cursor ¹ | Always zooms toward the cursor, up to ±10% bar spacing per event | Own wheel handler (`interaction/wheel.ts`): right edge fixed, Ctrl/⌘ anchors at the cursor; the library's 10% per notch |
| Wheel / two-finger vertical swipe over the price axis | Stretches or squeezes the price scale and turns auto-scale off ¹ | Zooms time, as anywhere else | Same handler: the way that zooms the chart in makes the candles taller; the middle of the price range stays put; 10% per notch; every event in a frame counts. Speed, fixed point and direction are provisional ¹ |
| Pinch (macOS sends it as Ctrl+wheel) | Zoom toward the fingers | Works | Same handler; every event in a frame counts (`interaction/viewport.ts`) |
| Two-finger horizontal swipe, Shift+wheel | Pan, with OS momentum | Works (0.8 px per wheel-delta px) | Same handler, 0.8 px per wheel pixel, anywhere (price axis included) |
| Click-drag and release | Pan; a quick flick keeps gliding | Kinetic scroll is touch-only by default (min speed 0.2, max 7, damping 0.997, min move 15 px) | Library drag with kinetic scroll on for mouse/trackpad |
| Vertical drag | Moves price and switches auto-scale off ¹ | Ignored while auto-scale is on | `interaction/verticalDrag.ts`: after 8 px of mostly vertical travel, auto-scale off and the price under the pointer stays under it |
| Drag price/time axis; double-click axis | Stretch / reset | Works | Library behavior |
| Alt+R, Ctrl/⌘+↑/↓, ←/→, Ctrl/⌘+←/→ | Reset, zoom, step one bar, move further | Not built in | `interaction/keyboard.ts` (move further = 10 bars ¹) |
| Type digits / letters on the chart | Interval prompt / symbol search | Not built in | Digits (and ",") open the interval prompt (M2); letters arrive with symbol search (M4) |

¹ From TradingView's notes and observation, not formal docs: on the parity checklist (§11).

### 4.3 Market data (measured from the dev machine, 2026-10-17)

| Exchange | Bars per REST request | History | Live streams worth using |
|---|---|---|---|
| Binance | 1,000 | XRPUSDT from 2018-05-04; 1-second bars exist | kline (updates every **2 s**), aggTrade + bookTicker (real-time, ~33 ms) |
| Bybit | 1,000 | Deep, paged | kline, publicTrade, orderbook.1 |
| OKX | 300 recent, 100 older | The recent endpoint reaches back 1,440 bars, history-candles beyond; 1-second bars | candles (business WS), trades, bbo-tbt |
| Coinbase | 350 | Deep, paged; periods without trades are left out | ticker, market_trades (WS candles are 5-minute only) |
| Kraken | 720 | **Only the live bar and the 720 before it**, whatever is asked | ticker, ohlc, trade |

- **Access:** all five served REST and WebSockets with no API key and no geo-block, and all returned CORS headers.
- **Binance's candle stream can lag trades by up to 2 s.** We merge trades into the live candle (§6.4).
- **TradingView's `BINANCE:XRPUSDT` is Binance's own data.** Binance's XRPUSDT daily bar (O 1.3115, H 1.3126) and 0.0001 tick size matched the TradingView screenshot exactly.
- **Watchlist Chg / Chg%** in TradingView compares against the **previous daily bar's close**, not a rolling 24 h window.
- **Pair lists** (2026-10-19, public endpoints, each answering in under a second):
  - Binance: 1,380 trading spot pairs (`exchangeInfo`, 2.5 MB), 24 h figures from `ticker/24hr?type=MINI`.
  - Bybit: 527 (`instruments-info` and `tickers`, turnover in the quote asset).
  - OKX: 1,184 (`instruments` and `tickers`; for spot, `volCcy24h` is in the quote asset).
  - Coinbase: about 515 once the 406 "-USDC" products are dropped. Those are aliases of the "-USD" books. The public Advanced Trade `market/products` also names assets ("US Dollar").
  - Kraken: 1,365 online (`AssetPairs` and `Ticker`, volume in the base asset). Bitcoin is XBT and Dogecoin XDG; TradingView keeps Kraken's own tickers (XBTUSD).
  - XRPUSDT is listed on all five.
- **Measured for M5** (2026-10-19, XRP pairs):
  - **Candle streams push only when the candle changes**, seconds apart in a quiet market: in 20 s, Bybit pushed 5 times, OKX 6, Kraken 2. Trades keep the live bar ticking, as on Binance.
  - **OKX's candle pushes carry no time**; the time received stands in.
  - **A first lookup downloads the pair list:** Coinbase 0.92 s, Kraken 0.26 s, OKX 0.27 s, Bybit 0.12 s.
  - **Opening a stream** takes Coinbase 1.0–1.2 s and Kraken 0.3–1.3 s. On an open stream, a subscription's first message follows in 0.2–0.4 s (Coinbase) and 0.17 s (Kraken).
  - **Coinbase REST:** 0.34 s typical, 0.42 s at the 95th percentile, 0.9 s at worst (40 requests).
  - **Limits:** Bybit 600 requests in 5 s; OKX 20 history requests in 2 s; Coinbase 10 public requests a second; Kraken publishes none for these, and bursts of a dozen passed, so five a second is used.
- **CoinGecko's exchange ids** (2026-10-19): `binance`, `bybit_spot`, `okex`, `gdax` (Coinbase Exchange), `kraken`; their logos are on its keyless image host.

### 4.4 CoinGecko (verified 2026-10-18)

- **Demo plan:**
  - Free, no card, 100 calls/min, 10,000 calls/month, attribution required.
  - Key goes in the `x-cg-demo-api-key` header.
  - Paid keys use `pro-api.coingecko.com` with `x-cg-pro-api-key`.
- **Validation gotcha:**
  - With an invalid key, `/ping` returns **401**, but data endpoints still return **200** (silent keyless fallback).
  - So we validate keys with `/ping` only.
- **Tickers aren't unique:**
  - Out of 22,339 coins, 5 use the ticker "xrp" and 12 use "btc".
  - `/exchanges/{id}/tickers` gives the exact `coin_id` for each exchange symbol (Binance XRP → `ripple`).
- **Logos:**
  - The image CDN needs no key, so downloads cost no credits.
  - Sizes are 250, 50 and 25 px; we use 50 px.
- **Exchange IDs:** CoinGecko calls Coinbase `gdax` and OKX `okex`.

## 5. Requirements (v1)

### 5.1 Chart

- **History and live data:**
  - Candles come from the selected exchange.
  - History loads in pages as you scroll back, fetched two screens ahead so you never hit an edge.
  - The live candle updates on every trade.
- **Legend:**
  - Logo · "XRP / TetherUS · 1D · Binance" · live-status dot.
  - O/H/L/C colored by bar direction, plus change and %.
- **Sell / spread / Buy** values come from the best bid/ask.
- **Last-price label:**
  - Two lines: price, then countdown to bar close.
  - Red or green by direction, with a dotted price line.
- **Crosshair:**
  - Dashed lines, with labels on both axes (time label format `Thu 08 Dec '22`).
  - A ⊕ button sits beside the price label.
- **Axes:**
  - Year labels on the time axis are bold.
  - Price precision comes from the symbol's tick size.
- **Gestures and shortcuts** per §4.2.
- **Done when:** XRPUSDT side by side with TradingView shows the same candles and the gestures feel the same (checklist in §11).
- **Status:** built in M1. The candles are Binance's own data, as on TradingView. The gestures are covered by automated tests; the side-by-side feel check is yours (§11). The price-axis swipe was added after your first review, with provisional constants to calibrate.

### 5.2 Top bar

- **Symbol pill:**
  - Clicking it opens symbol search.
  - Typing a letter on the chart also opens it.
- **Favorite intervals** shown in the bar; the active one is highlighted.
- **Interval dropdown:**
  - Collapsible sections Ticks / Seconds / Minutes / Hours / Days.
  - ★ toggles a favorite.
  - "Add custom interval…".
- **Interval prompt:** typing digits on the chart opens it (`15` ↵, `1D` ↵).
- **Done when:** every interval in the menu renders and matches TradingView's bars.
- **Status:** built in M2 (2026-10-19).
  - **Toolbar:** symbol pill, separator, the favorite intervals (the current one highlighted, and shown among them while it isn't a favorite), and the ⌄ menu.
  - **Menu:** "Add custom interval…", foldable sections, ★ favorites, ✕ on added intervals. Taller than the window, it spans it and scrolls under a thin overlay scrollbar, as in the reference.
  - **Interval prompt:** digits or "," on the chart; the line under the input says what Enter will switch to, or "Not applicable".
  - **Choices persist:** favorites, added intervals and folded sections survive reloads. The interval is in the URL and comes back for a page opened without one.
  - **Symbol search** (M4): the pill opens it, as does a letter typed on the chart (§5.4).
  - **Not yet:** the menu's lower half, the hover and current-row colors, the add dialog and the prompt have no reference screenshot yet (§11).

### 5.3 Watchlist

- **Layout:**
  - Columns Symbol / Last / Chg / Chg%.
  - Collapsible sections (e.g. CRYPTO).
- **Number display:**
  - The trailing digits that changed flash green or red.
  - Negatives use a real minus sign (U+2212).
  - Long symbols are hard-clipped, with no "…".
- **Interaction:**
  - Click or ↑/↓ switches the chart.
  - Drag to reorder, right-click menu, Delete removes.
- **Unavailable symbols** show red text and a gray letter avatar.
- **Persistence:** the panel is resizable and everything is remembered.
- **Done when:** 50 rows tick smoothly and the list survives a restart.
- **Status:** built in M3 (2026-10-19).
  - **Rows:** logo (or letter), ticker, Last, then Chg and Chg% against the previous daily close. The digits from the first changed one take the tick's color, green up or red down, and keep it until the price changes again.
  - **Chg decimals:** at most 5, cut rather than rounded, as the reference's 6-decimal coins show. Chg% rounds to 2.
  - **Live:** every row's quotes come from the gateway and are painted in one animation frame. With all 50 rows changing in the same frame, a frame costs about 1 ms (budget 2 ms).
  - **Interaction:** click or ↑/↓ shows a row on the chart, and the chart's symbol is the highlighted row. Ctrl/⌘ + ↑/↓ still zoom the chart. Delete, Backspace, the row's remove button or right-click → "Remove from watchlist" removes a row. Rows drag to a new place, also into another section. Sections fold.
  - **Under the mouse** (M6, measured from `docs/reference/05-watchlist-hover.png`): the row turns `#2E2E2E`, and a 22 px remove button (a bin on `#4A4A4A`) covers its right end, 7 px from the edge. The chart's own row stays blue.
  - **Thousands** are grouped with commas in Last, Chg and Chg% ("1,147.903").
  - **Saved** by the gateway in `data/watchlist.json` on every change, so it survives restarts. A list that couldn't load is retried every 3 s and never overwritten meanwhile.
  - **Unavailable symbols:** red ticker, no prices.
  - **Default list:** your coins from the reference, on Binance. Binance doesn't list XCH and has halted SNT, so they're left out. The reference's second ARB, DASH and XCH rows come from other exchanges; those arrive in M5.
  - **Not yet:** "Advanced view" and the list switcher are shown but do nothing (one list in v1). ("Add symbol" (+) arrived with M4, §5.4.) TradingView's row flags (the colored markers at a row's left edge in the hover reference) aren't built. The menus and dragging have no reference yet (§11).

### 5.4 Add symbol dialog (also used as Symbol search)

- **Search:** instant, across every listed pair on the five exchanges.
- **Ranking:** exact ticker > ticker prefix > base asset > description. Ties are broken by liquidity.
- **Choosing the exchange:** one row per pair, expandable into one row per exchange. This is where you pick the price source.
- **Filters:** tabs (All, Crypto) and filters (sources, types). Matched text is highlighted.
- **Keyboard:**
  - ↑/↓ moves, Enter adds.
  - Shift+Enter or Shift+click adds and closes.
  - Esc closes.
- **Already-added rows** show remove and locate buttons.
- **Done when:** typing "XRP" lists every exchange, and a picked row is live within 1 s.
- **Status:** built in M4 (2026-10-19).
  - **Opened by:** the watchlist's + ("Add symbol"); the symbol pill, or a letter typed on the chart ("Symbol search", which shows the pick on the chart instead of adding it).
  - **Catalog:** every trading spot pair on Binance, Bybit, OKX, Coinbase and Kraken (about 5,000), from their public APIs. Typing "XRP" lists all five.
  - **Every exchange can be picked** (M5). Measured live, a picked pair shows its price this soon after the click: Bybit 0.21–0.31 s, Binance 0.24–0.51 s, Kraken 0.30–0.47 s, OKX 0.33–0.40 s, Coinbase 0.53–0.61 s. Once, Coinbase took 1.15 s while its API answered slowly.
  - **An exchange without live data** would be listed with a dimmed + saying "Live data from … isn't available yet"; none is, now.
  - **Rows:** one per ticker. A ticker listed on several exchanges shows the first one's name, its logos stacked, and ⌄ to list the others. Exchanges with live data come first, then the most traded. Typed text is highlighted in the ticker and the description.
  - **Keyboard:** ↑/↓ highlight a row (none is highlighted at first, as in the reference); Enter adds the highlighted row or, without one, the top match, and the dialog stays open. Shift+Enter or Shift+click adds and closes; Escape closes an open filter, then the dialog.
  - **Filters:** chips All and Crypto (the same in v1, remembered); sources, types (spot) and exchange types (all are centralized).
  - **Added rows** offer remove (trash) and locate, which shows the row in the watchlist and on the chart. A new symbol goes to the end of the selected row's section (provisional, §11).
  - **Empty search:** the most traded pairs; scrolling down loads 50 more at a time.
  - **Logos:** coins as in the watchlist; exchanges from CoinGecko, cached in `data/logos/exchanges/`.

### 5.5 Logos (CoinGecko) — ships with M3

- **First launch:**
  - A popup asks for a CoinGecko key, with a "Get a free key ↗" link.
  - "Skip for now" works and doesn't nag again.
- **Reopening:** watchlist ⋯ menu → "Coin logos (CoinGecko)…" shows the masked key (`••••3f9a`) with Replace and Remove.
- **Save validates the key live.** It shows "✓ Key works · Demo plan" or a clear error: rejected, rate limited, or unreachable.
- **Key storage:**
  - Only the gateway keeps the key, in `data/secrets.json` (gitignored, owner-only permissions).
  - A `COINGECKO_API_KEY` environment variable overrides the file.
  - The key is never sent back to the browser and never stored in browser storage.
- **Without a key:** gray letter avatars.
- **Caching:** after the first sync, logos load from the local cache and work offline.
- **Attribution:** a "Data provided by CoinGecko" credit appears in the popup and the menu.
- **Pipeline:**
  1. Map each symbol using the per-exchange ticker list.
  2. Fall back to the highest market cap.
  3. Fall back to a letter avatar.
  - 50 px images are cached in `data/logos/` and refreshed weekly.
  - Budget: ≈45 calls for the first sync, ≈250/month after that (~2.5% of the free quota).
- **Status:** built in M3 (2026-10-19). Tested against a mock CoinGecko, plus a live check that CoinGecko rejects a made-up key. Your real key works: logos show in the watchlist and the legend (your check, 2026-10-19).
  - **Built:**
    - The first-launch dialog and "Skip for now" (remembered in `data/settings.json`).
    - The ⋯ menu's "Coin logos (CoinGecko)…", with the masked key, Replace and Remove.
    - The live key check, with its three errors. A key from `COINGECKO_API_KEY` shows as "Set by COINGECKO_API_KEY".
    - The dialog is our own design; TradingView has no equivalent.
  - **Mapping:** Binance's CoinGecko ticker list, most traded first, picks each base asset's coin. The top 500 coins by market cap are the fallback. Calls are spaced 1 s apart.
  - **Where logos show:** the watchlist and the chart legend. Until a logo loads, and for coins without one, the letter shows.
  - **Credit:** "Data provided by CoinGecko" appears in the dialog and under the ⋯ menu.
  - **Not yet:** exchange logos arrive with M4's dialog, the only place that shows exchanges.

### 5.6 Non-functional

- **Performance:**
  - 60 fps pan/zoom (120 fps on ProMotion) with 20k bars loaded.
  - Symbol/interval switch under 150 ms when cached, under 700 ms cold.
  - 50 live watchlist rows cost under 2 ms per frame. Measured: about 1 ms with all 50 changing in the same frame (`tests/e2e/perf.spec.ts`).
  - **History, cold** (1,000 bars, measured live 2026-10-19): Bybit 0.09–0.13 s, Binance 0.16–0.2 s, Kraken 0.29–0.56 s, Coinbase 0.6–1.0 s, OKX 0.69 s. Over the 700 ms target: Coinbase's built intervals, 3-minute 1.4 s and weekly 2.2–2.5 s (its 350 bars a request, 10 requests a second), and OKX's built seconds, 3.1 s a page with fewer bars in it (5S: 720, 45S: 80), as its older candles come 100 at a time.
  - **History, again** (M6 history cache, measured live): the same charts in 0.002–0.01 s; once newer bars exist, 0.17–0.2 s (OKX 45S was 3.1 s).
  - **Switching** (M6, from the click to the first frame with the new bars): your app on real data, 0.2–0.33 s the first time and 0.03–0.05 s after; against the mock, 0.04 s (`perf.spec.ts`). Both under the targets.
  - **Pan and zoom with 20,000 bars** (M6, over 1,000 on screen): each frame draws in 1.0 ms (median), 1.8 ms (95th percentile), 3.5 ms at worst, far inside a 60 Hz frame's 16.7 ms. Frames come every 16.7 ms; the occasional 33 ms gap is headless Chromium, with no script in it.
- **Security:** the gateway binds to 127.0.0.1 only and rejects foreign Origin and non-loopback Host headers.
- **Resilience:** exchange disconnects recover automatically, with gap-fill and a visible status dot.
  - **Measured** (M5, 2026-10-19): with every exchange's stream cut for 30 s by a relay that refuses connections, each was live again 1.8–2.5 s after the link returned, never showed live while cut, and missed no minute.

## 6. Architecture

### 6.1 Overview

```
 Browser (React UI)
 ┌──────────┬──────────────────────────────┬─────────────────┐
 │ Top bar  │ Chart: Lightweight Charts    │ Watchlist       │
 │          │ + our gesture layer          │ + Symbol search │
 └──────────┴──────────────┬───────────────┴─────────────────┘
      Data client: search · history · live bars · quotes
                           │  one WebSocket + REST, loopback only
 Local gateway (Node)      ▼
 ┌───────────────────────────────────────────────────────────┐
 │ Symbol registry + search   │ Bar service: paging,         │
 │                            │ resampling, SQLite cache     │
 │ Live service: candle +     │ Quote service: Chg%,         │
 │ trade merge                │ bid/ask, throttled updates   │
 │ Exchanges: Binance · Bybit · OKX · Coinbase · Kraken,     │
 │ each through its own public REST and WebSocket APIs       │
 └──────────────────────────┬────────────────────────────────┘
                            ▼ public REST + WebSockets, no keys
```

### 6.2 Components

| Part | Responsibility |
|---|---|
| `apps/web` | React UI: app shell, top bar, chart pane, watchlist, dialogs |
| `packages/chart` | Lightweight Charts wrapper: chart controller, plugins (countdown label, ⊕ button), gesture handlers |
| `packages/core` | Shared types, constants, UI ⇄ gateway protocol, interval math, resampler |
| `apps/gateway` | Local server: symbol registry and search, bar/live/quote services, exchange adapters, SQLite cache, secrets |

### 6.3 Data contracts

- **API shape** mirrors TradingView's Datafeed API: `searchSymbols`, `resolveSymbol`, `getBars({ from, to, countBack })`, `subscribeBars`, plus `subscribeQuotes`.
- **Symbol IDs** use TradingView's format: `BINANCE:XRPUSDT`.
- **Resolutions** use TradingView's notation: `1`, `5`, `60`, `1D`, `1W`, `1M`, `6M`, `1S`, `10T`.
- **Transport:**
  - REST for search, history and settings; one WebSocket for live data.
  - Messages are typed in `packages/core`, and any breaking change bumps `PROTOCOL_VERSION`.
- **Symbol search** (M4): `GET /api/symbols/search?query=&exchange=&offset=&limit=` returns `{matches, hasMore}`. Each match is one ticker with its exchanges' `listings`, each saying whether it's `live`. `GET /api/exchanges` lists the exchanges.
- **Quotes** (protocol v4): the browser subscribes with `{channel: 'quotes', symbol}`. The gateway answers `{type: 'quote', id, last, prevClose}`, at most every 250 ms per symbol and only when a number changed. Nothing is sent until the previous close is known; it's `null` only if it couldn't be loaded.

### 6.4 Live candle merge

- The exchange's candle messages are authoritative for open/high/low/volume.
- Trades update close/high/low the moment they arrive.
- The first trade at or after the next bar's start opens the new bar locally, without waiting for the exchange's candle.
- The previous bar's final candle, which arrives afterwards, is applied as a correction to that bar (`historical` updates).
- Updates go out at most every 50 ms per subscription, always ending on the latest value. A new bar is sent at once.
- After any reconnect, the live bar is re-seeded over REST and the chart reloads its most recent 1,000 bars to fill the gap.
- The countdown runs in the browser from the bar schedule and the local clock, ticking on each whole second.
- Code: `apps/gateway/src/market/liveBar.ts` and `MarketService.ts`.

### 6.5 Interval engine

- **Native first:** use the exchange's own interval when it has one.
- **Otherwise resample** from the largest native divisor:

  | Interval | Built from |
  |---|---|
  | 2m | 1m |
  | 10m | 5m |
  | 45m | 15m |
  | 3h | 1h |
  | 3M / 6M / 12M | 1M |
  | 5–45s | 1s |
  | Tick bars | Live trades |

- **Alignment:**
  - Intraday bars align to 00:00 UTC each day.
  - Weeks start Monday 00:00 UTC.
  - Months are calendar months.
- **How it's built** (M2):
  - **Picking the base:** the coarsest native interval whose bar boundaries all fall on the target's. Intraday bases must divide the day.
  - **Folding:** open of the first base bar, close of the last, highest high, lowest low, summed volume. Base bars without trades are skipped unless none in the period traded. That's exactly how Binance's own bars come out.
  - **History:** base bars are fetched as parallel time slices, at most 12 requests per page, 6 in flight. The oldest bar is dropped when the slices might not reach its start. An oldest slice that comes back short costs one more request to tell a real start of history from a gap, except on an exchange with a bar in every period (Coinbase, quiet ones filled in), where that is the start.
  - **Live:** the base interval's live bar is merged as usual (§6.4), and the target bar is the fold of its period's base bars. The current and previous periods are kept, so a late final candle corrects the right bar. Nothing is sent until the period's earlier base bars have arrived over REST.
  - **Tick bars:** made from trades, numbered by trade id, from Binance's aggregate trades. Their quantity is shared evenly by the trades.
    - History pages back by aggregate id (12 requests, about 40,000 trades, per page). Each page remembers which aggregate holds the trade before its oldest bar, so the next page starts exactly there. Without that, Binance is asked once.
    - Live, the trade stream extends the bar. A gap in trade ids restarts the feed, and the chart reloads what it missed.
  - Code: `packages/core/src/resample.ts`, `ticks.ts`, `intervals.ts`; `apps/gateway/src/market/history.ts`, `resampledBar.ts`, `ticks.ts`.

### 6.6 Exchange adapters (M5)

- **One stream client** (`apps/gateway/src/stream/StreamClient.ts`) per exchange connection:
  - Topics are reference-counted: the first listener subscribes upstream, the last one unsubscribes.
  - Subscribes and unsubscribes go out in batches, one every 250 ms at most. The first after a pause goes at once, and subscribes go before unsubscribes, so a switch's new pair needn't wait.
  - After any drop it reconnects with backoff (0.5 s, doubling to 30 s), subscribes again to everything, and reports `up`.
  - A keep-alive goes out every 20–30 s. Anything received proves the link; one that stays silent is replaced.
  - With nothing subscribed for 10 minutes, the connection closes; coming back sooner skips the connect.
  - Each exchange supplies a small protocol: its subscribe messages, how its frames map to topics, its ping.
- **Per exchange:**

  | | Candles | Trades | Best bid/ask | History per request | Notes |
  |---|---|---|---|---|---|
  | Binance | kline | aggTrade | bookTicker | 1,000 | Seconds and tick bars |
  | Bybit | kline | publicTrade | orderbook.1 | 1,000 | |
  | OKX | candle, on the business stream | trades | bbo-tbt | 300 recent, then 100 | Seconds; UTC bars; two connections |
  | Coinbase | polled over REST every 30 s | market_trades | ticker | 350, side by side | Quiet periods filled; heartbeats keep the link |
  | Kraken | ohlc | trade | ticker (on bid/ask changes) | its latest 720 only | Weeks built from days |

- **Pair lists:** each adapter keeps its exchange's pairs (tick size, stream names) for 12 h. They're loaded when the gateway starts, and refreshed in the background while the old list answers.
- **Pacing:** each exchange's REST requests go out in order, spaced under its limit (§3, §4.3).
- **History:** pages are fetched one after another, each ending where the last began. Coinbase, with a bar in every period, has its pages fetched side by side (§6.5). Kraken is never asked for bars older than it keeps.
- **Reconnect and gap-fill:** while an exchange's stream is down, its charts say so. When it's back, the live bar is re-seeded over REST and the chart reloads its latest 1,000 bars (§6.4).
- Code: `apps/gateway/src/exchanges/*/`, `exchanges/shared.ts`, `stream/StreamClient.ts`.

### 6.7 History cache (M6)

- **What:** the gateway keeps the last 64 history pages it served, in memory (`apps/gateway/src/market/historyCache.ts`).
- **A latest page** (no `to`) is answered as it is while the bar it ends on is still the live one, and was fetched at least 15 s after that bar opened, so every earlier bar was final (exchanges send a bar's final candle up to a few seconds late). The live bar is out of date, but the chart's live feed replaces it as soon as the chart subscribes.
- **Once newer bars exist,** only those are fetched (from the first bar that may have changed, with two to spare) and the page is brought up to date, keeping its length. A page more than 500 bars behind, or over 10 minutes old, is fetched whole.
- **Older pages** (with `to`) are kept for 30 minutes once all their bars are final.
- **Identical requests** at the same time share one fetch. Failures aren't kept. Tick charts aren't cached.
- **Checked live:** a Binance 1-second and 5-second page brought up to date equals one fetched afresh, bar for bar.

### 6.8 Local data (`data/`, gitignored)

| Path | Contents |
|---|---|
| `watchlist.json` | The watchlist |
| `settings.json` | Settings the gateway keeps; so far, whether the logo prompt was skipped |
| `secrets.json` | CoinGecko key (owner-only permissions) |
| `logos/index.json` | Each exchange's base assets → CoinGecko coins, and image URLs (refreshed weekly) |
| `logos/coins/` | Cached 50 px coin logos |
| `logos/exchanges/` | Cached exchange logos |
| `catalog.json` | Every exchange's trading pairs with 24 h volume, and asset names (one compact line, about 230 KB) |
| `tradingnerd.db` | Not used: the history cache is in memory (§6.7); a copy on disk would make a restart's first loads instant too |

- **Owner-only:** the folder is created owner-only (0700).
- **Atomic writes:** each file is written whole to a temporary file, then renamed into place.
- **Unreadable files:** one that can't be read is renamed aside (`….invalid-<time>`), and the gateway starts that file fresh.

### 6.9 Security

- **Loopback only:** the gateway listens on 127.0.0.1.
- **Request checks:**
  - Every request, REST or WebSocket handshake, must carry a loopback `Host` header.
  - If an `Origin` header is present, it must be an allowed origin.
  - This blocks other websites and DNS-rebinding attacks.
- **No CORS headers** are sent.
- **Secrets** are never logged, never returned to the browser, and never committed.

### 6.10 Repo layout and commands

```
apps/web          React UI (Vite)
apps/gateway      Local gateway (Node 26, Fastify)
packages/core     Shared types, constants, protocol
packages/chart    Chart engine wrapper (implemented from M1)
docs/SPEC.md      This document
docs/reference/   TradingView reference screenshots (Display P3) used by visual tests
data/             Local runtime data (gitignored, created at runtime)
```

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Gateway on 127.0.0.1:5180 and UI on http://127.0.0.1:5173 |
| `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm test:e2e` | Individual checks |
| `pnpm format` | Auto-format and apply safe lint fixes |
| `pnpm verify` | All checks; run before every delivery |
| `pnpm test:live` | Opt-in checks against the real exchanges |
| `pnpm exec playwright test visual --update-snapshots` (in `apps/web`) | Approve new visual baselines after an intended change; look at them first |

### 6.11 Stack

| Layer | Choice |
|---|---|
| Chart | Lightweight Charts 5.2 + our own plugins |
| UI | React 19, TypeScript 7, Vite 8, CSS Modules + CSS variables; Radix primitives and TanStack Virtual when needed |
| Gateway | Node 26 (native TypeScript), Fastify 5, @fastify/websocket, ws; history cache in memory |
| Quality | Biome, Vitest, Playwright |
| Later | Electron desktop shell |

## 7. UI and visual spec

### 7.1 Tokens

Measured from `docs/reference/` after converting Display P3 → sRGB. Defined once in `apps/web/src/theme/tokens.ts` and exposed as CSS variables.

| CSS variable | Value | Used for |
|---|---|---|
| `--color-bg` | `#0F0F0F` | Toolbar, chart and panel surfaces |
| `--color-gutter` | `#2E2E2E` | 4 px gaps between panels; 1 px row separators |
| `--color-grid` | `#1C1C1C` | Chart grid |
| `--color-chip` | `#3D3D3D` | Active interval, symbol pill, crosshair labels |
| `--color-separator` | `#4A4A4A` | Toolbar separators, menu dividers |
| `--color-popup` | `#1F1F1F` | Interval menu, dialogs |
| `--color-selection` | `#132E61` | Selected watchlist row |
| `--color-up` / `--color-down` | `#089981` / `#F23645` | Candles and price changes |
| `--color-up-text` | `#22AB94` | Rising numbers in text: watchlist Chg, digits that went up |
| `--color-unavailable` | `#F7525F` | Ticker of a symbol the exchange doesn't list |
| `--color-avatar-text` | `#636363` | Letter on a coin's placeholder avatar |
| `--color-bright` | `#F2F2F2` | Favorite stars, the chosen category chip |
| `--color-field-border` | `#636363` | Text field outlines (symbol search) |
| `--color-accent` | `#2962FF` | Buy button, focus rings, matched search text |
| `--color-crosshair` | `#9C9C9C` | Crosshair lines (dashed) |
| `--color-text` · `--color-text-secondary` · `--color-axis-text` | `#DBDBDB` · `#8C8C8C` · `#B8B8B8` | Text |
| `--font-family` | `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif` | All text |
| `--font-size-ui` · `--font-size-axis` | 14 px · 12 px | UI text · chart axes |

### 7.2 Layout geometry

Reference viewport is 1634 px wide.

- **Toolbar:** 38 px tall, full width, square corners.
- **Gutters and corners:** 4 px gutters around and between panels; panel corner radius 3.5 px. That was the best pixel match against the reference: 3.5 px scored 0.30–0.42 mean gray difference, 4 px up to 0.79.
- **Positions:** chart panel x 4 → 1311, splitter 1311 → 1315, watchlist 1315 → 1630 (315 px default width).
- **Width limits:** the watchlist is at least 240 px wide, and the chart never gets narrower than 320 px. The width is remembered.
- **Known difference:** in TradingView the watchlist joins the right icon bar, so its top-right corner is square. v1 has no icon bar, so all corners are rounded.

### 7.3 Details to match

- **Price axis** (measured at 2×, built in M1):
  - The axis is 72 px wide; tick labels start about 11 px in.
  - Labels are boxes sized to their text, starting 1 px inside the axis. Text is inset 9 px with 5 px after it. Widths are measured with every digit as 0, so a label never jitters while the countdown ticks or the crosshair moves.
  - Label edges sit on whole device pixels, as crisp as TradingView's.
  - Last-price label: two rows of 16 + 15 px (31 px), the first centered on the price, colored by the bar's direction. A dotted line (1 px dot, 3 px gap) runs across the pane.
  - Crosshair price label: 21 px tall, `#3D3D3D`, joined to a 23 px ⊕ box at the pane's right edge. The ⊕ menu is out of scope.
  - Tick labels that a label would only partly cover are hidden, so none peeks out.
  - Known difference: the crosshair dashes are 6 px / 6 px (library style); TradingView's are 5 / 6.
- **Legend** (built in M1):
  - Title 16 px. Status dot 18 px with a 10 px center.
  - OHLC at 14 px, colored by the bar's direction (close ≥ open). Change against the previous close.
  - Sell/Buy boxes 65.5 × 34 px with a 6 px radius: price 13 px medium, caption 11 px. Spread 11 px.
- **Toolbar** (measured at 2×, built in M2; every label lands where the reference's does):
  - Symbol pill: 128 × 28, fully rounded, `#3D3D3D`, 4 px from the window's edge. The ticker is 14 px semibold, 12 px in.
  - Inside the pill, a 28 × 24 capsule in `#0F0F0F` (inset 2 px) holds a two-candle icon.
  - Separator: 1 × 22 px `#4A4A4A`, 6 px either side. The ⊕ button TradingView has before it is out of scope.
  - Interval buttons: 14 px regular with tabular digits, 4 px padding, 4 px apart, 34 px tall. The active one gets a `#3D3D3D` chip with a 5.5 px radius (the reference's corner pixels match it row for row).
- **Interval menu** (measured at 2×, built in M2):
  - 195.5 px wide, `#1F1F1F`, hung from the ⌄ button.
  - "Add custom interval…" row: a 17 px "+" 16 px in, then the label.
  - Sections: 6 px above and below a 1 px `#4A4A4A` divider inset 6 px. Headers 24 px, 11 px uppercase with 0.4 px spacing, `#8C8C8C`, with a caret.
  - Rows: 32 px tall, 14 px regular with tabular digits. Favorites carry a solid 15.5 px star in `#F2F2F2`, 16 px from the right.
  - Scrollbar: a 3 px `#3D3D3D` thumb 1 px from the edge, drawn over the content.
- **Watchlist** (measured at 2×, built in M3; every edge here is within half a pixel of the reference):
  - Title row 48 px: "Watchlist ⌄" 14 px semibold, 16 px in. Three 34 px buttons (Add symbol, Advanced view, ⋯), 4 px apart, 9.5 px from the right.
  - Column titles: 13 px semibold `#8C8C8C` in a 28 px band over a 1 px `#3D3D3D` line, right edges at 163.5, 235.5 and 298.5 px. Then 5 px of space.
  - Section header: 30 px, pinned while its rows scroll. Caret 20 px in, then 11 px uppercase `#8C8C8C`.
  - Rows: 30 px with 1 px `#2E2E2E` separators; the first starts 111 px below the panel's top. Numbers are 14 px with tabular digits, right edges at 169.5, 242.5 and 307 px in the default 315 px panel.
  - Avatar: 18 px round, the logo or an 11 px semibold letter in `#636363` on `#2E2E2E`.
  - Colors: selected row `#132E61`; up `#22AB94`, down `#F23645`; an unlisted symbol's ticker `#F7525F`. The hover color `#1F1F1F` is provisional (§11).
  - Real minus sign; symbols hard-clipped.
- **Add symbol dialog** (measured from `docs/reference/04-add-symbol.png` at 2×, built in M4; CSS px from the dialog's top-left):
  - 840 × 680, `#1F1F1F`, 6 px corners, centered over a 50% black backdrop.
  - Title: 20 px semibold, 20 px in, its capitals 26.5 px down. Close: a 15 px × (1.25 px strokes) centered at (806, 34).
  - Search field: 800 × 40 at (20, 68), 1 px `#636363` outline, 8 px corners. A 1.5 px magnifier 13 px in; 16 px text from 57.5; a 16 px clear disc ending 13 px from the right.
  - Chips: 28 px tall, fully rounded, 14 px text, 12 px padding, 4 px apart, at y 124. `#2E2E2E`; the chosen one `#F2F2F2` with dark text.
  - Filters: 14 px text, capitals at y 176.5, each with an 8 px ⌄; the labels start at 32.5, 153.5 and 259.
  - Rows from y 205: 39 px plus a 1 px `#3D3D3D` line, ending 5 px short of the right edge, where a 3 px `#3D3D3D` scrollbar thumb sits 1 px in.
    - A 24 px coin logo 20 px in.
    - The ticker: 16 px, from 52.
    - The description: 14 px, from 151.
    - Matches in `#2962FF`.
  - Right of each row: "spot crypto" (12 px `#8C8C8C`), 8 px, the exchange (14 px), 9 px, an 18 px logo ending at 730.
    - Several exchanges stack 18 px logos 10 px apart, each over the next with a ring of the row's color, then a ⌄ (1.5 px strokes) in the logo's place.
    - Then two 28 px slots 8 px apart, at 751 and 787: + (17 px), or trash and locate (`#8C8C8C`).
  - Footer: 40 px `#2E2E2E`; 21 px keycaps with a 1 px `#4A4A4A` edge and a 1 px `#3D3D3D` shadow; 13 px text, its content 6.75 px right of center as in the reference.
  - Checked by pixel comparison: title, close, search field, chips, filters and footer are each within 1.5 gray levels on average of the reference (`tests/e2e/symbol-search.spec.ts`).
- **Attribution:** the TradingView logo at the bottom left is Lightweight Charts' required attribution, so we keep it.

### 7.4 Motion and feel

- **Chart:** no easing animations. It responds immediately to every input event; smoothness comes from cheap frames.
- **UI:**
  - Hover transitions 100 ms; dialogs fade/scale in 150 ms.
  - No layout shift when data arrives.
- **Hot path never touches React:**
  - The chart is updated imperatively.
  - Watchlist cells update per row, once per frame.
  - Splitter drags write a CSS variable per frame and commit on release.

## 8. Delivery plan

| | Milestone | Done when |
|---|---|---|
| M0 | Monorepo, tokens, app layout (toolbar, chart, watchlist, gutters, resizable split), gateway skeleton, test harness | Layout lines up with the reference screenshot; `pnpm verify` green |
| M1 | Chart on Binance: history + scroll-back, live candle merge, legend, countdown, crosshair, gesture handling | XRPUSDT side by side with TradingView: same candles, same gestures. **Committed 2026-10-18** |
| M2 | Interval bar and dropdown, favorites, custom intervals, resampler, seconds/ticks, type-to-switch | Every menu interval matches TradingView's bars. **Committed 2026-10-19** |
| M3 | Watchlist: live quotes, TradingView Chg%, digit flash, keyboard, sections, reorder, persistence; CoinGecko logos | 50 rows tick smoothly; survives restart; logo tests pass. **Committed 2026-10-19** |
| M4 | Add symbol / symbol search: pair catalog, ranking, exchange grouping, filters, keyboard | Typing "XRP" lists every exchange; picked row live in < 1 s. **Committed 2026-10-19** |
| M5 | Bybit, OKX, Coinbase, Kraken live adapters; reconnect + gap-fill; health dot | 30 s offline recovers with no missing candles. **Committed 2026-10-19** |
| M6 | Feel tuning vs TradingView, visual regression, performance profiling (Electron dropped, your call) | Parity checklist all passes. **Built 2026-10-19, except the feel tuning, which needs your side-by-side session (§11); awaiting your review** |

## 9. Testing strategy

- **Unit (Vitest):** pure logic — protocol parsing, interval math, resampler, Chg%, search ranking, layout math.
- **Gateway integration:**
  - Fastify `inject` plus real sockets on an ephemeral port.
  - Recorded exchange and CoinGecko responses; no live calls in automated tests.
  - The watchlist and logo routes run against a temporary data folder and a fake CoinGecko.
  - Each exchange adapter runs against responses and stream messages recorded on 2026-10-19 (`apps/gateway/test/fixtures/exchanges/`), with a local mock stream server for subscribing, routing and reconnecting.
- **E2E (Playwright, Chromium at 2× scale):** user flows, layout geometry, and no console errors.
  - Market data is mocked in the browser (`tests/e2e/fixtures.ts`): REST routes plus a routed WebSocket, seeded bars ending on the reference's last candle (1.2955), and the clock pinned to 16:09:54 UTC so the countdown reads 07:50:06.
  - Every test fails on any console error or warning.
  - Chromium runs with `--force-device-scale-factor=2`. Emulated 2× alone leaves `ResizeObserver` reporting 1× sizes, and charts then render blurry at half resolution.
  - Not `devices['Desktop Chrome']`: its Windows user agent switches on the Windows wheel handling.
  - Lightweight Charts applies view changes on the next frame, so tests read state after `settle()`.
  - The mock also serves the watchlist, quotes and logos, and a pair catalog across all five exchanges; a test can take an exchange's live data away.
  - An exchange outage: the chart says it's reconnecting, then reloads the bars it missed.
- **Performance** (`tests/e2e/perf.spec.ts`):
  - 50 watchlist rows ticking; panning and zooming through 20,000 bars (frame cost and steadiness); symbol and interval switches under 150 ms.
  - Its own Playwright project, run after the rest so parallel tests can't skew the timing.
  - It keeps the page's real clock (`realClock`). The pinned clock replaces `requestAnimationFrame` and `performance.now` with timer-driven, whole-millisecond versions.
  - Run it alone with `pnpm exec playwright test perf --no-deps` (in `apps/web`).
- **Symbol search** (M4):
  - Each exchange's pair list is parsed from responses recorded on 2026-10-19 (`apps/gateway/test/fixtures/catalog/`), including the pairs that must be left out.
  - The catalog's refresh, retry, save and reload run on simulated time.
  - The browser mock ranks its catalog with the gateway's own search (`searchCatalog`).
  - The dialog's title, field, chips, filters and footer are compared with `docs/reference/04-add-symbol.png` pixel by pixel.
- **Visual:** pixel checks against `docs/reference/`: gutter positions, surface colors, corner radius, the last-price label's size and text placement, the legend's position, and the watchlist's remove button (M6).
- **Visual regression** (M6, `tests/e2e/visual.spec.ts`): ten screens against approved screenshots: the chart page, the crosshair, a hovered watchlist row, the ⋯ menu, the interval menu, the custom interval dialog, Add symbol, symbol search, the legend during an outage, and the logo prompt. Any changed pixel fails the run.
- **Live (opt-in, `pnpm test:live`):** gateway and browser tests against the real exchanges:
  - Symbol names, full history back to 2018, live candle and quotes.
  - Binance's own 1m, 15m, 1h, 4h, 1D, 1W and 1M bars rebuilt exactly from smaller intervals.
  - Every resampled menu interval on its bar boundaries, up to the live bar.
  - A 100-tick bar rebuilt exactly from Binance's individual trades.
  - Live 45-second and 10-tick bars.
  - Watchlist quotes against Binance's own previous daily close.
  - CoinGecko rejects a made-up key.
  - Each exchange's real pair list loads, with XRPUSDT among the pairs. Typing "XRP" lists all five exchanges in one row, Binance first.
  - In the browser, a picked Binance pair is live within 1 s of the click. The test answers the watchlist save itself, so your list isn't changed.
  - Bybit, OKX, Coinbase and Kraken: tick sizes; daily history up to today, one bar a day; intervals built from smaller ones, on their boundaries; the live minute bar; the best bid and ask; quotes against the previous close.
  - A 30 s outage of all five exchanges' streams, cut by a local relay that refuses connections meanwhile: each recovers by itself, never shows live while cut, and misses no minute.
  - The history cache: Binance 1-second and 5-second pages brought up to date equal ones fetched afresh.
  - In the browser, a pair picked from each of Bybit, OKX, Coinbase and Kraken is live within 1 s. Coinbase's slowest API answers (about 1 in 40) can push it just past that.
- **Feel parity (manual, M1 and M6):** side-by-side checklist against TradingView:
  - zoom anchor, pinch speed, swipe speed, momentum, flick glide
  - price-axis swipe: speed, fixed point, direction
  - vertical drag, axis drag, double-click reset, shortcuts
  - Speeds are matched with the dev-only tuning panel (`?tune`); the fixed point is measured from screenshot pairs (§11).
- **Live smoke tests (manual):** real exchange streams; real CoinGecko key.

## 10. Risks

| Risk | Mitigation |
|---|---|
| "Exact feel" details aren't documented | We own the gesture layer and tune constants side by side with TradingView |
| Lightweight Charts lacks something | Plugin API first; fork (Apache-2.0) only as a last resort |
| Exchange outages, rate limits, API changes | Isolated adapters, cache, backoff, visible health dot |
| Shallow history (Kraken keeps 720 bars) | Its charts end there, and the oldest week or month built from its days can be partial |
| Small pages and low limits (Coinbase: 350 bars, 10 requests a second) | Windows fetched side by side and shared; a history cache in M6 |
| Trademarks | Personal/local use only, our own icons, Lightweight Charts attribution kept |

## 11. Open questions and parity checklist

- What does the icon inside TradingView's symbol pill do? We'll replicate it visually until decided.

**Side-by-side checklist** (open `BINANCE:XRPUSDT` 1D in TradingView next to tradingNerd). Each item is how M1 behaves; anything that differs is a quick change:

1. A plain wheel or two-finger vertical swipe zooms with the right edge fixed.
2. Ctrl/⌘ + wheel and a trackpad pinch zoom toward the cursor, at a similar speed.
3. A two-finger sideways swipe pans at a similar speed, with the same glide.
4. Dragging up or down turns auto-scale off; the dragged price stays under the pointer. A mostly horizontal drag keeps auto-scale on.
5. Ctrl/⌘ + ←/→ jumps 10 bars.
6. Countdown formats: "00:45" under an hour, "07:50:06" under a day, "3d 07:50:06" beyond.
7. Crosshair time label: "Thu 08 Dec '22" (daily and weekly), "… 14:35" intraday, "Dec '22" monthly.
8. Legend interval labels: minutes as "15", hours as "1h", then "1D", "1W", "1M".
9. Legend values colored by the bar's own direction (close vs open).
10. A two-finger vertical swipe or wheel over the price axis stretches or squeezes the candles vertically, not the time. The way that zooms the chart in makes them taller. Auto-scale turns off; double-clicking the axis or Alt+R turns it back on. **Provisional:** the middle of the price range stays put, and the speed equals the chart zoom.

**Intervals (M2)**, in the same side-by-side setup:

11. Every favorite and every menu interval shows the same candles as TradingView: 2m, 10m, 45m, 3h, 3M, 6M, 12M and 5–45s are built here; the rest are Binance's own.
12. A tick chart's bars match TradingView's: a tick counted as one trade, and bars starting at trade numbers divisible by the tick count. TradingView's tick history needs a Premium plan, so compare only if yours has it.
13. A current interval that isn't a favorite appears among the favorites in time order, highlighted. TradingView's placement is unconfirmed.
14. Typing "15m" in the interval prompt gives 15 minutes, and "1M" a month. TradingView's handling of a lowercase "m" is unconfirmed.

**Watchlist and logos (M3):**

15. Chg and Chg% match TradingView's for the same coins at the same moment. Both measure against the previous daily close (00:00 UTC). Include a coin priced to 6 decimals, such as VET, whose Chg shows 5.
16. A new price colors the digits from the first changed one, green up or red down. The color stays until the price changes again.
17. ✓ Your real CoinGecko key works: logos show in the watchlist and the legend (your check, 2026-10-19).

**Add symbol and symbol search (M4):**

18. Where TradingView puts a newly added symbol: ours goes to the end of the selected row's section.
19. Whether TradingView highlights a row before ↑/↓ (the reference shows none, so ours doesn't), and what Enter does without one (ours adds the top match).
20. TradingView describes Binance's XRPU as "XRP / U"; ours says "XRP / United Stables", Binance's own name for the asset.

**Exchanges (M5):**

21. A quiet Coinbase pair on 1m: ours shows a flat bar at the last price in each minute without trades. Does TradingView show the same, or leave gaps?
22. Each exchange's chart for the same pair (XRPUSDT on Bybit and OKX, XRPUSD on Coinbase and Kraken) shows the same candles as TradingView's.
23. How far back TradingView's Kraken charts go: ours end after 720 bars, all that Kraken's API keeps.
24. Descriptions on other exchanges use Binance's asset names where Binance lists the coin ("XRP / US Dollar" on Coinbase). Do TradingView's read the same?

**Watchlist from the hover reference (M6):**

25. Your LEOUSD shows Chg with 6 decimals (0.002800), where ours cut to 5, which your VET, SHIB, LUNC and ZEC rows all confirm. Which exchange is that LEOUSD from? Its price format may explain it.
26. Do TradingView's legend and price axis group thousands too (ours don't)? A chart of BTC would show it.
27. The remove button under the mouse, and a letter avatar on a hovered row (its gray circle matches the row): no reference shows these yet.
28. Flags: the colored markers at your rows' left edges aren't built. Say if you want them.

**Open question:** in the reference, TIA's and LDO's whole prices are red, not just the changed digits. The cause is unknown; a screenshot of it happening, or the TradingView setting behind it, would tell.

**Still needing a reference screenshot** (built in TradingView's idiom, not yet measured):

- The menu scrolled to the bottom (Hours and Days sections, with the current interval's row).
- A menu row under the mouse (hover color, outlined star).
- The "Add custom interval" dialog.
- The prompt after typing `5` on the chart.
- The watchlist's ⋯ menu, and a row's right-click menu.
- A watchlist row being dragged.
- The Add symbol dialog with a row under the mouse, a filter menu open, and a grouped row's ⌄ opened (TradingView's list of sources).
- The symbol search opened from the chart (its title and anything that differs from Add symbol).

**Calibrating the gesture constants** (TradingView doesn't publish them):

1. Open `http://127.0.0.1:5173/?tune`. A "Gesture tuning" panel appears (dev builds only). It sets chart zoom, pinch zoom, sideways pan and price-axis speeds, the price-axis fixed point and direction. Values apply instantly and survive reloads, but only while `?tune` is in the URL.
2. **Fixed point:** in TradingView, with auto-scale on, take a screenshot, do one short swipe over the price axis near its top, and take another. Repeat near the bottom. The axis labels in each pair show which price stayed put.
3. **Speeds and direction:** do the same swipe in both apps and move each slider until they match. Then press **Copy values** and paste the result into the chat.
4. The values become the defaults in `packages/chart/src/tuning.ts`, and the panel is deleted.

## 12. References

- Lightweight Charts: https://github.com/tradingview/lightweight-charts (releases, source)
- TradingView libraries and licensing: https://www.tradingview.com/free-charting-libraries/
- TradingView "Stay in focus" (Ctrl/⌘ zoom): https://www.tradingview.com/blog/en/stay-in-focus-15704
- TradingView Datafeed API: https://www.tradingview.com/charting-library-docs/latest/connecting_data/Datafeed-API/
- TradingView watchlist change calculation: https://www.tradingview.com/support/solutions/43000653369-how-are-change-and-change-calculated-in-the-watchlist/
- Binance WebSocket streams: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
- Coinbase Advanced Trade WebSocket channels: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
- CCXT (incl. WebSocket "Pro" API): https://docs.ccxt.com/docs/pro-manual
- CoinGecko API pricing: https://www.coingecko.com/en/api/pricing · authentication: https://docs.coingecko.com/v3.0.1/reference/authentication
