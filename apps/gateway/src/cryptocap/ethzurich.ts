import type { Anchor } from './anchors.ts';

/**
 * The ETH Zurich dataset of CoinMarketCap's daily figures (Wu, Wheatley and Sornette, Zenodo
 * record 4946058, CC0, docs/SPEC.md §4.14): 2,475 coins' market caps and closing prices, from
 * 28 April 2013 to 7 February 2018, dead coins too. Its market cap is the day's opening one
 * (00:00 UTC) and its price the day's close: Bitcoin's 52.5B on 15 September 2017 is 16.6M coins
 * at that day's open (3,166), not at its close (3,637) (measured 2026-10-26). So a day's point
 * pairs its market cap with the close the day before, and market cap ÷ price is the supply.
 */
export const ETH_ZURICH_URL = 'https://zenodo.org/records/4946058/files';
export const ETH_ZURICH_CAPS = 'market_cap_all_daily.csv';
export const ETH_ZURICH_CLOSES = 'close_price_all_daily.csv';
/** Coins ranked this high on some day are kept: the rest never reach a CRYPTOCAP symbol. */
export const DATASET_RANK = 200;

const DAY_SEC = 86_400;

/** One coin's days in the dataset. */
export interface DatasetCoin {
  /** CoinMarketCap's slug for it then ("binance-coin"). */
  slug: string;
  /** [time (UTC s, the day's 00:00), market cap, price], ascending, a point a day it has. */
  points: Anchor[];
}

/** A dataset file's columns: each slug's values by day (UTC s), from the wide CSV. */
function columns(csv: string): { days: number[]; values: Map<string, (number | null)[]> } {
  const lines = csv.split(/\r?\n/).filter((line) => line !== '');
  const header = (lines[0] ?? '').split(',');
  const slugs = header.slice(1);
  const values = new Map(slugs.map((slug) => [slug, [] as (number | null)[]]));
  const days: number[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const day = Date.parse(`${cells[0]}T00:00:00Z`);
    if (!Number.isFinite(day)) continue;
    days.push(day / 1000);
    for (const [i, slug] of slugs.entries()) {
      const value = Number(cells[i + 1] ?? '');
      values.get(slug)?.push(cells[i + 1] && Number.isFinite(value) && value > 0 ? value : null);
    }
  }
  return { days, values };
}

/**
 * The coins ranked in the top `rank` by market cap on some day, each with its days: the market
 * cap of the day, at its opening, and the close of the day before (CSV text of the two files).
 */
export function parseEthZurich(
  capsCsv: string,
  closesCsv: string,
  rank = DATASET_RANK,
): DatasetCoin[] {
  const caps = columns(capsCsv);
  const closes = columns(closesCsv);
  const closeIndex = new Map(closes.days.map((day, i) => [day, i]));
  const kept = new Set<string>();
  for (const [i] of caps.days.entries()) {
    const ranked = [...caps.values]
      .map(([slug, list]) => [slug, list[i] ?? null] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== null)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [slug] of ranked.slice(0, rank)) kept.add(slug);
  }
  const coins: DatasetCoin[] = [];
  for (const slug of [...kept].sort()) {
    const capList = caps.values.get(slug) ?? [];
    const closeList = closes.values.get(slug);
    if (!closeList) continue;
    const points: Anchor[] = [];
    for (const [i, day] of caps.days.entries()) {
      const cap = capList[i];
      const before = closeIndex.get(day - DAY_SEC);
      const price = before === undefined ? null : closeList[before];
      if (cap && price) points.push([day, cap, price]);
    }
    if (points.length > 0) coins.push({ slug, points });
  }
  return coins;
}
