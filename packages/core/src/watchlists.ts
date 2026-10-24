import { parseWatchlist, type Watchlist } from './watchlist.ts';

/**
 * Several watchlists, as on TradingView: each with a name and its sections, one of them open.
 * The gateway keeps them (`data/watchlists.json`); the UI asks for the list of lists and for
 * one list at a time.
 */

export const MAX_WATCHLISTS = 200;
export const MAX_WATCHLIST_NAME = 64;

/** A list's name and whether it's starred (TradingView's favorites). */
export interface WatchlistMeta {
  /** Stable id: lowercase letters, digits and dashes. */
  id: string;
  name: string;
  favorite: boolean;
}

/** One line of the list of lists. */
export interface WatchlistSummary extends WatchlistMeta {
  /** How many symbols it holds. */
  count: number;
}

/** Body of GET /api/watchlists: every list, and which one is open. */
export interface WatchlistsIndex {
  activeId: string;
  lists: WatchlistSummary[];
}

/** Body of GET and PUT /api/watchlists/:id: one list with its sections. */
export interface NamedWatchlist extends WatchlistMeta, Watchlist {}

export const isWatchlistId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value);

/** A list's name, trimmed; null if empty or too long. */
export function parseWatchlistName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_WATCHLIST_NAME ? name : null;
}

/** One line of the list of lists (a created or changed list's answer); null if malformed. */
export const parseWatchlistSummary = (value: unknown): WatchlistSummary | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { id, name, favorite, count } = value as Record<string, unknown>;
  const parsedName = parseWatchlistName(name);
  if (!isWatchlistId(id) || !parsedName || typeof favorite !== 'boolean') return null;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  return { id, name: parsedName, favorite, count };
};

export function parseWatchlistsIndex(value: unknown): WatchlistsIndex | null {
  if (typeof value !== 'object' || value === null) return null;
  const { activeId, lists } = value as Record<string, unknown>;
  if (!isWatchlistId(activeId) || !Array.isArray(lists) || lists.length === 0) return null;
  const parsed: WatchlistSummary[] = [];
  for (const item of lists) {
    const summary = parseWatchlistSummary(item);
    if (!summary) return null;
    parsed.push(summary);
  }
  return parsed.some((list) => list.id === activeId) ? { activeId, lists: parsed } : null;
}

export function parseNamedWatchlist(value: unknown): NamedWatchlist | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, name, favorite } = value as Record<string, unknown>;
  const parsedName = parseWatchlistName(name);
  const list = parseWatchlist(value);
  if (!isWatchlistId(id) || !parsedName || typeof favorite !== 'boolean' || !list) return null;
  return { id, name: parsedName, favorite, sections: list.sections };
}

/**
 * `name`, or with the first free " (n)" after it when a list already has it: TradingView's
 * "Watchlist (1)" (docs/SPEC.md §11).
 */
export function uniqueListName(name: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((item) => item.toLowerCase()));
  const base = name.trim().slice(0, MAX_WATCHLIST_NAME) || 'Watchlist';
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 1; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, MAX_WATCHLIST_NAME - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

/** MY WATCHLISTS' order: starred lists first, then by name. */
export function sortedLists<T extends WatchlistMeta>(lists: readonly T[]): T[] {
  return [...lists].sort(
    (a, b) =>
      Number(b.favorite) - Number(a.favorite) ||
      a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }),
  );
}
