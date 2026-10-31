# tradingNerd hand-over

The state of the work, for whoever picks it up next, human or AI. Update it at every hand-over. The rules are in [../AGENTS.md](../AGENTS.md); the decisions and their reasons in [SPEC.md](SPEC.md).

**Last updated:** 31 October 2026, by the AI Lead Architect and Lead Delivery Engineer (Claude).

## 1. Where things stand

| | |
|---|---|
| Branches | `main` is at `6c403cb` (pull request #2 merged: I1 and its gaps), protected by a ruleset; it was brought level with `m7-us-stocks` on 26 October. New work comes from `claude/…` branches as pull requests, which the user merges on GitHub (AGENTS.md, "Git"). `m7-us-stocks` is kept as a historical branch, and no new work happens there. Six older milestone branches (`m1-chart` … `m6-feel-performance`) aren't on GitHub |
| Home | https://github.com/iamdebasis/TradingNERD, public |
| Committed | M0–M8e (chart, intervals, watchlists, search, exchanges, feel, US stocks, several watchlists), M9a–M9e (CRYPTOCAP, formulas, Bitstamp, kept history, older market caps), A1, A2, A6 (accuracy steps), I1 with its gaps (indicators: Volume and RSI; merged on GitHub) |
| Committed, switched off | **M9f, each coin's older days:** steps 1–2 in `c4f260a`, built and tested, switched off in the charts; its download runs on the user's gateway |
| History cleaned (26 October) | Before the first push, every commit was rewritten: the author is **Debasis `<30506767+iamdebasis@users.noreply.github.com>`** (GitHub's private address), with times in UTC; the TradingView name and avatars in two reference screenshots are painted over. Every file, message and moment is otherwise as before. All 1,406 objects were searched afterwards: no personal email, name, home folder, Mac name, time zone or key |
| Built, not committed | **P1, the Pine Editor's first milestone** (31 October), on `claude/keen-allen-7wubfe`, from `main` at `6c403cb`: see §2b |
| Taken out | A3 (hiding unchecked coins), on the user's rule against hiding data |
| Not built | M7c (stock logos); A4 and A5 (overtaken by M9e and M9f) |

The milestone table is SPEC §8.

## 2. Under way: M9f, each coin's older days

The user said YES to steps 1–3: the ETH Zurich import, the Live Coin Watch download with its tests, and the accuracy test, stopping to report before anything on the charts changes. The design is SPEC §3 (rows of 26 October), §4.14 and §5.14.

**The state below is as of 26 October.** The download runs on the user's Mac, and the cloud sessions since (I1, P1) can't see it; read it from the app before planning the next step.

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

## 2b. Built: P1, the Pine Editor (31 October)

The user said YES on 27 October to "build P1 of the Pine Editor as above (installing Monaco, adding the right toolbar, saving scripts in `data/scripts.json`, and bringing Pine into v1's scope)", and after pull request #2 merged, "carefully go ahead". Built in a cloud session on `claude/keen-allen-7wubfe`, from `main` at `6c403cb`. **Not committed:** committing needs its own YES, and pushing and opening the pull request another. The design is SPEC §3 (the rows of 31 October), §4.16, §5.16, §6.17 and §7.5.

**What it does,** on the user's model for a built-in's code (27 October):
- **The right toolbar:** Watchlist and Pine Editor buttons at the window's right edge; the lit one's panel shows on the right.
- **Opening code:** the legend's Source code button (`{}`) on RSI and on every script opens its code; so does the name's menu (Create new, Built-in: Relative Strength Index, My scripts).
- **A built-in's code** is editable at once, under the banner "Built-in script. Your edits make a copy; the original stays as it is." Reset to original puts the built-in's code back, as one edit that Undo takes back. The built-in on the chart never changes.
- **Add to chart** (Ctrl/Cmd + Enter) puts the code on the chart as a script of its own, beside the built-in; then the button reads Update on chart. Code with errors stays off the chart, and the console lists them; a click goes to the line.
- **Save script** (Ctrl/Cmd + S) names it and makes it one of My scripts, version 1; each later save that changes the code is the next version, shown in the status bar. My scripts are in the Indicators dialog under Personal.
- **Unsaved code** is kept in this browser through closing the editor and reloading.
- **A script on the chart** has its legend row, its settings (Inputs and Style), Pine's plot styles, fills, backgrounds, hlines and per-bar colors. A runtime error shows a red "!" in its row, with the message.

| Part | State |
|---|---|
| `packages/pine` (new) | Our own Pine v6 engine: the lexer and parser, types and qualifiers, the runtime with Pine's execution model (each variable's history, `var`, the live bar rolled back and committed), the built-ins in SPEC §5.16, and the warm-up checks. 128 tests |
| `packages/indicators` | RSI's Pine code (`rsi.pine.ts`: our own, not TradingView's text); the model's additions for scripts (text, color and menu inputs, tooltips, Pine's looks, backgrounds, the price placement) |
| `packages/chart` | A script read as an indicator and run (`indicators/script.ts`); Pine's plot styles, per-bar colors, backgrounds, fills colored bar by bar, offsets, `show_last`, `trackprice`; a script's error. 11 new tests |
| Gateway | My scripts and their versions in `data/scripts.json` (`ScriptsStore.ts`, `routes/scripts.ts`), protocol v11. 14 new tests |
| `apps/web` | The right toolbar; the Pine Editor (Monaco 0.57.0, bundled, with Pine's colors measured from the user's screenshot); the open script kept in this browser; Save script; My scripts in the Indicators dialog; the legend's `{}` and error mark; the settings dialog's new inputs; the indicator store's version 2 (it still reads version 1). 5 new unit tests, 8 browser tests |

