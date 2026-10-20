import { readJson, writeJson } from '../lib/storage';

/** A letter typed on the chart opens symbol search with it, as on TradingView. */
export function searchKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  return /^[a-z]$/i.test(event.key) ? event.key : null;
}

/** TradingView's category chips we have symbols for, in its order. */
export const SEARCH_TABS = ['all', 'stocks', 'funds', 'crypto'] as const;
export type SearchTab = (typeof SEARCH_TABS)[number];

export const SEARCH_TAB_LABELS: Readonly<Record<SearchTab, string>> = {
  all: 'All',
  stocks: 'Stocks',
  funds: 'Funds',
  crypto: 'Crypto',
};

/** Where the chosen chip is remembered, as TradingView remembers it. */
export const SEARCH_TAB_KEY = 'tn.symbolSearch.tab';

export function loadSearchTab(): SearchTab {
  const saved = readJson(SEARCH_TAB_KEY);
  return SEARCH_TABS.includes(saved as SearchTab) ? (saved as SearchTab) : 'all';
}

export function saveSearchTab(tab: SearchTab): void {
  writeJson(SEARCH_TAB_KEY, tab);
}
