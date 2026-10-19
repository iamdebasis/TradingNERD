import { type BarsResponse, barCloseTime, barOpenTime, type Resolution } from '@tradingnerd/core';

/** A bar this long after its close is final: the exchanges' late final candles have arrived. */
export const FINAL_AFTER_MS = 15_000;
/** How long a latest page is answered again, within its live bar. */
export const LATEST_TTL_MS = 10 * 60_000;
/** How long a page of older, closed bars is kept. */
export const OLDER_TTL_MS = 30 * 60_000;
/** Pages kept, the least recently used dropped first. */
export const MAX_PAGES = 64;
/** Bars a latest page may fall behind and still be brought up to date with its newest bars. */
const MAX_CATCH_UP = 500;

interface Page {
  response: BarsResponse;
  /** When its bars were fetched. */
  fetchedAt: number;
}

/**
 * Recent history pages, so going back to a chart is instant. A final bar never changes, so a
 * latest page is answered again while only its live bar is out of date; the chart's live feed
 * replaces that bar as soon as it subscribes. Once newer bars exist, just those are fetched.
 * Older pages are kept for a while too. Callers must not change the pages they get.
 */
export class HistoryCache {
  private readonly pages = new Map<string, Page>();
  private readonly inFlight = new Map<string, Promise<BarsResponse>>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The latest `count` bars, the live one last; `load(n)` fetches the latest n. */
  latest(
    key: string,
    resolution: Resolution,
    count: number,
    load: (n: number) => Promise<BarsResponse>,
  ): Promise<BarsResponse> {
    return this.once(key, async () => {
      const now = this.now();
      const page = this.get(key, LATEST_TTL_MS, now);
      if (!page) return this.put(key, await load(count), now);

      const liveOpen = barOpenTime(resolution, now);
      // Bars opening from here on may have changed after the page was fetched.
      const unsettled = barOpenTime(resolution, page.fetchedAt - FINAL_AFTER_MS);
      if (unsettled === liveOpen && page.response.bars.at(-1)?.time === liveOpen / 1000) {
        return page.response;
      }
      const behind = barsFrom(resolution, unsettled, liveOpen, MAX_CATCH_UP);
      if (behind === null) return this.put(key, await load(count), now);
      const newest = await load(behind + 2);
      const first = newest.bars[0];
      if (!first || first.time * 1000 > unsettled) return this.put(key, await load(count), now);
      const bars = [...page.response.bars.filter((bar) => bar.time < first.time), ...newest.bars];
      const trimmed = bars.length > count;
      const response = {
        bars: trimmed ? bars.slice(-count) : bars,
        hasMore: page.response.hasMore || trimmed,
      };
      return this.put(key, response, now);
    });
  }

  /** A page of older bars; kept for a while once all of them are final. */
  older(
    key: string,
    resolution: Resolution,
    load: () => Promise<BarsResponse>,
  ): Promise<BarsResponse> {
    return this.once(key, async () => {
      const now = this.now();
      const page = this.get(key, OLDER_TTL_MS, now);
      if (page) return page.response;
      const response = await load();
      const last = response.bars.at(-1);
      if (!last || barCloseTime(resolution, last.time * 1000) <= now - FINAL_AFTER_MS) {
        this.put(key, response, now);
      }
      return response;
    });
  }

  /** Identical requests at the same time share one fetch. */
  private once(key: string, run: () => Promise<BarsResponse>): Promise<BarsResponse> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const promise = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private get(key: string, ttlMs: number, now: number): Page | undefined {
    const page = this.pages.get(key);
    if (!page) return undefined;
    this.pages.delete(key);
    if (now - page.fetchedAt >= ttlMs) return undefined;
    this.pages.set(key, page); // most recently used
    return page;
  }

  private put(key: string, response: BarsResponse, fetchedAt: number): BarsResponse {
    this.pages.delete(key);
    this.pages.set(key, { response, fetchedAt });
    for (const oldest of this.pages.keys()) {
      if (this.pages.size <= MAX_PAGES) break;
      this.pages.delete(oldest);
    }
    return response;
  }
}

/** How many bars open from `from` to `to` (both bar opens, inclusive); null past `limit`. */
function barsFrom(resolution: Resolution, from: number, to: number, limit: number): number | null {
  let count = 1;
  for (let open = from; open < to; open = barCloseTime(resolution, open)) {
    if (++count > limit) return null;
  }
  return count;
}
