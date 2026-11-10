import { formatPrice } from '@tradingnerd/chart';
import { type Bar, type SessionHours, symbolName } from '@tradingnerd/core';
import type { Inputs } from '@tradingnerd/indicators';
import type { AlertEvent, AlertFreq } from '@tradingnerd/pine';

/**
 * Alerts, as TradingView's Pine docs (Concepts, Alerts) and Help Center describe them. Price
 * alerts watch a symbol's live price against a value ("Crossing", "Greater Than"…). Alerts on
 * scripts take a script's alert() calls, its alertcondition() conditions, or a strategy's order
 * fills, on the symbol and timeframe the alert was made on: TradingView "saves a mirror image of
 * the script and its inputs, along with the chart's main symbol and timeframe", and an alert here
 * keeps a copy too, so changing the chart or the script afterwards leaves it as it was. Ours run
 * while tradingNerd is open (AlertRunner); TradingView's run on its servers around the clock.
 */

/**
 * How often an alert triggers: the Create Alert dialog's Trigger (Help Center, Differences between
 * alert frequencies). An alertcondition() alert has the first four; a price alert has "Only once"
 * and "Every time". alert() calls set their own (`freq`).
 */
export type AlertTrigger = 'once' | 'bar' | 'close' | 'minute' | 'every';

export const TRIGGERS: readonly { value: AlertTrigger; label: string }[] = [
  { value: 'once', label: 'Only once' },
  { value: 'bar', label: 'Once per bar' },
  { value: 'close', label: 'Once per bar close' },
  { value: 'minute', label: 'Once per minute' },
];

/**
 * A price alert's triggers: "Two options are available for regular price-based alerts - Only Once
 * and Every Time. Such alerts are based on the current price, so they are triggered regardless of
 * the interval" (Help Center, Why is the Once Per Bar option missing?).
 */
export const PRICE_TRIGGERS: readonly { value: AlertTrigger; label: string }[] = [
  { value: 'once', label: 'Only once' },
  { value: 'every', label: 'Every time' },
];

/**
 * Every time, at most once a minute: TradingView's frequencies page puts it with Once per minute,
 * "the system checks conditions every minute and triggers an alert whenever conditions are met"
 * (Help Center, Differences between alert frequencies). Provisional (docs/SPEC.md §11).
 */
export const EVERY_TIME_GAP_MS = 60_000;

/**
 * A price alert's operator, the Condition's second drop-down: the five that make an alert a price
 * alert (Help Center, Alerts separation by type). The channel and Moving ones are technical
 * alerts, left for later.
 */
export type PriceOperator =
  | 'crossing'
  | 'crossing_up'
  | 'crossing_down'
  | 'greater_than'
  | 'less_than';

export const PRICE_OPERATORS: readonly { value: PriceOperator; label: string }[] = [
  { value: 'crossing', label: 'Crossing' },
  { value: 'crossing_up', label: 'Crossing Up' },
  { value: 'crossing_down', label: 'Crossing Down' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
];

export const isPriceOperator = (value: unknown): value is PriceOperator =>
  PRICE_OPERATORS.some((op) => op.value === value);

const operatorLabel = (operator: PriceOperator): string =>
  PRICE_OPERATORS.find((op) => op.value === operator)?.label ?? operator;

/** A price alert's condition: its operator and value, with the decimals the symbol's prices have. */
export interface PriceCondition {
  kind: 'price';
  operator: PriceOperator;
  value: number;
  precision: number;
}

/** What an alert listens to: the dialog's Condition (Help Center, Alerts on alert() function). */
export type AlertCondition =
  /** The symbol's price against a value. */
  | PriceCondition
  /** An indicator's: "Any alert() function call". */
  | { kind: 'calls' }
  /** A strategy's three: "Order fills and alert() function calls", "Order fills only" and
   * "alert() function calls only". */
  | { kind: 'fills-calls' }
  | { kind: 'fills' }
  | { kind: 'calls-only' }
  /** One of an indicator's alertcondition() calls, by its place and title. */
  | { kind: 'condition'; index: number; title: string };

/** A price alert's value as its label writes it: with the symbol's decimals. */
export const priceText = (condition: Pick<PriceCondition, 'value' | 'precision'>): string =>
  formatPrice(condition.value, condition.precision);

export const conditionLabel = (condition: AlertCondition): string => {
  switch (condition.kind) {
    case 'price':
      return `${operatorLabel(condition.operator)} ${priceText(condition)}`;
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
  /**
   * "EXCHANGE:TICKER" and the timeframe (TradingView's notation), the chart's when made. A price
   * alert keeps the timeframe for {{interval}} only: it triggers "regardless of the interval".
   */
  symbol: string;
  interval: string;
  /** The script's copy; null for a price alert. */
  script: AlertScript | null;
  condition: AlertCondition;
  /** For an alertcondition() alert and a price alert. */
  trigger: AlertTrigger;
  /**
   * A price alert's hours, the chart's Session setting when made: a stock's pre- and post-market
   * trades count only with extended hours, as TradingView's watchlist alerts' Session setting
   * (provisional, docs/SPEC.md §11). Regular when absent.
   */
  session?: SessionHours;
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

export const isPriceAlert = (alert: Pick<AlertDef, 'condition'>): boolean =>
  alert.condition.kind === 'price';

/**
 * A price alert's own name and message, as TradingView's alert list writes one: "XRPUSDT Crossing
 * 1.3115" (provisional: TradingView's default message isn't documented, §11).
 */
export const priceAlertText = (symbol: string, condition: PriceCondition): string =>
  `${symbolName(symbol)} ${conditionLabel(condition)}`;

/**
 * An alert's title as the panel and the pop-up write it: its name, else the price alert's own
 * text, or the script and its condition.
 */
export const alertTitle = (alert: AlertDef): string => {
  const name = alert.name.trim();
  if (name) return name;
  if (alert.condition.kind === 'price') return priceAlertText(alert.symbol, alert.condition);
  return `${alert.script?.title ?? 'Script'}: ${conditionLabel(alert.condition)}`;
};

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
   * per minute, at most once a minute. Every time is a price alert's; on a condition it reads as
   * Once per minute, which TradingView's page puts it with.
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
      case 'every':
        if (now - this.lastFired < 60_000) return false;
        this.lastFired = now;
        return true;
    }
  }
}

