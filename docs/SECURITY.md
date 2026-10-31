# tradingNerd security

tradingNerd runs on one person's Mac, for that person only.
- **The rule (the user's, 26 October 2026):** no personal data or information leaves their computer, except what each data provider needs to answer.
- **What this file covers:** what may leave and what may not, how keys are kept, the rules for AI agents, and the checks to run again before every hand-over.

## What leaves the Mac, and where to

| Goes to | What it carries | Why |
|---|---|---|
| Binance, Bybit, OKX, Coinbase, Kraken, Bitstamp | The symbols and intervals asked for; no key, no account | Prices and candles |
| CoinGecko (`api.coingecko.com`, `pro-api.coingecko.com`, and the images at `coin-images.coingecko.com` and `assets.coingecko.com`) | The user's CoinGecko key (a request header), coin ids | Logos, CRYPTOCAP's coins |
| Alpaca (`data.alpaca.markets`, `api.alpaca.markets`, `paper-api.alpaca.markets`, `stream.data.alpaca.markets`) | The user's Alpaca key ID and secret (request headers, the stream's sign-in), stock symbols | US stocks |
| Nasdaq Trader (`www.nasdaqtrader.com`) | Nothing: a download of the public symbol directory | Stock search |
| Live Coin Watch (`api.livecoinwatch.com`) | The user's Live Coin Watch key (a request header), coin codes and dates | Older market caps |

That is the whole list. Each provider also sees the Mac's IP address and which symbols are looked at; live data can't be fetched without that.

**Never leaves:** the watchlists, flags, chart settings, the downloaded history, the keys (except each to its own provider), the user's Pine scripts (My scripts and their versions in `data/scripts.json`, and the open script's unsaved code, kept in the browser), and anything in `data/`. ETH Zurich's dataset is put in place by hand; the app never contacts Zenodo.

## How the app keeps it so

- **Not reachable from the network.**
  - The gateway (5180) and the web app (5173) listen on 127.0.0.1 only.
  - Every gateway request, REST or WebSocket, must carry a loopback `Host`, and an allowed `Origin` if any. That shuts out other websites and DNS rebinding (`apps/gateway/src/security.ts`).
  - No CORS headers are sent.
- **Keys:**
  - **Where they're kept:** in `data/secrets.json` (owner-only, `-rw-------`, in an owner-only `data/`), or in the environment (`COINGECKO_API_KEY`, `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `LIVECOINWATCH_API_KEY`).
  - **Saving one:** a key is checked with its provider before it's kept.
  - **The browser:** gets a key only masked (`••••` and the last four), and never stores one; the browser tests check that.
  - **On the wire:** keys go only in request headers, each to its own provider, never in a web address.
  - **Logs:** no log line prints a key, and logs stay on the user's terminal, at "warn" level.
