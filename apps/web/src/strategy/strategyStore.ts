import type { ScriptStrategy } from '@tradingnerd/chart';
import { useSyncExternalStore } from 'react';

/** The Strategy Tester's tabs (Pine docs: Strategies, Strategy Tester). */
export type TesterTab = 'overview' | 'summary' | 'trades' | 'properties';

export interface StrategyTesterState {
  open: boolean;
  /** The strategy it shows (its title is the panel's dropdown); null for the first. */
  selected: string | null;
  tab: TesterTab;
  /** The List of Trades newest first, as TradingView lists them by default. */
  newestFirst: boolean;
  /** Each strategy on the chart, in the legend's order. */
  strategies: readonly ScriptStrategy[];
}

/**
 * The Strategy Tester's store: the strategies on the chart and what they traded, the panel being
 * open, the strategy and the tab it shows. The chart fills it on each update; the panel reads it.
 * A strategy newly on the chart opens the panel, as adding one does on TradingView.
 */
export class StrategyStore {
  private value: StrategyTesterState = {
    open: false,
    selected: null,
    tab: 'overview',
    newestFirst: true,
    strategies: [],
  };
  private readonly listeners = new Set<() => void>();

  get = (): StrategyTesterState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setOpen(open: boolean): void {
    if (open !== this.value.open) this.commit({ ...this.value, open });
  }

  select(id: string): void {
    this.commit({ ...this.value, selected: id });
  }

  setTab(tab: TesterTab): void {
    this.commit({ ...this.value, tab });
  }

  toggleOrder(): void {
    this.commit({ ...this.value, newestFirst: !this.value.newestFirst });
  }

  /** The chart's strategies as it has them now: a change only when one came, went or traded. */
  setStrategies(strategies: readonly ScriptStrategy[]): void {
    const old = this.value.strategies;
    const same =
      old.length === strategies.length &&
      old.every((s, i) => {
        const next = strategies[i];
        return next && next.id === s.id && next.state === s.state && next.error === s.error;
      });
    if (same) return;
    const known = new Set(old.map((s) => s.id));
    const added = strategies.find((s) => !known.has(s.id));
    const open = this.value.open || added !== undefined;
    const selected = added ? added.id : this.value.selected;
    this.commit({ ...this.value, strategies, open: strategies.length > 0 && open, selected });
  }

  /** The strategy shown: the chosen one, else the first. */
  current(): ScriptStrategy | null {
    const { strategies, selected } = this.value;
    return strategies.find((s) => s.id === selected) ?? strategies[0] ?? null;
  }

  private commit(next: StrategyTesterState): void {
    this.value = next;
    for (const listener of this.listeners) listener();
  }
}

export const strategyStore = new StrategyStore();

export function useStrategyTester(): StrategyTesterState {
  return useSyncExternalStore(strategyStore.subscribe, strategyStore.get, strategyStore.get);
}
