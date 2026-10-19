import { type Bar, barOpenTime, type Resolution, resolutionDurationMs } from '@tradingnerd/core';
import { mapLimit } from './concurrency.ts';
import type { ExchangeAdapter } from './types.ts';

export interface History {
  /** Ascending by time. */
  bars: Bar[];
  /** False once the start of the exchange's history has been reached. */
  hasMore: boolean;
}

/** Parallel requests per history call; a slice is one request. */
const SLICE_CONCURRENCY = 6;

/**
 * Up to `count` native bars opening before `endMs` (the latest when null), one request after
 * another, each ending where the previous one began. Stops after `maxRequests` requests.
 */
export async function pageBack(
  adapter: ExchangeAdapter,
  ticker: string,
  resolution: Resolution,
  endMs: number | null,
  count: number,
  maxRequests = Number.POSITIVE_INFINITY,
): Promise<History> {
  const bars: Bar[] = [];
  let end = endMs;
  for (let requests = 0; bars.length < count; requests++) {
    if (requests >= maxRequests) return { bars, hasMore: true };
    const limit = Math.min(adapter.maxBarsPerRequest, count - bars.length);
    const page = await adapter.fetchBars(ticker, resolution, end, limit);
    const firstKnown = bars[0]?.time ?? Number.POSITIVE_INFINITY;
    const cutoff = end;
    const fresh = page.filter(
      (bar) => bar.time < firstKnown && (cutoff === null || bar.time * 1000 < cutoff),
    );
    bars.unshift(...fresh);
    const oldest = fresh[0];
    if (page.length < limit || !oldest) return { bars, hasMore: false };
    end = oldest.time * 1000;
  }
  return { bars, hasMore: true };
}

/**
 * `pageBack`'s bars. An exchange with a bar in every period (`gapless`) has its pages fetched
 * at once, as time slices, instead of one after another.
 */
export async function fetchHistory(
  adapter: ExchangeAdapter,
  ticker: string,
  resolution: Resolution,
  endMs: number | null,
  count: number,
): Promise<History> {
  const pages = Math.ceil(count / adapter.maxBarsPerRequest);
  if (!adapter.gapless || pages < 2 || resolutionDurationMs(resolution) === null) {
    return pageBack(adapter, ticker, resolution, endMs, count);
  }
  const history = await fetchSlices(adapter, ticker, resolution, endMs, count, pages);
  if (history.bars.length <= count) return history;
  return { bars: history.bars.slice(-count), hasMore: true };
}

/**
 * About `count` native bars opening before `endMs` (up to the live bar when null), fetched as
 * time slices in parallel; at most `maxRequests` slices. Exchanges serve fixed-length
 * intervals without gaps (Binance even returns seconds without trades), so slices of
 * `maxBarsPerRequest` bar lengths tile the range exactly. Calendar months page back instead.
 */
export async function fetchSlices(
  adapter: ExchangeAdapter,
  ticker: string,
  resolution: Resolution,
  endMs: number | null,
  count: number,
  maxRequests: number,
): Promise<History> {
  const barMs = resolutionDurationMs(resolution);
  if (barMs === null) return pageBack(adapter, ticker, resolution, endMs, count, maxRequests);

  const end = endMs ?? barOpenTime(resolution, Date.now()) + barMs;
  const span = adapter.maxBarsPerRequest * barMs;
  const slices = Math.max(1, Math.min(maxRequests, Math.ceil(count / adapter.maxBarsPerRequest)));
  const ranges = Array.from({ length: slices }, (_, i) => ({
    start: end - (i + 1) * span,
    end: end - i * span,
  }));
  const pages = await mapLimit(ranges, SLICE_CONCURRENCY, (range) =>
    adapter.fetchRange(ticker, resolution, range.start, range.end),
  );
  const bars = pages.toReversed().flat();

  const oldestStart = end - slices * span;
  const first = bars[0];
  let hasMore = true;
  if (adapter.gapless) {
    hasMore = first !== undefined && first.time * 1000 <= oldestStart;
  } else if (!first || first.time * 1000 > oldestStart) {
    // The oldest slice isn't full: either history starts there or there's a gap. One look tells.
    const before = await adapter.fetchBars(
      ticker,
      resolution,
      first ? first.time * 1000 : oldestStart,
      1,
    );
    hasMore = before.length > 0;
  }
  return { bars, hasMore };
}
