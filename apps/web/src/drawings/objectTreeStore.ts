import { useSyncExternalStore } from 'react';
import { readJson, writeJson } from '../lib/storage';

/**
 * The Object tree's panel (docs/SPEC.md §5.27, D3c): whether it's open on the right (kept in this
 * browser, as the alert manager's is), and what it asks of the chart, which owns the drawings'
 * selection and the settings dialogs: select these drawings, open these settings. The chart pane
 * answers each request once, in order, by its number.
 */

/** Where the panel's open state is kept. */
export const OBJECT_TREE_OPEN_KEY = 'tn.layout.objectTreeOpen';

/** A request without its number, which the store gives it. */
export type TreeAsk =
  | { kind: 'select'; ids: readonly string[] }
  | { kind: 'drawing-settings'; ids: readonly string[] }
  | { kind: 'indicator-settings'; id: string };

export type TreeRequest = TreeAsk & { seq: number };

export interface ObjectTreeState {
  open: boolean;
  /**
   * How many times it was asked to show (its button, a menu's "Object Tree…"): each time, it
   * takes the right from the panels over it, even when it was open under one of them.
   */
  shown: number;
  /** The latest requests to the chart, oldest first. */
  requests: readonly TreeRequest[];
}

/** Requests kept for the chart: more than can be made between two of its renders. */
const KEPT_REQUESTS = 16;

export class ObjectTreeStore {
  private value: ObjectTreeState = {
    open: readJson(OBJECT_TREE_OPEN_KEY) === true,
    shown: 0,
    requests: [],
  };
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  get = (): ObjectTreeState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens it and brings it forward. */
  show(): void {
    writeJson(OBJECT_TREE_OPEN_KEY, true);
    this.commit({ ...this.value, open: true, shown: this.value.shown + 1 });
  }

  close(): void {
    if (!this.value.open) return;
    writeJson(OBJECT_TREE_OPEN_KEY, false);
    this.commit({ ...this.value, open: false });
  }

  /** Asks the chart to select these drawings, or to open these settings. */
  ask(ask: TreeAsk): void {
    this.seq += 1;
    const request = { ...ask, seq: this.seq } as TreeRequest;
    this.commit({
      ...this.value,
      requests: [...this.value.requests, request].slice(-KEPT_REQUESTS),
    });
  }

  private commit(next: ObjectTreeState): void {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The Object tree the app uses. */
export const objectTreeStore = new ObjectTreeStore();

export function useObjectTree(): ObjectTreeState {
  return useSyncExternalStore(objectTreeStore.subscribe, objectTreeStore.get);
}
