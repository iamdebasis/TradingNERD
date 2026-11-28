import { join } from 'node:path';
import {
  type Drawing,
  type DrawingsFile,
  drawingsKey,
  MAX_DRAWING_SYMBOLS,
  normalizeGroups,
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
   * Replaces a symbol's drawings; returns them as stored (normalized, the group rules holding:
   * D3c2). Saves run one after another, each building on the last, so two symbols saved
   * together both stay.
   */
  put(value: unknown): Promise<SymbolDrawings> {
    const parsed = parseSymbolDrawings(value);
    if (!parsed)
      return Promise.reject(new MarketError('bad_request', 'Those are not valid drawings'));
    const grouped = { ...parsed, drawings: normalizeGroups(parsed.drawings).slice() };
    const run = this.saves.then(() => this.save(grouped));
    this.saves = run.catch(() => {});
    return run;
  }

  /**
   * Indicators that left the chart take their drawings with them from every symbol, not only
   * the chart's (docs/SPEC.md §11, item 159; D3c): an indicator given a removed one's id again
   * (`rsi-1`) must never show another symbol's old drawings. It waits for the saves before it,
   * as they wait for each other, and writes nothing when there's nothing to drop.
   */
  dropPanes(value: unknown): Promise<{ removed: number }> {
    const panes = panesOf(value);
    if (!panes) return Promise.reject(new MarketError('bad_request', 'Those are not panes'));
    const run = this.saves.then(() => this.drop(panes));
    this.saves = run.catch(() => {});
    return run;
  }

  private async drop(panes: ReadonlySet<string>): Promise<{ removed: number }> {
    const state = await this.load();
    let removed = 0;
    const symbols: Record<string, Drawing[]> = {};
    for (const [symbol, drawings] of Object.entries(state.symbols)) {
      const kept = drawings.filter((drawing) => drawing.pane === null || !panes.has(drawing.pane));
      removed += drawings.length - kept.length;
      if (kept.length > 0) symbols[symbol] = kept;
    }
    if (removed === 0) return { removed };
    const next: DrawingsFile = { version: 1, symbols };
    await this.file.write(next);
    this.state = Promise.resolve(next);
    return { removed };
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

/** At most this many panes in one drop: far more indicators than a chart holds. */
const MAX_DROPPED_PANES = 100;

/** `{ panes: ["rsi-1", …] }`, each an indicator's id; null when it isn't that. */
function panesOf(value: unknown): Set<string> | null {
  const panes = (value as { panes?: unknown } | null)?.panes;
  if (!Array.isArray(panes) || panes.length === 0 || panes.length > MAX_DROPPED_PANES) return null;
  const ok = panes.every(
    (pane) => typeof pane === 'string' && pane.length > 0 && pane.length <= 64,
  );
  return ok ? new Set(panes as string[]) : null;
}

function symbolKey(value: unknown): string {
  const key = typeof value === 'string' ? drawingsKey(value) : '';
  if (key.length === 0 || key.length > 300) {
    throw new MarketError('bad_request', 'A symbol is needed');
  }
  return key;
}
