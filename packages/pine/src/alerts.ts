/**
 * Alert events, as TradingView's Pine docs describe them (Concepts, Alerts): a script's alert()
 * calls and its alertcondition() conditions, which an alert created on the script turns into
 * notifications. Code creates the events only; the alert itself is made in the app, which runs a
 * copy of the script on its symbol and timeframe and decides when they trigger (apps/web alerts).
 * "Alerts only trigger in the realtime bar": an alert() call on history makes no event.
 */

/** alert()'s `freq` (alert.freq_*): every call, a call's first on each bar, or the bar's close. */
export type AlertFreq = 'all' | 'once_per_bar' | 'once_per_bar_close';

/** One alert() call on a realtime bar. */
export interface AlertEvent {
  /** Which alert() call in the code, by its place: once_per_bar counts each call on its own. */
  call: number;
  message: string;
  freq: AlertFreq;
  /** The bar it ran on, and whether that run was the bar's close (barstate.isconfirmed). */
  bar: number;
  final: boolean;
}

/** An alertcondition() as the Create Alert dialog lists it: its title and its message. */
export interface AlertConditionDef {
  /** "Alert" when the call gives none (the Pine docs). */
  title: string;
  /** A const string: placeholders in it are filled in when the alert triggers. */
  message: string;
}

export const asFreq = (value: string): AlertFreq =>
  value === 'all' || value === 'once_per_bar_close' ? value : 'once_per_bar';

/** What an alert's message placeholders read when it triggers (Pine docs, Alerts: Placeholders). */
export interface PlaceholderContext {
  /** The symbol's exchange and ticker ("BINANCE", "BTCUSDT"). */
  exchange: string;
  ticker: string;
  /** The timeframe the alert runs on, in TradingView's notation ("60", "1D"). */
  interval: string;
  /** The bar it triggered on. */
  bar: { time: number; open: number; high: number; low: number; close: number; volume: number };
  /** When it triggered, ms. */
  now: number;
  /** Each plot's value on that bar, in the script's order, with its title. */
  plots: readonly { title: string; value: number }[];
  /** A strategy's order fill (its {{strategy.*}} placeholders), when one triggered it. */
  order?: {
    action: 'buy' | 'sell';
    contracts: number;
    price: number;
    id: string;
    comment: string;
    alertMessage: string;
    positionSize: number;
    marketPosition: 'long' | 'short' | 'flat';
    prevMarketPosition: 'long' | 'short' | 'flat';
  };
}

/** A time as the placeholders write it: UTC, "yyyy-MM-ddTHH:mm:ssZ" (the Pine docs). */
export function placeholderTime(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * A number as a placeholder writes it: whole numbers plainly, others with up to 8 decimals and no
 * trailing zeros (provisional, docs/SPEC.md §11: TradingView's own formatting isn't documented).
 */
export function placeholderNumber(value: number): string {
  if (!Number.isFinite(value)) return 'NaN';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(8)));
}

/**
 * An alert's message with its placeholders filled in: {{exchange}}, {{interval}}, {{open}},
 * {{high}}, {{low}}, {{close}}, {{volume}}, {{plot_0}}…{{plot_19}}, {{plot("title")}},
 * {{ticker}}, {{time}}, {{timenow}}, and an order fill's {{strategy.order.*}},
 * {{strategy.position_size}}, {{strategy.market_position}} and
 * {{strategy.prev_market_position}}. One it doesn't know stays as written.
 */
export function fillPlaceholders(template: string, ctx: PlaceholderContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, inner: string) => {
    const name = inner.trim();
    const plotTitle = /^plot\(\s*"([^"]*)"\s*\)$/.exec(name);
    if (plotTitle) {
      const plot = ctx.plots.find((p) => p.title === plotTitle[1]);
      return plot ? placeholderNumber(plot.value) : whole;
    }
    const plotIndex = /^plot_(\d+)$/.exec(name);
    if (plotIndex) {
      // "only one of the first 20 plots can be used".
      const k = Number(plotIndex[1]);
      const plot = k < 20 ? ctx.plots[k] : undefined;
      return plot ? placeholderNumber(plot.value) : whole;
    }
    switch (name) {
      case 'exchange':
        return ctx.exchange;
      case 'ticker':
        return ctx.ticker;
      case 'interval':
        return ctx.interval;
      case 'open':
      case 'high':
      case 'low':
      case 'close':
      case 'volume':
        return placeholderNumber(ctx.bar[name]);
      case 'time':
        return placeholderTime(ctx.bar.time);
      case 'timenow':
        return placeholderTime(ctx.now);
    }
    const order = ctx.order;
    if (!order) return whole;
    switch (name) {
      case 'strategy.order.action':
        return order.action;
      case 'strategy.order.contracts':
        return placeholderNumber(order.contracts);
      case 'strategy.order.price':
        return placeholderNumber(order.price);
      case 'strategy.order.id':
        return order.id;
      case 'strategy.order.comment':
        return order.comment;
      case 'strategy.order.alert_message':
        return order.alertMessage;
      case 'strategy.position_size':
        return placeholderNumber(order.positionSize);
      case 'strategy.market_position':
        return order.marketPosition;
      case 'strategy.prev_market_position':
        return order.prevMarketPosition;
      default:
        return whole;
    }
  });
}