**Measured** (the cloud's machine, Node 26; SPEC §4.16):

| What | Result |
|---|---|
| RSI's Pine code against the built-in, 20,000 bars, 7 smoothings × 2 sources | Identical on every bar |
| One run over 20,000 bars | 20–35 ms (the built-in: 7 ms); 81–85 ms with the warm-up checks |
| A live tick, with the checks | 6–11 µs |
| The warm-up rule for scripts, against a history 3,000 bars longer | RSI drawn from bar 293 (the built-in: 294), within 5.7 × 10⁻⁹ of the longer history's values |
| Requests while the editor loads Monaco, its worker and its icon font | 673, all to 127.0.0.1 (a scratch browser check, not in the repository) |

**Checks in the cloud (31 October):**
- Typecheck and lint clean.
- Unit tests all pass: core 345, indicators 78, pine 128, chart 76, web 171, gateway 531 (plus 66 live tests, not run).
- The browser suite, visual and performance tests aside: 202 of 207 pass, all 8 Pine tests among them. The 5 failures are the known platform ones (§3).
- **Performance,** for comparison only: the budgets are the Mac's, and the cloud's machine misses some even on `main`. With Volume and RSI, panning and zooming 20,000 bars, against `main` on the same machine, three runs each:

  | | Median frame | 95th percentile |
  |---|---|---|
  | `main` | 2.0–3.0 ms | 14.4–14.5 ms |
  | P1 | 2.7–3.1 ms | 13.8–14.5 ms |

  Timed call by call, older history's arrival and the indicators' redraw are no slower with P1 (194 and 106 ms, against `main`'s 216 and 116). A first run's 17.1 ms at the 95th percentile was the machine's noise.
- **Found while measuring, and fixed:** a script's definition was rebuilt each time the legend asked with the symbol's precision after its rows asked with the default. Now one is kept per precision; its regression test fails without the fix.

**Left for the Mac** (the cloud can't do these):
1. After pulling, `pnpm install` (P1 adds `monaco-editor`), then restart `pnpm dev`: the gateway and the web app move to protocol v11 together. Then `pnpm verify`, the browser tests included. The right toolbar changes the full-page screenshot on purpose (`chart-page.png`, 48 px wider); look at it, then renew it with `pnpm exec playwright test visual --update-snapshots` (in `apps/web`). The element shots shouldn't change; if one does, look at why before renewing it.
2. The performance budgets: `pnpm exec playwright test perf --no-deps`.
3. The hand checks (SPEC §5.16, "Done when"): RSI's copy reads as the built-in on the user's chart, and a script of the user's own runs as it does on TradingView.
4. A read-only check against the user's running app. A check saves no script: `data/scripts.json` holds the user's own.

**Decisions for the user:**
- The editor's look is provisional until a screenshot of TradingView's editor on code being edited, at full size, and one of its right toolbar (SPEC §11, item 74).
- The built-in RSI's smoothed MA (EMA, SMMA) waits longer than its script needs: 452 and 587 bars, against 314 and 349 for the same accuracy (item 76). Making the built-in follow the measured rule is the user's call.
- A proposal for AGENTS.md, which changes only on the user's word: add `data/scripts.json` to its list of files a live check never changes and checksums, and bring its "Where the work stands" up to date (it still says 26 October, `main` at `38e1ae9`).

**Provisional** (SPEC §11, items 75 and 77–81): the warm-up checks' thresholds; a Style tab color against the script's own; Pine defaults TradingView doesn't document; drawing details; a name already taken numbered ("My RSI 2"); `ta.rsi` with no falls.

**I1, merged on GitHub (pull request #2), still has the Mac's checks:** `pnpm verify` with the chart page's baseline renewed, the performance budgets with Volume and RSI, the hand checks H1–H7 against TradingView (SPEC §9) with the screenshots in SPEC §11, item 62, and a read-only check against the running app. Its decisions are still the user's: a new chart starts without Volume, unlike TradingView's (§11, item 64), and the warm-up rule leaves the first few hundred bars of RSI blank where a provider's history stops short of the listing (item 65).

## 3. Running and checking

- **Start:** `pnpm dev`, then open http://127.0.0.1:5173.
- **Keys,** each in its dialog: CoinGecko (coin logos and CRYPTOCAP), Alpaca (US stocks), Live Coin Watch (older market caps).
- **Before every delivery:** `pnpm verify`, then a read-only check against the running app (AGENTS.md).
- **Test counts on 31 October** (with P1, not yet committed):
  - core 345, indicators 78, pine 128, chart 76, web 171;
  - gateway 531 (plus 66 that need the live internet);
  - browser 225 (8 for the Pine Editor, 23 for indicators, 13 visual, 5 performance);
  - lint and typecheck clean.
- **Known flaky test:** Bitstamp's "polls the live candle every 30 s" sometimes fails under load and passes on a rerun.
- **Cloud sessions** (Claude Code on the web): put `/opt/node26/bin` first on PATH (the default `node` there is 22). Typecheck, lint and the unit tests run there; the browser tests don't yet, a known gap (AGENTS.md, "Commands"). The real check against the running app happens on the Mac.
  - The browser tests can be run there by hand without writing anything into the repository: point Playwright at the preinstalled browser through a scratch folder of links (`PLAYWRIGHT_BROWSERS_PATH`, with `chromium-1248` and `chromium_headless_shell-1248` linked to `/opt/pw-browsers/…-1243`), skip the visual tests and pass `--update-snapshots=none`. Five tests fail there for platform reasons only (font metrics, pixels, a flick's 1 px): `chart.spec.ts` Sell and Buy's spread, `gestures.spec.ts` the flick, `reference.spec.ts` the legend's place, `symbol-search.spec.ts` and `watchlist.spec.ts` pixel checks. Its performance budgets are the Mac's: the cloud's machine misses some even on `main`, so compare there only against `main` on the same machine.
  - The browser window in the tests is 1,682 px wide: TradingView's 1,634 px reference layout plus the 48 px right toolbar (`playwright.config.ts`).

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
- **GitHub's merge commits:** merging on GitHub made `9324baa` (pull request #1) and `6c403cb` (#2), with GitHub as committer and +0530, the time zone the 26 October rewrite took out. Both are public on `main`, so the identity check (AGENTS.md, "Git") now prints a second line that no push of ours adds. How merges should go is the user's call, from the options given on 26 October: fast-forward `main` from the Mac with a bypass of the ruleset for the user alone, accept GitHub's commits in the docs, or try merging from a browser set to UTC (GitHub doesn't document which time zone it stamps).
- **Free limits that can change:** CoinGecko's 10,000 calls a month, Live Coin Watch's 10,000 requests a day. CoinDesk reportedly ended its free plan in 2026.
- **Indicators (I1):** every look not measured from a screenshot is provisional (SPEC §11, items 62–63 and 70); TradingView's tick volume for TOTAL isn't ours (item 68); RSI's Timeframe input and the sentence-case title wait on the user (items 71 and 73). The Source code button came with P1 (item 72).
- **Pine Editor (P1):** built, not committed (§2b). Its look is provisional until the screenshots in SPEC §11, item 74; the built-in RSI's smoothed MA waits on the user (item 76). P2 (version history, Rename, Make a copy, Delete, Pine Logs, more of the language, Volume's code) and P3 (drawings, libraries, strategies, alerts) are planned in SPEC §8, each for its own YES.

## 6. Next steps, in order

For P1 (§2b): the user's YES to commit it, and another to push it and open the pull request into `main`; then on the Mac, `pnpm verify` with the chart page's baseline renewed after looking at it, the performance budgets, the hand checks, and I1's own checks still open. Then, on the user's YES, P2.

For M9f:

1. Size step 2b and tell the user how many requests it needs.
2. Let the download finish, then run `tools/accuracy/check.sh`.
3. Report the result year by year, then ask YES to switch M9f on in the charts.
4. Update SPEC (§5.14 status, §8, §11) and this file, then ask YES to commit, and again to push and open a pull request.
5. Then the user's list: Phase 3 (Kraken's history files), and the open items above, each with its own plan and YES.

Steps 1–3 need the user's Mac: the download runs on its gateway, and the ruler needs macOS's `sips`.
