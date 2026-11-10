# tradingNerd hand-over

The state of the work, for whoever picks it up next, human or AI. Update it at every hand-over. The rules are in [../AGENTS.md](../AGENTS.md); the decisions and their reasons in [SPEC.md](SPEC.md).

**Last updated:** 10 November 2026 (the hand-over after the Mac's `pnpm verify`: three browser tests fixed for the Mac's keys, five visual baselines to renew on the Mac, GitHub sign-in on the Mac; the gateway's own address merged as pull request #8), by the AI Lead Architect, Lead Delivery Engineer and UI Lead (Claude).

## 1. Where things stand

| | |
|---|---|
| Branches | `main` is at `de15c5f` (pull request #8 (https://github.com/iamdebasis/TradingNERD/pull/8) merged on 10 November: the gateway's own address; #7 the same day: price alerts; #6 on 9 November: Pine for any script, steps 1 to 4; #5 before it, the hand-over of 8 November; #4, P2 and P4; #3, P1, the Pine Editor), protected by a ruleset; it was brought level with `m7-us-stocks` on 26 October. New work comes from `claude/…` branches as pull requests, which the user merges on GitHub (AGENTS.md, "Git"). `m7-us-stocks` is kept as a historical branch, and no new work happens there. Six older milestone branches (`m1-chart` … `m6-feel-performance`) aren't on GitHub |
| Merged | **Pull request #8** (https://github.com/iamdebasis/TradingNERD/pull/8), the gateway's own address sending a browser on to the app (§2h), merged on 10 November: `main` is at `de15c5f`. **Pull request #7** (https://github.com/iamdebasis/TradingNERD/pull/7), price alerts (§2g), merged on 10 November. **Pull request #6** (https://github.com/iamdebasis/TradingNERD/pull/6), Pine like TradingView's for any script, merged on 9 November: steps 1 to 4 (compatibility with older versions, §2c; drawings, §2d; strategies and the Strategy Tester, §2e; alerts on scripts and the non-standard data, §2f). **Pull request #5** (https://github.com/iamdebasis/TradingNERD/pull/5), the hand-over of P2 and P4, on 8 November |
| Under way | **The hand-over after the Mac's `pnpm verify`** (§2i): three browser tests fixed to press the Mac's keys, and these docs, on `claude/keen-allen-7wubfe` from `main` at `de15c5f`, for its own pull request |
| Waiting on the Mac | Renewing five visual baselines after a look, and signing git in to GitHub so the Mac can push (§9, step 2) |
| Home | https://github.com/iamdebasis/TradingNERD, public |
| Committed | M0–M8e (chart, intervals, watchlists, search, exchanges, feel, US stocks, several watchlists), M9a–M9e (CRYPTOCAP, formulas, Bitstamp, kept history, older market caps), A1, A2, A6 (accuracy steps), I1 with its gaps (indicators: Volume and RSI), P1 (the Pine Editor), P2 (real Pine scripts, the editor as TradingView's), P4 (other symbols and timeframes, open interest), Pine for any script (compatibility with older versions, drawings, strategies and the Strategy Tester, alerts on scripts, Renko, Line Break, Kagi and Point & Figure data), price alerts and the gateway's own address; all merged on GitHub |
| Committed, switched off | **M9f, each coin's older days:** steps 1–2 in `c4f260a`, built and tested, switched off in the charts; its download runs on the user's gateway (§4) |
| History cleaned (26 October) | Before the first push, every commit was rewritten: the author is **Debasis `<30506767+iamdebasis@users.noreply.github.com>`** (GitHub's private address), with times in UTC; the TradingView name and avatars in two reference screenshots are painted over. Every file, message and moment is otherwise as before. All 1,406 objects were searched afterwards: no personal email, name, home folder, Mac name, time zone or key |
| Merged: P2 | **P2, real Pine scripts and the editor as TradingView's** (31 October to 2 November), from `main` at `4295233`, committed step by step on the user's YES: step 1 (versions and types, `212fb59`), step 3 (the built-ins on TradingView's own values, `0c80d88`), step 4 (the plotshape family, `074a0a7`), step 5 (libraries, protocol v12, `264218c`), step 6 (the script menu, Version history, help while typing, `f296709`) and step 7 (Pine Logs, Convert code to v6, Move script to bottom, the corpus's last fixes, `e90c080`). The corpus: 478 of 481 manual examples and 199 of 199 community scripts that need only P2 run (99.6%), and the manual's error examples all stop as on TradingView; 671 of 689 plots equal TradingView's (SPEC §4.17). Merged with P4 on 7 November (pull request #4). Provisional: SPEC §11, items 89 to 103 |
| Merged: P4 | **P4, other symbols and timeframes** (3 to 7 November), on the same branch after P2, committed step by step on the user's YES: step 1 (`request.security()`, `44abccf`), step 2 (dynamic requests, `8765ac4`), step 3 (lower timeframes, `timeframe =`, ticker ids, currencies, `fa1e80c`), step 4 (requested data from the gateway, the legend's ring, RSI's Timeframe, Symbol Search for `input.symbol`, `1628f6e`), step 6 (open interest symbols, `e59a120`) and step 7 (the docs, `84e6e2e`). Step 5, measuring the open interest providers, has no code. Merged on 7 November (pull request #4); §3 below. Provisional: SPEC §11, items 104 to 117 |
| Taken out | A3 (hiding unchecked coins), on the user's rule against hiding data |
| Not built | M7c (stock logos); A4 and A5 (overtaken by M9e and M9f) |

What's left for the Mac, for every milestone, is one list: §9. The milestone table is SPEC §8.

## 2i. The Mac's `pnpm verify` of 10 November

The user ran `pnpm verify` on the Mac with price alerts and the gateway's address merged. Typecheck, lint and every unit test passed (verify runs them first). The browser tests: 236 passed, 8 failed, 5 didn't run. None of the failures was the app's.

| What | Tests | Why | Now |
|---|---|---|---|
| Keys | 3: Indicators' "/ opens the dialog…", Pine Logs' "an entry's Scroll to bar… Source code…", the editor's "help while typing" | Written and passed in the cloud with Linux's keys. On a Mac, Ctrl+A goes to the field's start, so "vol" landed before the old text; the code editor's first line is ⌘↑ (⌘Home does nothing); hover help is ⌘K ⌘I, not Ctrl+K Ctrl+I | Fixed: each test presses its platform's keys (AGENTS.md, "Tests"; SPEC §3) |
| Visual | 5: the chart page, a row's menu, the interval menu, the Gestures popup, the custom interval dialog | The chart page's reference is from 24 October, before the Indicators, Alert and Alerts buttons and the right toolbar's 48 px. The other four differ by 9 to 2,893 pixels with code unchanged since 26 October; the cloud's renders of all four show the same content as the Mac's references, so only the drawing of text differs (the Gestures popup now sits at x = 823.84 px under its button, which the new buttons moved) | To renew on the Mac after a look (§9, step 2; SPEC §11, item 134) |
| Speed | 5 didn't run | The performance tests run only after the others pass | §9, step 2 |

**Pushing from the Mac** failed: "Invalid username or token. Password authentication is not supported for Git operations." Git on the Mac isn't signed in to GitHub, which takes a token or the GitHub CLI since 2021; `gh auth login` once (§9). The first try also had nothing to commit, as the images hadn't been renewed yet.

**Checks (cloud), 10 November:**

| Check | Result |
|---|---|
| Typecheck and lint | Clean |
| Unit tests | All pass: core 350, indicators 78, Pine 409, chart 100, web 228, gateway 571 (77 live ones skipped) |
| The three fixed tests, on Linux | Pass |
| The code editor with a Mac user agent (Monaco then takes its Mac keys) | ⌘↓ goes to the last line, ⌘↑ to Line 1, Col 1, ⌘K ⌘I opens the hover help, and ⌘Home does nothing: the Mac's failure, reproduced |
| The browser suite without the visual and performance tests (231) | 227 pass; the 4 failures are the cloud's known pixel and font checks (§6), which pass on the Mac |
| The Pine corpus | Unchanged: the manual's 1,034 of 1,069 examples run, the community's 809 of 854; 33 of the 34 error examples stop (manual-663 runs as v5, as before) |
| UI review: the five visual scenes rendered in the cloud beside the Mac's references | The four element shots hold the same content (labels, values, colors, stars, buttons); the chart page differs by the new buttons and the right toolbar |

## 2h. The gateway's own address (10 November)

Merged on 10 November as pull request #8. Opening http://127.0.0.1:5180 showed `{"message":"Route GET:/ not found",…}` (the user's screenshot): 5180 is the gateway, which only serves the app's data; the app is on 5173. Nothing was broken, but the address was a dead end. Now the gateway's own address sends the browser on to the app with a temporary redirect, keeping the chart in the query (`http://127.0.0.1:5180/?symbol=BINANCE:BTCUSDT&interval=60` opens the app on that chart). The Host and Origin checks still run first, so other websites and DNS rebinding are refused as before (SPEC §3 and §6.9, 10 November; SECURITY.md).

**Checks (cloud):** the gateway's `server.test.ts` (50) passes, and its new test fails without the route; a gateway of our own on port 5191 (a scratch data folder, no keys) answered `302` to `http://127.0.0.1:5173/` and refused a foreign Host, and a real browser opened on its address landed on the app with the asked-for chart.

## 2g. Price alerts (9 November)

The user's YES: "build price alerts (Crossing, Crossing Up, Crossing Down, Greater Than and Less Than a value, on any symbol, triggering Only once or Every time on the live price) in the Create Alert dialog and the alert manager, with tests and the docs updated" (SPEC §3, 9 November; §4.23; §5.26; §6.22; §11 item 135).

- **The dialog** (the top bar's Alert, Alt+A, or the alert manager's +) now starts on the chart symbol's price, as TradingView's does: Condition is the symbol (the chart's scripts come next in the same drop-down), then Crossing, Crossing Up, Crossing Down, Greater Than or Less Than; Value starts at the current price in the symbol's decimals (the arrow keys step it by the tick); Trigger is Only once or Every time; the name and message follow the condition ("XRPUSDT Crossing Up 1.3500") until typed in, with the same placeholders.
- **The alert manager** lists a price alert by its condition and its symbol alone, as it triggers regardless of the interval; Edit keeps it a price alert on its own symbol.
- **How they run:** each active price alert watches its symbol's 1-minute live bars from the gateway while tradingNerd is open, whatever the chart shows. A new high or low since the update before is a price that traded, so a spike through the value inside one update is caught. Crossing Up needs the price below the value and then at it ("drops below … and then rises back to that level"); Greater Than and Less Than need the price past the value, and trigger at once when it already is (provisional: TradingView doesn't say); Every time triggers again at most once a minute; Only once stops it. A stock's pre- and post-market trades count when its chart showed extended hours; a symbol without 1-minute bars (a market cap) is watched on the alert's timeframe.

**Found and fixed on the way:** an edited price alert kept its old message ("XRPUSDT Crossing Up 1.3500" after the value became 1.36); while the message is the condition's own text it now follows the value. And an alert restarted after an error (a stock's before its Alpaca key was added, or a script's) kept showing the old error while running; each start now clears it, for alerts on scripts too. Each fix has a test that fails without it.

**Checks (cloud):** typecheck and lint clean; unit tests all pass (core 350, indicators 78, Pine 409, chart 100, web 228, gateway 570 and 77 live ones skipped); the new `priceAlerts.test.ts` (16) catches a rule broken on purpose (2 of its tests failed with Crossing Up from above wrong). The browser suite without its visual and performance tests: 226 of 231 passed; the 5 failures are the cloud's known 4 pixel and font checks (§6) and Symbol Search's "Enter adds the top match" under load, which passed 3 of 3 alone, as in step 4. `alerts.spec.ts` (4) passes: a price alert starts at the current price, triggers when the live price crosses its value, stops, and edits with its message following; a Greater Than one, Every time, triggers again a minute on. Screenshots of the dialog, its operators, the alert manager, a pop-up and the edit dialog were looked at in the cloud's browser. No live exchange check: the cloud can't reach the exchanges' live streams (§9 has the Mac's).

**Not built** (SPEC §5.26 "Later"): the channel and Moving conditions, alerts on an indicator's plot or a drawing, Expiration. **Provisional** (SPEC §11, item 135): the "already past the value" case, Every time's minute, the default name and message, the dialog's layout.

## 2f. Step 4: alerts, non-standard data, the realtime bar, offsets (9 November)

The last step of making any script run as on TradingView (the user's YES of 8 November), and the two gaps steps 1 to 3 left (SPEC §3, 9 November; §5.24, §5.25; §6.21, §6.22).

- **Alerts on scripts.** The top bar's new **Alert** button (as in TradingView's bar, after Indicators), Alt+A, or the alert manager's + opens **Create alert on SYMBOL**: the script and its condition ("Any alert() function call", each `alertcondition()` title; a strategy's "Order fills and alert() function calls", "Order fills only", "alert() function calls only"), the Trigger for `alertcondition()` alerts (Only once, Once per bar, Once per bar close, Once per minute), Alert name, Message with TradingView's placeholders (`{{close}}`, `{{plot_0}}`, `{{plot("RSI")}}`, `{{ticker}}`, `{{time}}`, `{{strategy.order.action}}` and the rest), Show pop-up and Play sound. The right toolbar's new **Alerts** opens the alert manager in the watchlist's place: each alert's status (Active, Stopped — Triggered, Stopped manually), Stop or Restart, Edit, Remove; and the **Log**.
- **How they run:** each alert keeps a copy of its script, inputs, symbol and timeframe, as TradingView does, and runs it on that symbol's live bars while tradingNerd is open, whatever the chart shows. `alert()` calls trigger by their frequency (each call's first on a bar by default; a strategy's at the bar's close); a strategy's order fills carry their `alert_message`. Kept in this browser; no email or webhook, which would send data off the Mac.
- **Renko, Line Break, Kagi and Point & Figure data:** `ticker.renko()`, `ticker.linebreak()`, `ticker.kagi()` and `ticker.pointfigure()` (and v4's `renko()` and the rest) in `request.security()`, built from the symbol's own bars by TradingView's documented rules: Renko's 2-box reversal and its wicks, Line Break's N-line reversal, Kagi's reversal amount, P&F's columns, ATR and percentage box sizes to the tick.
- **Strategies on the realtime bar:** as TradingView by default, a strategy now calculates on a live bar only when it closes (`calc_on_every_tick` restores every tick), while its stop and limit orders still fill on the bar's prices. A closed market's last bar counts as history.
- **Offsets worked out as the script runs:** `plot(…, offset = shift)` with `shift` from the chart's timeframe (three v3 Ichimokus), and v5's series offset with its last value and a warning, as TradingView does; v6 refuses a series one.

**Found and fixed on the way:** Renko and P&F prices drifted by rounding when adding boxes up, so bars built from two starts never matched (now whole numbers of boxes; settles in 1 to 3 bars on a 2,000-bar walk); a live bar's bricks turning the other way with the same count left the run's state stale (now it runs afresh).

**The corpus now:** the manual's 1,034 of 1,069 examples run (1,023 before step 4): its ten Renko, Line Break, Kagi and Point & Figure examples, the Renko strategy among them (156 of its 160 strategies now), and its v5 offset example; the community's 809 of 854 (806): three v3 Ichimokus with offsets from the timeframe. None that ran before stops now (SPEC §4.17).

**Checks (cloud):** typecheck and lint clean; unit tests all pass (core 350, indicators 78, Pine 409, chart 100, web 212, gateway 570); the browser suite: 224 passed, 18 failed: the cloud's known 17 (pixel baselines and font widths, as on 8 November) and one flake (Symbol Search's Enter, under load; 3 of 3 alone). The new browser tests (alerts ×2, the run-time offset) pass, and the offset one fails with the chart's fix taken out. Screenshots of the Alert button, the dialog, the alert manager and a pop-up were looked at in the cloud's browser.

**Not built** (SPEC §5.25 "Later", §11 items 129 to 133): price, drawing and watchlist alerts; Expiration, email, webhooks; alerts with the app closed; these chart types on the chart itself; `calc_on_order_fills`; a session's last bar is calculated when the next opens. **Provisional:** the non-standard bars' undocumented choices (item 130), the alert UI's look and defaults (items 133 and SPEC §7.7). **On the Mac:** renew the visual baselines for the two new buttons after looking at them (item 134).

## 2c. Pine compatibility with older versions (8 November)

Your VuManChu B Divergences (v4) failed to compile: "Cannot call 'ta.valuewhen' with argument 'condition'='fractalTop'". **The cause:** v4 and v5 let a number stand for a bool wherever a function or variable needs one, and our engine allowed it only in conditions. **Why we missed it:** the corpus had no script that did it, and the version rules were never tested one by one. Both are now fixed: the script compiles and runs, all 34 plots, its 4h, 12h and 1h requests, 1,000 bars in 1.3 s (synthetic bars in the cloud; its values against TradingView's are the Mac's check).

**Then, systematically** (SPEC §3 and §4.17, 8 November):
- **TradingView's reference, all 884 entries:** everything is known but the drawings, the strategies, TradingView's own data, and `bid`/`ask`.
- **The migration guides, rule by rule:** fixed v5's na bools and v4's Monday-to-Friday sessions; constants are plain text as the reference types them (`shape.*`, `location.*`, `size.*`).
- **The corpus, grown from 271 to 854 community scripts:** fixed `fill(hline1, hline2)`, `linktoseries`, a repeated `transp`, `plot(style = dashed)` and `array.new(na)`. 723 run; of the 722 that need neither drawings nor strategies, 683 (94.6%); the rest are mostly the scripts' own mistakes. Known gaps: SPEC §11, item 122.

**Left:** drawings (327 of the corpus's failures), strategies (169), TradingView's own data (no free source), the chart types Renko and the like: the next steps of this work.

## 2e. Pine strategies and the Strategy Tester (8 November)

Step 3: **strategies run as on TradingView**, with its broker emulator, trades marked on the chart and the Strategy Tester (SPEC §5.23, §6.20).

- **The engine:** `strategy()` with all 33 properties at the reference's defaults; `strategy.entry`, `order`, `exit` (take-profit, stop-loss, trailing stops, partial exits), `close`, `close_all`, `cancel`, `cancel_all`, `risk.*`; all 35 `strategy.*` variables and 26 trade functions. The emulator follows the manual's rules: fills from the next bar's open, the open → high → low → close path (or low first), gaps at the open, reversals, pyramiding, FIFO, OCA groups, commission, slippage, margin calls. Each rule is tested against the outcome the manual describes.
- **On the chart:** each fill marked on the candles: blue arrows for long entries, red for short, purple for exits, with the order's name and size; a triangle at the fill price.
- **The Strategy Tester:** below the chart, opening when a strategy is added: Overview (net profit, closed trades, percent profitable, profit factor, max drawdown, average trade and bars, the equity curve with drawdown and buy & hold), Performance Summary (All, Long, Short), List of Trades and Properties. The right toolbar's new button toggles it.
- **Older versions:** v4/v5's `when =`, `strategy.close(id, when)`, a comment first in v5's `strategy.close_all()`, v4's bool `strategy.long`, and v4/v5 `?:` of a bool and a number.

**The corpus now:** the manual's 1,023 of 1,069 examples run (868 before strategies), 155 of its 160 strategies; the community's 806 of 854 (789), 19 of its 20 strategies (SPEC §4.17).

**Not built yet** (SPEC §11, item 129): the settings dialog's Properties tab; recalculating on order fills or every tick (the script runs once per bar, the default); the Bar Magnifier; another account currency; the live bar updates the strategy on each tick, where TradingView waits for its close. **Provisional** (item 128): the intrabar tie rule, quantity rounding, drawdown from highs and lows, the ratios, the markers' look.

## 2d. Pine drawings (8 November)

Step 2 of making any script run as on TradingView: **labels, lines, boxes, tables, polylines and linefills**, in the engine and on the chart (SPEC §5.22, §6.19).

- **In the engine:** every drawing function of the v6 reference, with `chart.point`, their constants, methods and casts. The last 50 of each kind by default and `max_*_count` up to 500 (polylines 100), the oldest going first; one table per position; a live bar's update rolls back what it drew, as TradingView does.
- **On the chart:** where their bars (by index or time, past the last bar too) and prices are, an overlay's on the candles' scale; tables at the pane's corners. Checked in the cloud's browser: a table, label bubbles, an extended line, a box with its text and markers below the bars. That check found that a script without plots placed no prices (the chart library places none on a series without values), fixed.
- **What the drawing scripts found in the engine, all fixed:** screeners' requests in loops and their tuple count, a request's context missing a declaration, one-line functions of several statements, a string wrapped onto the next line, `ta.change()` and `ta.valuewhen()` types, "UTC0", `editable` from an input, v5's `bool == 1`, a `const` label (SPEC §3, 8 November).

**The corpus now:** the manual's 868 of 1,069 examples run (560 before step 1), 310 of its 318 drawing examples; the community's 789 of 854 (723 before), all 65 of its drawing scripts. What's left is strategies (169 scripts), TradingView's own data, published libraries to paste in, and the scripts' own mistakes.

**Checks:** typecheck and lint clean; unit tests all pass (core 350, indicators 78, Pine 342, chart 99, web 202, gateway 570); the new browser test passes in the cloud, and fails with the price fix taken out. The rest of the browser suite, `pnpm verify` and the looks against TradingView are the Mac's (§9).

**Provisional** (SPEC §11, items 123 to 127): the drawings' sizes and padding, a request's tuple count, the wrapped string's join, drawings in a pane without plots, and two manual examples that break v6's own rules.

## 2. The hand-over check of 8 November (pull request #5)

On 8 November the user asked for a complete check and hand-over, without more questions: "do whatever is required to complete this and handover … update the branch and create complete PR". It was done in a cloud session on `claude/keen-allen-7wubfe`, from `main` at `684091e`.

**What the pull request carries:**
- **The docs as merged** (7 November): this file, SPEC §8 and AGENTS.md say P2 and P4 are merged; AGENTS.md lists open interest among the data sources, and says which live tests the cloud can't run.
- **This check** and its evidence: below, and in SPEC §4.20, §8 and §9.
- **One fix the check found:** the settings dialog's text fields, and `input.symbol`'s field, now look like its number fields (6 px corners, no fill); a symbol too long for its field ends in "…" and shows whole on hover (SPEC §3, 8 November). Its browser test failed before the fix and passes after.

**The checks** (the cloud's machine, Node 26):

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Up to date |
| Typecheck and lint | Clean |
| Unit tests | All pass: core 350, indicators 78, pine 312, chart 91, web 202, gateway 570 (plus 77 live tests, opt-in) |
| The whole browser suite, 237 tests | 220 pass. 17 fail, all known cloud-only ones, which fail on `main` there too: the 13 visual tests (their baselines are the Mac's) and 4 pixel or font-width checks (Sell and Buy's spread, the legend's place, Symbol Search's pixels, the row menu's pixels). The 1 px flick, flaky there, passed this time |
| The browser tests that open the settings dialog, after the fix (`requests`, `indicators`, `pine`) | 44 of 44 pass |
| Live tests for open interest | 3 of 11 pass: OKX's two and Binance's archive. The exchanges refused the other 8: Binance's futures APIs (HTTP 451, a restricted location) and Bybit (HTTP 403, its country block). Nothing was done to get around them |
| The other live tests | Not run: Binance's, Coinbase's, Kraken's and Bitstamp's spot APIs aren't reachable from the cloud |
| The corpus | The same as on 7 November: of the manual's examples, 478 of 481 that need only P2 and 80 of 103 that need requests; of the community scripts, 199 of 199 and 11 of 11; all 34 error examples stop |

**The running app,** read-only, in the cloud: the web app on 5173 and a gateway of our own on 5191, on a scratch copy of `data/` without `secrets.json`, both stopped after.

| What | Result |
|---|---|
| OKX:BTCUSDT 1h | 1,000 real bars from OKX. No live ticks: OKX's stream (`ws.okx.com`) isn't allowed in the cloud |
| The user's OI script ("Custom Open Interest and Volume Oscillator") on it | The ring turned at the end of its legend row while `BINANCE:BTCUSDTPERP_OI` loaded; then its four plots drew, with no error. The legend read "OI_VO BTC Tether 5 20 1000 96392.6 −13608.8 0.0 0.0" |
| Its newest hours | Binance's API refuses the cloud, so the newest open interest is the archive's, to the end of 6 November (its files come a day or more late). The script's request repeats that last value over the hours since, as Pine's `gaps_off` does. On the Mac, Binance's API fills them |
| BINANCE:BTCUSDT.P_OI, 1D | 1,000 daily bars to 6 November, "BTCUSDT Open Interest · 1D · Binance", the scale in thousands (K). Its last close, 96,392.578, is the script's value above |
| RSI with Timeframe 1W, on the 1h chart | 6 weekly values merged onto the hours; its legend "RSI 14 close 1W ∅ ∅" |
| The chart's indicators on the open interest chart | Carried over; RSI 1W drew after 4.1 s, the time its weekly bars took to load, not a stall. It shows 27 weekly values: open interest history doesn't begin at the perpetual's listing (Binance's from September 2020, 322 weeks), so the warm-up rule (SPEC §5.15) leaves RSI's first 294 or so blank (§11, item 65) |
| `input.symbol` | Picked with Symbol Search. After the fix: 34 px high, 6 px corners, no fill, as the number fields; `BINANCE:BTCUSDT.P_OI` ends in "…" and shows whole on hover |
| Errors | Only 502s from `/api/symbols/resolve` for the default watchlist's Binance spot symbols: the gateway can't reach Binance's spot API from the cloud |

**The UI review** (against our other dialogs and SPEC §7; no TradingView screenshot of these pieces exists yet):
- **The legend's ring:** 12 px, turning at the end of the row while a script's data loads, gone when it arrives (SPEC §11, item 107).
- **RSI's Calculation section:** Timeframe and Wait for timeframe closes, after RSI's own inputs, in the dialog's idiom (item 108).
- **The text and symbol fields:** fixed, as above. Their look against TradingView's own is still provisional (item 107).
- **The top bar's symbol pill** cuts a long name: `BTCUSDT.P_OI` needs about 100 px and the formula `TOTAL2/XRPUSD` 117 px, where the pill keeps 84 px (measured in the test browser). Left as it is: TradingView clips long symbols in its watchlist (SPEC §5.3), and how its header shows one isn't measured (SPEC §11, item 118).
- The check's screenshots were sent in the session and aren't committed. The same check can be run on the Mac.

**What the cloud couldn't do,** for the Mac (§9): `pnpm verify` against the Mac's baselines; `pnpm test:live` for Binance's futures APIs, Bybit and the spot exchanges; the running app with live ticks and the user's own `data/`; and values against TradingView's, which need the user's screenshots (SPEC §11, items 113 and 117).

## 3. Merged: P4, other symbols and timeframes (3 to 7 November, pull request #4)

The user said YES to "build P4 as planned: steps 1–7 on `claude/keen-allen-7wubfe`, each step committed after its checks pass, with pushing and the pull request left for their own YES". The design is SPEC §3 (the rows of 3 and 7 November), §4.19, §4.20, §5.20, §5.21 and §6.18. On the user's YES of 7 November it was pushed with P2 and opened as pull request #4 (https://github.com/iamdebasis/TradingNERD/pull/4), which the user merged the same day.

**What it does:**
- **Scripts ask for other symbols and timeframes** as on TradingView: `request.security()` and `request.security_lower_tf()`, `request.currency_rate()`, `indicator(timeframe =)`, ticker ids (`ticker.new` and the rest, Heikin Ashi), dynamic requests and their rules, the 40-request limit.
- **Their data comes from the gateway** like the chart's own, history and live. A script waiting for it draws nothing, with a ring turning in its legend row; a symbol that doesn't exist says so in its row.
- **`input.symbol`** is picked with Symbol Search; **the built-in RSI** has TradingView's Calculation section (Timeframe, Wait for timeframe closes).
- **Open interest symbols:** `BINANCE:BTCUSDT.P_OI` (and the older `BINANCE:BTCUSDTPERP_OI` the user's script uses), every perpetual's on Binance, Bybit and OKX, in the exchange's own unit, from 5 minutes up. History comes from the exchanges' own free APIs and Binance's archive, kept in `data/oi/`; live values every 15 s.

**Measured** (SPEC §4.19, §4.20):

| What | Result |
|---|---|
| The corpus, scripts that need requests | Manual 80 of 103, community 11 of 11. Of the 23 that don't run, 22 need what comes later (financial data, Renko and the like, TradingView's feeds) and one a chart below an hour |
| The corpus, scripts that need only P2 | Still 478 of 481 and 199 of 199; the manual's 34 error examples all stop |
| TradingView's own lower-timeframe values (a public dataset, run locally) | 4 of 4 bars equal |
| The user's OI script on 500 hourly bars of real Binance open interest | Runs; its "Open Interest" plot equals the bars' closes on all 500 |
| Binance's archive for BTCUSDT | From 1 September 2020, every 5 minutes; all 2,258 days in about 2.5 minutes, 6.5 MB kept |
| Open interest history against TradingView's (from February 2020) | Binance's BTCUSDT from September 2020, most other coins from December 2021; OKX's days from January 2024; Bybit not measured (it refuses the cloud) |
| A data fault found | Binance's archive has eight readings of 0 on 15 October (13:40 to 14:40 UTC) between about 93,000 BTC: left out as failed readings |

**Checks in the cloud (7 November):** typecheck and lint clean; every unit test passed (the same counts as in §2); the browser suite 219 passed and 18 failed, the known cloud-only ones; OKX's and the archive's live tests passed. A gateway of our own on 5191 resolved the three symbols and served 40 daily bars of BTCUSDT open interest in 6.4 s on first load, OKX's hourly bars and Binance's weekly ones. For this, the cloud environment's network allows `fapi.binance.com`, `dapi.binance.com`, `data.binance.vision`, `api.bybit.com` and `www.okx.com` (the user approved it on 7 November). In the cloud, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` for the live tests.

**Decisions for the user:**
- **Open interest units** (SPEC §11, item 113): each is in its exchange's own unit; TradingView's are known only for `BINANCE:BTCUSDT.P_OI` (BTC). Screenshots of `BINANCE:BTCUSD.P_OI`, `BYBIT:BTCUSD.P_OI` and `OKX:BTCUSDT.P_OI` on TradingView, with a value at a date, would settle the rest.
- **Older open interest** (item 115): TradingView's goes back to February 2020; the free sources start later. Coinalyze's daily history needs a free key from the user; a paid source (Tardis.dev, CoinGlass) would cost money. Or keep what the exchanges give.

## 4. Under way: M9f, each coin's older days

The user said YES to steps 1–3: the ETH Zurich import, the Live Coin Watch download with its tests, and the accuracy test, stopping to report before anything on the charts changes. The design is SPEC §3 (rows of 26 October), §4.14 and §5.14.

**The state below is as of 26 October.** The download runs on the user's Mac, and the cloud sessions since (I1, P1, P2, P4 and this hand-over) can't see it; read it from the app before planning the next step.

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

## 5. Merged: P1, the Pine Editor (31 October, pull request #3)

Built on the user's YES of 27 October, from `main` at `6c403cb`, and merged on 31 October (pull request #3). The design is SPEC §3 (the rows of 31 October), §4.16, §5.16, §6.17 and §7.5.

**What it does,** on the user's model for a built-in's code (27 October):
- **The right toolbar:** Watchlist and Pine Editor buttons at the window's right edge; the lit one's panel shows on the right.
- **Opening code:** the legend's Source code button (`{}`) on RSI and on every script opens its code; so does the name's menu.
- **A built-in's code** is editable at once, under the banner "Built-in script. Your edits make a copy; the original stays as it is." Reset to original puts it back. The built-in on the chart never changes.
- **Add to chart** (Ctrl/Cmd + Enter), then **Update on chart**; code with errors stays off the chart, and the console lists them.
- **Save script** (Ctrl/Cmd + S) makes it one of My scripts, version 1, and each later save that changes the code the next version (`data/scripts.json`, protocol v11); unsaved code is kept in this browser.
- **A script on the chart** has its legend row, its settings (Inputs and Style), Pine's plot styles, fills, backgrounds, hlines and per-bar colors; a runtime error shows a red "!" in its row.

**Measured** (the cloud's machine, Node 26; SPEC §4.16):

| What | Result |
|---|---|
| RSI's Pine code against the built-in, 20,000 bars, 7 smoothings × 2 sources | Identical on every bar |
| One run over 20,000 bars | 20–35 ms (the built-in: 7 ms); 81–85 ms with the warm-up checks |
| A live tick, with the checks | 6–11 µs |
| The warm-up rule for scripts, against a history 3,000 bars longer | RSI drawn from bar 293 (the built-in: 294), within 5.7 × 10⁻⁹ of the longer history's values |
| Panning and zooming 20,000 bars with Volume and RSI, three runs each | Median frame 2.7–3.1 ms (`main` on the same machine: 2.0–3.0); 95th percentile 13.8–14.5 ms (`main`: 14.4–14.5). The budgets are the Mac's |

**Decisions for the user:**
- The editor's look is provisional until a screenshot of TradingView's editor on code being edited, at full size, and one of its right toolbar (SPEC §11, item 74).
- The built-in RSI's smoothed MA (EMA, SMMA) waits longer than its script needs: 452 and 587 bars, against 314 and 349 for the same accuracy (item 76). Making the built-in follow the measured rule is the user's call.
- A proposal for AGENTS.md, which changes only on the user's word: add `data/scripts.json` to its list of files a live check never changes and checksums.

**Provisional** (SPEC §11, items 75 and 77–81): the warm-up checks' thresholds; a Style tab color against the script's own; Pine defaults TradingView doesn't document; drawing details; a name already taken numbered ("My RSI 2"); `ta.rsi` with no falls.

**I1 (pull request #2)** has decisions of its own: a new chart starts without Volume, unlike TradingView's (§11, item 64), and the warm-up rule leaves the first few hundred bars of RSI blank where a provider's history stops short of the listing (item 65).

## 6. Running and checking

- **Start:** `pnpm dev`, then open http://127.0.0.1:5173 (the gateway's own address, http://127.0.0.1:5180, sends you there too).
- **Keys,** each in its dialog: CoinGecko (coin logos and CRYPTOCAP), Alpaca (US stocks), Live Coin Watch (older market caps).
- **Before every delivery:** `pnpm verify`, then a read-only check against the running app (AGENTS.md).
- **Test counts on 10 November:**
  - core 350, indicators 78, pine 409, chart 100, web 228;
  - gateway 571 (plus 77 that need the live internet);
  - browser 249 (13 visual, 5 performance among them);
  - lint and typecheck clean.
- **Known flaky tests:** Bitstamp's "polls the live candle every 30 s" sometimes fails under load and passes on a rerun; in the cloud, so does the gestures test's 1 px flick.
- **Cloud sessions** (Claude Code on the web): put `/opt/node26/bin` first on PATH (the default `node` there is 22). Typecheck, lint and the unit tests run there; `pnpm test:e2e` doesn't yet, a known gap (AGENTS.md, "Commands"). The real check against the running app happens on the Mac.
  - Live tests there need `NODE_USE_ENV_PROXY=1` (Node's `fetch` doesn't use the session's proxy otherwise), and the hosts allowed in the environment's network settings. Binance's futures APIs and Bybit refuse the cloud's location; the spot exchanges aren't allowed there.
  - The browser tests can be run there by hand without writing anything into the repository: point Playwright at the preinstalled browser through a scratch folder of links (`PLAYWRIGHT_BROWSERS_PATH`, with `chromium-1248` and `chromium_headless_shell-1248` linked to `/opt/pw-browsers/…-1243`) and pass `--update-snapshots=none`. The 13 visual tests fail there (the baselines are the Mac's), and four pixel checks for platform reasons only (font metrics, pixels): `chart.spec.ts` Sell and Buy's spread, `reference.spec.ts` the legend's place, `symbol-search.spec.ts` and `watchlist.spec.ts` pixel checks; `gestures.spec.ts`'s flick now and then. Its performance budgets are the Mac's: the cloud's machine misses some even on `main`, so compare there only against `main` on the same machine.
  - The browser window in the tests is 1,682 px wide: TradingView's 1,634 px reference layout plus the 48 px right toolbar (`playwright.config.ts`).
  - A real check there: a gateway of our own (`GATEWAY_PORT=5191`, `DATA_DIR` a scratch copy of `data/` without `secrets.json`, `NODE_USE_ENV_PROXY=1`) and the web app on 5173 (`GATEWAY_PORT=5191 pnpm exec vite` in `apps/web`; the gateway accepts only that origin), both stopped after.

## 7. Security

Audited on 26 October against the code, the running app and all of git history ([SECURITY.md](SECURITY.md)): every point held.
- **Only providers:** nothing leaves the Mac but what the data providers need.
- **Keys:** owner-only and masked to the browser.
- **Network:** the servers can't be reached from other machines.
- **No telemetry.** The only remote is GitHub (`origin`), and the repository is public, so anything pushed is published.
- **To do:** back up `data/` (encrypted, e.g. Time Machine), above all `data/cryptocap/anchors.json`, whose kept days can't be downloaded again, and `data/oi/`, whose 5-minute recordings from OKX (its API keeps 5 days of them) and Bybit can't be fetched again.

## 8. Open items

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
- **GitHub's merge commits:** merging on GitHub made `9324baa` (pull request #1), `6c403cb` (#2), `4295233` (#3), `684091e` (#4) and every merge since (#5 to #8, `de15c5f` the latest), with GitHub as committer and +0530, the time zone the 26 October rewrite took out. They're public on `main`, so the identity check (AGENTS.md, "Git") prints a second line, which no push of ours adds. How merges should go is the user's call, from the options given on 26 October: fast-forward `main` from the Mac with a bypass of the ruleset for the user alone, accept GitHub's commits in the docs, or try merging from a browser set to UTC (GitHub doesn't document which time zone it stamps).
- **Free limits that can change:** CoinGecko's 10,000 calls a month, Live Coin Watch's 10,000 requests a day. CoinDesk reportedly ended its free plan in 2026.
- **Indicators (I1):** every look not measured from a screenshot is provisional (SPEC §11, items 62–63 and 70); TradingView's tick volume for TOTAL isn't ours (item 68); the sentence-case title waits on the user (item 73). RSI's Timeframe came with P4 (item 71), the Source code button with P1 (item 72).
- **Pine (P1, P2):** the editor's look is provisional until the screenshots in SPEC §11, item 74; the built-in RSI's smoothed MA waits on the user (item 76); P2's provisional looks are items 89 to 103.
- **Requests and open interest (P4):** open interest's units and history depth wait on the user's word (§3; SPEC §11, items 113 and 115); it isn't listed in Symbol Search yet (item 111); the ring's and the symbol field's look wait on a screenshot (item 107); the top bar's pill cuts names as long as `BTCUSDT.P_OI` (item 118).
- **The Mac's visual baselines:** five to renew after a look (§2i; SPEC §11, item 134). Until then `pnpm verify` fails on them, and the five performance tests, which run after the others, don't run.
- **Pushing from the Mac:** git there isn't signed in to GitHub (10 November: "Password authentication is not supported for Git operations"). `gh auth login` once fixes it (§9).
- **Price alerts:** whether Greater Than and Less Than trigger at once when the price is already past the value, and how often Every time triggers, wait on a check against TradingView (SPEC §11, item 135); the dialog's look waits on a screenshot.
- **Step 4 (alerts, non-standard data):** alerts run only while the app is open and live in this browser (SPEC §11, item 133); the non-standard bars' undocumented choices (item 130); a strategy's last bar of a session closes when the next opens (item 131); the alert UI and its defaults wait on screenshots (item 133, SPEC §7.7).

## 9. Next steps, in order

**1. This hand-over's pull request** (§2i: the three tests' keys and these docs); the user merges it on GitHub. The gateway's own address (§2h) was merged on 10 November as pull request #8, price alerts (§2g) as #7, and steps 1 to 4 of Pine for any script on 9 November as #6.

**2. On the Mac, after merging it and pulling `main`** (none of this can be done in the cloud):
1. Restart `pnpm dev`. There are no new dependencies since P1; run `pnpm install` first only if it hasn't run since then.
2. Sign git in to GitHub, once, so the Mac can push: `gh auth login` (GitHub.com → HTTPS → Yes, authenticate Git → Login with a web browser). If `gh` is missing: `brew install gh`, or https://cli.github.com.
3. `pnpm verify`. Everything should pass but the five visual tests (and the five performance tests, which run only after the others). Then look at each `-diff.png` under `apps/web/test-results/visual-…/` (`open apps/web/test-results/visual-*/*-diff.png`), where changed pixels are red: the chart page shows the new buttons and the wider window; the other four should show red only along text and edges. Anything else red: stop, and send that image to the AI.
4. Renew them and check: `cd apps/web && pnpm exec playwright test visual --update-snapshots && cd ../..`, then `pnpm verify` again, which should pass in full.
5. Commit the five renewed images on a branch, check the identity, push, and open a pull request:
   ```
   git checkout -b claude/visual-baselines
   git add apps/web/tests/e2e/visual.spec.ts-snapshots
   TZ=UTC git commit -m "Visual baselines renewed on the Mac: the new buttons, the right toolbar, the Mac's text drawing"
   git log --all --format='%an <%ae> %ad|%cn <%ce> %cd' --date=format:%z | sort -u
   git push -u origin claude/visual-baselines
   gh pr create --fill --base main
   ```
   The identity check should print only Debasis with +0000, besides GitHub's own merge commits (+0530, §8).
6. The performance budgets with Volume and RSI, if step 3 didn't run them: `pnpm exec playwright test perf --no-deps` (in `apps/web`).
7. `pnpm test:live`: Binance's futures APIs, Bybit and the spot exchanges, which the cloud can't reach.
8. A read-only check against the running app (AGENTS.md): http://127.0.0.1:5180 opens the app (§2h); the user's OI script on BTCUSDT 1h, its values against TradingView's at a few hours. The first daily load of `BINANCE:BTCUSDTPERP_OI` waits about 2.5 minutes while Binance's archive downloads into `data/oi/`; later loads are instant.
9. The hand checks against TradingView: I1's H1–H7 (SPEC §9, with the screenshots in SPEC §11, item 62); P1's (SPEC §5.16, "Done when": RSI's copy reads as the built-in, a script of the user's runs as on TradingView); P2's 10 scripts, and the user's Ichimoku with `JollyWizard/lib_hlm/1` pasted through "Add library…" (SPEC §5.17); the user's VuManChu B on BTCUSDT 4h (§2c); a drawing script's labels, lines, boxes and tables beside TradingView's (§2d); a strategy's List of Trades and Performance Summary beside TradingView's Strategy Tester on the same symbol and timeframe (§2e); an alert on a script with `alert()` and one with `alertcondition()`, created on both, triggering on the same live bars with the same messages; a Crossing Up price alert just above the live price on both, triggering together, and a Greater Than one made below the price, to see whether TradingView's triggers at once (SPEC §11, item 135); a `request.security(ticker.renko(…))` plot (and Kagi, Line Break, P&F) beside TradingView's (§2f).

**3. Screenshots from TradingView that would settle the provisional looks and units:** plotshape at each size (SPEC §11, item 89); the Pine Logs pane, the editor at the bottom and Convert code to v6 (items 101 to 103); a script loading another symbol and an `input.symbol` field (item 107); the open interest symbols with a value at a date (item 113), which would also show how TradingView's header fits a long name (item 118); a script's labels, boxes and tables, to measure their sizes and padding (item 123); TradingView's Strategy Tester and a strategy's trade markers in the dark theme (item 128); the Create Alert dialog on a script and on a price, the alert manager with an alert and its log, and an alert's pop-up (items 133 and 135); a Renko, Kagi, Line Break and P&F request plotted on a chart, with the bars' dates (item 130).

**4. M9f** (on the Mac: the download runs on its gateway, and the ruler needs macOS's `sips`):
1. Size step 2b and tell the user how many requests it needs.
2. Let the download finish, then run `tools/accuracy/check.sh`.
3. Report the result year by year, then ask YES to switch M9f on in the charts.
4. Update SPEC (§5.14 status, §8, §11) and this file, then ask YES to commit, and again to push and open a pull request.

**5. Then the plan's next milestones** (SPEC §8): the channel and Moving price conditions, and indicator, drawing and watchlist alerts; the chart types themselves (Renko and the rest on the chart); the strategies' Properties tab and `calc_on_order_fills` (SPEC §11, item 129); the open items P2 and P4 left (SPEC §11, items 100, 111 and 122); Phase 3 (Kraken's history files); and the user's list above.
