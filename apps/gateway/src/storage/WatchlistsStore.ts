import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_WATCHLIST,
  isWatchlistId,
  MAX_WATCHLISTS,
  type NamedWatchlist,
  parseWatchlist,
  parseWatchlistName,
  uniqueListName,
  type Watchlist,
  type WatchlistSection,
  type WatchlistSummary,
  type WatchlistsIndex,
} from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from './jsonFile.ts';

interface StoredList {
  id: string;
  name: string;
  favorite: boolean;
  sections: WatchlistSection[];
}

interface Stored {
  version: 1;
  activeId: string;
  lists: StoredList[];
}

/** The id and name of the list that was there before several lists. */
export const FIRST_LIST = { id: 'watchlist', name: 'Watchlist' } as const;

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, activeId, lists } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(lists)) return null;
  if (lists.length === 0 || lists.length > MAX_WATCHLISTS) return null;
  const parsed: StoredList[] = [];
  const ids = new Set<string>();
  for (const item of lists) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, name, favorite } = item as Record<string, unknown>;
    const listName = parseWatchlistName(name);
    const list = parseWatchlist(item);
    if (!isWatchlistId(id) || ids.has(id) || !listName || typeof favorite !== 'boolean' || !list) {
      return null;
    }
    ids.add(id);
    parsed.push({ id, name: listName, favorite, sections: list.sections });
  }
  const first = parsed[0] as StoredList;
  const active = typeof activeId === 'string' && ids.has(activeId) ? activeId : first.id;
  return { version: 1, activeId: active, lists: parsed };
}

const summaryOf = (list: StoredList): WatchlistSummary => ({
  id: list.id,
  name: list.name,
  favorite: list.favorite,
  count: list.sections.reduce((sum, section) => sum + section.symbols.length, 0),
});

const named = (list: StoredList): NamedWatchlist => structuredClone(list);

export interface NewList {
  name: string;
  /** Its sections (an uploaded file's), or a copy of another list's (`copyOf`), or none. */
  sections?: WatchlistSection[];
  copyOf?: string;
  /** Open it at once (the default). */
  activate?: boolean;
}

/**
 * The user's watchlists, as on TradingView: several named lists, starred or not, one of them
 * open. Kept by the gateway in `data/watchlists.json` (gitignored). The first time, the one list
 * kept before (`watchlist.json`) becomes "Watchlist"; that file stays as it was. Changes run one
 * at a time, so two at once never lose either.
 */
