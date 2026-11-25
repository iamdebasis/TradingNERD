import type { CursorMode, MagnetMode } from '@tradingnerd/chart';
import {
  type Drawing,
  type DrawingTool,
  drawingsKey,
  isDrawingTool,
  LINE_TOOLS,
} from '@tradingnerd/core';
import { useSyncExternalStore } from 'react';
import { type DrawingsApi, drawingsApi } from '../data/api';
import { indicatorStore } from '../indicators/indicatorStore';
import { readJson, writeJson } from '../lib/storage';

/**
 * The user's drawings on the chart (docs/SPEC.md §5.27, §6.24): the chart symbol's, loaded from
 * the gateway when the symbol changes and saved there after each edit; their undo and redo; the
 * selection the chart reports; and the left toolbar's tool and modes, which this browser keeps.
 * A load or save that fails is tried again every DRAWINGS_RETRY_MS, the chart saying so
 * meanwhile, and a symbol's list not yet saved is what the chart shows when it comes back to it.
 */

/** Where the left toolbar's modes are remembered. */
export const DRAWING_TOOLBAR_KEY = 'tn.drawings.toolbar';
/** Undo steps kept for the chart's symbol (ours; TradingView doesn't say). */
export const UNDO_LIMIT = 100;
/** A failed load or save is tried again this long after (as the watchlist's and flags' loads). */
export const DRAWINGS_RETRY_MS = 3_000;

/** Runs `run` after `ms`; the function it returns cancels it. */
export type Later = (run: () => void, ms: number) => () => void;

const later: Later = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

const CURSORS: readonly CursorMode[] = ['cross', 'dot', 'arrow', 'eraser'];

/** The left toolbar's modes, kept in this browser. */
export interface ToolbarPrefs {
  cursor: CursorMode;
  magnetOn: boolean;
  /** The magnet's strength, kept while it's off. */
  magnet: MagnetMode;
  keepDrawing: boolean;
  lockAll: boolean;
  hideAll: boolean;
  /** The Lines group's tool its button shows: the last one chosen. */
  lineTool: DrawingTool;
  /** The drawings toolbar shows (TradingView's Drawings toolbar switch; shown at first). */
  toolbarShown: boolean;
}

export const DEFAULT_TOOLBAR: Readonly<ToolbarPrefs> = Object.freeze({
  cursor: 'cross',
  magnetOn: false,
  magnet: 'weak',
  keepDrawing: false,
  lockAll: false,
  hideAll: false,
  lineTool: 'trend-line',
  toolbarShown: true,
});

export function sanitizeToolbar(value: unknown): ToolbarPrefs {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_TOOLBAR };
  const raw = value as Record<string, unknown>;
  const bool = (key: keyof ToolbarPrefs) =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : (DEFAULT_TOOLBAR[key] as boolean);
  return {
    cursor: CURSORS.includes(raw.cursor as CursorMode)
      ? (raw.cursor as CursorMode)
      : DEFAULT_TOOLBAR.cursor,
    magnetOn: bool('magnetOn'),
    magnet: raw.magnet === 'strong' ? 'strong' : 'weak',
    keepDrawing: bool('keepDrawing'),
    lockAll: bool('lockAll'),
    hideAll: bool('hideAll'),
    lineTool:
      isDrawingTool(raw.lineTool) && (LINE_TOOLS as readonly string[]).includes(raw.lineTool)
        ? raw.lineTool
        : DEFAULT_TOOLBAR.lineTool,
    toolbarShown: bool('toolbarShown'),
  };
}

