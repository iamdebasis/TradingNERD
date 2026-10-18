# tradingNerd — Product & Technical Spec

Living document. Last updated **2026-10-18** (M0 committed; M1 built and verified, awaiting review).
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
| Type digits / letters on the chart | Interval prompt / symbol search | Not built in | M2 / M4 |

¹ From TradingView's notes and observation, not formal docs: on the parity checklist (§11).

### 4.3 Market data (measured from the dev machine, 2026-10-17)

| Exchange | Bars per REST request | History | Live streams worth using |
|---|---|---|---|
| Binance | 1,000 | XRPUSDT from 2018-05-04; 1-second bars exist | kline (updates every **2 s**), aggTrade + bookTicker (real-time, ~33 ms) |
| Bybit | 1,000 | Deep, paged | kline, publicTrade, tickers |
| OKX | 300 | Deep, paged; 1-second bars | candles (business WS), trades, tickers |
| Coinbase | 350 | Deep, paged | ticker, market_trades (WS candles are 5-minute only) |
| Kraken | — | **Only the latest ~720 bars** per interval | ticker, ohlc, trade |

- **Access:** all five served REST and WebSockets with no API key and no geo-block, and all returned CORS headers.
- **Binance's candle stream can lag trades by up to 2 s.** We merge trades into the live candle (§6.4).
- **TradingView's `BINANCE:XRPUSDT` is Binance's own data.** Binance's XRPUSDT daily bar (O 1.3115, H 1.3126) and 0.0001 tick size matched the TradingView screenshot exactly.
- **Watchlist Chg / Chg%** in TradingView compares against the **previous daily bar's close**, not a rolling 24 h window.

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

### 5.6 Non-functional

- **Performance:**
  - 60 fps pan/zoom (120 fps on ProMotion) with 20k bars loaded.
  - Symbol/interval switch under 150 ms when cached, under 700 ms cold.
  - 50 live watchlist rows cost under 2 ms per frame.
- **Security:** the gateway binds to 127.0.0.1 only and rejects foreign Origin and non-loopback Host headers.
- **Resilience:** exchange disconnects recover automatically, with gap-fill and a visible status dot.

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
 │ Exchanges: Binance · Bybit · OKX · Coinbase · Kraken      │
 │            + CCXT for the pair catalog / long tail        │
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

### 6.6 Local data (`data/`, gitignored)

| Path | Contents |
|---|---|
| `tradingnerd.db` | SQLite: candle cache, symbol catalog, watchlists, favorites, settings |
| `secrets.json` | CoinGecko key (owner-only permissions) |
| `logos/coins/`, `logos/exchanges/` | Cached 50 px logo images |

### 6.7 Security

- **Loopback only:** the gateway listens on 127.0.0.1.
- **Request checks:**
  - Every request, REST or WebSocket handshake, must carry a loopback `Host` header.
  - If an `Origin` header is present, it must be an allowed origin.
  - This blocks other websites and DNS-rebinding attacks.
- **No CORS headers** are sent.
- **Secrets** are never logged, never returned to the browser, and never committed.

### 6.8 Repo layout and commands

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
| `pnpm test:live` | Opt-in checks against real Binance |

### 6.9 Stack

| Layer | Choice |
|---|---|
| Chart | Lightweight Charts 5.2 + our own plugins |
| UI | React 19, TypeScript 7, Vite 8, CSS Modules + CSS variables; Radix primitives and TanStack Virtual when needed |
| Gateway | Node 26 (native TypeScript), Fastify 5, @fastify/websocket; CCXT and SQLite from M1/M4 |
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
| `--color-selection` | `#132E61` | Selected watchlist row |
| `--color-up` / `--color-down` | `#089981` / `#F23645` | Candles and price changes |
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
- **Watchlist rows:**
  - 30 px tall, with 1 px `#2E2E2E` separators.
  - The selected row is `#132E61`.
  - Changed digits flash; real minus sign; symbols hard-clipped.
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
| M1 | Chart on Binance: history + scroll-back, live candle merge, legend, countdown, crosshair, gesture handling | XRPUSDT side by side with TradingView: same candles, same gestures. **Built 2026-10-18; awaiting your review** |
| M2 | Interval bar and dropdown, favorites, custom intervals, resampler, seconds/ticks, type-to-switch | Every menu interval matches TradingView's bars |
| M3 | Watchlist: live quotes, TradingView Chg%, digit flash, keyboard, sections, reorder, persistence; CoinGecko logos | 50 rows tick smoothly; survives restart; logo tests pass |
| M4 | Add symbol / symbol search: pair catalog, ranking, exchange grouping, filters, keyboard | Typing "XRP" lists every exchange; picked row live in < 1 s |
| M5 | Bybit, OKX, Coinbase, Kraken live adapters; reconnect + gap-fill; health dot | 30 s offline recovers with no missing candles |
| M6 | Feel tuning vs TradingView, visual regression, performance profiling, optional Electron | Parity checklist all passes |

## 9. Testing strategy

- **Unit (Vitest):** pure logic — protocol parsing, interval math, resampler, Chg%, search ranking, layout math.
- **Gateway integration:**
  - Fastify `inject` plus real sockets on an ephemeral port.
  - Recorded exchange and CoinGecko responses; no live calls in automated tests.
- **E2E (Playwright, Chromium at 2× scale):** user flows, layout geometry, and no console errors.
  - Market data is mocked in the browser (`tests/e2e/fixtures.ts`): REST routes plus a routed WebSocket, seeded bars ending on the reference's last candle (1.2955), and the clock pinned to 16:09:54 UTC so the countdown reads 07:50:06.
  - Every test fails on any console error or warning.
  - Chromium runs with `--force-device-scale-factor=2`. Emulated 2× alone leaves `ResizeObserver` reporting 1× sizes, and charts then render blurry at half resolution.
  - Not `devices['Desktop Chrome']`: its Windows user agent switches on the Windows wheel handling.
  - Lightweight Charts applies view changes on the next frame, so tests read state after `settle()`.
- **Visual:** pixel checks against `docs/reference/`: gutter positions, surface colors, corner radius, the last-price label's size and text placement, and the legend's position.
- **Live (opt-in, `pnpm test:live`):** gateway tests and one browser test against real Binance (symbol names, full history back to 2018, live candle and quotes).
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
| Shallow history (Kraken ~720 bars) | Show "no more data"; default to deep-history exchanges |
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
