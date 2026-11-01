# The Pine corpus check

Real Pine scripts through our engine, to measure what runs (docs/SPEC.md §4.17, §9).

- **What it reads:** TradingView's Pine manual examples, from the manual's GitHub mirrors, and eight community collections of open-source indicators on GitHub. The list is `SOURCES` in `corpus.ts`.
- **Where they go:** `tools/pine-corpus/.cache/`, which git ignores. Their licences don't let us publish them, so none is committed.
- **What it never does:** contact tradingview.com.

```sh
pnpm test:corpus                          # download if needed, run every script, report
node tools/pine-corpus/corpus.ts fetch    # download only
```

Each script compiles and runs over 600 made-up daily bars. The report gives:
- what share of each corpus runs;
- what share of the scripts that need only P2's features runs (no drawings, other symbols or strategies);
- what stops the rest.

Every script's result is written to `.cache/report.json`, with the commit of each source.
