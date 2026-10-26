# tradingNerd hand-over

The state of the work, for whoever picks it up next, human or AI. Update it at every hand-over. The rules are in [../AGENTS.md](../AGENTS.md); the decisions and their reasons in [SPEC.md](SPEC.md).

**Last updated:** 26 October 2026, by the AI Lead Architect and Lead Delivery Engineer (Claude).

## 1. Where things stand

| | |
|---|---|
| Branches | `main` is at `9324baa` (pull request #1 merged: the docs' fixes), pushed and protected by a ruleset; it was brought level with `m7-us-stocks` on 26 October. New work comes from `claude/…` branches as pull requests, which the user merges on GitHub (AGENTS.md, "Git"). `m7-us-stocks` is kept as a historical branch, and no new work happens there. Six older milestone branches (`m1-chart` … `m6-feel-performance`) aren't on GitHub |
| Home | https://github.com/iamdebasis/TradingNERD, public |
| Committed | M0–M8e (chart, intervals, watchlists, search, exchanges, feel, US stocks, several watchlists), M9a–M9e (CRYPTOCAP, formulas, Bitstamp, kept history, older market caps), A1, A2, A6 (accuracy steps) |
| Committed, switched off | **M9f, each coin's older days:** steps 1–2 in `c4f260a`, built and tested, switched off in the charts; its download runs on the user's gateway |
| History cleaned (26 October) | Before the first push, every commit was rewritten: the author is **Debasis `<30506767+iamdebasis@users.noreply.github.com>`** (GitHub's private address), with times in UTC; the TradingView name and avatars in two reference screenshots are painted over. Every file, message and moment is otherwise as before. All 1,406 objects were searched afterwards: no personal email, name, home folder, Mac name, time zone or key |
| Built, not committed | **I1, indicators' framework with Volume and RSI**, on `claude/keen-allen-7wubfe` (a cloud session, 26 October): see §2b |
| Taken out | A3 (hiding unchecked coins), on the user's rule against hiding data |
| Not built | M7c (stock logos); A4 and A5 (overtaken by M9e and M9f) |

The milestone table is SPEC §8.

## 2. Under way: M9f, each coin's older days

The user said YES to steps 1–3: the ETH Zurich import, the Live Coin Watch download with its tests, and the accuracy test, stopping to report before anything on the charts changes. The design is SPEC §3 (rows of 26 October), §4.14 and §5.14.

| Step | State |
|---|---|
| 1. ETH Zurich's dataset | In place in `data/cryptocap/older-coins/`: `market_cap_all_daily.csv` and `close_price_all_daily.csv`, the same bytes as Zenodo's, placed by hand because Zenodo turns programs away. 1,211 coins ever in a day's top 200 |
| 2a. Reading Live Coin Watch's list | Paused at 65,900 coins read (about 22,000 kept as candidates) when the user's app stopped on 26 October; it carries on when `pnpm dev` runs again |
| 2b. Each candidate's months | Next, automatically: a request a coin, in groups most likely first, each group given up after 1,000 in a row outside a month's 250 largest. **First check how many requests it will need** (`data/cryptocap/older-coins/index.json`, `listed`; `lookAtGroups` in `olderCoins.ts`) and tell the user before it spends many |
| 2c. Every day of the chosen coins | Then, automatically: each coin among a month's 200 largest (stablecoins, the 60 largest), and each of CoinGecko's coins, 100 days a request. About 2–3 days in all at the free 10,000 requests a day; it waits at the day's end (00:00 UTC) and carries on after restarts |
| 3. The accuracy test | Ready, waiting for the download. See below |
| 4. In the charts | Needs the user's YES after the test. Turn the switch on by default and retire M9e's whole-market days for TOTAL, TOTAL2, TOTAL3 and BTC.D |
| 5. Commit | Needs its own YES |

**Watching it:** `GET http://127.0.0.1:5180/api/older-caps` → `coins` (`state`, `progress`, `message`), or the dialog "Older market caps (Live Coin Watch)…" in the watchlist's ⋯ menu. The key is saved in the app (`data/secrets.json`), so a plain `pnpm dev` is enough.

**The accuracy test** (`tools/accuracy/`):
1. `tools/accuracy/check.sh` starts a gateway of its own on 5191, on a copy of `data/` without `secrets.json`, with `CRYPTOCAP_OLDER_COINS=1`. It has no keys, so it downloads nothing.
2. It reads TradingView's TOTAL2/XRPUSD weekly chart off `docs/reference/tv-total2-xrpusd-1w-2026-10-26.png`, pixel column by pixel column.
3. It compares those columns with our weekly highs drawn into the same columns.

| What | Figures |
|---|---|
| The ruler, validated on our own last year | Median −0.2%; half the columns between −0.3% and +0.1% |
| **Pass mark** | Within ±3% in each year 2019–2024; no step at 7/8 February 2018 or at our first day; a bar every day |
| **Today, M9e (Live Coin Watch's whole market)** | 2018 +20.7%, 2019 +11.7%, 2020 +2.2%, 2021 +5.9%, 2022 +8.3%, 2023 +9.2%, 2024 +9.2%, 2025 +2.3% |
| 2017 | Can't pass: TradingView's own 2017 is smaller than Ethereum's market cap alone (+231%) |

If a year misses, report it with the reasons before changing anything. Likely causes:
- coins missed between monthly looks;
- Live Coin Watch's supply jumps;
- wrapped tokens let through.

## 2b. Built: I1, indicators (Volume and RSI)

The user said YES to building I1 on 26 October (the plan's research, design and milestones; SPEC §3, §4.15, §5.15, §6.16). Built in a cloud session on `claude/keen-allen-7wubfe`, restarted from `main`. Not committed: the commit and the push each need their own YES.

| Part | State |
|---|---|
| `packages/indicators` | Pine's `ta.*` kernels, Volume and RSI as TradingView defines them, the run (committed bars and the live one), the warm-up rule. 73 tests, matching Tulip's published rows and TradingView's EMA example |
| Gateway | `fromListing` on history pages (protocol v10): native, resampled, cached and tick pages. Tests pass |
| `packages/chart` | Panes, Volume at the bottom of the price pane, RSI's pane with its lines, fill and value labels, the crosshair label per pane, the wheel and vertical drag per pane, pane heights told after a drag |
| `apps/web` | The Indicators button and its favorites ⌄, the dialog (`/` opens it), legend rows with Hide, Settings and Remove, the fold button, pane legends, the settings dialog (Inputs, Style, Defaults → Reset settings), kept in this browser |
| Checks in the cloud | Typecheck and lint clean; unit tests all pass (core 339, indicators 73, chart 64, web 166, gateway 517); the browser suite, visual tests aside, 187 of 192 pass with the 16 new indicator tests, the 5 failures the known platform ones (§3), as before the change |

**Left for the Mac** (the cloud can't do these):
1. `pnpm verify`, the browser tests included. The chart page's visual baseline changes on purpose (the toolbar's new Indicators button): look at it, then renew it with `pnpm exec playwright test visual --update-snapshots` (in `apps/web`). The other twelve must not change.
2. The performance budgets with Volume and RSI (`pnpm exec playwright test perf --no-deps`): in the cloud the 95th percentile frame was 11.4–11.6 ms against a 10 ms budget, where the Mac is several times faster (SPEC §11, item 67).
3. The hand checks H1–H7 against TradingView (SPEC §9), with the screenshots in SPEC §11, item 62, which also settle the provisional looks.
4. A read-only check against the user's running app.

**Decisions for the user:** a new chart starts without Volume, unlike TradingView's (§11, item 64); the warm-up rule leaves the first few hundred bars of RSI blank where a provider's history stops short of the listing (item 65).

## 3. Running and checking

- **Start:** `pnpm dev`, then open http://127.0.0.1:5173.
- **Keys,** each in its dialog: CoinGecko (coin logos and CRYPTOCAP), Alpaca (US stocks), Live Coin Watch (older market caps).
- **Before every delivery:** `pnpm verify`, then a read-only check against the running app (AGENTS.md).
- **Test counts on 26 October** (with I1, not yet committed):
  - core 339, indicators 73, chart 64, web 166;
  - gateway 517 (plus 66 that need the live internet);
  - browser 210 (16 for indicators, 2 more performance);
  - lint and typecheck clean.
- **Known flaky test:** Bitstamp's "polls the live candle every 30 s" sometimes fails under load and passes on a rerun.
- **Cloud sessions** (Claude Code on the web): put `/opt/node26/bin` first on PATH (the default `node` there is 22). Typecheck, lint and the unit tests run there; the browser tests don't yet, a known gap (AGENTS.md, "Commands"). The real check against the running app happens on the Mac.
  - The browser tests can be run there by hand without writing anything into the repository: point Playwright at the preinstalled browser through a scratch folder of links (`PLAYWRIGHT_BROWSERS_PATH`, with `chromium-1248` and `chromium_headless_shell-1248` linked to `/opt/pw-browsers/…-1243`), skip the visual tests and pass `--update-snapshots=none`. Five tests fail there for platform reasons only (font metrics, pixels, a flick's 1 px): `chart.spec.ts` Sell and Buy's spread, `gestures.spec.ts` the flick, `reference.spec.ts` the legend's place, `symbol-search.spec.ts` and `watchlist.spec.ts` pixel checks. Its performance budgets are the Mac's.

## 4. Security

Audited on 26 October against the code, the running app and all of git history ([SECURITY.md](SECURITY.md)): every point held.
- **Only providers:** nothing leaves the Mac but what the data providers need.
- **Keys:** owner-only and masked to the browser.
- **Network:** the servers can't be reached from other machines.
- **No telemetry.** The only remote is GitHub (`origin`), and the repository is public, so anything pushed is published.
- **To do:** back up `data/` (encrypted, e.g. Time Machine), above all `data/cryptocap/anchors.json`, whose kept days can't be downloaded again.

## 5. Open items

The full list is SPEC §11; these are the ones that matter most.

- **Accuracy:**
  - Older years read a few percent high until M9f is switched on (§11, items 58–59).
  - About 24 coins' supply differs from TradingView's, and CoinGecko's figure is shown (item 50).
  - TradingView's own 2017 is incomplete.
- **Depth:**
  - Kraken gives the last 720 bars; its free downloadable OHLCVT files could give the rest (Phase 3).
  - OKX stops at its own cut-offs.
  - US stocks start in 2016 (item 60).
- **Waiting for the user's word:**
  - gold and silver for BTCUSD/XAUUSD and BTCUSD/SILVER;
  - TradingView-style self-widening watchlist columns (item 53);
  - a separate data folder for the browser tests' own gateway (item 57);
  - M7c stock logos.
- **Free limits that can change:** CoinGecko's 10,000 calls a month, Live Coin Watch's 10,000 requests a day. CoinDesk reportedly ended its free plan in 2026.
- **Indicators (I1):** every look not measured from a screenshot is provisional (SPEC §11, items 62–63); TradingView's tick volume for TOTAL isn't ours (item 68); the current RSI's gradient fills are unconfirmed (item 69).

## 6. Next steps, in order

For I1 (§2b): the user's YES to commit, and another to push and open the pull request; then on the Mac, `pnpm verify` with the chart page's baseline renewed after looking at it, the performance budgets, and the hand checks with the screenshots asked for.

For M9f:

1. Size step 2b and tell the user how many requests it needs.
2. Let the download finish, then run `tools/accuracy/check.sh`.
3. Report the result year by year, then ask YES to switch M9f on in the charts.
4. Update SPEC (§5.14 status, §8, §11) and this file, then ask YES to commit, and again to push and open a pull request.
5. Then the user's list: Phase 3 (Kraken's history files), and the open items above, each with its own plan and YES.

Steps 1–3 need the user's Mac: the download runs on its gateway, and the ruler needs macOS's `sips`.
