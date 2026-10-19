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

/** TradingView's category chips; v1 lists crypto only, so both show the same pairs. */
export type SearchTab = 'all' | 'crypto';

/** Where the chosen chip is remembered, as TradingView remembers it. */
export const SEARCH_TAB_KEY = 'tn.symbolSearch.tab';

export function loadSearchTab(): SearchTab {
  return readJson(SEARCH_TAB_KEY) === 'crypto' ? 'crypto' : 'all';
}

export function saveSearchTab(tab: SearchTab): void {
  writeJson(SEARCH_TAB_KEY, tab);
}
