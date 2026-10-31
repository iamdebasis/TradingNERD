import type { ChartIndicator, ChartScript } from '@tradingnerd/chart';
import { isScriptId, type SavedScript, type ScriptOrigin } from '@tradingnerd/core';
import { type IndicatorKind, indicatorDefinition } from '@tradingnerd/indicators';
import { useSyncExternalStore } from 'react';
import { type ScriptsApi, scriptsApi } from '../data/api';
import { BUILTIN_CODE, compiled } from '../indicators/definitions';
import { indicatorStore } from '../indicators/indicatorStore';
import { readJson, writeJson } from '../lib/storage';

/** Where the editor's state and drafts are kept in this browser (docs/SPEC.md §5.16). */
export const PINE_KEY = 'tn.pine.editor';

/** A new indicator's code, as Create new → Indicator starts it (our own words). */
export const NEW_INDICATOR = '//@version=6\nindicator("My script")\nplot(close)\n';

/** What the editor has open. */
export type PineOrigin =
  /** A built-in's code: edits make a copy, the original stays (the user's model). */
  | { kind: 'builtin'; builtin: ScriptOrigin }
  /** One of My scripts. */
  | {
      kind: 'saved';
      scriptId: string;
      name: string;
      version: number;
      savedAt: number;
      from: ScriptOrigin | null;
    }
  /** A new script, not saved yet. */
  | { kind: 'new' };

export interface PineDocument {
  /** Which opening of a script this is: the editor starts afresh (its Undo too) for another. */
  key: string;
  origin: PineOrigin;
  /** The code as last saved, or the built-in's own: Reset to original and Save compare with it. */
  original: string;
  /** The code in the editor now. */
  text: string;
  /** The script on the chart its Add to chart put there (Update on chart), if any. */
  chartId: string | null;
}

export interface PineState {
  /** The panel is showing. */
  open: boolean;
  document: PineDocument | null;
  /** Loading a saved script, or saving one. */
  busy: boolean;
  /** The last thing that went wrong (a failed save, say), for the panel to show. */
  notice: string | null;
}

const EMPTY: PineState = { open: false, document: null, busy: false, notice: null };

const isOrigin = (value: unknown): value is ScriptOrigin => value === 'rsi' || value === 'volume';

let opened = 0;
/** A new opening's key. */
const nextKey = () => `${Date.now().toString(36)}-${++opened}`;

function sanitizeOrigin(value: unknown): PineOrigin | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'builtin' && isOrigin(raw.builtin))
    return { kind: 'builtin', builtin: raw.builtin };
  if (raw.kind === 'new') return { kind: 'new' };
  if (
    raw.kind === 'saved' &&
    isScriptId(raw.scriptId) &&
    typeof raw.name === 'string' &&
    typeof raw.version === 'number' &&
    typeof raw.savedAt === 'number'
  ) {
    return {
      kind: 'saved',
      scriptId: raw.scriptId,
      name: raw.name,
      version: raw.version,
      savedAt: raw.savedAt,
      from: isOrigin(raw.from) ? raw.from : null,
    };
  }
  return null;
}

/** The kept state, or none: a damaged entry starts the editor empty. */
export function sanitizePineState(value: unknown): PineState {
  if (typeof value !== 'object' || value === null) return EMPTY;
  const raw = value as Record<string, unknown>;
  const doc = raw.document as Record<string, unknown> | null | undefined;
  let document: PineDocument | null = null;
  if (doc && typeof doc === 'object') {
    const origin = sanitizeOrigin(doc.origin);
    if (origin && typeof doc.original === 'string' && typeof doc.text === 'string') {
      document = {
        key: typeof doc.key === 'string' ? doc.key : 'kept',
        origin,
        original: doc.original,
        text: doc.text,
        chartId: typeof doc.chartId === 'string' ? doc.chartId : null,
      };
    }
  }
  return { open: raw.open === true, document, busy: false, notice: null };
}

/** The name the header shows: the built-in's, the saved script's, or a new one's. */
export function documentName(document: PineDocument): string {
  switch (document.origin.kind) {
    case 'builtin':
      return indicatorDefinition(document.origin.builtin).name;
    case 'saved':
      return document.origin.name;
    case 'new':
      return 'Untitled script';
  }
}

/** The built-in a document's code started from, if any. */
const fromOf = (document: PineDocument): ScriptOrigin | null =>
  document.origin.kind === 'builtin'
    ? document.origin.builtin
    : document.origin.kind === 'saved'
      ? document.origin.from
      : null;

/**
 * The Pine Editor (docs/SPEC.md §5.16), kept in this browser: whether it's open, the script it
 * has open with its unsaved code, and the chart script its Add to chart made. The code is kept
 * as typed, through closing the editor and reloading, until it's saved or reset, as TradingView
 * keeps unsaved changes.
 */
export class PineStore {
  private value: PineState;
  private readonly listeners = new Set<() => void>();
  private readonly api: ScriptsApi;

  constructor(api: ScriptsApi = scriptsApi) {
    this.api = api;
    this.value = sanitizePineState(readJson(PINE_KEY));
  }

  get = (): PineState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setOpen(open: boolean): void {
    if (open !== this.value.open) this.commit({ ...this.value, open });
  }

