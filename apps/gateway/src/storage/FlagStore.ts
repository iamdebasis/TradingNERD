import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_FLAG_STATE, type FlagState, parseFlagState } from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from './jsonFile.ts';

/**
 * Flagged symbols, kept by the gateway in `data/flags.json` (gitignored). A flag belongs to the
 * symbol, as in TradingView, so it isn't part of the watchlist.
 */
export class FlagStore {
  private readonly file: JsonFile<FlagState>;
  private readonly watchlistPath: string;

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}) {
    this.file = new JsonFile(join(dataDir, 'flags.json'), parseFlagState, {
      onInvalid: (movedTo) =>
        onWarning(`The flags file was unreadable; kept it as ${movedTo} and started fresh`),
    });
    this.watchlistPath = join(dataDir, 'watchlist.json');
  }

  async get(): Promise<FlagState> {
    return (
      (await this.file.read()) ?? (await this.carryOver()) ?? structuredClone(DEFAULT_FLAG_STATE)
    );
  }

  /** Validates and saves the whole state; returns it as stored (normalized). */
  async put(value: unknown): Promise<FlagState> {
    const state = parseFlagState(value);
    if (!state) throw new MarketError('bad_request', 'Those are not valid flags');
    await this.file.write(state);
    return state;
  }

  /**
   * Flags the first build of this feature kept inside the watchlist file (2026-10-19), moved
   * here once.
   */
  private async carryOver(): Promise<FlagState | null> {
    let flags: unknown;
    try {
      flags = (JSON.parse(await readFile(this.watchlistPath, 'utf8')) as { flags?: unknown }).flags;
    } catch {
      return null;
    }
    const state = parseFlagState({ flags });
    if (!state || Object.keys(state.flags).length === 0) return null;
    await this.file.write(state);
    return state;
  }
}
