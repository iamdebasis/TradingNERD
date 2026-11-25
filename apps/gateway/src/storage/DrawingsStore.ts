import { join } from 'node:path';
import {
  type DrawingsFile,
  drawingsKey,
  MAX_DRAWING_SYMBOLS,
  parseDrawingsFile,
  parseSymbolDrawings,
  type SymbolDrawings,
} from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from './jsonFile.ts';

/**
 * The user's drawings (docs/SPEC.md §5.27), kept by the gateway in `data/drawings.json`
 * (gitignored), every symbol's in one file. A drawing belongs to its symbol, as on TradingView,
 * and shows on every interval. The file is read once; each save changes one symbol's drawings
 * and writes the whole file, whole or not at all (JsonFile).
 */
export class DrawingsStore {
  private readonly file: JsonFile<DrawingsFile>;
  private state: Promise<DrawingsFile> | null = null;
  private saves: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}) {
    // One compact line: brushes (D4) hold hundreds of points each.
    this.file = new JsonFile(join(dataDir, 'drawings.json'), parseDrawingsFile, {
      indent: 0,
      onInvalid: (movedTo) =>
        onWarning(`The drawings file was unreadable; kept it as ${movedTo} and started fresh`),
    });
  }

  /** A symbol's drawings, none when it has none. */
  async get(symbol: unknown): Promise<SymbolDrawings> {
    const key = symbolKey(symbol);
    const state = await this.load();
    return { symbol: key, drawings: state.symbols[key] ?? [] };
  }

  /**
   * Replaces a symbol's drawings; returns them as stored (normalized). Saves run one after
   * another, each building on the last, so two symbols saved together both stay.
   */
  put(value: unknown): Promise<SymbolDrawings> {
    const parsed = parseSymbolDrawings(value);
    if (!parsed)
      return Promise.reject(new MarketError('bad_request', 'Those are not valid drawings'));
    const run = this.saves.then(() => this.save(parsed));
    this.saves = run.catch(() => {});
    return run;
  }

  private async save(parsed: SymbolDrawings): Promise<SymbolDrawings> {
    const state = await this.load();
    const symbols = { ...state.symbols };
    if (parsed.drawings.length > 0) symbols[parsed.symbol] = parsed.drawings;
    else delete symbols[parsed.symbol];
    if (Object.keys(symbols).length > MAX_DRAWING_SYMBOLS) {
      throw new MarketError('bad_request', 'Too many symbols with drawings');
    }
    const next: DrawingsFile = { version: 1, symbols };
    await this.file.write(next);
    // Kept once written, as the watchlists are: a save that couldn't be written leaves the
    // drawings as stored. The next save waits for this one (`saves`), so it builds on it.
    this.state = Promise.resolve(next);
    return parsed;
  }

  private load(): Promise<DrawingsFile> {
    if (this.state) return this.state;
    const loading = this.file
      .read()
      .then((stored): DrawingsFile => stored ?? { version: 1, symbols: {} })
      .catch((error: unknown) => {
        // Not kept: the next call reads the file again.
        this.state = null;
        throw error;
      });
    this.state = loading;
    return loading;
  }
}

function symbolKey(value: unknown): string {
  const key = typeof value === 'string' ? drawingsKey(value) : '';
  if (key.length === 0 || key.length > 300) {
    throw new MarketError('bad_request', 'A symbol is needed');
  }
  return key;
}
