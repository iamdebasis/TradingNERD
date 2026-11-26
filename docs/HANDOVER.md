# tradingNerd hand-over

The state of the work, for whoever picks it up next, human or AI. Update it at every hand-over. The rules are in [../AGENTS.md](../AGENTS.md); the decisions and their reasons in [SPEC.md](SPEC.md).

**Last updated:** 26 November 2026 (the pitchforks' lines from point 1, fixed after your screenshot of TradingView's, for their own pull request, §2v; D3a merged as pull request #23; D3b planned, waiting on your YES), by the AI Lead Architect, Lead Delivery Engineer and UI Lead (Claude).

## Final hand-over (18 November 2026)

Everything built until 26 November is merged on GitHub, `main` at `77c475d` (pull request #23, D3a, the first of D3's three parts, managing drawings, §2u). Since then, the pitchforks' lines from point 1 are fixed on `claude/keen-allen-7wubfe` for their own pull request (§2v); D3b's plan (templates, a tool's last style, favorites) waits on your YES. This part is the state of the Pine work to start from; the sections below it are each step's record.

**What tradingNerd is:** TradingView's chart page, on your Mac. A gateway (Node, 127.0.0.1:5180) brings the six exchanges, Alpaca's US stocks, CRYPTOCAP and open interest; a web app (React, 127.0.0.1:5173) has the chart, watchlists, symbol search, indicators, the Pine Editor, alerts, and since D1 the drawing tools. How the code fits together: [ARCHITECTURE.md](ARCHITECTURE.md). Every decision with its reason: SPEC §3.

### The Pine engine is general, not built for one script

- **You asked on 18 November whether it's built around VuManChu B.** It isn't.
- **The code:** VuManChu B appears 6 times, all comments: 4 in tests, noting where a case came from; one on a page-size setting that applies to every script; one in the corpus tool, noting the community scripts added after it failed.
- **The design:** a compiler and runtime for Pine v1 to v6 (`packages/pine`, SPEC §6.17). It reads, type-checks and runs scripts bar by bar, as TradingView's Execution model describes; nothing in it depends on which script runs.
- **The check:** 1,965 real scripts (TradingView's manual's examples and community collections from GitHub) through the engine (`pnpm test:corpus`). Each engine step since P2 was checked on all of them.
- **VuManChu B's place:** your real, heavy script, so it's the measure for speed and the check against your screenshots. Every fix it led to was general.

### How complete it is, measured on 18 November

| The corpus | Scripts | Run here |
|---|---|---|
| TradingView's manual's examples (some split into parts) | 1,111 | 1,035 |
| Community scripts from GitHub | 854 | 809 |
| **All** | **1,965** | **1,844** |

| Why the other 121 stop | Scripts |
|---|---|
| The manual's own error examples, stopping as intended | 33 |
| Not valid scripts (no output, no version line, placeholders, pseudo-code) | 8 |
| The script's own mistake, which TradingView refuses too | 29 |
| TradingView-only data (`request.financial`, `economic`, `earnings` and the rest) | 17 |
| A published library to paste in first | 12 |
| The manual's demonstrations and page text inside its code | 6 |
| The script's own checks on the corpus's made-up bars | 4 |
| **Ours, or to check on TradingView** (SPEC §11, item 154) | **12** |

- **TradingView's v6 reference:** all 884 entries known (probed on 8 November): TradingView's own data refused with a message, `bid` and `ask` always na (TradingView's on tick charts only).
- **TradingView's releases since April 2025:** up to April 2026 all built but exported constants in libraries and `request.footprint()`, two not checked. Not built after it: `calc_on_every_history_tick`, the `once` structure, binary search on arrays of a user-defined type, tables in the bottom panel (SPEC §4.24; §11, item 149).
- **Limits:** TradingView's 40 requests, drawing limits, 100,000 elements and 500 ms loops are enforced; its 64 plots and 20 s or 40 s per calculation aren't, so we're more lenient there (items 150, 141).
- **The full comparison**, TradingView's way of running a script beside ours, release by release: SPEC §4.24.

### What still stops a TradingView script here, in order

Each is a step of its own, researched first and built on your YES (SPEC §8, "Any script", A to F):

| | What | SPEC §11 |
|---|---|---|
| **A** | **Values that differ from TradingView's, first:** a default outside `minval`/`maxval` clamped (any script; your RSI line's color on 322 of 365 days); chained requests in v4 and v5 scripts without dynamic requests, to calibrate on a screenshot; an inner context's warm-up; 7 qualifier cases to check on TradingView | 145, 111, 147, 154 |
| **B** | **TradingView's newer Pine:** exported constants, `once`, binary search on arrays of a user-defined type, `calc_on_every_history_tick`, the 64-plot and 20/40 s limits. First read the release notes this session couldn't: February, March, May and June 2026, and the rest after April in full | 149, 150, 141 |
| **C** | **Not built:** another indicator's output as a source; strategies' `calc_on_order_fills`, Bar Magnifier, account currency, 9,000-order limit and Properties tab; the chart script's More menu; the Profiler; tables in the bottom panel; chart types on the chart (it draws candles only); alerts that keep running with the page closed, in the gateway (TradingView's run on its servers) | 122, 129, 100, 149, 151, 133 |
| **D** | **Data:** footprints from the exchanges' own trades; TradingView's own data where a provider has the same; forex, futures, indices and bonds. Each compared across providers first (value 5) | 149 |
| **E** | **Built-in indicators:** RSI and Volume now; TradingView's others as our own Pine code, checked against its values as RSI's was | 152 |
| **F** | **Speed,** after the Mac's numbers | 137, 138, 139, 143 |

**What no work can do here:** run protected and invite-only scripts (their code isn't public), or use TradingView's own data feeds.

### Provisional

What TradingView doesn't document ships marked provisional, to calibrate from your screenshots (SPEC §11). For scripts, the ones that matter most: the indicators' and the editor's looks (items 62, 74, 89 to 103), the warm-up checks (75), alerts (133), price alerts (135), Symbol Search's Enter before its results (144), a pane's scale labels (146) and a waiting script's live bar (148).

### Running and checking

- **Commands:** AGENTS.md, "Commands"; `pnpm verify` before every delivery.
- **In a cloud session:** typecheck, lint, the unit tests and the corpus run. The browser suite ran there too, with the repo's config and the preinstalled Chromium, without its visual and performance tests: 284 of 290 at the last run (26 November, the pitchforks' fix): the 4 known pixel and font checks, and 2 timeouts at the run's start that passed on a rerun (SPEC §11, item 178). tradingview.com doesn't open there: read its pages on the Mac.
- **On the Mac:** everything, the visual, performance and live tests included, and the real check against your running app. Its `pnpm verify` of 18 November: typecheck, lint and the unit tests passed, and 250 of the 256 browser tests; one failed, the heavy-script alert's, on the alert's chime (fixed in §2r), and the 5 perf tests didn't run, as they wait for the others.

### On the Mac, first

`pnpm verify`, with D1's visual baselines renewed first, as its drawings toolbar moves the chart (§2s): it should pass in full, and the perf tests' "Renderer:" line should name the Mac's GPU. Then D1's hand checks against TradingView; a price alert with Play sound, to hear the chime; VuManChu B on 1D and 4h scrolled and zoomed back, `pnpm test:live` and the hand checks: §9. The Mac's run of 18 November checked the work merged since 15 November (pull requests #12 to #19) in its unit and browser tests; the perf tests, the live tests and the hand checks haven't run on it yet.

## 1. Where things stand

| | |
|---|---|
| Branches | `main` is at `77c475d` (pull request #23 (https://github.com/iamdebasis/TradingNERD/pull/23) merged on 26 November: D3a; #22 the same day: the drawing tools' second milestone, D2; #21 on 25 November: the first, D1; #20 on 19 November: the alert chime's fix; #19 on 18 November: the final hand-over; #18 the same day: Symbol Search's Enter; #17 on 17 November: scripts freezing the tab, steps 3b and 3c, and the wait for contexts; #16 the same day: step 3; #15 on 16 November: step 2b; #14 the same day: step 2; #13 the same day: step 1; #12 on 15 November: the perf tests on the GPU; #11 on 10 November: the Mac's second run; #10 the same day: the Mac's visual baselines; #9: the hand-over of the Mac's first run; #8: the gateway's own address; #7: price alerts; #6 on 9 November: Pine for any script, steps 1 to 4; #5 before it, the hand-over of 8 November; #4, P2 and P4; #3, P1, the Pine Editor), protected by a ruleset; it was brought level with `m7-us-stocks` on 26 October. New work comes from `claude/…` branches as pull requests, which the user merges on GitHub (AGENTS.md, "Git"). `m7-us-stocks` is kept as a historical branch, and no new work happens there. Six older milestone branches (`m1-chart` … `m6-feel-performance`) aren't on GitHub |
| Merged | **Pull request #23** (https://github.com/iamdebasis/TradingNERD/pull/23), D3a: several drawings at once, the drawings' menu, visual order, copy and paste (§2u), merged on 26 November: `main` is at `77c475d`. **Pull request #22** (https://github.com/iamdebasis/TradingNERD/pull/22), the drawing tools' second milestone, D2, channels and pitchforks (§2t), merged on 26 November. **Pull request #21** (https://github.com/iamdebasis/TradingNERD/pull/21), the drawing tools' first milestone, D1 (§2s), merged on 25 November. **Pull request #20** (https://github.com/iamdebasis/TradingNERD/pull/20), the alert chime's fix (§2r), merged on 19 November. **Pull request #19** (https://github.com/iamdebasis/TradingNERD/pull/19), the final hand-over, documents only (above), merged on 18 November. **Pull request #18** (https://github.com/iamdebasis/TradingNERD/pull/18), Symbol Search's Enter, before its results are in (§2q), merged on 18 November. **Pull request #17** (https://github.com/iamdebasis/TradingNERD/pull/17), scripts freezing the tab, steps 3b and 3c: a requested context's run kept after live updates, and with requests inside it; a script waiting for its contexts to page back (§2p), merged on 17 November. **Pull request #16** (https://github.com/iamdebasis/TradingNERD/pull/16), scripts freezing the tab, step 3: a requested context's run kept when a fresh run would give it again (§2o), merged on 17 November. **Pull request #15** (https://github.com/iamdebasis/TradingNERD/pull/15), scripts freezing the tab, step 2b: alerts' scripts in workers of their own (§2n), merged on 16 November. **Pull request #14** (https://github.com/iamdebasis/TradingNERD/pull/14), scripts freezing the tab, step 2: scripts on the chart in workers of their own (§2m), merged on 16 November. **Pull request #13** (https://github.com/iamdebasis/TradingNERD/pull/13), scripts freezing the tab, step 1 (§2l), merged on 16 November. **Pull request #12** (https://github.com/iamdebasis/TradingNERD/pull/12), the perf tests on the GPU, one at a time (§2k), merged on 15 November. **Pull request #11** (https://github.com/iamdebasis/TradingNERD/pull/11), the Mac's second run (§2j): the Bitstamp polling test, two live tests and the gateway asking a dropped connection again, merged on 10 November. **Pull request #10** (https://github.com/iamdebasis/TradingNERD/pull/10), the five visual baselines renewed on the Mac (§2j), merged on 10 November. **Pull request #9** (https://github.com/iamdebasis/TradingNERD/pull/9), the hand-over of the Mac's first run (§2i), merged on 10 November. **Pull request #8** (https://github.com/iamdebasis/TradingNERD/pull/8), the gateway's own address sending a browser on to the app (§2h), merged on 10 November. **Pull request #7** (https://github.com/iamdebasis/TradingNERD/pull/7), price alerts (§2g), merged on 10 November. **Pull request #6** (https://github.com/iamdebasis/TradingNERD/pull/6), Pine like TradingView's for any script, merged on 9 November: steps 1 to 4 (compatibility with older versions, §2c; drawings, §2d; strategies and the Strategy Tester, §2e; alerts on scripts and the non-standard data, §2f). **Pull request #5** (https://github.com/iamdebasis/TradingNERD/pull/5), the hand-over of P2 and P4, on 8 November |
| Under way | **The pitchforks' lines from point 1** (§2v): a Schiff's and a Modified Schiff's from point 1 to point 2, an Inside's from point 1 to point 2 and from its middle to point 3, as your screenshot of TradingView's four pitchforks shows them. Fixed on `claude/keen-allen-7wubfe` from `main` at `77c475d`, for its own pull request. **D3b** (templates, a tool's last style, favorites) is planned and waits on your YES; D3c after it (SPEC §8) |
| Waiting on the Mac | The visual baselines renewed for D1 (the drawings toolbar moves the chart; Undo and Redo join the top bar; D2 and D3a change none), then `pnpm verify` (it should pass in full, the perf tests' "Renderer:" line naming the Mac's GPU, not SwiftShader); D1's, D2's and D3a's hand checks against TradingView, and the screenshots SPEC §11 items 161 to 177 ask for; a price alert with Play sound to hear the chime; the user's VuManChu B on 1D and 4h, scrolled and zoomed back, an alert on it; `pnpm test:live`; the other hand checks (§9) |
| Home | https://github.com/iamdebasis/TradingNERD, public |
| Committed | M0–M8e (chart, intervals, watchlists, search, exchanges, feel, US stocks, several watchlists), M9a–M9e (CRYPTOCAP, formulas, Bitstamp, kept history, older market caps), A1, A2, A6 (accuracy steps), I1 with its gaps (indicators: Volume and RSI), P1 (the Pine Editor), P2 (real Pine scripts, the editor as TradingView's), P4 (other symbols and timeframes, open interest), Pine for any script (compatibility with older versions, drawings, strategies and the Strategy Tester, alerts on scripts, Renko, Line Break, Kagi and Point & Figure data), price alerts, the gateway's own address, steps 1, 2, 2b, 3, 3b and 3c against scripts freezing the tab, with the wait for contexts, Symbol Search's Enter before its results are in, the final hand-over, the alert chime's fix, and the drawing tools' D1, D2 and D3a; all merged on GitHub |
| Committed, switched off | **M9f, each coin's older days:** steps 1–2 in `c4f260a`, built and tested, switched off in the charts; its download runs on the user's gateway (§4) |
| History cleaned (26 October) | Before the first push, every commit was rewritten: the author is **Debasis `<30506767+iamdebasis@users.noreply.github.com>`** (GitHub's private address), with times in UTC; the TradingView name and avatars in two reference screenshots are painted over. Every file, message and moment is otherwise as before. All 1,406 objects were searched afterwards: no personal email, name, home folder, Mac name, time zone or key |
| Merged: P2 | **P2, real Pine scripts and the editor as TradingView's** (31 October to 2 November), from `main` at `4295233`, committed step by step on the user's YES: step 1 (versions and types, `212fb59`), step 3 (the built-ins on TradingView's own values, `0c80d88`), step 4 (the plotshape family, `074a0a7`), step 5 (libraries, protocol v12, `264218c`), step 6 (the script menu, Version history, help while typing, `f296709`) and step 7 (Pine Logs, Convert code to v6, Move script to bottom, the corpus's last fixes, `e90c080`). The corpus: 478 of 481 manual examples and 199 of 199 community scripts that need only P2 run (99.6%), and the manual's error examples all stop as on TradingView; 671 of 689 plots equal TradingView's (SPEC §4.17). Merged with P4 on 7 November (pull request #4). Provisional: SPEC §11, items 89 to 103 |
| Merged: P4 | **P4, other symbols and timeframes** (3 to 7 November), on the same branch after P2, committed step by step on the user's YES: step 1 (`request.security()`, `44abccf`), step 2 (dynamic requests, `8765ac4`), step 3 (lower timeframes, `timeframe =`, ticker ids, currencies, `fa1e80c`), step 4 (requested data from the gateway, the legend's ring, RSI's Timeframe, Symbol Search for `input.symbol`, `1628f6e`), step 6 (open interest symbols, `e59a120`) and step 7 (the docs, `84e6e2e`). Step 5, measuring the open interest providers, has no code. Merged on 7 November (pull request #4); §3 below. Provisional: SPEC §11, items 104 to 117 |
| Taken out | A3 (hiding unchecked coins), on the user's rule against hiding data |
| Not built | M7c (stock logos); A4 and A5 (overtaken by M9e and M9f) |

What's left for the Mac, for every milestone, is one list: §9. The milestone table is SPEC §8.

## 2v. The pitchforks' lines from point 1 (26 November)

**Asked:** on 26 November, with your screenshots of our four pitchforks and TradingView's: "some lines" missing in ours, "WHY IS THIS HAPPENING?"; then the fix on your YES ("YES GO AHEAD fix the pitchforks"). Fixed on `claude/keen-allen-7wubfe`, restarted from `main` at `77c475d`, for its own pull request.

**Why it happened:** TradingView draws lines from point 1 that ours didn't. A Schiff and a Modified Schiff have a line from point 1 to point 2; an Inside has one from point 1 to point 2 and one from that line's middle to point 3. D2 followed the third-party capture, which leaves them out; TradingView's own menu icons showed a line from point 1, which SPEC §11 item 161 recorded as "not drawn", provisional. Your screenshot settled it. The Pitchfork itself has none: its median starts at point 1, and it matched already.

**What was already right,** measured on your TradingView screenshot by fitting each red line to its pixels (SPEC §4.26):

| Pitchfork | Measured |
|---|---|
| Schiff | The median passes 1.5 px from point 1's bar halfway to point 2's price, where ours starts it, and 0.36 px from the middle of points 2 and 3 |
| Modified Schiff | The median meets the line from point 1 to point 2 0.508 of the way along it (ours: its middle, 0.5), and passes 0.30 px from the middle of points 2 and 3 |
| Inside | The median meets the line from point 2 to 3 0.499 of the way along it (ours: its middle), parallel to the second line (76.94° and 76.93°), which meets the line from point 1 to point 2 0.502 of the way along it (ours: its middle) |

**Fixed:** `packages/chart/src/drawings/pitchforks.ts` draws those lines (`pitchforkGuides`), in the median's look, cut at the pane's edge, kept with the median off as the line from point 2 to 3 is, and taking a click as the rest of the drawing does. Nothing else changes.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 397, indicators 78, Pine 457, chart 258, web 286, gateway 586 (77 live ones skipped); the fix's own are 10 of them (SPEC §9);
- the browser tests: `channels.spec.ts`, 13, all pass, its new test among them. The suite without its visual and performance tests: 284 of 290 pass:
  - 4 failures are the cloud's known pixel and font checks, with the same numbers as before;
  - 2 timed out once, at the run's start: the heavy-script alert's worker wasn't made within 5 s, and the Add symbol dialog wasn't ready within 30 s. Neither touches the pitchforks. Each passed on a rerun, and both files passed twice over from a fresh start (16 of 16). Their cause isn't found: an open item (SPEC §11, item 178);
- each new test checked failing without the fix (three mutations, each caught);
- a real check against our own gateway in the cloud (port 5191, an empty data folder) and the web app, on OKX:LTCUSDT 1D: the four pitchforks drawn by hand from the toolbar, points placed as on your screenshot; 2, 3, 3 and 4 lines, each line from point 1 where it should be within 0.5 px; saved, and served back the same after a reload; no page errors.

**Not done, and why:** the hand check against TradingView on the Mac. Still provisional (SPEC §11, item 161): Extend lines carrying a pitchfork's lines back past their start, and the lines from point 1 kept with the median off. A screenshot of each on TradingView would settle them.

## 2u. Drawing tools, D3a: several at once, the drawings' menu, copy and paste (26 November)

**Asked:** on 26 November, after D2 merged (pull request #22): D3's research ("start D3 research CAREFULLY"), then D3a's build on your YES ("YES GO AHEAD build D3a CAREFULLY"). D3 comes in three parts, each its own pull request (SPEC §3): D3a here; D3b, templates, a tool's last style and favorites; D3c, the Object Tree, hiding, renaming and groups. Built on `claude/keen-allen-7wubfe`, restarted from `main` at `df37c72`.

**Built** (SPEC §4.27, §5.27, §6.24, §7.8):
- **Several at once:**
  - ⌘ + click (Ctrl elsewhere) adds a drawing to the selection or takes it out;
  - ⌘ + drag on no drawing draws a box, adding every drawing it touches;
  - those selected move together, by a drag on any of them; ⌘ + drag clones them all; Delete removes them; each is one undo step, and locked ones stay;
  - a plain click on one of several selects it alone.
- **Shift's straight moves:** Shift while dragging holds a drawing, or several, to across or to up and down (D1 had Shift's 45° for a point only).
- **The arrows:** with drawings selected, ← and → move them a bar, ↑ and ↓ a pixel; with none, the chart scrolls as before.
- **The drawings' menu,** from a right-click on a drawing or the floating toolbar's new More (⋯), for every drawing selected:
  - Visual order ›: Bring to front, Bring forward, Send backward, Send to back;
  - Intervals visibility ›: Current interval and above, Current interval and below, Current interval only, All intervals;
  - Clone, Copy (⌘C), Lock or Unlock, Remove, Settings….
  A Mac's Ctrl + click, its right-click, opens it too.
- **Visual order:** Send to back puts a drawing under the candles (protocol 15); Bring to front over everything; the other two one step at a time.
- **Intervals visibility:** each choice sets the Visibility tab from the chart's interval.
- **Clone, Copy and Paste:**
  - Clone puts copies where the drawings are;
  - ⌘C and ⌘V copy and paste, on this symbol or another, at the same times and prices, the copies selected;
  - what's copied is kept in this browser.
- **The floating toolbar for several:** color, thickness, style, lock and remove set every drawing selected; Settings opens their Visibility tab, set for all.
- **Changed from D1:** Remove, in the menu and the floating toolbar, leaves locked drawings, as the Delete key does; D1's toolbar removed them.
- **The menu component** (`PopupMenu`) gained submenus, greyed-out items and keys (↑ ↓ through its items, → into a submenu, ← and Escape out). The watchlist's menus look as before.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 397, indicators 78, Pine 457, chart 248, web 286, gateway 586 (77 live ones skipped). D3a's own are 44 of them (SPEC §9);
- the browser tests: `manage.spec.ts`, 14, all pass. The suite without its visual and performance tests: 285 of 289 pass. The 4 failures are the cloud's known pixel and font checks (§6), the same four with the same numbers as in D2's run; the watchlist row menu's is among them, so its new submenus changed nothing there;
- every new test was checked failing without what it tests: seven mutation checks, each caught (SPEC §9);
- speed: dragging ten selected among a hundred drawings, ten of them filled, the ten spread from the bottom of the pile to its top: no task of the page's over 50 ms in three runs in the cloud (under 100 ms asked);
- a real check against our own gateway in the cloud (port 5191, an empty data folder) and the web app, on OKX:BTCUSDT 1h from OKX itself:
  - two trend lines drawn by hand, selected with Ctrl + click, the floating toolbar showing;
  - dragged together, both moved 10 hours and −312.07;
  - from one's right-click menu (its seven items in order), Send to back and "Current interval only", stored as `below: true` and Hours 1–1 with the minutes off;
  - copied, then pasted on OKX:ETHUSDT after loading it, with the same points and a new id, and selected;
  - after a reload, both served back on BTCUSDT, the first still under the bars;
  - six saves, each answered 200; no page errors.

**Not done, and why:**
- **The visual and performance tests, and the real check against your running app,** are the Mac's. D3a changes no visual baseline: nothing new shows without a selection. D1's renewal still stands.
- **Hand checks against TradingView:** on the Mac (§9).
- **Provisional** (SPEC §11, items 171 to 177):
  - the menu's items, their order, icons and words, which TradingView shows only in screenshots;
  - Send to back going under the candles;
  - the box's rules, and a click narrowing a selection;
  - where a clone and a paste land, and that they're unlocked;
  - Remove leaving locked drawings;
  - the arrows' steps;
  - the floating toolbar and Settings with several selected.
- **Left for D3b and D3c, as planned:** Hide (with the Object Tree, which brings a hidden drawing back), templates, a tool's last style, favorites, renaming and groups. The chart's own right-click menu wasn't asked for; alerts on drawings are D6.

**Screenshots that would settle them:**
1. a trend line's right-click menu, then with Visual order open, then with Intervals visibility open;
2. the floating toolbar with two drawings selected (⌘ + click), and its ⋯ menu;
3. a parallel channel over candles after Send to back;
4. the Settings dialog with two drawings selected.

**And by hand on TradingView:** whether ⌘V on the same chart lands on the original or beside it; how far ↑ moves a selected drawing; whether a locked drawing's trash button deletes it; whether a new trend line takes the last color used (for D3b).

## 2t. Drawing tools, D2: channels and pitchforks (26 November)

**Asked:** on 25 November, after D1 merged (pull request #21): D2's research ("whatever is necessary"), then its build on your YES ("YES to build D2 CAREFULLY"). Built on `claude/keen-allen-7wubfe`, restarted from `main` at `8bb0443`, for its own pull request.

**Built** (SPEC §4.26, §5.27, §6.24, §7.8):
- **The menu's Channels and Pitchforks,** under the Lines, as your screenshot has them: Parallel channel, Regression trend, Flat top/bottom, Disjoint channel; Pitchfork, Schiff, Modified Schiff and Inside pitchfork; their icons traced from the screenshot; the dividers measured; no shortcuts. The toolbar's button remembers any of the 17.
- **Drawing them:** three clicks, or a drag for the first line and a click for the third point; a regression trend's two clicks, on the price pane.
- **Their constructions:**
  - a parallel channel's second line through its third point, its dashed middle level, its background;
  - a flat top/bottom's flat line at the third point's price;
  - a disjoint channel's mirrored second line;
  - each pitchfork's median, its levels at 0.5 and 1 each side, and their bands;
  - a regression trend's least-squares line, its Up and Down lines two sample deviations away, its bands, and Pearson's R.
- **Editing:** each tool's handles (a parallel channel's six: its ends keep its width, its second line's middle sets it, its first's moves it all); a click inside a channel's background takes it; move, clone, delete, lock and undo as D1's.
- **Settings:** each tool's rows as its Help Center page lists them: levels, Background, Extend, Prices, a regression's Inputs, the channels' Text, a pitchfork's Style turning it into another kind on the same points; each tool's Coordinates.
- **Defaults:** TradingView's own, from its Charting Library docs (SPEC §3, 26 November).
- **A regression trend's data:** worked out only from every bar of its range. It asks for the older history it needs and, until it's in, shows only a line between its points.
- **Kept** as D1's drawings (protocol 14); a D1 drawing reads unchanged.
- **Found and fixed while checking:**
  - a regression's request for older bars, asked from inside the chart's `setBars`, was dropped, as the session counts its load done only after: now it's asked once that code has finished;
  - dragging among many filled drawings painted every one of them again at each move: now the still ones are painted once into two bitmaps, under and over the moving one.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 379, indicators 78, Pine 457, chart 233, web 275, gateway 586 (77 live ones skipped). D2's own are 69 of them (SPEC §9);
- the browser tests: `channels.spec.ts`, 12, all pass. The suite without its visual and performance tests: 271 of 275 pass; the 4 failures are the cloud's known pixel and font checks (§6), the same four as in D1's runs;
- a real check against our own gateway in the cloud (port 5191, an empty data folder) and the web app, on OKX:BTCUSDT 1h: a parallel channel by three clicks, saved to `data/drawings.json`; a pitchfork turned Inside in its settings, saved with the same points; a regression trend whose Pearson's R equals one worked out apart over the same 53 closes; all three served back after a reload. On 1m, the regression asked for its history: the chart paged back from 1,000 bars to 8,674 and worked it out over all 3,121 of its minutes, its Pearson's R again equal to one worked out apart;
- every new test was checked failing without what it tests (SPEC §9);
- the Channels and Pitchforks sections against your screenshot: places, dividers and icons as measured (SPEC §9).

**Speed, measured in the cloud's software canvas** (long tasks of the page):

| Scene | Dragging one drawing | Moving the pointer over them |
|---|---|---|
| 100 trend lines | none over 50 ms | none |
| 90 lines, 5 channels, 5 pitchforks (the test's) | at most 78 ms in three runs | — |
| 66 lines, 17 channels, 17 pitchforks | 107 and 113 ms once each run, the rest 52 to 73 | 52 to 73 ms |
| 50 channels, 50 pitchforks | 103 to 119 ms at the drag's start and end; 30 moves in 2.0 s (4.2 s before the bitmaps) | 68 to 136 ms |

The time is the canvas filling the translucent bands, not our code (a profile: about 7 ms of geometry against 720 ms of the browser's own painting). Every full repaint pays it. Your Mac paints canvases on its GPU, where it should be far cheaper: to measure there (SPEC §11, item 168).

**Not done, and why:**
- **The visual and performance tests, and the real check against your running app,** are the Mac's. D2 changes no visual baseline: the visual tests don't open the menu. D1's renewal still stands.
- **Hand checks against TradingView:** on the Mac (§9).
- **Provisional** (SPEC §11, items 161 to 170):
  - the pitchforks' origins, where TradingView's own pages contradict each other;
  - the disjoint channel's mirrored line, against the Help Center's "parallel";
  - the regression's deviation (n − 1), its "use deviation" off, and Pearson's R written with every digit;
  - the handles and what they do; the settings' rows; the floating toolbar coloring the whole drawing;
  - where a channel's text sits; which fills take clicks; a regression on the price pane only, with its 50,000-bar limit.

**Screenshots that would settle them:**
1. the four pitchforks on the same three points, selected;
2. a selected parallel channel, flat top/bottom and disjoint channel;
3. a regression trend over a range you name (say BTCUSDT 1D, 1 to 31 October 2026), selected, with the price axis showing;
4. each tool's settings dialog, Style tab, and the regression's Inputs;
5. the floating toolbar of a selected channel and pitchfork.

## 2s. Drawing tools, D1: the toolbar and the Lines tools (25 November)

**Asked on 25 November:** TradingView's drawing tools, all but the technical ones (Gann and Fibonacci, patterns, forecasting, volume-based), as an exact copy, with your screenshot of TradingView's toolbar and Lines menu. The plan has six milestones, D1 to D6 (SPEC §8); D1 is built on `claude/keen-allen-7wubfe` from `main` at `8dab233`, for its own pull request.

**Built** (SPEC §5.27, §6.24, §7.8):
- **The left toolbar:** the cursors (Cross, Dot, Arrow, Eraser) and the trend line tools, each group's button holding its last choice and a tab opening its menu; the magnet (Weak, Strong); Keep drawing; Lock all drawings; Hide all drawings (⌘⌥H); Remove objects. An arrow at its foot hides it and a tab brings it back.
- **The 9 Lines tools:** Trendline, Ray, Info line, Extended line, Trend angle, Horizontal line, Horizontal ray, Vertical line, Crossline; drawn with clicks or in one stroke; TradingView's ⌥T, ⌥H, ⌥J, ⌥V and ⌥C.
- **Editing:** select; move by the line or a point by its handle, the chart never moving with it; Shift's 45°; Ctrl/⌘ + drag to clone; Delete; the Eraser; locks; double-click for the settings.
- **The floating toolbar** (color, thickness, style, settings, lock, remove) and **the settings dialog** (Style, Text, Coordinates, Visibility).
- **Undo and Redo:** the top bar's two buttons after Alert, ⌘Z and ⇧⌘Z; 100 steps per symbol.
- **Kept** by the gateway, per symbol, in `data/drawings.json` (protocol 13), on every interval; drawings on an indicator's pane go with the indicator.
- **Found and fixed while checking:** the gateway kept a save before writing it, so a failed write would have been served as stored; the app tried a failed save again only at the next edit, and a failed load not at all, and said nothing. Now a failed load or save is tried again every 3 s, the chart says so meanwhile, and a symbol's list not yet saved is what the chart shows on coming back to it. A save asked for just as the one before it ended, which a load answering at that very moment does, was never sent; now the queue starts again for it.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 366, indicators 78, Pine 457, chart 178, web 274, gateway 586 (77 live ones skipped). D1's own are 120 of them (SPEC §9);
- the browser tests: `drawings.spec.ts`, 25, all pass. The suite without its visual and performance tests: 259 of 263 pass; the 4 failures are the cloud's known pixel and font checks (§6), the same four as in the last runs;
- a real check against our own gateway in the cloud (port 5191, an empty data folder) and the web app, on OKX:BTCUSDT 1h: ⌥T and two clicks drew a trend line, saved to `data/drawings.json`; Undo took it out of the file and Redo put it back; a reload and 4h showed it (SPEC §9);
- every new test was checked failing without what it tests (SPEC §9);
- the toolbar and Lines menu against your screenshot: sizes, places and colors as measured; the icons 0.24 to 2.87 gray levels apart on average, the Trend angle's the furthest (SPEC §9);
- dragging among 100 drawings: no task of the page over 100 ms.

**Not done, and why:**
- **The visual and performance tests, and the real check against your running app,** are the Mac's. The 13 visual baselines need renewing there: the drawings toolbar moves the chart 52 px right, and Undo and Redo join the top bar. The layout and reference tests hide the toolbar, as your October screenshots had TradingView's hidden.
- **Hand checks against TradingView:** on the Mac (§9).
- **Provisional:** what TradingView doesn't document or your screenshot doesn't show: handles, the stats, the trend angle, arrowheads, dashes and text placement (from a third-party capture); the floating toolbar, the settings dialog, the cursors, hover colors and the save notice (ours); the toolbar's #0F0F0F against your screenshot's black (SPEC §11, items 155 to 158).
- **Found, not fixed:** a script's drawings between bars (`xloc.bar_time` on another interval) sit at the pane's left edge, Lightweight Charts placing only whole bar indexes; the same fix as the user's drawings', on its own YES (SPEC §11, item 160).
- **A known limitation:** a removed indicator's drawings on another symbol can come back if an indicator with the same id is added before that symbol loads (SPEC §11, item 159); the gateway's cleanup comes with D3.

**In the repo:** `docs/reference/08-drawing-lines-menu.png`, your screenshot of 25 November, as the menu's reference. The repo is public; it shows TradingView's menu over a Nifty 50 chart and nothing personal.

**Lost and rebuilt (25 November):** the usage limit paused the session at 13:14 UTC. While it waited, the cloud replaced the session's container (17:01), and D1, not yet committed, went with it. It was rebuilt exactly from the session's own record of every change: each file write, edit and command, replayed in order on `main` at `8dab233`, with the test runs left out. Checked:
- every file read recorded during the build matched the rebuilt file;
- the change's size is the same as before the loss: 22 files changed, 839 lines added and 40 removed;
- the 26 line counts measured before the loss match;
- your screenshot came back from your own message.

The lesson: in a cloud session, work lives only in its container until it's pushed.

## 2r. The Mac's `pnpm verify` of 18 November, and the alert's chime (18 November)

**The Mac's run:** typecheck, lint and the unit tests passed. Of the browser tests, 250 passed, 1 failed and 5 didn't run (the perf tests, which wait for the others). All 13 visual tests passed, and so did the pixel checks and Symbol Search's Enter tests.

**The failure:** `alerts.spec.ts`, "an alert on a heavy script runs in a worker of its own…": a task of the page's of 277 ms, where 200 ms is the limit. The test found a real fault; it isn't flaky.

**The cause: the alert's chime, not its script.** The script ran in its worker as designed. When the alert triggered, Play sound (on by default, and on in the test) made a new `AudioContext`, and making a browser's first one waits on the computer's audio output, the page with it (SPEC §3, 18 November). Measured in the cloud, the test's steps in a fresh browser each time:

| Run | The chime | Its AudioContext made in | The page's long tasks | Longest |
|---|---|---|---|---|
| 1 | as on `main` | 41 ms | 60, 92 ms | 92 ms |
| 2 | as on `main` | 65 ms | 118 ms | 118 ms |
| 3 | as on `main` | 50 ms | 53, 106 ms | 106 ms |
| 4 | the fix | none made | 50 ms | 50 ms |
| 5 | the fix | none made | 56, 50 ms | 56 ms |
| 6 | the fix | none made | none | 0 ms |

- **A CPU profile of the trigger:** 42 of its 46 ms went on making the AudioContext; the rest was React drawing the pop-up. Under Chrome's tracing the same task took 527 ms.
- **The other long tasks,** up to 56 ms here, are the page drawing after Create and the pop-up, the same with either chime.
- **Not measured:** the Mac, from here. Its 277 ms is most likely the same wait on macOS's audio output, the only part of the task that depends on the machine. If the test fails again, its message lists the page's long tasks, so the run itself says what they were.

**Changed** (`apps/web/src/alerts/alertSound.ts`):
- **The same chime:** 880 Hz, then 1318.5 Hz, with the same rise and fall, worked out as samples at its first play and kept as a WAV in the page's memory (48,554 bytes; nothing leaves the Mac).
- **Played from an audio element,** a new one for each trigger, so two alerts at once chime twice. No AudioContext is made.
- **Its cost:** making the WAV took 1 to 8 ms, once; a play takes 0 to 2 ms of the page's time, its sound starting 4 to 26 ms later.
- **The sound is the same:** against the browser's own Web Audio rendering of the old chime, at most one step of a 16-bit sample apart.
- **A tab you haven't clicked yet keeps it silent,** as before: Chrome's autoplay rule is the same for audio elements and Web Audio, and TradingView's Help Center says the same of its own sound (SPEC §3).

**Tests:**
- **New, `alertSound.test.ts` (7):** the chime's length, pitches, peaks and quiet parts; its WAV's format and every sample; two plays from two audio elements, the WAV made once and no AudioContext; a play the browser refuses, caught; nothing done without audio elements.
- **They fail without the fix:** with `main`'s way of playing, the two play tests fail (two AudioContexts made, no audio element); without the refusal's catch, Vitest fails the run on the unhandled `NotAllowedError`.
- **The heavy-script test** (`alerts.spec.ts`) now also checks that the chime played once from an audio element, 0.55 s long, and that no AudioContext was made. It fails on `main` (one AudioContext, no audio element). If its 200 ms check fails, its message lists the page's long tasks.
- **The five alert tests, 10 runs each:** 50 of 50.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 350, indicators 78, Pine 457, chart 109, web 249, gateway 576 (77 live ones skipped);
- **the browser suite** without its visual and performance tests: 234 of 238 pass. The 4 failures are the cloud's known pixel and font checks (§6), the same four as in the last run.

**What it means for you:** an alert with Play sound no longer holds the page while the computer's audio wakes up, and you hear the same chime.

The real check is the Mac's: `pnpm verify`, and a price alert with Play sound (§9).

## 2q. Symbol Search's Enter, before its results are in (17 November)

The two tests that failed now and then, "Enter adds the top match" and "input.symbol is picked with Symbol Search" (SPEC §11, item 144), came from a real bug in the app, not in the tests or the engine.

**The cause:** Enter took the top of whatever list was on screen, and a list stays on screen until the answer for the new text comes. Typed fast, Enter took the list from before typing. That list has 50 rows, AMEX:SPY on top, with XRPUSDC and LDOUSDT rows further down, out of view. The tests waited for those rows to be "visible", which Playwright counts even when a row is scrolled out of view, so their waits passed on the old list and Enter added or picked SPY. You'd have got the same by typing fast and pressing Enter.

**Changed** (SPEC §3, 17 November; in `SymbolSearchDialog.tsx`):
- **Enter takes the top result for what's typed**, as TradingView documents: "pressing the Enter key without selecting a search result will automatically select the top search result as the input value. If no results are available, pressing Enter will have no effect" (Charting Library docs, Featuresets).
- **An Enter that comes before the results waits for them.** Shift+Enter still adds and closes, once they're in.
- **An Enter is for the text it was pressed on:** more typing, another tab or source, ↑/↓ or a click drops it.
- **A highlighted row counts only on results for what's typed** (the formula's row always is).
- **No results, or a search that failed:** Enter does nothing.
- TradingView doesn't document the waiting, the dropping or the failed search, so those are provisional (SPEC §11, item 144).

**Tests:**
- **New,** in `symbol-search.spec.ts`: "Enter waits for the results for what was typed, then takes their top match; with none it does nothing". It holds each typed search's answer back, presses Enter while it's held, then lets it go.
- **It fails on `main`** (Enter added SPY), and **with each rule taken out:**

| Taken out | What the test saw |
|---|---|
| The whole fix (`main`'s dialog) | AMEX:SPY added from the list before typing |
| Dropping an Enter on more typing | BINANCE:XRPEUR added, typed after the Enter |
| Nothing taken after a failed search | AMEX:SPY added from the old list |
| The waiting Enter's Shift | The dialog stayed open |

- **Proper waits:** "Enter adds the top match…" and the chart's symbol search (`symbol-search.spec.ts`), and "input.symbol is picked with Symbol Search" (`requests.spec.ts`), now wait for the list to read as the answer for what's typed, not for a row to show.
- **The four Enter tests (the new one and the three above), 12 runs each:** 48 of 48 pass.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 350, indicators 78, Pine 457, chart 109, web 242, gateway 576 (77 live ones skipped);
- **the browser suite** without its visual and performance tests: 234 of 238 pass. The 4 failures are the cloud's known pixel and font checks (§6), the same four as in the last two runs; the fifth those runs had, one of the two Enter tests, is gone.

**What it means for you:** type a symbol and press Enter at once, and it adds (or shows) what you typed, never the list from before. Enter waits as long as the search for what you typed takes.

The real check against your running app is the Mac's (§9).

## 2p. Scripts freezing the tab, steps 3b and 3c: a requested context's run kept after live updates, and with requests inside it; a script waiting for its contexts to page back (17 November)

Step 3 (pull request #16) kept only VuManChu B's 8 cheap context runs between loads. Its other 18 have requests inside them, and on a live chart nearly every context has had a live update between two loads (SPEC §11, item 143).

**Changed** (SPEC §3, 17 November; how it's built: §6.18):
- **3b:** a context's run that had live updates since its run afresh is kept at the next load when its code can't tell them from history. The compiler marks the reads that can: a `varip`, five `barstate.*` (`isrealtime`, `ishistory`, `isnew`, `islast`, `islastconfirmedhistory`), `last_bar_index`, `last_bar_time` and `chart.right_visible_bar_time`. A kept run follows its data's live updates, and its warm-up verdict is worked out again.
- **3c:** a context's run with requests inside it is kept when those give what they gave. It records each request its code makes, and asks them again once per load and live update before it's used; they're listed and counted toward Pine's 40 as their calls would be.
- **A request inside another follows its inner context's live updates** on the live bar. Before, it showed the inner value as it was whenever the outer's own bars didn't move (1,142 for 2,000 in a test), on `main` too.
- **Bar times:** a run afresh records its bars' times every time.
- **The corpus tool** now also reloads each script with requests after live updates on its contexts' data, and checks it against a fresh run.
- **A script waits for its contexts to page back** (your second YES, SPEC §11, item 148). When older chart bars come in, the request loader learns the chart's new first bar at once, and its contexts that don't reach back to it start paging. A script in a worker whose contexts are paging back waits: what it drew stays on its bars, and it runs once they're in. Its live bar waits with it.
- **The loader keeps a page that a live update overtook** (it threw it away before), and **a failed page no longer holds the scripts:** it's asked again after 5 s, and the scripts run on what's in meanwhile.

**Found while building it:**
- **Step 3 had a regression, on `main` now:** a kept Renko context carried its old bricks' times after live updates remade its bricks at the same count. The new live-then-reload check found it in 4 of the manual's Renko examples. Fixed, with a test that fails on step 3's engine.
- A context with no live bar (its market closed) whose inner request moved within a load was kept at the next load with the old value (1,500 for 1,800). Fixed before delivery, with a test.
- **The corpus has no script with a request inside a request** (counted with a hook): 3c is held by the unit tests and by your VuManChu B, which has 18 such context runs.
- **Zooming out got slower with 3b and 3c alone,** for a reason in the chart's schedule (below). That's why the wait was built before committing.
- **A context's page was thrown away when a live update came while it loaded.** The gateway forwards every exchange update as it comes, so a busy context could page back slowly. Fixed, with a test that fails on the old loader.

| Measured in the cloud, 17 November, `main` (`1d7cedb`) and this branch taken in turn, three rounds: VuManChu B on 4h with its 1h, 12h and 1D data, a reload as 5,000 older bars come in (7,000 → 12,000) | `main` | 3b and 3c |
|---|---|---|
| Data unchanged, from the listing: the reload (Node) | 2.84–3.02 s (18 context runs afresh) | 1.99–2.24 s (0) |
| Data unchanged, not from the listing, so with warm-up checks | 5.70–6.43 s (18) | 1.90–2.17 s (0) |
| A tick on each context between the loads, as on a live chart | 3.03–3.29 s (26) | 2.79–3.12 s (18) |
| The 1h context paged back between the loads | 2.84–3.07 s (19) | 2.69–2.77 s (7) |
| 300 live updates, one context at a time: median, slowest | 0.52–0.62 ms, 27–44 ms | 0.56–0.68 ms, 20–27 ms |

| In the browser (the browser tests' fake gateway), zooming out on 4h with VuManChu B: `main`, 3b and 3c alone, and 3b and 3c with the wait, taken in turn, three rounds | `main` | 3b and 3c alone | With the wait |
|---|---|---|---|
| **Its values after the last page** | 2.2–2.7 s | 4.1–4.8 s | **1.9–2.0 s** |
| Loads in the worker during the zoom (timed there, two rounds each) | 2 | 3 | 1, as the last page comes |
| The page blocked in all (its own drawing) | 6.6–7.3 s | 6.8–7.6 s | 5.7–6.3 s |

This run was slower overall than the morning's (`main`'s values came 1.4–1.9 s after the last page then), which is why the versions are taken in turn.

**What it means on your charts:**
- **Reloads with the data unchanged are much quicker.** Older chart bars with nothing else changed: about a third quicker from the listing, and about three times quicker where the warm-up checks run.
- **On a live chart:** the 8 cheap contexts are now kept after live updates. The 18 with requests inside them still run again whenever they've had one: a request's value on a live bar isn't the one a fresh run reads there.
- **Zooming out, the values come sooner than on `main`:** 1.9–2.0 s after the last page, against 2.2–2.7 s. With 3b and 3c alone they came later (4.1–4.8 s): the chart ran the script again as soon as its own older bars came, while the 1h context was still paging back, and ran that context 13,000 bars short of its listing, with its warm-up checks (0.7 s for one run, against 0.2 s over all 48,000), then once more. Now the script waits for its contexts and runs once (SPEC §11, item 148).
- **While a script waits, its live bar waits too:** for as long as its contexts take to page back, a second or two in the cloud. Then it runs over everything, the latest tick included.

**Not in this step:**
- a context with requests inside it kept after live updates (item 143);
- Lightweight Charts 5.3.0 (item 139);
- VuManChu B beside TradingView: its inputs outside their range (item 145), its pane's scale labels (item 146), its chained requests (item 111).

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 350, indicators 78, Pine 457 (8 new, 2 changed), chart 109, web 242 (3 new), gateway 576 (77 live ones skipped);
- **each part taken out fails its own test:** asking the inner requests again (5 fail), `touch()` on a live update (2), registering them as asked on history (1), keeping runs with requests inside (2), running the live bar again (2), running a kept one afresh (1), marking a closed one not fresh (1), keeping after live updates (5), the live marks (2), recording the bar times (1);
- **the corpus:** every script's outcome is unchanged from `main` (all 1,965: 1,844 run). Every script with requests that runs gives a fresh run's results after live updates and a reload. With the live marks taken out, 2 fail that check: the manual's non-repainting request and a community script with the same pattern;
- **VuManChu B against a fresh run** (Node): its plot values and colors, errors, requested list and plots' starts are the same after older chart bars, after a tick following a kept reload, after live updates and a reload, and after only the 1h context moved;
- **the wait:** the loader's 3 new tests each fail on the loader as it was; the new browser test (a script asking for 4h bars on the daily chart, scrolled back while its context's next page is held: it waits with its 1,000 points kept, then draws all 2,500 days in one run) fails with the whole change out, with the wait out and with `reachBack` out;
- **the browser suite** without its visual and performance tests: 232 of 237, the new test among those that pass.
  - Four failures are the cloud's known pixel and font checks (§6).
  - The fifth, Symbol Search's "Enter adds the top match", is the known flake (SPEC §11, item 144). This time Enter added AMEX:SPY. In the earlier run, `requests.spec.ts`'s "input.symbol is picked with Symbol Search" failed the same way, also on `main` (alone, 3 of 12 runs with `main`'s engine, 1 of 12 with this one). Both take the AMEX:SPY row, so that's where to look.

The real check against your running app is the Mac's (§9).

## 2o. Scripts freezing the tab, step 3: a requested context's run kept when a fresh run would give it again (17 November)

Steps 2 and 2b (pull requests #14 and #15) took scripts and alerts off the page's thread. What was left (SPEC §11, item 138): each page of older chart bars ran a script again over every bar in its worker, and every requested context with it, though their data hadn't changed. On VuManChu B on 4h that was about a third of the worker's time.

**Changed** (SPEC §3, 17 November; how it's built: §6.18):
- a script's run keeps its requested contexts from one load to the next, in the page and in its worker;
- a context's run is kept when a fresh run would give it again:
  - it last ran afresh, and its data hasn't changed since;
  - its code reads no clock (`timenow`, `math.random()` without a seed) and makes no requests of its own (`request.currency_rate()` counts as one);
  - its prices aren't converted to another currency;
  - no run of it stopped on an error;
- any other runs afresh, as before, and a context the load no longer asks for is let go at its end.

**Found while building it:**
- My first build read the plan's rule loosely and kept a context's run after live updates, which shows wrong data. After a live new day, the manual's non-repainting request (`barstate.isrealtime` inside) read 1 on the day that was live, where a fresh run reads 0, and a `varip` counter read 3, not 2. It's now built strictly: a context that had a live update since its run afresh runs afresh at the next load. A test holds it (it fails with the loose rule).
- `request.currency_rate()` inside a context reads other contexts' data, so it counts as a request of its own.
- A run that stopped on an error isn't kept: the 500 ms limit's error can come out otherwise.

| Measured in the cloud, 17 November, `main` and step 3 taken in turn, three rounds: VuManChu B on 4h, a reload as 5,000 older bars load (7,000 → 12,000), with its 1D, 12h, 1h and 4h data | `main` (`609b188`) | Step 3 |
|---|---|---|
| Data unchanged, from the listing: the reload (Node) | 2.78–2.94 s | 2.62–2.88 s |
| Of it, the contexts run afresh | 1.04–1.23 s (26 runs) | 0.98–1.04 s (18 runs) |
| Data unchanged, not from the listing, so with warm-up checks: the reload | 5.37–5.73 s | 5.31–5.42 s |
| Of it, the contexts run afresh | 4.02–4.41 s (26) | 3.88–4.00 s (18) |
| A tick on each context between the loads, as on a live chart: the reload | 2.74–3.01 s (26) | 2.69–2.97 s (26) |
| In the browser (the browser tests' fake gateway), zooming out on 4h: 14 pages of 4h and 1h bars, then its values after the last page | 1.5–1.7 s | 1.4–1.6 s |
| The same zoom: the page blocked (its own drawing) | 5.5–6.1 s | 5.1–6.0 s |

**What it means on your charts: little, so far.** The 8 runs it keeps are VuManChu B's cheap ones, about 0.1–0.3 s of a reload. The 18 that make requests of their own hold about 90% of the contexts' time, and still run again. On a live chart, every context whose live bar moved since its run runs again, and between two loads that's nearly all of them. So older bars get their values about 0.1 s sooner at best, which is within the spread.

The plan's figures for `main` (3.9–4.25 s and 7.1–8.8 s) came from runs not taken in turn. Taken in turn today, they're 2.78–2.94 s and 5.37–5.73 s. The contexts' share the plan gave, about 40% and 75%, holds. What the plan missed is that most of that share is in runs with requests of their own.

What step 3 gives besides is the groundwork for 3b and 3c, and a guard: the corpus now reloads every script and compares it with a fresh run.

**Not in this step:**
- **3b:** keeping a context's run after live updates when its code can't tell them from history, which needs the compiler to mark the few reads that can (SPEC §11, item 143);
- **3c:** keeping a run with requests of its own (18 of VuManChu B's 26);
- Lightweight Charts 5.3.0.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 350, indicators 78, Pine 449 (9 new), chart 109, web 239, gateway 576 (77 live ones skipped);
- the new tests fail without their part: six on `main`'s engine, and each rule taken out in turn fails its own (the loose rule fails two);
- the browser suite without its visual and performance tests: 231 of 236. Four failures are the cloud's known pixel and font checks (§6), which pass on the Mac. The fifth, Symbol Search's "Enter adds the top match", fails now and then on `main` too: alone, 3 of 13 runs with `main`'s engine and 3 of 13 with step 3's. So it isn't this step's; its cause is still to find (SPEC §11, item 144);
- the corpus: every script's outcome unchanged (all 1,965), and every one that runs gives a fresh run's results after its reloads. With a broken keep (kept runs ignoring changed data), 73 of its 180 running request scripts fail that check.

The real check against your running app is the Mac's (§9).

## 2n. Scripts freezing the tab, step 2b: alerts' scripts in workers of their own (16 November)

Step 2 (§2m, merged as pull request #14) took the chart's scripts off the page's thread. Alerts' copies of their scripts still ran on it: an alert on VuManChu B on 4h blocked the page 4.0–4.2 s as it started (at every app start, reconnect or library change), in blocks of up to 2.1 s, and each alert added its own. TradingView runs alerts on its servers: "closing TradingView or leaving the chart page doesn't stop them" (Help Center, Will alerts work if TradingView is not open on the computer?).

**Changed** (SPEC §3, 16 November; how it's built: §6.22, §6.23):
- each alert on a script runs its copy in a worker of its own, on its own symbol and timeframe, as before;
- the page still decides what triggers, with the same rules (`TriggerState`): each live update is checked when its worker answers, in the order the updates went out, on the bars as that update saw them, so `{{close}}` is the tick that triggered it;
- an alert's worker stops when the alert is stopped, removed, edited (its new copy gets a new one) or reset, when an "Only once" alert triggers, and when the app closes;
- without workers, alerts run in the page as before.

| Measured in the cloud: an alert on VuManChu B on 4h (5,000 bars, and its 1D, 12h and 1h data), the chart on XRPUSDT 1D without a script; runs taken in turn on the same machine, 16 November | `main` (`6b6884d`, step 2) | With workers |
|---|---|---|
| The page blocked while the alert starts | 4.02–4.63 s | 0.39–0.62 s |
| Its longest single block | 2.02–2.29 s | 0.12–0.13 s |
| The Pine package's code on the page as it starts | 3.6–4.2 s | 0.16–0.19 s: compiling the script, which the page still does to list its plots and conditions, and taking in its worker's results |
| The same, per live tick | 2.1–2.5 ms | 0.1–0.4 ms |
| The chart showed its bars within 5 s of opening | 4 of 7 runs | 6 of 6 runs |

On `main`, three runs stopped there: the alert's run held the page as the app started, so the chart's own bars came late. The rest of the 0.4–0.6 s with workers is the app opening.

**The same alerts:** each of the alert runner's cases gives the same alerts and messages in the page and through a worker (`alerts.test.ts`): alert() calls by frequency, alertcondition() with placeholders, order fills, errors, a script waiting for another symbol's bars. The corpus, as before (the manual's 1,034 of 1,069, the community's 809 of 854), gives the same results through a worker, alertcondition() values now among them; the corpus tool now counts a script that follows the clock as varying even when two quick runs in the page agree (manual-409 did once).

**Provisional** (SPEC §11, item 142): a tick that comes while an alert's script runs afresh a second time as it starts (its requests' data landing) goes into that run, which doesn't alert, as no run afresh does. In the page such a tick waited and ran after it.

**Not in this step:** alerts with the app closed (TradingView's run on its servers; ours could run on the gateway, your call); step 3; Lightweight Charts 5.3.0.

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 350, indicators 78, Pine 440 (3 new), chart 109, web 239 (9 new), gateway 576;
- the two new safeguards' tests fail without them: a message read from the feed's latest bars says `close 112` for the tick at 111, and a waiting script not run afresh never alerts;
- the browser suite without its visual and performance tests: 232 of 236. The 4 failures are the cloud's known pixel and font checks (§6), which pass on the Mac. The new heavy-alert test fails with the alert run in the page;
- the corpus as above.

The real check against your running app is the Mac's (§9).

## 2m. Scripts freezing the tab, step 2: scripts in workers of their own (16 November)

Step 1 (§2l, merged as pull request #13) made scripts run less often. But a script still ran on the page's own thread, the one that draws and answers clicks: zooming out on a long 4h history with VuManChu B still blocked the tab for 23–27 s in all, in blocks of up to 6.5 s. TradingView runs Pine on its servers, so its page never runs one (SPEC §3, 16 November).

**Changed** (SPEC §3, 16 November; how it's built: §6.23):
- every Pine script on the chart runs in a worker of its own (a Web Worker: a thread of the browser's beside the page's). The page sends it the bars and its requests' data, and draws what comes back;
- while a script calculates for the first time, its legend row shows the loading ring where its values go. When older bars load, what it drew stays on its own bars until the run over all of them is in;
- a script whose look alone changed (a color, a hidden plot) keeps its run and is drawn again at once. A script removed while it calculates stops its worker at once;
- a browser without workers would run scripts in the page, as before;
- a fresh run takes its own drawings and trades (before, a reload whose drawings changed as often as the last load's kept the last load's: a label on the last bar stayed where it was before older bars loaded);
- Lightweight Charts 5.2.1 loses the chart's time points when the candles are its only series with data and are set again, and then throws "Value is null" on every frame. Scripts in workers made that likely (their series wait empty while the candles are set). An invisible series on the first bar's time keeps it from happening. 5.3.0, published 10 November, fixes it; the upgrade waits on your YES (SPEC §11, item 139).

| Measured in the cloud, VuManChu B on 4h: 12,000 bars, with 48,000 1h, 4,000 12h and 2,000 daily ones (16 November, three rounds each, taken in turn on the same machine) | `main` (`ca62c84`, step 1) | With workers |
|---|---|---|
| Chart opening, the page blocked | 1.83–2.03 s | 0.52–0.58 s |
| Its longest single block | 1.24–1.39 s | 0.14–0.17 s |
| Zoomed out until its history is in, the page blocked | 26.3–26.8 s | 6.7–7.4 s |
| Its longest single block | 5.2–6.5 s | 0.31–0.46 s |
| The zoom done: all 60 wheel turns taken and the history in | 27 s | 7–8 s |
| The script's values over all 12,000 bars | with each page, the page blocked meanwhile | 3.9–4.4 s after the zoom began, 2.3–2.4 s after the last page |
| A heavy script added from the Pine Editor (4,000 loop steps a bar, 1,000 bars): the page's longest task | 2.1 s | under 0.2 s |

On `main`, two of the three rounds paged back only to 11,000 bars, so its numbers are if anything low.

**What's left of the page's time while zooming** (a Chrome trace and a CPU profile of the same zoom with workers): the script's own 3.9 s are all in its worker now. Of the page's 8.1 s:
- 5.1 s are Chrome drawing the chart's canvases in software, as the cloud has no GPU;
- 1.6 s are JavaScript, nearly all of it Lightweight Charts drawing VuManChu B's 34 lines over 12,000 bars;
- 0.4 s are the canvases copied out for the screen.

With no script, the same zoom has no long task at all. On the Mac the canvases draw on the GPU, so much of the 5.1 s may leave the page's thread there; that's the Mac's to measure (§9).

**The same results:** the corpus, the manual's 1,034 of 1,069 examples and the community's 809 of 854 (as before), gives the same results through a worker's two ends as in the page, but for the 16 whose results differ from one run to the next in the page too (`math.random()`, `timenow`). VuManChu B with data for all four timeframes: the same values through the worker as in the page (hash `fae19f56862687b0` both).

**Not fixed yet:**
- older bars wait for their values while the worker runs the script again over every bar (zooming out on 4h with VuManChu B, 2.3–2.4 s after the last page, in the cloud); keeping a requested context's run when its data didn't change is step 3 (SPEC §11, item 138);
- the page's own drawing of a script's many lines, above;
- alerts' scripts still run in the page: an alert running VuManChu B costs 1.5 s at its start and when its history changes. Moving them to workers is step 2b (item 140);
- a script that runs very long runs on in its worker, the page free, until it's removed; TradingView stops a calculation after 20 to 40 s depending on the plan (item 141).

**Checks (cloud):**
- typecheck and lint clean;
- the unit tests pass: core 350, indicators 78, Pine 437 (23 new), chart 109 (4 new), web 230, gateway 576. The engine's two new tests fail without their fix;
- the corpus as above;
- the browser suite without its visual and performance tests: 231 of 235. The 4 failures are the cloud's known pixel and font checks (§6), which pass on the Mac;
- `workers.spec.ts`'s heavy-script test fails with the script run in the page (one task of 2.1 s). `pine.spec.ts`'s marks test fails without the invisible series (the marks are never drawn).

The real check against your running app is the Mac's (§9).

## 2l. Scripts freezing the tab, step 1 (15 November)

The user's VuManChu B froze the tab ("Page Unresponsive" in the browser), with two copies on XRPUSDT 1D, and lagged badly on 4h. Pine runs on the page's main thread, which also draws and answers clicks. Measured in the cloud (SPEC §9):
- **Every page of history ran each script again from scratch:** the chart's own pages, and every page of a timeframe a script asks for (VuManChu B asks for 1D, 720, 60 and 240), each time over every bar, its main run and three check runs.
- **Its request calls read the same symbol and timeframe texts again on every bar:** 40% of its time.

**Changed** (SPEC §3, 15 November):
- a request reads each symbol and timeframe text once (the keys, the timeframes, the call's own texts, the Heikin Ashi ticker);
- a script waiting on a request's data runs without its check runs (it draws nothing until the data is in);
- it runs again for its requests' data once all of it is in, then once its contexts stop paging back;
- with a script on the chart, a page of older history is the gateway's most, 5,000 bars.

| Measured in the cloud, VuManChu B | Before | After |
|---|---|---|
| One load, 2,800 daily bars (no request data) | 950 ms | 532 ms |
| Chart opening, 2,500 daily bars, 1 copy, blocked (medians of 3) | 1.96 s | 0.99 s |
| The same, 2 copies | 2.33 s | 1.43 s |
| 4h chart of 12,000 bars, opening, blocked | 4.1–5.0 s | 1.5–1.7 s |
| The same, zoomed out until its history is in, blocked | 77–95 s | 23–24 s |
| Its longest single block | 8.1–8.5 s | 4.3–4.4 s |

The values are identical: the corpus's 1,965 scripts' outcomes, and every value of VuManChu B's with data for all four timeframes. **Not fixed yet:** zooming out on a long 4h history still blocks the tab for seconds at a time, since each page of the chart's own history runs the scripts again over every bar. Step 2 took the scripts off the page's thread, into workers of their own (§2m).

**Checks (cloud):** typecheck and lint clean; the unit tests pass (core 350, indicators 78, Pine 414, chart 105, web 230, gateway 576), the new ones failing without their changes; the corpus unchanged; the browser suite without its visual and performance tests 227 of 232, the 5 failures the cloud's known 4 pixel and font checks and Symbol Search's Enter under load (passes 3 of 3 alone).

## 2k. The Mac's performance runs of 10 November

With #11 merged, `pnpm verify` on the Mac passed 248 of its 249 browser tests: the first full run with #9's keys, #10's baselines and the Bitstamp fix. The user then ran the perf tests in windows (`pnpm exec playwright test perf --project=perf --no-deps --headed` in `apps/web`), where the browser draws on the GPU.

| Test | `pnpm verify` (headless) | In windows (GPU) | Asked |
|---|---|---|---|
| Pan and zoom, 20,000 bars | a frame every 16.7 ms | 8.3 ms | under 20 ms |
| The same with Volume and RSI | **33.2 ms** (failed) | 8.3 ms | under 20 ms |
| Slowest switch | 120 ms | 86 ms | under 150 ms |
| Slowest switch, Volume and RSI | 119 ms | **152 ms** (failed) | under 150 ms |

- **Why headless missed:** headless Chromium draws in software unless told otherwise (Chromium's "Using GPU Hardware in Headless Chrome"), and in software RSI's line alone, zoomed out to 2,800 bars that jump at every bar, takes longer to draw than a frame (19 ms, measured in the cloud). On the GPU the same chart draws every 8.3 ms: 120 fps on ProMotion (SPEC §5.6).
- **Why the windows' switch missed:** the five perf tests ran at once, in five windows. The first switch is the slowest in every run; headless, the same test passed at 119 ms.
- **Measured in the cloud** (a CPU profile of the test's own input; scratch, outside the repo): the browser's own drawing, 3.4–3.6 s with no indicators, 3.9 s with Volume, 9.8–10.1 s with RSI: its line +4.1 s, its two gradient fills about +2.6 s, its pane and levels almost nothing. The library's conflation wouldn't help (it would hide peaks, and at 2× it never starts, as our zoom stops at 0.5 px a bar); cheaper ways of drawing the line changed its pixels, so they're out (SPEC §11, item 67).
- **Changed** (SPEC §3, 15 November): the perf project draws on the GPU (`--enable-gpu`), runs one test at a time (`workers: 1`) and prints its renderer; the screenshot tests keep drawing in software. Drawing RSI's gradient fills only where they show is for later (SPEC §11, item 137).

**Checks (cloud):** typecheck and lint clean; the unit tests pass (core 350, indicators 78, Pine 409, chart 100, web 228, gateway 576); the config lists all 249 browser tests; the perf project ran one test at a time and printed its renderer, SwiftShader here, with no GPU, and its drawing budget with Volume and RSI missed there, as it always has in the cloud. Whether the Mac's headless browser takes the GPU this way is for its next `pnpm verify` to show.

## 2j. The Mac's second run of 10 November

With #9 merged, the user signed git in to GitHub (`gh auth login`), renewed the five visual baselines and pushed them as pull request #10, then ran `pnpm verify` and `pnpm test:live`.

| What | Result | Cause | Now |
|---|---|---|---|
| The five new baselines (#10) | Reviewed in the cloud from the branch | The chart page has the Indicators and Alert buttons and the right toolbar; the four element shots hold the same content as before. The Gestures popup's left edge shows a sliver of a red candle: the popup sits at a fractional x (823.84 px) under its button | Merged on 10 November. Snapping popups to whole pixels would keep their edges crisp: for the next visual change, so the baselines change once |
| `pnpm verify` | Stopped at Bitstamp's "polls the live candle every 30 s"; the browser tests didn't run | The test checked right after moving its fake clock, but the poll's answer comes through promises the fake clock doesn't wait for: on a busy machine a moment later. Reproduced: with the fake Bitstamp answering 20 ms late, the old check fails with the Mac's very message ("expected [] to have a length of 2 but got +0") | Fixed: the test waits for the answer, and passes with the late answer too |
| Live: "typing XRP lists every exchange…" | Timed out at 5 s | Its 30 s wait for six exchanges' lists sat inside the default 5 s limit; Bitstamp's list alone took 2.2 s | Fixed: 60 s |
| Live: Kraken's quote, Bitstamp's weekly bars | "unreachable (fetch failed)" | A passing network hiccup; the gateway didn't ask a dropped connection again, and a chart would have shown the same error | Fixed: a dropped connection is asked again after 0.5 s and 1.5 s, for every exchange (not after a timeout or an answer) |
| Live: Binance COIN-M open interest | Steps of 10 and 15 minutes | Binance's live API left points out; its archive has all 288 a day (6 to 9 November, measured); our series fills them from the archive a day on, at the gateway's next start (SPEC §11, item 136) | Fixed: the test takes whole 5-minute steps |

The other 73 live tests passed, the 30 s outage on all six exchanges among them. The web half of `pnpm test:live` runs after the gateway half passes, so it hasn't run yet.

**Checks (cloud):** typecheck and lint clean; the unit tests pass four times in a row (core 350, indicators 78, Pine 409, chart 100, web 228, gateway 576); the six retry tests (three in `http.test.ts`, two in `binance-rest.test.ts`, and Bybit's outage in `catalog-sources.test.ts`) fail without the retry, and the one for a timeout or an answer fails when every error is asked again. Bybit's outage test was the only one the retry slowed (it sat through the real waits, 2 s); it now runs them on the fake clock, in 8 ms. The live tests can't run in the cloud (Binance's futures API answers 451 there; the spot exchanges aren't allowed): the Mac's next `pnpm test:live` is their check.

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
- **Test counts on 18 November:**
  - core 350, indicators 78, pine 457, chart 109, web 249;
  - gateway 576 (plus 77 that need the live internet);
  - browser 256 (13 visual, 5 performance among them), as the Mac counted them;
  - lint and typecheck clean.
- **Known flaky tests:** none in the unit tests since 10 November (Bitstamp's polling test was fixed: §2j). In the cloud, the gestures test's 1 px flick now and then. Symbol Search's Enter tests failed now and then on a real bug, fixed on 18 November (§2q).
- **The perf tests** draw on the GPU, one at a time, and print the renderer they drew with (§2k). In the cloud they draw in software and miss some budgets, as before.
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

- **Two browser tests timed out once at the start of a cloud run** (26 November): the heavy-script alert and Bitstamp's source filter, both passing on a rerun; their cause isn't found (SPEC §11, item 178). If either fails again, measure its timing first.
- **Making any TradingView script run here:** the roadmap, A to F, in the final hand-over above (SPEC §8, "Any script"; §11, items 149 to 154).
- **Drawing tools (D1 to D3a):** the looks TradingView doesn't document, or your screenshots don't show, are provisional (SPEC §11, items 155 to 158 for D1, 161 to 170 for D2 (161 settled by your screenshot of 26 November, §2v), 171 to 177 for D3a: the drawings' menu, Send to back under the candles, the selection's rules, where a clone and a paste land, Remove leaving locked drawings, the arrows' steps, several in the floating toolbar and Settings); a removed indicator's drawings can come back on a re-added one before their symbol loads (item 159, with D3c's Object Tree); a script's drawings between bars sit at the pane's left edge (item 160), found, not fixed. D3b to D6 are planned (SPEC §8).
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
- **GitHub's merge commits:** merging on GitHub made `9324baa` (pull request #1), `6c403cb` (#2), `4295233` (#3), `684091e` (#4) and every merge since (#5 to #20, `8dab233` the latest), with GitHub as committer and +0530, the time zone the 26 October rewrite took out. They're public on `main`, so the identity check (AGENTS.md, "Git") prints a second line, which no push of ours adds. How merges should go is the user's call, from the options given on 26 October: fast-forward `main` from the Mac with a bypass of the ruleset for the user alone, accept GitHub's commits in the docs, or try merging from a browser set to UTC (GitHub doesn't document which time zone it stamps).
- **Free limits that can change:** CoinGecko's 10,000 calls a month, Live Coin Watch's 10,000 requests a day. CoinDesk reportedly ended its free plan in 2026.
- **Indicators (I1):** every look not measured from a screenshot is provisional (SPEC §11, items 62–63 and 70); TradingView's tick volume for TOTAL isn't ours (item 68); the sentence-case title waits on the user (item 73). RSI's Timeframe came with P4 (item 71), the Source code button with P1 (item 72).
- **Pine (P1, P2):** the editor's look is provisional until the screenshots in SPEC §11, item 74; the built-in RSI's smoothed MA waits on the user (item 76); P2's provisional looks are items 89 to 103.
- **Requests and open interest (P4):** open interest's units and history depth wait on the user's word (§3; SPEC §11, items 113 and 115); it isn't listed in Symbol Search yet (item 111); the ring's and the symbol field's look wait on a screenshot (item 107); the top bar's pill cuts names as long as `BTCUSDT.P_OI` (item 118).
- **The Mac's visual baselines:** renewed on the Mac and merged as pull request #10 (§2j). Popups at fractional positions blend their edge pixel with the chart (the Gestures popup): snapping them to whole pixels waits for the next visual change.
- **Pushing from the Mac:** works since 10 November (`gh auth login`); #10 was pushed from it.
- **Performance:** the perf tests now draw on the GPU (§2k); whether the Mac's headless browser takes it waits on its next `pnpm verify` (the "Renderer:" line). Drawing RSI's gradient fills only where they show is for later (SPEC §11, item 137).
- **Scripts on long histories:** since step 2 they run in workers of their own, and the page never waits on them (§2m). What's left:
  - older bars wait for their values while the worker runs the script again over every bar (2.3–2.4 s on 4h with VuManChu B, in the cloud). Steps 3, 3b and 3c keep the requested contexts a fresh run would give again (§2o, §2p). What still runs again at every load: the script itself over every bar, and on a live chart each context with requests inside it that had a live update (SPEC §11, items 138 and 143);
  - the page's own drawing of a script's many lines, 6.7–7.4 s in all while zooming out with VuManChu B in the cloud, in steps under 0.5 s, most of it Chrome drawing in software for want of a GPU; the Mac's numbers are to measure (item 138);
  - alerts' scripts ran in the page until step 2b (§2n; item 140); a tick that comes while an alert's script runs afresh a second time at its start doesn't alert (provisional, item 142);
  - Lightweight Charts 5.3.0 fixes the bug the invisible series works around; the upgrade waits on your YES (item 139).
- **Symbol Search's Enter before its results are in:** fixed (§2q). Its waiting, its dropping on more typing and nothing on a failed search are provisional, as TradingView doesn't document them (SPEC §11, item 144). After a failed search the list before stays on screen without the error, as before.
- **A script waiting for its contexts:** its live bar waits with it while they page back, a second or two in the cloud (provisional, SPEC §11, item 148).
- **Found while checking VuManChu B against your screenshot (17 November), recorded, not built (now in the roadmap's A; item 146 waits on a screenshot):** an input whose default is outside its `minval`/`maxval` is moved into range here and kept as written on TradingView, which changes VuManChu B's RSI line colors (SPEC §11, item 145); a script pane's price-scale labels are whole numbers on TradingView and decimals here (item 146); its chained requests are evaluated as dynamic requests are, where TradingView passes a value in for a v4 script (item 111). Found reading the code: an inner context's warm-up verdict doesn't reach the context that asks for it (item 147).
- **Open interest's archive pass** runs once per gateway start, so points Binance's live API left out fill in at the next start after Binance publishes that day (SPEC §11, item 136).
- **Price alerts:** whether Greater Than and Less Than trigger at once when the price is already past the value, and how often Every time triggers, wait on a check against TradingView (SPEC §11, item 135); the dialog's look waits on a screenshot.
- **Step 4 (alerts, non-standard data):** alerts run only while the app is open and live in this browser (SPEC §11, item 133); the non-standard bars' undocumented choices (item 130); a strategy's last bar of a session closes when the next opens (item 131); the alert UI and its defaults wait on screenshots (item 133, SPEC §7.7).

## 9. Next steps, in order

**1. The pitchfork fix's pull request** (the lines from point 1, §2v), once it's committed; the user merges it on GitHub. Then D3b, planned (templates, a tool's last style, favorites), on its own YES. #23, D3a, was merged on 26 November; #22, D2, the same day; #21, D1, on 25 November; #20, the alert chime's fix, on 19 November; #19, the final hand-over, on 18 November; #18, Symbol Search's Enter, the same day; #17, steps 3b and 3c and the wait for contexts, on 17 November; #16, step 3, the same day; #15, step 2b, on 16 November; #14, step 2, the same day; #13, step 1, too; #12, the perf tests on the GPU, on 15 November; #11, #10 and #9 on 10 November.

**2. On the Mac, after merging it and pulling `main`** (none of this can be done in the cloud):
1. Restart `pnpm dev`. There are no new dependencies since P1; run `pnpm install` first only if it hasn't run since then.
2. Renew the visual baselines, which D1 changes: `pnpm exec playwright test visual --update-snapshots` in `apps/web`, then look at each new image before keeping it. Each should differ from the last only by the drawings toolbar at the chart's left and Undo and Redo after Alert in the top bar.
3. The user's VuManChu B, one copy and then two, on XRPUSDT 1D and on a 4h chart, scrolled and zoomed far back: no "Page Unresponsive" and no stops of seconds. While a copy calculates the first time its legend row shows the loading ring, and older bars get its values a few seconds after they appear (§2m), the same values as before step 3 (§2o, §2p), and its last bar's values follow each live tick, but for a second or two while its contexts page back after a zoom (§2p). Then an alert on it (the top bar's Alert, on VuManChu B, one of its conditions): creating it, and opening the app with it, holds the page no more than the chart does, and it triggers as before (§2n). If the chart still stutters while zooming, say how much: in the cloud, drawing its 34 lines in software still blocks the page 7 s in all, in steps under 0.5 s, and the Mac draws on its GPU.
4. `pnpm verify`. It should pass in full, D1's 25 drawing tests, D2's 12 and D3a's 14 among the rest. On 18 November it passed but for the heavy-script alert's test, on the alert's chime (§2r), and the perf tests didn't run, as they wait for the others. The perf tests now draw on the GPU, one at a time: their "Renderer:" line should name the Mac's GPU (Apple's, through ANGLE's Metal renderer), not SwiftShader. If it says SwiftShader, send the output: the fallback is to run the perf tests in a window, which drew every 8.3 ms on 10 November. A visual test that fails: look at its `-diff.png` under `apps/web/test-results/visual-…/` before anything else.
5. `pnpm test:live`: the gateway half, then the web half, which runs only after the gateway half passes. A failure there: send its output.
6. A read-only check against the running app (AGENTS.md): http://127.0.0.1:5180 opens the app (§2h); the user's OI script on BTCUSDT 1h, its values against TradingView's at a few hours. The first daily load of `BINANCE:BTCUSDTPERP_OI` waits about 2.5 minutes while Binance's archive downloads into `data/oi/`; later loads are instant.
7. The hand checks against TradingView: D1's, side by side with TradingView on the same symbol (each Lines tool drawn, moved and edited; the magnet; Shift's 45°; the floating toolbar; the settings dialog's four tabs; text on a line; an Info line's stats; drawings kept after a reload and on another interval); D2's the same way (each channel and pitchfork on the same points as TradingView's, their handles, settings and fills; a regression trend's lines and Pearson's R over the same range; dragging among a chart full of them, to see whether the Mac's GPU paints the bands fast, §2t); D3a's the same way (⌘ + click and a ⌘ box; moving, cloning and removing several; the right-click menu and the ⋯ menu, each item; Send to back over candles; Intervals visibility on two intervals; ⌘C and ⌘V on another symbol; the arrows; and the four checks by hand in §2u); I1's H1–H7 (SPEC §9, with the screenshots in SPEC §11, item 62); P1's (SPEC §5.16, "Done when": RSI's copy reads as the built-in, a script of the user's runs as on TradingView); P2's 10 scripts, and the user's Ichimoku with `JollyWizard/lib_hlm/1` pasted through "Add library…" (SPEC §5.17); the user's VuManChu B on BTCUSDT 4h (§2c); a drawing script's labels, lines, boxes and tables beside TradingView's (§2d); a strategy's List of Trades and Performance Summary beside TradingView's Strategy Tester on the same symbol and timeframe (§2e); an alert on a script with `alert()` and one with `alertcondition()`, created on both, triggering on the same live bars with the same messages; a Crossing Up price alert just above the live price on both, triggering together, and a Greater Than one made below the price, to see whether TradingView's triggers at once (SPEC §11, item 135); a `request.security(ticker.renko(…))` plot (and Kagi, Line Break, P&F) beside TradingView's (§2f); Symbol Search beside TradingView's, typing a symbol and pressing Enter at once, in the chart's search and in Add symbol: it shows or adds what was typed, and with nothing matching Enter does nothing (§2q); and an alert with Play sound, after a click on the page: it chimes as before, and the chart doesn't stop as it plays (§2r).

**3. The drawing tools' next milestones, D3b to D6** (SPEC §8: D3b, templates, a tool's last style and favorites, next; then D3c, the Object Tree; each researched in SPEC §4.27), **and the Pine roadmap, in order** (the final hand-over above; SPEC §8, "Any script", A to F), each researched first and built on its own YES. The roadmap: A, the values that differ from TradingView's (SPEC §11, items 145, 111, 147 and 154); B, TradingView's newer Pine (items 149, 150 and 141); C, the behaviors not built (items 122, 129, 100 and 151); D, data, compared across providers first (item 149); E, built-in indicators (item 152); F, speed after the Mac's numbers: RSI's fills (item 137), long histories (138), Lightweight Charts 5.3.0 with the visual baselines checked on the Mac (139), contexts with requests inside kept after live updates (143). A pane's scale labels (item 146) wait on a screenshot.

**4. Screenshots from TradingView that would settle the provisional looks and units:** for managing drawings, the four in §2u (SPEC §11, items 171 to 177); for the channels and pitchforks, the five in §2t (SPEC §11, items 161 to 170); for the drawing tools (SPEC §11, items 155 to 158), a selected and a hovered Trendline with its floating toolbar, an Info line, a Trend angle, the settings dialog's four tabs, text on a horizontal line in each alignment, and the cursors; plotshape at each size (SPEC §11, item 89); the Pine Logs pane, the editor at the bottom and Convert code to v6 (items 101 to 103); a script loading another symbol and an `input.symbol` field (item 107); the open interest symbols with a value at a date (item 113), which would also show how TradingView's header fits a long name (item 118); a script's labels, boxes and tables, to measure their sizes and padding (item 123); TradingView's Strategy Tester and a strategy's trade markers in the dark theme (item 128); the Create Alert dialog on a script and on a price, the alert manager with an alert and its log, and an alert's pop-up (items 133 and 135); a Renko, Kagi, Line Break and P&F request plotted on a chart, with the bars' dates (item 130).

**5. M9f** (on the Mac: the download runs on its gateway, and the ruler needs macOS's `sips`):
1. Size step 2b and tell the user how many requests it needs.
2. Let the download finish, then run `tools/accuracy/check.sh`.
3. Report the result year by year, then ask YES to switch M9f on in the charts.
4. Update SPEC (§5.14 status, §8, §11) and this file, then ask YES to commit, and again to push and open a pull request.

**6. Then the plan's next milestones** (SPEC §8): the channel and Moving price conditions, and indicator, drawing and watchlist alerts; the chart types themselves (Renko and the rest on the chart); the strategies' Properties tab and `calc_on_order_fills` (SPEC §11, item 129); the open items P2 and P4 left (SPEC §11, items 100, 111 and 122); Phase 3 (Kraken's history files); and the user's list above.
