# AGENTS.md: tradingNerd

Instructions for AI coding agents working in this repository (Claude Code, Codex, Cursor, Copilot, Gemini CLI and the like). They apply to every task. The user's own words in the chat override them.

## Read first, in this order

1. **This file:** the rules and how to work with the user.
2. **[CLAUDE.md](CLAUDE.md):** the user's five core values. They're copied below.
3. **[docs/HANDOVER.md](docs/HANDOVER.md):** where the work stands, what's under way, and what's next.
4. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):** how the code fits together.
5. **[docs/SECURITY.md](docs/SECURITY.md):** read it before touching keys, network calls or `data/`.
6. **[docs/SPEC.md](docs/SPEC.md):** the source of truth, found by its sections:
   - §3: decisions, with their reasons and dates
   - §4: research
   - §5: requirements
   - §6: architecture in detail
   - §7: the visual spec
   - §8: the delivery plan
   - §9: tests
   - §11: open questions and provisional choices
   - §12: references

## The project

tradingNerd is a local clone of TradingView's chart page, for one user on their own Mac: a chart, a watchlist, symbol search and TradingView's gestures.
- **Goal:** it looks and feels identical to TradingView, or better.
- **Data:**
  - free public exchange APIs: Binance, Bybit, OKX, Coinbase, Kraken and Bitstamp;
  - US stocks from Alpaca (the user's free key);
  - coin logos and market caps from CoinGecko (the user's free key);
  - older market caps from Live Coin Watch (the user's free key) and ETH Zurich's dataset.
- **Nothing is hosted.** A local gateway (Node) serves a local web app (React). Both listen on 127.0.0.1 only.

## Core values (binding)

Copied word for word from [CLAUDE.md](CLAUDE.md), which is the original. Change both together, and only with the user's YES.

> tradingNerd is a local clone of TradingView. It should look and feel identical to TradingView, and the user wants a perfect product, maybe better than TradingView. These five core values apply to every task in this repo, in this order.
>
> ### 1. YES before any change
>
> Do not build, edit, install or otherwise change anything in this repo until the user answers YES to a specific yes/no question that names exactly what will change.
>
> - A YES covers only the step it was asked about. Ask again before the next one.
> - Committing and pushing need their own YES.
> - These need no YES: research, reading code, read-only checks, and notes kept outside the repo.
>
> ### 2. Work in roles
>
> Every task is planned and built by these leads, in this order:
>
> 1. **Lead Product Manager:** scope, user stories and acceptance criteria, checked against `docs/SPEC.md`; what's in and what's left for later.
> 2. **Lead Tech Architect:** the design (data, components, edge cases, risks), then the build.
> 3. **UI/Art Lead:** the look and feel, measured from TradingView's screenshots: sizes, colors, states (hover, drag, focus), icons and motion, with pixel checks against the references.
> 4. **Proper testing:** unit, integration and end-to-end tests, plus a real check against the running app.
> 5. **Lead Delivery Engineer:** the order of work and its risks, then the hand-over with the test evidence and an honest account of what is and isn't done. Report failing tests and skipped steps plainly.
>
> ### 3. Deep-dive research first, never guess
>
> Before planning or building anything, do a proper deep dive into how TradingView does it, and read our own requirements. Understand the feature fully before proposing it, building it or asking the user for a screenshot.
>
> - Cover the whole feature area, not only the part asked about (deleting sections also means moving and folding them).
> - Search everything that helps: TradingView's help center, blog, release notes, Charting Library docs, forums and communities, videos, and guides in other languages. Re-check the screenshots the user has already sent. Cite sources, and keep TradingView's own apart from third-party ones.
> - Read our own requirements: `docs/SPEC.md` (decisions, requirements, open items) and the code the feature touches.
> - Ask the user only for what is still unknown after that. Say what was searched, and don't block on the answer.
> - If TradingView doesn't document a behavior, say so plainly. Ship it marked provisional, then calibrate it by measuring the user's own screenshots.
> - Read TradingView's public pages, but never script or automate tradingview.com.
>
> ### 4. Core values first
>
> Before implementing any feature, go through values 1–3. Show the user a short check at the top of the proposal or build plan:
>
> - **YES:** the YES in hand, or the question being asked.
> - **Roles:** each lead's plan: product, architecture, UI/art, tests and delivery.
> - **Research:** the deep dive (TradingView's sources and our SPEC), with sources, and what is still unknown.
> - **Data:** for chart integrations, the providers compared (history depth and accuracy; free, free key or paid) and the one chosen (value 5).
>
> If any value isn't met yet, stop and meet it first.
>
> ### 5. The best data for every chart
>
> Every chart integration (a token, a symbol, an index such as TOTAL) gets the most accurate and longest history we can find. Before building one:
>
> - Compare providers on history depth and accuracy, free ones first, measured from this machine against TradingView's own numbers and depth.
> - Say which need a free API key, and what a paid tier would add.
> - Use official APIs and data the provider allows. TradingView is the benchmark, never the source (value 3).

## The user's standing rules

The user gave these during the work; they bind as the core values do.

### Data on the charts

- **Never show wrong data.** When ours differs from TradingView's, fix the cause (the source, the definition or the method), not the number. A3 tried hiding unchecked coins instead and was taken out.
- **Never hide data.** Every chart shows everything its providers give, over its whole history, at every interval. Nothing is cut to a date it was checked from.
- **When a provider's own figure differs from TradingView's,** raise it with the user rather than choosing between the two rules alone. An example is CoinGecko's HYPE supply, 12% below TradingView's.
- **"Minor data glitches are fine"** was the user's word on 26 October 2026 for Live Coin Watch's older totals (M9e). It isn't a general licence.
- **Measure, don't guess.** TradingView's undocumented behavior ships marked provisional (SPEC §11), then gets calibrated from the user's screenshots, which are Display P3. Say exactly what was compared, and over which dates.
- **TradingView is the benchmark, never the source.** Never script or automate tradingview.com, and never use its "export chart data". Its public pages may be read.
- **Don't get around blocks or bot checks.** Zenodo turns programs from this network away, so ETH Zurich's files were placed by hand.

### Working with the user

- **Work as Lead Architect and Lead Delivery Engineer.** Decide with reasons, own the design and the delivery, and don't make the user repeat themselves.
- **Plans and build reports start with the core-values check** (YES, Roles, Research, Data) and end with **one specific YES question** that names exactly what will change.
- **Write in plain words:** short sentences, tables for numbers, what was measured and how. The user replies briefly ("YES GO AHEAD"). Say plainly what failed, what was skipped and what's provisional.
- **Hand-overs** carry the test evidence and an honest status. The user often asks for "the update": answer with what's done, what's running and what's next.

### Git

- **Work comes as pull requests.** Each task is done on a `claude/…` branch, pushed, and opened as a pull request into `main`; the user merges it on GitHub. `main` is protected by a ruleset, so nothing is pushed to it directly. `m7-us-stocks` is kept as a historical branch; no new work happens there.
- **Commit only on a YES, and push and open the pull request only on their own YES.** The repository's home is https://github.com/iamdebasis/TradingNERD, and it's public: anything pushed is published.
- **Commit as the project's identity only:** `Debasis <30506767+iamdebasis@users.noreply.github.com>`, GitHub's private address, set in this repository's `.git/config` on the user's Mac. A fresh clone (a cloud session) has none. Never use a personal email, and never set an identity without asking.
- **Commit times in UTC:** commit with `TZ=UTC` (`TZ=UTC git commit …`), so no commit carries the local time zone.
- **Before any push,** check that `git log --all --format='%an <%ae> %ad|%cd' --date=format:%z | sort -u` shows only that identity and +0000.
- **Commit messages:** a subject naming the milestones ("M9e, A2, A6: older market caps back, OTHERS as TradingView's, formula weeks from days"), a blank line, then dash bullets of what changed and why, then your tool's co-author trailer, if it uses one.

### The user's running app

- **The user runs `pnpm dev`:** the gateway on 127.0.0.1:5180 under `node --watch`, and the web app on 127.0.0.1:5173.
  - **Never stop or kill it.**
  - **Editing a gateway source file restarts it,** and long downloads carry on from their last save. While one runs, batch your gateway edits.
  - **Servers you start yourself stop with your session,** so the user should start `pnpm dev` themselves.
- **Live checks against the user's app are read-only:**
  - GET requests only; writes are intercepted (watchlists, flags, keys, logo syncing).
  - Never modify `data/watchlist.json`, `data/watchlists.json`, `data/flags.json` or `data/secrets.json`.
  - Checksum them before and after (`shasum`).
- **The browser tests fake every write route,** so running them against the user's dev servers is safe. When `pnpm dev` isn't running, Playwright starts its own gateway on the real `data/`. The exchanges are pointed nowhere, but logo syncing uses the user's CoinGecko key (SPEC §11, item 57).
- **For a check that needs other settings,** start a gateway of your own:
  - on another port (`GATEWAY_PORT=5191`);
  - with `DATA_DIR` set to a copy of `data/` made without `secrets.json`;
  - and stop it after.

### Keys and personal data

Everything is in [docs/SECURITY.md](docs/SECURITY.md). In short:
- **Where keys live:** only in `data/secrets.json` (owner-only), or in the environment variables `COINGECKO_API_KEY`, `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` and `LIVECOINWATCH_API_KEY`.
- **Never** print, log, commit or copy a key, not even its masked last four characters. Never send one to the browser, which sees them masked.
- **Don't read `secrets.json`.** The user's Live Coin Watch key is also in `~/.tradingnerd-lcw-key`, for research; read it only inside a script and never print it.
- **No personal data leaves the user's Mac** except what each provider needs to answer (see SECURITY.md). Publish nothing: no pages, documents or uploads.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Installs the dependencies (pnpm workspace; Node 26, see `.nvmrc`) |
| `pnpm dev` | Gateway on 127.0.0.1:5180, web app on http://127.0.0.1:5173 |
| `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm test:e2e` | Each check on its own |
| `pnpm format` | Biome: formats and applies safe fixes |
| `pnpm verify` | Every check above: run it before every delivery |
| `pnpm test:live` | Opt-in checks against the real exchanges |
| `pnpm --filter @tradingnerd/gateway exec vitest run test/<file>` | One gateway test file |
| `pnpm --filter @tradingnerd/web exec playwright test tests/e2e/<file>` | One browser test file |
| `pnpm exec playwright test visual --update-snapshots` (in `apps/web`) | New visual baselines after an intended change: look at them first |

**In a cloud session** (Claude Code on the web, Linux):
- Put `/opt/node26/bin` first on PATH; the default `node` there is 22.
- `pnpm install`, `pnpm typecheck`, `pnpm lint` and `pnpm test` run as on the Mac.
- `pnpm test:e2e`, and so `pnpm verify`, don't run there yet, a known gap (the user's call, 26 October 2026):
  - the visual baselines are the Mac's (`*-darwin.png`), and Playwright would write Linux ones into the repository;
  - the browser installed there belongs to another Playwright version than ours.
- Report e2e as not run. The browser tests and the real check against the running app happen on the Mac.

## Code conventions

- **TypeScript everywhere.** The gateway runs as TypeScript directly on Node 26, with no build step; imports name their `.ts` files. Biome formats and lints: 2 spaces, single quotes, 100 columns.
- **Comments are plain English.** They say what something is and why, cite measurements with their dates ("measured 2026-10-25") and SPEC sections, and use TradingView's own terms (Chg%, sections, flags). Match the comment density of the code around you.
- **Tests:**
  - Vitest next to each package's code (`apps/gateway/test/`, `packages/*/src/*.test.ts`), named as sentences of behavior.
  - Playwright in `apps/web/tests/e2e/`, against a fake gateway (`fixtures.ts`).
  - Fakes live in `apps/gateway/test/helpers/`.
  - A regression test must fail without its fix: check that it does.
- **Data files** are written whole or not at all (`storage/jsonFile.ts`). One that can't be read is moved aside, never overwritten silently.
- **UI text** uses TradingView's wording. Measurements of TradingView's look are in SPEC §7, with its tokens.

## Definition of done

1. `pnpm verify` passes (in a cloud session, every check but e2e: see "Commands"). Rerun a known flaky test before reporting it: Bitstamp's "polls the live candle every 30 s" fails now and then under load.
2. A real check against the user's running app, read-only, with the numbers compared to TradingView's.
3. `docs/SPEC.md` updated: decision rows, research, requirements, architecture, tests, plan and open items.
4. `docs/HANDOVER.md` updated with the state and next steps.
5. The hand-over to the user, then a YES question to commit, and another to push and open the pull request.

## Where the work stands

See [docs/HANDOVER.md](docs/HANDOVER.md). As of 26 October 2026:
- **Committed:** M0–M9e, A1, A2, A6, and M9f's checkpoint, switched off in the charts. `main` is at `38e1ae9`, pushed and public.
- **Under way:** M9f's download (it pauses while the app is stopped). Its accuracy test waits for it.