export class WatchlistsStore {
  private readonly file: JsonFile<Stored>;
  private readonly before: JsonFile<Watchlist>;
  private state: Stored | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}) {
    this.file = new JsonFile(join(dataDir, 'watchlists.json'), parseStored, {
      onInvalid: (movedTo) =>
        onWarning(`The watchlists file was unreadable; kept it as ${movedTo} and started fresh`),
    });
    this.before = new JsonFile(join(dataDir, 'watchlist.json'), parseWatchlist, {
      onInvalid: (movedTo) =>
        onWarning(`The watchlist file was unreadable; kept it as ${movedTo} and started fresh`),
    });
  }

  /** Every list, and which one is open. */
  index(): Promise<WatchlistsIndex> {
    return this.run((state) => ({ result: indexOf(state) }));
  }

  get(id: string): Promise<NamedWatchlist> {
    return this.run((state) => ({ result: named(listOf(state, id)) }));
  }

  /** Saves a list's sections; returns it as stored (normalized). */
  save(id: string, value: unknown): Promise<NamedWatchlist> {
    const list = parseWatchlist(value);
    if (!list)
      return Promise.reject(new MarketError('bad_request', 'That is not a valid watchlist'));
    return this.run((state) => {
      const current = listOf(state, id);
      const saved = { ...current, sections: list.sections };
      return { next: replaceList(state, saved), result: named(saved) };
    });
  }

  /** Creates a list (new, a copy, or from a file), named so it doesn't repeat another's. */
  create(value: unknown): Promise<WatchlistSummary> {
    let input: NewList;
    try {
      input = parseNewList(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.run((state) => {
      if (state.lists.length >= MAX_WATCHLISTS) {
        throw new MarketError('bad_request', `At most ${MAX_WATCHLISTS} watchlists`);
      }
      const sections = input.copyOf
        ? structuredClone(listOf(state, input.copyOf).sections)
        : (input.sections ?? []);
      const list: StoredList = {
        id: newId(state),
        name: uniqueListName(
          input.name,
          state.lists.map((item) => item.name),
        ),
        favorite: false,
        sections,
      };
      const next: Stored = {
        ...state,
        lists: [...state.lists, list],
        activeId: input.activate === false ? state.activeId : list.id,
      };
      return { next, result: summaryOf(list) };
    });
  }

  /** Renames or stars a list. */
  update(id: string, value: unknown): Promise<WatchlistSummary> {
    const { name, favorite } = (typeof value === 'object' && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    const newName = name === undefined ? undefined : parseWatchlistName(name);
    if (newName === null || (favorite !== undefined && typeof favorite !== 'boolean')) {
      return Promise.reject(new MarketError('bad_request', 'A name, or a star, to change'));
    }
    return this.run((state) => {
      const current = listOf(state, id);
      const updated = {
        ...current,
        ...(newName ? { name: newName } : {}),
        ...(typeof favorite === 'boolean' ? { favorite } : {}),
      };
      return { next: replaceList(state, updated), result: summaryOf(updated) };
    });
  }

  /** Deletes a list; the open one hands over to the first left. The last one stays. */
  remove(id: string): Promise<WatchlistsIndex> {
    return this.run((state) => {
      listOf(state, id);
      if (state.lists.length === 1) {
        throw new MarketError('bad_request', "The last watchlist can't be deleted");
      }
      const lists = state.lists.filter((list) => list.id !== id);
      const first = lists[0] as StoredList;
      const next: Stored = {
        ...state,
        lists,
        activeId: state.activeId === id ? first.id : state.activeId,
      };
      return { next, result: indexOf(next) };
    });
  }

  /** Opens a list. */
  activate(id: string): Promise<WatchlistsIndex> {
    return this.run((state) => {
      listOf(state, id);
      const next: Stored = { ...state, activeId: id };
      return { next, result: indexOf(next) };
    });
  }

  /** The open list's sections (GET /api/watchlist, as before several lists). */
  active(): Promise<Watchlist> {
    return this.run((state) => ({
      result: { sections: structuredClone(listOf(state, state.activeId).sections) },
    }));
  }

  /** Saves the open list's sections (PUT /api/watchlist, as before several lists). */
  async saveActive(value: unknown): Promise<Watchlist> {
    const { activeId } = await this.index();
    const saved = await this.save(activeId, value);
    return { sections: saved.sections };
  }

  /** Runs a read or a change after the ones before it; a change is saved before it counts. */
  private run<T>(step: (state: Stored) => { next?: Stored; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.load();
      const { next, result } = step(state);
      if (next) {
        await this.file.write(next);
        this.state = next;
      }
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async load(): Promise<Stored> {
    if (this.state) return this.state;
    let state = await this.file.read();
    if (!state) {
      const before = (await this.before.read()) ?? structuredClone(DEFAULT_WATCHLIST);
      state = {
        version: 1,
        activeId: FIRST_LIST.id,
        lists: [{ ...FIRST_LIST, favorite: false, sections: before.sections }],
      };
      await this.file.write(state);
    }
    this.state = state;
    return state;
  }
}

function indexOf(state: Stored): WatchlistsIndex {
  return { activeId: state.activeId, lists: state.lists.map(summaryOf) };
}

function listOf(state: Stored, id: string): StoredList {
  const list = state.lists.find((item) => item.id === id);
  if (!list) throw new MarketError('not_found', "There's no such watchlist");
  return list;
}

function replaceList(state: Stored, list: StoredList): Stored {
  return { ...state, lists: state.lists.map((item) => (item.id === list.id ? list : item)) };
}

function newId(state: Stored): string {
  for (;;) {
    const id = `l-${randomUUID().slice(0, 8)}`;
    if (!state.lists.some((list) => list.id === id)) return id;
  }
}

function parseNewList(value: unknown): NewList {
  const { name, sections, copyOf, activate } = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Record<string, unknown>;
  const listName = parseWatchlistName(name);
  if (!listName) throw new MarketError('bad_request', 'A watchlist needs a name');
  if (activate !== undefined && typeof activate !== 'boolean') {
    throw new MarketError('bad_request', '"activate" must be true or false');
  }
  if (copyOf !== undefined && !isWatchlistId(copyOf)) {
    throw new MarketError('not_found', "There's no such watchlist");
  }
  let parsedSections: WatchlistSection[] | undefined;
  if (sections !== undefined) {
    const list = parseWatchlist({ sections });
    if (!list) throw new MarketError('bad_request', 'That is not a valid watchlist');
    parsedSections = list.sections;
  }
  return {
    name: listName,
    ...(parsedSections ? { sections: parsedSections } : {}),
    ...(typeof copyOf === 'string' ? { copyOf } : {}),
    ...(typeof activate === 'boolean' ? { activate } : {}),
  };
}