export interface DrawingsState {
  /** The chart symbol whose drawings these are (its key, "BINANCE:XRPUSDT"), null before one. */
  symbol: string | null;
  drawings: readonly Drawing[];
  /**
   * Loading until the gateway answers; failed when it couldn't (nothing is saved then, so a
   * symbol's drawings are never written over with a partial list); ready.
   */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** Why the symbol's drawings couldn't load, or null; tried again meanwhile. */
  loadError: string | null;
  /** Why the symbol's last save failed, or null once one is made; tried again meanwhile. */
  saveError: string | null;
  /** The tool being drawn with, or null for the cursor. */
  tool: DrawingTool | null;
  prefs: ToolbarPrefs;
  /** The drawings selected on the chart. */
  selection: readonly string[];
  canUndo: boolean;
  canRedo: boolean;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DrawingStore {
  private value: DrawingsState;
  private readonly listeners = new Set<() => void>();
  private readonly api: Pick<DrawingsApi, 'load' | 'save'>;
  /** The indicators on the chart: drawings on a pane of one that's gone aren't kept. */
  private readonly panes: () => ReadonlySet<string>;
  private past: (readonly Drawing[])[] = [];
  private future: (readonly Drawing[])[] = [];
  private loading: AbortController | null = null;
  /** Edits made before the symbol's drawings came: kept on top of them once they do. */
  private early: Drawing[] | null = null;
  /** The latest list to save for each symbol, saved one at a time. */
  private readonly pending = new Map<string, readonly Drawing[]>();
  private saving: Promise<void> | null = null;
  /** The list on its way to the gateway. */
  private sending: { symbol: string; drawings: readonly Drawing[] } | null = null;
  /** Lists whose save failed, nothing newer having come for their symbol: tried again later. */
  private readonly unsaved = new Map<string, readonly Drawing[]>();
  /** Why each symbol's last save failed, until one is made. */
  private readonly saveErrors = new Map<string, string>();
  private readonly later: Later;
  private cancelSaveRetry: (() => void) | null = null;
  private cancelLoadRetry: (() => void) | null = null;

  constructor(
    api: Pick<DrawingsApi, 'load' | 'save'> = drawingsApi,
    panes: () => ReadonlySet<string> = () => new Set(),
    schedule: Later = later,
  ) {
    this.api = api;
    this.panes = panes;
    this.later = schedule;
    this.value = {
      symbol: null,
      drawings: [],
      status: 'idle',
      loadError: null,
      saveError: null,
      tool: null,
      prefs: sanitizeToolbar(readJson(DRAWING_TOOLBAR_KEY)),
      selection: [],
      canUndo: false,
      canRedo: false,
    };
  }

  get = (): DrawingsState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The chart shows another symbol: its drawings load, and undo starts afresh. */
  setSymbol(symbol: string): void {
    const key = drawingsKey(symbol);
    if (key === this.value.symbol) return;
    this.loading?.abort();
    this.past = [];
    this.future = [];
    this.early = null;
    this.commit({
      ...this.value,
      symbol: key,
      drawings: [],
      selection: [],
      loadError: null,
      saveError: this.saveErrors.get(key) ?? null,
    });
    void this.load(key);
  }

  /** Loads the symbol's drawings again, after a failed load (an edit asks for it too). */
  async load(key = this.value.symbol): Promise<void> {
    if (!key) return;
    this.cancelLoadRetry?.();
    this.cancelLoadRetry = null;
    const controller = new AbortController();
    this.loading = controller;
    this.commit({ ...this.value, status: 'loading' });
    try {
      const loaded = await this.api.load(key, controller.signal);
      if (controller.signal.aborted || key !== this.value.symbol) return;
      const panes = this.panes();
      // A list of the symbol's not yet saved (waiting, on its way, or failed and to be tried
      // again) is newer than the gateway's: it's the one shown.
      const base = this.unsavedOf(key) ?? loaded.drawings;
      // A drawing on the pane of an indicator no longer on the chart has nowhere to show.
      const kept = base.filter((d) => d.pane === null || panes.has(d.pane));
      const early = this.early ?? [];
      this.early = null;
      const known = new Set(kept.map((d) => d.id));
      const drawings = [...kept, ...early.filter((d) => !known.has(d.id))];
      // Undo steps taken before the drawings came would undo them too: they start afresh.
      this.past = [];
      this.future = [];
      this.commit({
        ...this.value,
        drawings,
        status: 'ready',
        loadError: null,
        ...this.undoFlags(),
      });
      if (kept.length !== base.length || early.length > 0) this.queueSave();
    } catch (error) {
      if (controller.signal.aborted || key !== this.value.symbol) return;
      this.commit({ ...this.value, status: 'failed', loadError: message(error) });
      // Tried again while the chart stays on the symbol (an edit tries at once).
      this.cancelLoadRetry = this.later(() => {
        this.cancelLoadRetry = null;
        if (key === this.value.symbol && this.value.status === 'failed') void this.load(key);
      }, DRAWINGS_RETRY_MS);
    } finally {
      if (this.loading === controller) this.loading = null;
    }
  }

  /** The chart made an edit (drawn, moved, cloned, erased, deleted): one undo step. */
  edit(drawings: readonly Drawing[]): void {
    this.apply(drawings, true);
  }

  /** Changes a drawing (the floating toolbar, a lock): one undo step. */
  update(id: string, change: (drawing: Drawing) => Drawing): void {
    let changed = false;
    const drawings = this.value.drawings.map((drawing) => {
      if (drawing.id !== id) return drawing;
      const next = change(drawing);
      changed ||= next !== drawing;
      return next;
    });
    if (changed) this.apply(drawings, true);
  }

  remove(ids: readonly string[]): void {
    const going = new Set(ids);
    const drawings = this.value.drawings.filter((drawing) => !going.has(drawing.id));
    if (drawings.length !== this.value.drawings.length) this.apply(drawings, true);
  }

  /** Remove objects → Remove drawings: every drawing of the chart's symbol, one undo step. */
  removeAll(): void {
    if (this.value.drawings.length > 0) this.apply([], true);
  }

  /**
   * A drawing as its settings dialog has it now: shown at once, neither saved nor an undo step
   * until the dialog's Ok (finishPreview).
   */
  preview(drawing: Drawing): void {
    const drawings = this.value.drawings.map((item) => (item.id === drawing.id ? drawing : item));
    this.commit({ ...this.value, drawings });
  }

  /** The dialog closed: Ok keeps what it shows as one undo step, Cancel puts `before` back. */
  finishPreview(before: readonly Drawing[], keep: boolean): void {
    if (!keep) {
      this.commit({ ...this.value, drawings: before });
      return;
    }
    if (before === this.value.drawings) return;
    this.pushHistory(before);
    this.commit({ ...this.value, ...this.undoFlags() });
    this.queueSave();
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.value.drawings);
    this.commit({ ...this.value, drawings: previous, ...this.undoFlags() });
    this.queueSave();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.value.drawings);
    this.commit({ ...this.value, drawings: next, ...this.undoFlags() });
    this.queueSave();
  }

  /** The chart's selection, as it reports it. */
  setSelection(ids: readonly string[]): void {
    const same =
      ids.length === this.value.selection.length &&
      ids.every((id, i) => id === this.value.selection[i]);
    if (!same) this.commit({ ...this.value, selection: ids.slice() });
  }

  /** A tool to draw with, or null for the cursor; a line tool becomes its group's button. */
  setTool(tool: DrawingTool | null): void {
    const prefs =
      tool && (LINE_TOOLS as readonly string[]).includes(tool) && tool !== this.value.prefs.lineTool
        ? { ...this.value.prefs, lineTool: tool }
        : this.value.prefs;
    if (prefs !== this.value.prefs) writeJson(DRAWING_TOOLBAR_KEY, prefs);
    this.commit({ ...this.value, tool, prefs });
  }

  /** A drawing was finished (Keep drawing off) or let go: the cursor comes back. */
  toolDone(): void {
    if (this.value.tool !== null) this.commit({ ...this.value, tool: null });
  }

  setPrefs(change: Partial<ToolbarPrefs>): void {
    const prefs = sanitizeToolbar({ ...this.value.prefs, ...change });
    writeJson(DRAWING_TOOLBAR_KEY, prefs);
    // Choosing a cursor puts the tool down, as on TradingView.
    const tool = change.cursor !== undefined ? null : this.value.tool;
    this.commit({ ...this.value, prefs, tool });
  }

  /**
   * Indicators left the chart: the drawings on their panes go with them (TradingView's rule),
   * from the undo steps too, as undo can't bring the indicator back.
   */
  dropPanes(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    const keep = (list: readonly Drawing[]) =>
      list.filter((drawing) => drawing.pane === null || !gone.has(drawing.pane));
    this.past = this.past.map(keep);
    this.future = this.future.map(keep);
    const drawings = keep(this.value.drawings);
    if (drawings.length === this.value.drawings.length) return;
    this.commit({ ...this.value, drawings });
    this.queueSave();
  }

  /** Every save asked for so far has been made (or has failed, to be tried again later). */
  async whenSaved(): Promise<void> {
    while (this.saving) await this.saving;
  }

  private apply(drawings: readonly Drawing[], history: boolean): void {
    if (history) this.pushHistory(this.value.drawings);
    this.commit({ ...this.value, drawings, ...this.undoFlags() });
    if (this.value.status === 'ready') {
      this.queueSave();
      return;
    }
    // Not loaded yet (or the load failed): kept until the stored drawings are in, then saved
    // with them; a failed load is tried again.
    this.early = drawings.slice();
    if (this.value.status === 'failed') void this.load();
  }

  private pushHistory(drawings: readonly Drawing[]): void {
    this.past.push(drawings);
    if (this.past.length > UNDO_LIMIT) this.past.shift();
    this.future = [];
  }

  private undoFlags(): Pick<DrawingsState, 'canUndo' | 'canRedo'> {
    return { canUndo: this.past.length > 0, canRedo: this.future.length > 0 };
  }

  private queueSave(): void {
    const { symbol, drawings, status } = this.value;
    if (!symbol || status !== 'ready') return;
    this.pending.set(symbol, drawings);
    // The newest list takes the place of one whose save failed.
    this.unsaved.delete(symbol);
    this.drainSoon();
  }

  private drainSoon(): void {
    this.saving ??= this.drain().finally(() => {
      this.saving = null;
      // A save asked for as the last one ended (a load answering at that moment) goes now.
      if (this.pending.size > 0) this.drainSoon();
    });
  }

  private async drain(): Promise<void> {
    for (let next = this.pending.entries().next(); !next.done; ) {
      const [symbol, drawings] = next.value;
      this.pending.delete(symbol);
      this.sending = { symbol, drawings };
      try {
        await this.api.save({ symbol, drawings: drawings.slice() });
        this.saveErrors.delete(symbol);
      } catch (error) {
        this.saveErrors.set(symbol, message(error));
        // Kept to be tried again, unless a newer list for the symbol came meanwhile.
        if (!this.pending.has(symbol)) this.unsaved.set(symbol, drawings);
        this.retrySaves();
      } finally {
        this.sending = null;
      }
      const saveError = this.saveErrors.get(symbol) ?? null;
      if (symbol === this.value.symbol && saveError !== this.value.saveError) {
        this.commit({ ...this.value, saveError });
      }
      next = this.pending.entries().next();
    }
  }

  /** The failed saves go again after DRAWINGS_RETRY_MS. */
  private retrySaves(): void {
    if (this.cancelSaveRetry) return;
    this.cancelSaveRetry = this.later(() => {
      this.cancelSaveRetry = null;
      for (const [symbol, drawings] of this.unsaved) {
        if (!this.pending.has(symbol)) this.pending.set(symbol, drawings);
      }
      this.unsaved.clear();
      this.drainSoon();
    }, DRAWINGS_RETRY_MS);
  }

  /** The symbol's newest list the gateway may not have yet, if there's one. */
  private unsavedOf(symbol: string): readonly Drawing[] | undefined {
    if (this.pending.has(symbol)) return this.pending.get(symbol);
    if (this.sending?.symbol === symbol) return this.sending.drawings;
    return this.unsaved.get(symbol);
  }

  private commit(next: DrawingsState): void {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The ids of the indicators on the chart: a drawing on a pane belongs to one of them. */
const indicatorIds = (): ReadonlySet<string> =>
  new Set(indicatorStore.get().list.map((indicator) => indicator.id));

/** The drawings the app uses. */
export const drawingStore = new DrawingStore(drawingsApi, indicatorIds);

// An indicator removed from the chart takes the drawings on its pane with it.
let indicatorsBefore = indicatorIds();
indicatorStore.subscribe(() => {
  const now = indicatorIds();
  const removed = [...indicatorsBefore].filter((id) => !now.has(id));
  indicatorsBefore = now;
  drawingStore.dropPanes(removed);
});

/** The drawings and the toolbar's state; re-renders when they change. */
export function useDrawings(): DrawingsState {
  return useSyncExternalStore(drawingStore.subscribe, drawingStore.get);
}
