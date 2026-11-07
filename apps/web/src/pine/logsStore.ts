import type { ScriptLogs } from '@tradingnerd/chart';
import type { LogEntry } from '@tradingnerd/pine';
import { useSyncExternalStore } from 'react';

/** The Pine Logs pane's state (Pine docs, Debugging: Pine Logs). */
export interface LogsState {
  /** The pane is showing. */
  open: boolean;
  /** The script whose logs it shows (its title is the pane's dropdown); null for the first. */
  selected: string | null;
  /** Each logging script on the chart, in the legend's order. */
  scripts: readonly ScriptLogs[];
  /** The chart symbol's time zone, which the timestamps are written in (UTC for crypto). */
  zone: string;
}

/** A request to bring a bar into view and show its time over it (an entry's Scroll to bar). */
export interface BarRequest {
  bar: number;
}

/**
 * The Pine Logs pane's store: which scripts on the chart log, what they logged, the pane being
 * open and the script it shows. The chart fills it on each update; the pane reads it.
 */
export class LogsStore {
  private value: LogsState = { open: false, selected: null, scripts: [], zone: 'Etc/UTC' };
  private readonly listeners = new Set<() => void>();
  private readonly barListeners = new Set<(request: BarRequest) => void>();

  get = (): LogsState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens the pane on a script's logs, or on the one it showed. */
  open(id: string | null = null): void {
    this.commit({ ...this.value, open: true, selected: id ?? this.value.selected });
  }

  close(): void {
    if (this.value.open) this.commit({ ...this.value, open: false });
  }

  select(id: string): void {
    this.commit({ ...this.value, selected: id });
  }

  /** The chart symbol's time zone (SymbolInfo.timezone). */
  setZone(zone: string): void {
    if (zone !== this.value.zone) this.commit({ ...this.value, zone });
  }

  /**
   * The chart's logging scripts and their logs, as it has them now: a change only when a script
   * came or went, or logged something new.
   */
  setScripts(scripts: readonly ScriptLogs[]): void {
    const before = this.value.scripts;
    const same =
      before.length === scripts.length &&
      before.every((item, i) => {
        const next = scripts[i] as ScriptLogs;
        return item.id === next.id && item.written === next.written && item.logs === next.logs;
      });
    if (!same) this.commit({ ...this.value, scripts: [...scripts] });
  }

  /** The logs the pane shows: the selected script's, or the first one's. */
  shown(): ScriptLogs | null {
    const { scripts, selected } = this.value;
    return scripts.find((item) => item.id === selected) ?? scripts[0] ?? null;
  }

  /** Asks the chart to bring an entry's bar into view (Scroll to bar). */
  scrollToBar(entry: LogEntry): void {
    for (const listener of this.barListeners) listener({ bar: entry.bar });
  }

  /** The chart hears Scroll to bar here. */
  onScrollToBar(listener: (request: BarRequest) => void): () => void {
    this.barListeners.add(listener);
    return () => this.barListeners.delete(listener);
  }

  private commit(next: LogsState): void {
    this.value = next;
    for (const listener of this.listeners) listener();
  }
}

export const logsStore = new LogsStore();

export function useLogs(): LogsState {
  return useSyncExternalStore(logsStore.subscribe, logsStore.get, logsStore.get);
}