/**
 * What one update of the live price went through: the price before it (`from`; NaN for the first
 * price seen, which has none), then the lowest and highest it traded at and where it ended. Only
 * `from` coming first and `close` last is known: the low and the high came between, in either
 * order.
 */
export interface PriceMove {
  from: number;
  low: number;
  high: number;
  close: number;
}

/**
 * Crossing Up: the price was below the value, then reached it. "The alert triggers only after the
 * price drops below $100,000 and then rises back to that level" (Help Center, Learn how to
 * configure alerts). A gap over the value counts: the price went from below to above it.
 */
export function crossedUp(move: PriceMove, value: number): boolean {
  if (move.from < value) return move.high >= value;
  // From at or above it: below it and back, which only a close at or above it shows.
  return move.low < value && move.close >= value;
}

/** Crossing Down: the price was above the value, then reached it. */
export function crossedDown(move: PriceMove, value: number): boolean {
  if (move.from > value) return move.low <= value;
  return move.high > value && move.close <= value;
}

/**
 * Whether an update meets a price alert's condition. Crossing, Crossing Up and Crossing Down are
 * moves through the value, so the first price seen meets none of them. Greater Than and Less Than
 * are where the price is: "Greater than / Less than. For example, the current BTC price is
 * $105,000. You set a Less than alert at $100,000. The notification will trigger when the BTC
 * price falls to $99,999.99" (Help Center, How to use price alerts). A price already beyond the
 * value meets them at once; TradingView doesn't say, so that's provisional (§11).
 */
export function priceConditionMet(
  condition: Pick<PriceCondition, 'operator' | 'value'>,
  move: PriceMove,
): boolean {
  const { operator, value } = condition;
  if (Number.isNaN(move.from)) {
    if (operator === 'greater_than') return move.close > value;
    if (operator === 'less_than') return move.close < value;
    return false;
  }
  switch (operator) {
    case 'crossing':
      return crossedUp(move, value) || crossedDown(move, value);
    case 'crossing_up':
      return crossedUp(move, value);
    case 'crossing_down':
      return crossedDown(move, value);
    case 'greater_than':
      return move.high > value;
    case 'less_than':
      return move.low < value;
  }
}

/**
 * Turns a live bar stream into price moves. Each update of a bar brings its close; a new high or
 * low means the price traded there since the update before. A bar's earlier highs and lows hide
 * what came back inside them, which is why price alerts watch 1-minute bars (AlertRunner): their
 * range starts afresh each minute. The first bar seen is the start: its close only, as what it
 * traded before came before the alert.
 */
export class PriceWatch {
  private last: { time: number; low: number; high: number; close: number } | null = null;

  /** The move this bar makes, or null for a bar before the latest (not the live price). */
  move(bar: Bar): PriceMove | null {
    const last = this.last;
    if (last && bar.time < last.time) return null;
    let low = bar.close;
    let high = bar.close;
    if (last && bar.time === last.time) {
      if (bar.low < last.low) low = Math.min(low, bar.low);
      if (bar.high > last.high) high = Math.max(high, bar.high);
    } else if (last) {
      // A new bar: everything it traded is new.
      low = Math.min(low, bar.low);
      high = Math.max(high, bar.high);
    }
    const same = last !== null && bar.time === last.time;
    this.last = {
      time: bar.time,
      low: same ? Math.min(last.low, bar.low) : bar.low,
      high: same ? Math.max(last.high, bar.high) : bar.high,
      close: bar.close,
    };
    return { from: last ? last.close : Number.NaN, low, high, close: bar.close };
  }
}

/**
 * When a price alert triggers, kept between the updates of its live price: Only once, the first
 * time its condition is met (the runner then stops it); Every time, each time it's met, at most
 * once a minute (EVERY_TIME_GAP_MS).
 */
export class PriceTrigger {
  private readonly condition: PriceCondition;
  private readonly every: boolean;
  private readonly watch = new PriceWatch();
  private lastFired = Number.NEGATIVE_INFINITY;

  constructor(condition: PriceCondition, trigger: AlertTrigger) {
    this.condition = condition;
    this.every = trigger === 'every';
  }

  /** Whether the alert triggers on this bar of its live stream, at `now` (ms). */
  update(bar: Bar, now: number): boolean {
    const move = this.watch.move(bar);
    if (!move || !priceConditionMet(this.condition, move)) return false;
    if (this.every && now - this.lastFired < EVERY_TIME_GAP_MS) return false;
    this.lastFired = now;
    return true;
  }
}
