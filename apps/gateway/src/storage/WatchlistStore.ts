import { join } from 'node:path';
import { DEFAULT_WATCHLIST, parseWatchlist, type Watchlist } from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from './jsonFile.ts';

/** The watchlist, kept by the gateway in `data/watchlist.json` (gitignored). */
export class WatchlistStore {
  private readonly file: JsonFile<Watchlist>;

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}) {
    this.file = new JsonFile(join(dataDir, 'watchlist.json'), parseWatchlist, {
      onInvalid: (movedTo) =>
        onWarning(`The watchlist file was unreadable; kept it as ${movedTo} and started fresh`),
    });
  }

  async get(): Promise<Watchlist> {
    return (await this.file.read()) ?? structuredClone(DEFAULT_WATCHLIST);
  }

  /** Validates and saves a whole watchlist; returns it as stored (normalized). */
  async put(value: unknown): Promise<Watchlist> {
    const watchlist = parseWatchlist(value);
    if (!watchlist) throw new MarketError('bad_request', 'That is not a valid watchlist');
    await this.file.write(watchlist);
    return watchlist;
  }
}