- **The browser loads nothing from outside.** No web fonts, CDNs, analytics or trackers. Logos are fetched by the gateway, only from CoinGecko's two image hosts, and served from `data/logos/`. Outside links open only when clicked, without a referrer (`rel="noopener noreferrer"`).
  - **The Pine Editor** (P1) is Monaco, installed as a package (`monaco-editor`, Microsoft's, MIT) and bundled with the app: its code, worker, styles and icon font come from the web app's own server, never from Monaco's CDN.
  - **Pine scripts run in the browser,** in our own engine (`packages/pine`): a script can read only the chart's bars and the symbol's details, and has no way to reach the network, files or the page. A runaway loop stops at 500 ms per bar.
- **No telemetry** in the code or its dependencies.
- **Git:**
  - `data/`, `.env` files and test output are ignored (`.gitignore`), and `data/` has never been committed.
  - Every commit carries only `Debasis <30506767+iamdebasis@users.noreply.github.com>` (GitHub's private address) and times in UTC. The history was rewritten on 26 October, before the first push, to take out a personal email and the local time zone.
  - The TradingView reference screenshots have the user's name and avatars painted over; they still show which coins are on the user's watchlists.
  - The keys in tests are made up (`PKTEST…`, `a1b2c3d4-…`).
  - The repository's home: https://github.com/iamdebasis/TradingNERD, public.

## Rules for AI agents

- **Never print, log, commit or copy a key,** not even its masked last four characters. Never put one in a chat, an issue or a document.
- **Don't open `data/secrets.json`,** not even to list its entries. To learn whether a key is set, ask the gateway: `GET /api/stocks/key`, `/api/logos/status`, `/api/older-caps`.
- **The user's Live Coin Watch key is also in `~/.tradingnerd-lcw-key`** (owner-only), for research. Read it only inside a script, use it only with Live Coin Watch, and never print it. To check that a key appears nowhere it shouldn't, compare inside the script and print only "yes" or "no".
- **Never copy `data/secrets.json` anywhere.** A gateway of your own gets `DATA_DIR` set to a copy of `data/` made without it.
- **Publish nothing from this project:** no web pages, shared documents or uploads. Research may read public pages, and must send no personal data.
- **Commit only as the project's identity, in UTC** (AGENTS.md, "Git"), and check before any push. Never put a personal email, name, home folder or time zone into a commit or a file.
- **Screenshots** added to the repository have account names, avatars and anything identifying covered first. Keep the pixels the tests measure, and prove nothing else changed.
- **Never get around a block** (bot checks, rate limits, refused requests). Back off, or ask the user.
- **Live checks against the user's app are read-only** (AGENTS.md). `data/scripts.json` holds the user's own scripts: a check never saves, renames or deletes one (the browser tests fake `/api/scripts`).

## Checks to run before a hand-over

```sh
# Who can reach the servers: both must show 127.0.0.1.
lsof -nP -iTCP:5173 -iTCP:5180 -sTCP:LISTEN

# Which hosts the code talks to: compare with the table above.
grep -rhoE "(https|wss)://[a-zA-Z0-9._-]+" apps/gateway/src apps/web/src apps/web/index.html packages/*/src | sort | uniq -c

# Where keys go: only into request headers to their own provider.
grep -rnE "x-api-key|x-cg-(demo|pro)-api-key|APCA-API-(KEY-ID|SECRET-KEY)" apps/gateway/src

# Permissions: owner-only.
stat -f '%Sp %N' data data/secrets.json

# Never committed, and pushed only to GitHub.
git log --all --oneline -- data/ | wc -l     # 0
git remote -v                                # only origin, https://github.com/iamdebasis/TradingNERD

# Only the project's identity, as author and committer, in UTC, before any push.
git log --all --format='%an <%ae> %ad|%cn <%ce> %cd' --date=format:%z | sort -u
```

Also:
- Scan every commit and the uncommitted files for key-shaped strings: CoinGecko's `CG-…`, Alpaca's `PK…`/`AK…`, and UUIDs. Only the tests' made-up ones may appear.
- Read the answers of the key routes on the running gateway. Each must show only a masked value.

## If a key leaks

1. Revoke it on the provider's site at once: CoinGecko's developer dashboard, Alpaca's dashboard, or Live Coin Watch's API page.
2. Put a new one in its dialog: the coin-logo dialog for CoinGecko, "US stocks" for Alpaca, "Older market caps (Live Coin Watch)…" for Live Coin Watch.
3. If it reached a commit that was pushed, it's public: the repository is public, and copies and caches outlive a rewrite, so revoking it is what protects it. If the commit was never pushed, rewrite it before pushing anything.

## Last audit

26 October 2026, by the AI lead, against the code, the user's running app and the whole git history. Every point above held:
- 28 commits and 26 uncommitted files had no real key.
- The key routes answered with masked values only.
- The user's shell history held no key.
- **Before the first push** (the same day): all 29 commits were rewritten to the project identity with times in UTC. The name and avatars in two screenshots were covered, with no other pixel changed. The time zone was taken out of `HANDOVER.md`, and the old copies were deleted (a backup stayed outside the repository until the user confirmed). Then all 1,406 objects in the repository were searched: no personal email, name, home folder, Mac name, time zone or key. The 65 browser tests that read the screenshots pass.
