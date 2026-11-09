import type { Inputs } from '@tradingnerd/indicators';
import type { AlertEvent, AlertFreq } from '@tradingnerd/pine';

/**
 * Alerts on scripts, as TradingView's Pine docs (Concepts, Alerts) and Help Center describe them:
 * a script's alert() calls, its alertcondition() conditions, or a strategy's order fills, on the
 * symbol and timeframe the alert was made on. TradingView "saves a mirror image of the script and
 * its inputs, along with the chart's main symbol and timeframe": an alert here keeps a copy too,
 * so changing the chart or the script afterwards leaves it as it was. Ours run while tradingNerd
 * is open (AlertRunner); TradingView's run on its servers around the clock.
 */

/**
 * How often an alertcondition() alert triggers: the Create Alert dialog's Trigger (Help Center,
 * Differences between alert frequencies). alert() calls set their own (`freq`).
 */
export type AlertTrigger = 'once' | 'bar' | 'close' | 'minute';

export const TRIGGERS: readonly { value: AlertTrigger; label: string }[] = [
  { value: 'once', label: 'Only once' },
  { value: 'bar', label: 'Once per bar' },
  { value: 'close', label: 'Once per bar close' },
  { value: 'minute', label: 'Once per minute' },
];

/** What an alert listens to: the dialog's Condition (Help Center, Alerts on alert() function). */
export type AlertCondition =
  /** An indicator's: "Any alert() function call". */
  | { kind: 'calls' }
  /** A strategy's three: "Order fills and alert() function calls", "Order fills only" and
   * "alert() function calls only". */
  | { kind: 'fills-calls' }
  | { kind: 'fills' }
  | { kind: 'calls-only' }
  /** One of an indicator's alertcondition() calls, by its place and title. */
  | { kind: 'condition'; index: number; title: string };

export const conditionLabel = (condition: AlertCondition): string => {
  switch (condition.kind) {
    case 'calls':
      return 'Any alert() function call';
    case 'fills-calls':
      return 'Order fills and alert() function calls';
    case 'fills':
      return 'Order fills only';
    case 'calls-only':
      return 'alert() function calls only';
    case 'condition':
      return condition.title;
  }
};

export const takesCalls = (condition: AlertCondition): boolean =>
  condition.kind === 'calls' || condition.kind === 'fills-calls' || condition.kind === 'calls-only';

export const takesFills = (condition: AlertCondition): boolean =>
  condition.kind === 'fills' || condition.kind === 'fills-calls';

/**
 * The message a strategy's order fill alert starts with (TradingView's default, as tutorials of
 * its dialog show it: provisional, docs/SPEC.md §11).
 */
export const ORDER_FILL_MESSAGE =
  '{{strategy.order.action}} @ {{strategy.order.contracts}} filled on {{ticker}}. New strategy position is {{strategy.position_size}}';

/** A script as an alert keeps it: its code, its inputs, and its title. */
export interface AlertScript {
  title: string;
  source: string;
  inputs: Inputs;
}

export type AlertStatus = 'active' | 'triggered' | 'stopped';

export interface AlertDef {
  id: string;
  /** The Alert name field; empty for the condition's own. */
  name: string;
  /** "EXCHANGE:TICKER" and the timeframe (TradingView's notation), the chart's when made. */
  symbol: string;
  interval: string;
  script: AlertScript;
  condition: AlertCondition;
  /** For an alertcondition() alert. */
  trigger: AlertTrigger;
  /** The Message field: placeholders fill in when it triggers. alert() calls bring their own. */
  message: string;
  /** Notifications: a pop-up in the app, and a sound. */
  popup: boolean;
  sound: boolean;
  /** Active; stopped after triggering ("Only once"); or stopped by hand. */
  status: AlertStatus;
  created: number;
}

/** One time an alert triggered: the Alerts panel's Log. */
export interface AlertLogEntry {
  id: string;
  alert: string;
  name: string;
  symbol: string;
  interval: string;
  message: string;
  time: number;
}

/** An alert's title as the panel and the pop-up write it: its name, else script and condition. */
export const alertTitle = (alert: AlertDef): string =>
  alert.name.trim() || `${alert.script.title}: ${conditionLabel(alert.condition)}`;

/**
 * When an alert's events trigger it, kept between updates of its run (the script's own state is
 * rolled back on each tick; this isn't).
 */
export class TriggerState {
  /** alert() calls that triggered on a bar, by "bar time:call" (once_per_bar). */
  private readonly calls = new Set<string>();
  /** The bar an alertcondition() alert last triggered on (Once per bar). */
  private conditionBar: number | null = null;
  /** When it last triggered, ms (Once per minute). */
  private lastFired = Number.NEGATIVE_INFINITY;

  /**
   * Whether an alert() call triggers: every call (freq_all), a call's first on its bar
   * (freq_once_per_bar: "only the first time each of the alert() calls is executed during the
   * realtime bar"), or a call on the bar's closing run (freq_once_per_bar_close).
   */
  callFires(event: Pick<AlertEvent, 'call' | 'final'> & { freq: AlertFreq }, barTime: number) {
    if (event.freq === 'all') return true;
    if (event.freq === 'once_per_bar_close') return event.final;
    const key = `${barTime}:${event.call}`;
    if (this.calls.has(key)) return false;
    this.calls.add(key);
    // Bars long gone needn't be remembered.
    if (this.calls.size > 512) this.calls.delete(this.calls.values().next().value as string);
    return true;
  }

  /**
   * Whether an alertcondition() alert triggers on one run of a realtime bar where its condition is
   * `value` (Help Center, Differences between alert frequencies): Only once, the first time;
   * Once per bar, the first time on each bar; Once per bar close, on the bar's closing run; Once
   * per minute, at most once a minute.
   */
  conditionFires(
    trigger: AlertTrigger,
    value: boolean,
    final: boolean,
    barTime: number,
    now: number,
  ): boolean {
    if (!value) return false;
    switch (trigger) {
      case 'once':
        return true;
      case 'close':
        return final;
      case 'bar':
        if (this.conditionBar === barTime) return false;
        this.conditionBar = barTime;
        return true;
      case 'minute':
        if (now - this.lastFired < 60_000) return false;
        this.lastFired = now;
        return true;
    }
  }
}