  /** A built-in's code, to edit as a copy (the legend's Source code, Create new → Built-in). */
  openBuiltin(builtin: ScriptOrigin, chartId: string | null = null): void {
    const original = BUILTIN_CODE[builtin as IndicatorKind] ?? '';
    const current = this.value.document;
    // The built-in already open keeps its unsaved code.
    if (current?.origin.kind === 'builtin' && current.origin.builtin === builtin) {
      this.commit({
        ...this.value,
        open: true,
        document: { ...current, chartId: chartId ?? current.chartId },
      });
      return;
    }
    this.commit({
      ...this.value,
      open: true,
      notice: null,
      document: {
        key: nextKey(),
        origin: { kind: 'builtin', builtin },
        original,
        text: original,
        chartId,
      },
    });
  }

  /** Create new → Indicator. */
  openNew(): void {
    this.commit({
      ...this.value,
      open: true,
      notice: null,
      document: {
        key: nextKey(),
        origin: { kind: 'new' },
        original: NEW_INDICATOR,
        text: NEW_INDICATOR,
        chartId: null,
      },
    });
  }

  /** One of My scripts, from the gateway. */
  async openSaved(scriptId: string, chartId: string | null = null): Promise<void> {
    this.commit({ ...this.value, open: true, busy: true, notice: null });
    try {
      const script = await this.api.get(scriptId);
      this.commit({
        ...this.value,
        busy: false,
        document: this.savedDocument(script, chartId, nextKey()),
      });
    } catch (error) {
      this.commit({
        ...this.value,
        busy: false,
        notice: messageOf(error, 'The script could not be opened'),
      });
    }
  }

  /**
   * An indicator's code (the legend's Source code): a built-in's own; a saved script's; or the
   * code a draft put on the chart, as a copy of what it started from.
   */
  openIndicator(indicator: ChartIndicator): void {
    if (indicator.kind !== 'script') {
      this.openBuiltin(indicator.kind);
      return;
    }
    const script = indicator.script as ChartScript;
    if (script.scriptId) {
      void this.openSaved(script.scriptId, indicator.id);
      return;
    }
    const origin: PineOrigin = script.from
      ? { kind: 'builtin', builtin: script.from }
      : { kind: 'new' };
    const original = script.from
      ? (BUILTIN_CODE[script.from as IndicatorKind] ?? '')
      : NEW_INDICATOR;
    this.commit({
      ...this.value,
      open: true,
      notice: null,
      document: { key: nextKey(), origin, original, text: script.source, chartId: indicator.id },
    });
  }

  /** The code as typed. */
  setText(text: string): void {
    const document = this.value.document;
    if (!document || document.text === text) return;
    this.commit({ ...this.value, document: { ...document, text } });
  }

  /**
   * Add to chart, or Update on chart once added (Ctrl/Cmd + Enter). Code that doesn't compile
   * stays off the chart, as in TradingView; returns whether it went on.
   */
  addToChart(): boolean {
    const document = this.value.document;
    if (!document) return false;
    if (!compiled(document.text).program) return false;
    const scriptId = document.origin.kind === 'saved' ? document.origin.scriptId : null;
    const onChart =
      document.chartId !== null &&
      indicatorStore.get().list.some((item) => item.id === document.chartId);
    if (onChart && document.chartId) {
      indicatorStore.updateScript(document.chartId, { source: document.text, scriptId });
      return true;
    }
    const chartId = indicatorStore.addScript({
      source: document.text,
      scriptId,
      from: fromOf(document),
    });
    this.commit({ ...this.value, document: { ...(this.value.document as PineDocument), chartId } });
    return true;
  }

  /** Whether the open code is on the chart now (the button reads Update on chart). */
  isOnChart(): boolean {
    const chartId = this.value.document?.chartId;
    return chartId != null && indicatorStore.get().list.some((item) => item.id === chartId);
  }

  /**
   * Saves the code (Ctrl/Cmd + S): one of My scripts gets a new version; a built-in's copy or a
   * new script becomes one of My scripts under `name`, and the built-in stays as it was.
   */
  async save(name?: string): Promise<boolean> {
    const document = this.value.document;
    if (!document) return false;
    this.commit({ ...this.value, busy: true, notice: null });
    try {
      const saved =
        document.origin.kind === 'saved'
          ? await this.api.save(document.origin.scriptId, document.text)
          : await this.api.create({
              name: name ?? documentName(document),
              source: document.text,
              from: fromOf(document),
            });
      const current = this.value.document ?? document;
      const next = this.savedDocument(saved, current.chartId, current.key, current.text);
      // The chart script it put there now belongs to the saved script.
      if (next.chartId && indicatorStore.get().list.some((item) => item.id === next.chartId)) {
        indicatorStore.updateScript(next.chartId, { scriptId: saved.id, source: saved.source });
      }
      this.commit({ ...this.value, busy: false, document: next });
      return true;
    } catch (error) {
      this.commit({
        ...this.value,
        busy: false,
        notice: messageOf(error, 'The script could not be saved'),
      });
      return false;
    }
  }

  dismissNotice(): void {
    if (this.value.notice !== null) this.commit({ ...this.value, notice: null });
  }

  private savedDocument(
    script: SavedScript,
    chartId: string | null,
    key: string,
    text = script.source,
  ): PineDocument {
    return {
      key,
      origin: {
        kind: 'saved',
        scriptId: script.id,
        name: script.name,
        version: script.version,
        savedAt: script.savedAt,
        from: script.from,
      },
      original: script.source,
      text,
      chartId,
    };
  }

  private commit(next: PineState): void {
    this.value = next;
    writeJson(PINE_KEY, { open: next.open, document: next.document });
    for (const listener of [...this.listeners]) listener();
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const pineStore = new PineStore();

export function usePine(): PineState {
  return useSyncExternalStore(pineStore.subscribe, pineStore.get);
}
