import { Args, type Call, constant, type Handler, series } from './args.ts';
import type { Compiler, Scope } from './compiler.ts';
import type { Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import { CONST, type Compiled, SERIES, SIMPLE } from './types.ts';
import type { Value } from './values.ts';

/**
 * Pine's strategies (Pine docs: Strategies; the v6 reference's strategy() and strategy.*): orders
 * a script places, filled by a broker emulator on the chart's own bars, and the trades and
 * figures that come of them. The emulator's rules are the manual's (Broker emulator, Orders and
 * trades, Order types, Order placement and cancellation, Closing a market position, OCA groups,
 * Simulating trading costs, Margin):
 * - an order placed on a bar's close fills from the next bar's open; market orders at the open;
 * - inside a bar the price is assumed to go open → high → low → close when the open is nearer
 *   the high, open → low → high → close when nearer the low, with no gaps inside the bar;
 * - a price order crossed in the gap between two bars fills at the bar's open;
 * - limit orders fill at their price or better, stop orders at theirs or worse, slippage added to
 *   market and stop fills;
 * - entries reverse an opposite position, pyramiding caps the entries in one direction, exits
 *   close trades oldest first unless `close_entries_rule = "ANY"`.
 * What the manual doesn't say is provisional (docs/SPEC.md §11): an open at equal distance from
 * the high and the low goes up first; quantities sized from cash or equity are whole for stocks
 * and funds and to 8 decimals for the rest; the drawdown and run-up figures use the bars' highs
 * and lows.
 */

/** The strategy() declaration's properties, at the reference's defaults. */
export interface StrategyProps {
  initialCapital: number;
  /** strategy.fixed, strategy.cash or strategy.percent_of_equity, as their text. */
  qtyType: 'fixed' | 'cash' | 'percent_of_equity';
  qtyValue: number;
  /** Entries allowed in one direction: 0 and 1 both allow one. */
  pyramiding: number;
  commissionType: 'percent' | 'cash_per_contract' | 'cash_per_order';
  commissionValue: number;
  /** In ticks, against the trade, on market and stop fills. */
  slippage: number;
  processOrdersOnClose: boolean;
  closeEntriesRule: 'FIFO' | 'ANY';
  /** Percent of a position's value covered by the strategy's own funds; 0 for no limit. */
  marginLong: number;
  marginShort: number;
  calcOnOrderFills: boolean;
  calcOnEveryTick: boolean;
  /** Ticks past a limit's price the market must go before it fills. */
  fillLimitsAssumption: number;
  /** The account's currency; '' for the chart's own (currency.NONE). */
  currency: string;
  riskFreeRate: number;
  useBarMagnifier: boolean;
}

export const DEFAULT_STRATEGY: Readonly<StrategyProps> = {
  initialCapital: 1_000_000,
  qtyType: 'fixed',
  qtyValue: 1,
  pyramiding: 0,
  commissionType: 'percent',
  commissionValue: 0,
  slippage: 0,
  processOrdersOnClose: false,
  closeEntriesRule: 'FIFO',
  marginLong: 100,
  marginShort: 100,
  calcOnOrderFills: false,
  calcOnEveryTick: false,
  fillLimitsAssumption: 0,
  currency: '',
  riskFreeRate: 2,
  useBarMagnifier: false,
};

/** strategy()'s own parameters, after indicator()'s common ones, in the reference's order. */
export const STRATEGY_PARAMS = [
  'title',
  'shorttitle',
  'overlay',
  'format',
  'precision',
  'scale',
  'pyramiding',
  'calc_on_order_fills',
  'calc_on_every_tick',
  'max_bars_back',
  'backtest_fill_limits_assumption',
  'default_qty_type',
  'default_qty_value',
  'initial_capital',
  'currency',
  'slippage',
  'commission_type',
  'commission_value',
  'process_orders_on_close',
  'close_entries_rule',
  'margin_long',
  'margin_short',
  'explicit_plot_zorder',
  'max_lines_count',
  'max_labels_count',
  'max_boxes_count',
  'calc_bars_count',
  'risk_free_rate',
  'use_bar_magnifier',
  'fill_orders_on_standard_ohlc',
  'max_polylines_count',
  'dynamic_requests',
  'behind_chart',
] as const;

/** Reads strategy()'s properties from its call (constants, as the reference types them). */
export function strategyProps(c: Compiler, args: Args): StrategyProps {
  const num = (name: string, fallback: number) => {
    const value = args.constant(name, fallback, 'float');
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const bool = (name: string, fallback: boolean) => {
    const value = args.constant(name, fallback, 'bool');
    return value === null ? fallback : value === true;
  };
  const text = (name: string, fallback: string) => {
    const value = args.constant(name, fallback, null);
    return typeof value === 'string' ? value : fallback;
  };
  const qtyType = text('default_qty_type', 'fixed');
  const commissionType = text('commission_type', 'percent');
  const rule = text('close_entries_rule', 'FIFO').toUpperCase();
  const currency = text('currency', '');
  void c;
  return {
    initialCapital: num('initial_capital', DEFAULT_STRATEGY.initialCapital),
    qtyType:
      qtyType === 'cash' || qtyType === 'percent_of_equity' ? qtyType : DEFAULT_STRATEGY.qtyType,
    qtyValue: num('default_qty_value', DEFAULT_STRATEGY.qtyValue),
    pyramiding: Math.max(0, Math.floor(num('pyramiding', 0))),
    commissionType:
      commissionType === 'cash_per_contract' || commissionType === 'cash_per_order'
        ? commissionType
        : 'percent',
    commissionValue: num('commission_value', 0),
    slippage: Math.max(0, Math.floor(num('slippage', 0))),
    processOrdersOnClose: bool('process_orders_on_close', false),
    closeEntriesRule: rule === 'ANY' ? 'ANY' : 'FIFO',
    marginLong: Math.max(0, num('margin_long', DEFAULT_STRATEGY.marginLong)),
    marginShort: Math.max(0, num('margin_short', DEFAULT_STRATEGY.marginShort)),
    calcOnOrderFills: bool('calc_on_order_fills', false),
    calcOnEveryTick: bool('calc_on_every_tick', false),
    fillLimitsAssumption: Math.max(0, Math.floor(num('backtest_fill_limits_assumption', 0))),
    currency: currency === 'NONE' ? '' : currency,
    riskFreeRate: num('risk_free_rate', DEFAULT_STRATEGY.riskFreeRate),
    useBarMagnifier: bool('use_bar_magnifier', false),
  };
}

// ---- trades and orders ----

/** A trade, open or closed: one entry's fill, and for a closed one the exit that ended it. */
export interface Trade {
  /** In the order trades were opened. */
  num: number;
  entryId: string;
  entryComment: string;
  /** The bar its entry order was placed on: an exit for its id covers it from there. */
  entryOrderBar: number;
  entryBar: number;
  /** In milliseconds. */
  entryTime: number;
  entryPrice: number;
  /** Signed: positive long, negative short; what's still open for an open trade. */
  size: number;
  /** The entry's commission, per unit, so a partial close takes its share. */
  entryCommissionPerUnit: number;
  /** Best and worst unrealized profit while open, in money, both positive. */
  maxRunup: number;
  maxDrawdown: number;
  exitId: string;
  exitComment: string;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  /** The closed part's profit, both commissions taken off. */
  profit: number;
  commission: number;
}

/** A fill, as the chart marks it: where, how much, which way and the order's name. */
export interface StrategyFill {
  bar: number;
  time: number;
  price: number;
  /** Signed: positive bought, negative sold. */
  qty: number;
  /** Opened or added to a position (an entry), or reduced or closed one (an exit). */
  entry: boolean;
  /** The order's comment if it has one, else its id. */
  name: string;
  /** The position after the fill. */
  position: number;
}

type OcaType = 'none' | 'cancel' | 'reduce';

/** An order from strategy.entry(), strategy.order(), strategy.close() or strategy.close_all(). */
interface Order {
  id: string;
  kind: 'entry' | 'order' | 'close' | 'close_all';
  /** For entries and orders. */
  side: 1 | -1;
  /** Units; NaN for the strategy's default size (entries and orders). */
  qty: number;
  /** For strategy.close(): a share of the trades with its id, when qty isn't given. */
  qtyPercent: number;
  limit: number;
  stop: number;
  /** A stop-limit whose stop has been reached: its limit is active now. */
  triggered: boolean;
  ocaName: string;
  ocaType: OcaType;
  comment: string;
  placedBar: number;
  /** strategy.close(…, immediately = true): fills on the tick it's placed. */
  immediately: boolean;
}

/** A strategy.exit() call: its bracket's levels, for the trades it covers. */
interface ExitRule {
  id: string;
  fromEntry: string;
  qty: number;
  qtyPercent: number;
  profit: number;
  limit: number;
  loss: number;
  stop: number;
  trailPrice: number;
  trailPoints: number;
  trailOffset: number;
  ocaName: string;
  comment: string;
  commentProfit: string;
  commentLoss: string;
  commentTrailing: string;
  placedBar: number;
  /** Order of first placement: earlier calls reserve their part of a trade first. */
  order: number;
}

/** One exit call's orders for one trade: how much of it they may still close, its trail. */
interface Bracket {
  /** Units still to close; set when first applied. */
  remaining: number;
  /** A trailing stop's best price since it activated, NaN before. */
  best: number;
}

/** What a fill touches while a bar's prices are walked. */
interface Pending {
  price: number;
  /** Ordering inside one tick: market before price orders, then by creation. */
  rank: number;
  run: (price: number) => void;
}

const isNum = (x: number) => !Number.isNaN(x);
const naNum = (v: Value | undefined) => (typeof v === 'number' ? v : Number.NaN);

// ---- the broker emulator ----

/** Figures the Strategy Tester and the strategy.* variables share. */
export interface StrategyFigures {
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  commission: number;
  wins: number;
  losses: number;
  evens: number;
  maxContractsAll: number;
  maxContractsLong: number;
  maxContractsShort: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  maxRunup: number;
  maxRunupPercent: number;
  marginCalls: number;
}

/** What the chart and the Strategy Tester read of a run: copies, as of its last bar. */
export interface StrategyState {
  props: StrategyProps;
  open: Trade[];
  closed: Trade[];
  fills: StrategyFill[];
  figures: StrategyFigures;
  /** Equity after each closed trade, from the initial capital. */
  equityByTrade: number[];
  /** The last bar's close and open profit, for the open trades' figures. */
  lastClose: number;
  openProfit: number;
  /** The first and last bars it ran on, their times (ms), and the first close (buy & hold). */
  firstBar: number;
  lastBar: number;
  firstTime: number;
  lastTime: number;
  firstClose: number;
  /** The symbol's price step, to write prices at its precision. */
  mintick: number;
}

const blankFigures = (): StrategyFigures => ({
  netProfit: 0,
  grossProfit: 0,
  grossLoss: 0,
  commission: 0,
  wins: 0,
  losses: 0,
  evens: 0,
  maxContractsAll: 0,
  maxContractsLong: 0,
  maxContractsShort: 0,
  maxDrawdown: 0,
  maxDrawdownPercent: 0,
  maxRunup: 0,
  maxRunupPercent: 0,
  marginCalls: 0,
});

/** The broker emulator of one run: its orders, trades and figures. */
export class Broker {
  readonly props: StrategyProps;
  open: Trade[] = [];
  closed: Trade[] = [];
  fills: StrategyFill[] = [];
  figures: StrategyFigures = blankFigures();
  private orders: Order[] = [];
  private exits = new Map<string, ExitRule>();
  /** By exit id, then trade number. */
  private brackets = new Map<string, Map<number, Bracket>>();
  private tradeCount = 0;
  private exitCount = 0;
  /** Equity's highest and lowest so far, for drawdown and run-up. */
  private peak = Number.NaN;
  private trough = Number.NaN;
  private equityByTrade: number[] = [];
  /** strategy.risk.*: the direction entries may take, the largest position, a halt. */
  allowed: 'all' | 'long' | 'short' = 'all';
  maxPositionSize = Number.NaN;
  private riskDrawdown: { value: number; percent: boolean } | null = null;
  private riskIntradayLoss: { value: number; percent: boolean } | null = null;
  private riskIntradayFills = Number.NaN;
  private riskConsLossDays = Number.NaN;
  private halted = false;
  private haltedDay = '';
  private dayFills = 0;
  private day = '';
  private dayStartEquity = Number.NaN;
  private consLossDays = 0;
  /** The time (ms) of the bar being processed. */
  private time = 0;
  /** Bumped by every change, so a reader can tell when there's something new. */
  version = 0;
  firstBar = -1;
  lastBar = -1;
  firstTime = 0;
  lastTime = 0;
  firstClose = Number.NaN;
  lastClose = Number.NaN;
  mintick = 0.01;

  constructor(props: StrategyProps) {
    this.props = props;
  }

  // ---- the position ----

  get position(): number {
    let size = 0;
    for (const trade of this.open) size += trade.size;
    return Math.abs(size) < 1e-12 ? 0 : size;
  }

  get avgPrice(): number {
    let size = 0;
    let cost = 0;
    for (const trade of this.open) {
      size += trade.size;
      cost += trade.size * trade.entryPrice;
    }
    return size === 0 ? Number.NaN : cost / size;
  }

  openProfitAt(price: number): number {
    let profit = 0;
    for (const trade of this.open) profit += (price - trade.entryPrice) * trade.size;
    return profit;
  }

  equityAt(price: number): number {
    return this.props.initialCapital + this.figures.netProfit + this.openProfitAt(price);
  }

  // ---- placing orders (strategy.entry() and the rest) ----

  /** A change on the live bar is undone before its next update, as variables are. */
  private touch(rt: Runtime): void {
    rt.touch(this, () => {
      const saved = this.capture();
      return () => this.restore(saved);
    });
    this.version++;
  }

  place(rt: Runtime, order: Omit<Order, 'triggered' | 'placedBar'>): void {
    if (this.halted) return;
    this.touch(rt);
    // "If an unfilled order with the same id exists, a call to this command modifies that
    // order" (the reference, strategy.entry()); a closing order is one per id too.
    const same = this.orders.findIndex((o) => o.id === order.id && o.kind === order.kind);
    const next: Order = { ...order, triggered: false, placedBar: rt.index };
    if (same >= 0) this.orders[same] = next;
    else this.orders.push(next);
    // strategy.close(…, immediately = true) and process_orders_on_close fill on this tick.
  }

  exit(rt: Runtime, rule: Omit<ExitRule, 'placedBar' | 'order'>): void {
    if (this.halted) return;
    this.touch(rt);
    const old = this.exits.get(rule.id);
    this.exits.set(rule.id, {
      ...rule,
      placedBar: rt.index,
      order: old?.order ?? this.exitCount++,
    });
  }

  cancel(rt: Runtime, id: string | null): void {
    this.touch(rt);
    if (id === null) {
      this.orders = [];
      this.exits.clear();
      this.brackets.clear();
      return;
    }
    this.orders = this.orders.filter((o) => o.id !== id);
    if (this.exits.delete(id)) this.brackets.delete(id);
  }

  setRisk(rt: Runtime, change: (broker: Broker) => void): void {
    this.touch(rt);
    change(this);
  }

  limitDrawdown(value: number, percent: boolean): void {
    this.riskDrawdown = { value, percent };
  }

  limitIntradayLoss(value: number, percent: boolean): void {
    this.riskIntradayLoss = { value, percent };
  }

  limitIntradayFills(count: number): void {
    this.riskIntradayFills = count;
  }

  limitConsLossDays(count: number): void {
    this.riskConsLossDays = count;
  }

  // ---- a bar ----

  /** Before the script runs on a bar: the orders placed before it fill on its prices. */
  openBar(rt: Runtime): void {
    const bar = rt.bar;
    this.touch(rt);
    this.time = bar.time * 1000;
    if (this.firstBar < 0) {
      this.firstBar = rt.index;
      this.firstTime = this.time;
      this.firstClose = bar.close;
    }
    this.newDay(rt);
    if (this.orders.length === 0 && this.open.length === 0) return;
    const { open: o, high: h, low: l, close: c } = bar;
    this.tick(rt, o, true);
    // Open nearer the high: up first; nearer the low: down first (equal: up, provisional).
    const path = h - o <= o - l ? [o, h, l, c] : [o, l, h, c];
    for (let i = 1; i < path.length; i++) this.walk(rt, path[i - 1] as number, path[i] as number);
  }

  /** After the script ran on a bar: orders filled on its close, then the bar's figures. */
  closeBar(rt: Runtime): void {
    const bar = rt.bar;
    this.lastBar = rt.index;
    this.lastTime = bar.time * 1000;
    this.lastClose = bar.close;
    this.mintick = rt.symbol.mintick || 0.01;
    const onClose = this.orders.filter(
      (o) =>
        o.placedBar === rt.index &&
        isMarket(o) &&
        (o.immediately || this.props.processOrdersOnClose),
    );
    if (onClose.length > 0) {
      this.touch(rt);
      for (const order of onClose) this.fillMarket(rt, order, bar.close);
    }
    if (this.open.length > 0 || onClose.length > 0) this.touch(rt);
    this.marginCall(rt);
    this.barFigures(rt);
    this.checkRisk(rt);
  }

  /** The open tick: market orders, and price orders the gap since the last close crossed. */
  private tick(rt: Runtime, price: number, opening: boolean): void {
    if (opening) {
      for (const order of [...this.orders]) {
        if (isMarket(order) && order.placedBar < rt.index) this.fillMarket(rt, order, price);
      }
    }
    // A price order already reached at the open fills there (the manual: Broker emulator).
    for (let guard = 0; guard < 1000; guard++) {
      const due = this.pending(rt).filter((p) => this.reachedAt(p, price));
      if (due.length === 0) return;
      due.sort((a, b) => a.rank - b.rank);
      (due[0] as Pending).run(price);
    }
  }

  private reachedAt(p: Pending & { dir?: 1 | -1 }, price: number): boolean {
    // dir 1: fills when the price is at or above its level; -1: at or below.
    return p.dir === 1 ? price >= p.price : price <= p.price;
  }

  /** The price moves from `from` to `to`: each order it reaches fills, nearest first. */
  private walk(rt: Runtime, from: number, to: number): void {
    const up = to > from;
    if (to === from) return;
    this.updateTrails(rt, from, to, up, true);
    let start = from;
    for (let guard = 0; guard < 1000; guard++) {
      let best: (Pending & { dir?: 1 | -1 }) | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const p of this.pending(rt)) {
        const dir = (p as Pending & { dir?: 1 | -1 }).dir;
        if (up ? dir !== 1 : dir !== -1) continue;
        const inside = up ? p.price > start && p.price <= to : p.price < start && p.price >= to;
        if (!inside) continue;
        const distance = Math.abs(p.price - start);
        if (
          distance < bestDistance ||
          (distance === bestDistance && best !== null && p.rank < best.rank)
        ) {
          best = p;
          bestDistance = distance;
        }
      }
      if (!best) break;
      start = best.price;
      best.run(best.price);
    }
    this.updateTrails(rt, from, to, up, false);
  }

  /** Every resting price order, with the level and side that fills it. */
  private pending(rt: Runtime): (Pending & { dir: 1 | -1 })[] {
    const tick = rt.symbol.mintick || 0.01;
    const out: (Pending & { dir: 1 | -1 })[] = [];
    let rank = 0;
    for (const order of this.orders) {
      // Placed on this bar's close: it waits for the next bar (the manual: Orders and trades).
      if (order.placedBar >= rt.index || isMarket(order)) continue;
      const side = order.kind === 'entry' || order.kind === 'order' ? order.side : 0;
      if (side === 0) continue;
      const limitLevel = isNum(order.limit)
        ? order.limit - side * this.props.fillLimitsAssumption * tick
        : Number.NaN;
      if (isNum(order.stop) && !order.triggered) {
        // A stop (or a stop-limit's stop): buying when the price reaches it from below.
        out.push({
          price: order.stop,
          dir: side === 1 ? 1 : -1,
          rank: rank++,
          run: (price) => {
            if (isNum(order.limit)) {
              order.triggered = true;
              this.version++;
              // Its limit is active now: marketable at once if the price is already there.
              if (side === 1 ? price <= limitLevel : price >= limitLevel) {
                this.fillPriceOrder(rt, order, price);
              }
              return;
            }
            this.fillPriceOrder(rt, order, price + side * this.props.slippage * tick);
          },
        });
      } else if (isNum(order.limit)) {
        out.push({
          price: limitLevel,
          dir: side === 1 ? -1 : 1,
          rank: rank++,
          // A limit fills at its price, or better when the market opened past it.
          run: (price) =>
            this.fillPriceOrder(
              rt,
              order,
              side === 1 ? Math.min(order.limit, price) : Math.max(order.limit, price),
            ),
        });
      }
    }
    for (const bracket of this.bracketOrders(rt)) out.push({ ...bracket, rank: rank++ });
    return out;
  }

  // ---- exits ----

  /** The exit calls' take-profit, stop-loss and trailing stop orders for each trade they cover. */
  private bracketOrders(rt: Runtime): { price: number; dir: 1 | -1; run: (p: number) => void }[] {
    if (this.exits.size === 0 || this.open.length === 0) return [];
    const tick = rt.symbol.mintick || 0.01;
    const out: { price: number; dir: 1 | -1; run: (p: number) => void }[] = [];
    const rules = [...this.exits.values()].sort((a, b) => a.order - b.order);
    // What earlier calls reserved of each trade (the manual: Partial and multi-level exits).
    const reserved = new Map<number, number>();
    for (const rule of rules) {
      let held = this.brackets.get(rule.id);
      for (const trade of this.open) {
        if (!this.covers(rule, trade)) continue;
        if (!held) {
          held = new Map();
          this.brackets.set(rule.id, held);
        }
        const size = Math.abs(trade.size);
        const taken = reserved.get(trade.num) ?? 0;
        let bracket = held.get(trade.num);
        if (!bracket) {
          const want = isNum(rule.qty) ? rule.qty : (size * rule.qtyPercent) / 100;
          bracket = { remaining: Math.max(0, Math.min(want, size - taken)), best: Number.NaN };
          held.set(trade.num, bracket);
        }
        const qty = Math.min(bracket.remaining, size - taken);
        reserved.set(trade.num, taken + qty);
        if (qty <= 0) continue;
        const side = trade.size > 0 ? 1 : -1;
        const entry = trade.entryPrice;
        // Of a level in ticks and one as a price, the one the market reaches first.
        const nearest = (fromTicks: number, price: number, favorable: boolean) => {
          const a = isNum(fromTicks) ? entry + (favorable ? side : -side) * fromTicks * tick : NaN;
          if (!isNum(a)) return price;
          if (!isNum(price)) return a;
          return favorable === side > 0 ? Math.min(a, price) : Math.max(a, price);
        };
        const tp = nearest(rule.profit, rule.limit, true);
        let sl = nearest(rule.loss, rule.stop, false);
        // An active trailing stop: of it and the stop-loss, the one reached first.
        const trail = this.trailLevel(rule, trade, bracket, tick);
        let trailing = false;
        if (isNum(trail) && (!isNum(sl) || (side > 0 ? trail > sl : trail < sl))) {
          sl = trail;
          trailing = true;
        }
        const fill = (price: number, comment: string) =>
          this.fillExit(rt, rule, trade, bracket as Bracket, price, comment);
        if (isNum(tp)) {
          // A take-profit is a limit order: at its price or better.
          out.push({
            price: tp,
            dir: side > 0 ? 1 : -1,
            run: (price) =>
              fill(side > 0 ? Math.max(tp, price) : Math.min(tp, price), rule.commentProfit),
          });
        }
        if (isNum(sl)) {
          out.push({
            price: sl,
            dir: side > 0 ? -1 : 1,
            run: (price) =>
              fill(
                price - side * this.props.slippage * tick,
                trailing ? rule.commentTrailing : rule.commentLoss,
              ),
          });
        }
      }
    }
    return out;
  }

  /** Whether an exit call covers a trade: its entry id, placed before or on the call's bar. */
  private covers(rule: ExitRule, trade: Trade): boolean {
    if (rule.fromEntry === '') return true;
    return trade.entryId === rule.fromEntry && trade.entryOrderBar <= rule.placedBar;
  }

  /** A trailing stop's level once active; NaN before it activates or without one. */
  private trailLevel(rule: ExitRule, trade: Trade, bracket: Bracket, tick: number): number {
    if (!isNum(rule.trailOffset) || !isNum(bracket.best)) return Number.NaN;
    const side = trade.size > 0 ? 1 : -1;
    return bracket.best - side * rule.trailOffset * tick;
  }

  /** The activation level a trailing stop waits for: the one of its two the market reaches first. */
  private trailActivation(rule: ExitRule, trade: Trade, tick: number): number {
    if (!isNum(rule.trailOffset)) return Number.NaN;
    const side = trade.size > 0 ? 1 : -1;
    const fromPoints = isNum(rule.trailPoints)
      ? trade.entryPrice + side * rule.trailPoints * tick
      : Number.NaN;
    const a = fromPoints;
    const b = rule.trailPrice;
    if (!isNum(a)) return b;
    if (!isNum(b)) return a;
    return side > 0 ? Math.min(a, b) : Math.max(a, b);
  }

  /**
   * Trailing stops along a move: one activates when the market reaches its level, then follows
   * the best price by its offset. Activations are checked as the move starts, the best price
   * taken as it ends (a stop can't be hit while the price moves its own way).
   */
  private updateTrails(
    rt: Runtime,
    from: number,
    to: number,
    up: boolean,
    starting: boolean,
  ): void {
    if (this.exits.size === 0) return;
    const tick = rt.symbol.mintick || 0.01;
    for (const rule of this.exits.values()) {
      if (!isNum(rule.trailOffset)) continue;
      const held = this.brackets.get(rule.id);
      if (!held) continue;
      for (const trade of this.open) {
        const bracket = held.get(trade.num);
        if (!bracket || bracket.remaining <= 0) continue;
        const side = trade.size > 0 ? 1 : -1;
        const favorable = side > 0 ? up : !up;
        if (!favorable) continue;
        const level = this.trailActivation(rule, trade, tick);
        if (starting) {
          if (!isNum(bracket.best) && isNum(level) && (side > 0 ? to >= level : to <= level)) {
            bracket.best = side > 0 ? Math.max(level, from) : Math.min(level, from);
            this.version++;
          }
        } else if (isNum(bracket.best)) {
          bracket.best = side > 0 ? Math.max(bracket.best, to) : Math.min(bracket.best, to);
        }
      }
    }
  }

  private fillExit(
    rt: Runtime,
    rule: ExitRule,
    trade: Trade,
    bracket: Bracket,
    price: number,
    comment: string,
  ): void {
    const qty = Math.min(bracket.remaining, Math.abs(trade.size), Math.abs(this.position));
    if (qty <= 0) return;
    bracket.remaining -= qty;
    // Exits with an OCA name reduce the others in it by what filled.
    if (rule.ocaName !== '') {
      for (const other of this.exits.values()) {
        if (other === rule || other.ocaName !== rule.ocaName) continue;
        const held = this.brackets.get(other.id);
        for (const b of held?.values() ?? []) b.remaining = Math.max(0, b.remaining - qty);
      }
    }
    const name = comment || rule.comment || rule.id;
    this.reduce(rt, qty, trade, rule.id, name, price, true);
  }

  // ---- fills ----

  private fillMarket(rt: Runtime, order: Order, raw: number): void {
    const tick = rt.symbol.mintick || 0.01;
    const index = this.orders.indexOf(order);
    if (index < 0) return;
    this.orders.splice(index, 1);
    if (order.kind === 'close' || order.kind === 'close_all') {
      const side = this.position > 0 ? -1 : 1;
      const price = raw + side * this.props.slippage * tick;
      if (order.kind === 'close_all') {
        const all = Math.abs(this.position);
        if (all > 0)
          this.reduce(rt, all, null, '', order.comment || 'Close position order', price, false);
        return;
      }
      const ofId = this.open.filter((t) => t.entryId === order.id);
      const total = ofId.reduce((sum, t) => sum + Math.abs(t.size), 0);
      if (total <= 0) return;
      const qty = isNum(order.qty) ? Math.min(order.qty, total) : (total * order.qtyPercent) / 100;
      if (qty <= 0) return;
      const name = order.comment || `Close entry(s) order ${order.id}`;
      this.reduce(rt, qty, ofId[0] ?? null, '', name, price, false);
      return;
    }
    this.fillEntry(rt, order, raw + order.side * this.props.slippage * tick);
  }

  private fillPriceOrder(rt: Runtime, order: Order, price: number): void {
    const index = this.orders.indexOf(order);
    if (index < 0) return;
    this.orders.splice(index, 1);
    this.fillEntry(rt, order, price);
  }

  /** An entry or an order fills: a new trade, more of one, or a reversal (the manual). */
  private fillEntry(rt: Runtime, order: Order, price: number): void {
    const side = order.side;
    let qty = isNum(order.qty) ? order.qty : this.defaultQty(rt, price);
    if (!(qty > 0)) return;
    const position = this.position;
    const name = order.comment || order.id;
    if (order.kind === 'entry') {
      // strategy.risk.allow_entry_in(): an entry the other way only closes the position.
      if (this.allowed !== 'all' && (this.allowed === 'long') !== (side === 1)) {
        if (position * side < 0)
          this.reduce(rt, Math.abs(position), null, order.id, name, price, false);
        this.oca(order, qty);
        return;
      }
      if (position * side > 0) {
        const same = this.open.filter((t) => Math.sign(t.size) === side).length;
        if (same >= Math.max(1, this.props.pyramiding)) return;
      }
      if (isNum(this.maxPositionSize)) {
        const room = this.maxPositionSize - (position * side > 0 ? Math.abs(position) : 0);
        qty = Math.min(qty, Math.max(0, room));
        if (qty <= 0) return;
      }
      this.oca(order, qty);
      if (position * side < 0) {
        // A reversal: the position closes and the new one opens, in one fill of both sizes.
        const all = Math.abs(position);
        this.reduce(rt, all, null, order.id, name, price, false, true);
        this.openTrade(rt, order, side, qty, price);
        this.addFill(rt, price, side * (qty + all), true, name);
        return;
      }
      this.openTrade(rt, order, side, qty, price);
      this.addFill(rt, price, side * qty, true, name);
      return;
    }
    // strategy.order(): the position becomes its sum with the order (no reversal, no pyramiding).
    this.oca(order, qty);
    let rest = qty;
    if (position * side < 0) {
      const closing = Math.min(qty, Math.abs(position));
      this.reduce(rt, closing, null, order.id, name, price, false, true);
      rest -= closing;
    }
    if (rest > 1e-12) this.openTrade(rt, order, side, rest, price);
    this.addFill(rt, price, side * qty, rest > 1e-12, name);
  }

  /** OCA groups: a fill cancels or reduces the other orders of its group (the manual). */
  private oca(order: Order, filled: number): void {
    if (order.ocaName === '' || order.ocaType === 'none') return;
    for (const other of [...this.orders]) {
      if (other === order || other.ocaName !== order.ocaName || other.ocaType !== order.ocaType)
        continue;
      if (order.ocaType === 'cancel') {
        this.orders.splice(this.orders.indexOf(other), 1);
      } else if (isNum(other.qty)) {
        other.qty -= filled;
        if (other.qty <= 0) this.orders.splice(this.orders.indexOf(other), 1);
      }
    }
  }

  private openTrade(rt: Runtime, order: Order, side: 1 | -1, qty: number, price: number): void {
    const commission = this.commissionOf(qty, price);
    this.open.push({
      num: this.tradeCount++,
      entryId: order.id,
      entryComment: order.comment,
      entryOrderBar: order.placedBar,
      entryBar: rt.index,
      entryTime: this.time,
      entryPrice: price,
      size: side * qty,
      entryCommissionPerUnit: commission / qty,
      maxRunup: 0,
      maxDrawdown: 0,
      exitId: '',
      exitComment: '',
      exitBar: -1,
      exitTime: Number.NaN,
      exitPrice: Number.NaN,
      profit: Number.NaN,
      commission,
    });
    this.figures.commission += commission;
    this.dayFills++;
    const size = Math.abs(this.position);
    const f = this.figures;
    f.maxContractsAll = Math.max(f.maxContractsAll, size);
    if (this.position > 0) f.maxContractsLong = Math.max(f.maxContractsLong, size);
    else f.maxContractsShort = Math.max(f.maxContractsShort, size);
  }

  /**
   * Closes `qty` of the position at `price`: oldest trades first, or `prefer` first with
   * `close_entries_rule = "ANY"` (the manual: Closing a market position).
   */
  private reduce(
    rt: Runtime,
    qty: number,
    prefer: Trade | null,
    exitId: string,
    name: string,
    price: number,
    mark: boolean,
    partOfEntry = false,
  ): void {
    const commission = this.commissionOf(qty, price);
    const sold = this.position > 0 ? -1 : 1;
    let left = qty;
    const order =
      this.props.closeEntriesRule === 'ANY' && prefer
        ? [prefer, ...this.open.filter((t) => t !== prefer)]
        : [...this.open];
    for (const trade of order) {
      if (left <= 1e-12) break;
      const size = Math.abs(trade.size);
      const part = Math.min(size, left);
      const side = trade.size > 0 ? 1 : -1;
      const share = commission * (part / qty);
      const entryCommission = trade.entryCommissionPerUnit * part;
      const profit = (price - trade.entryPrice) * side * part - entryCommission - share;
      const closed: Trade = {
        ...trade,
        size: side * part,
        exitId: exitId || name,
        exitComment: name,
        exitBar: rt.index,
        exitTime: this.time,
        exitPrice: price,
        profit,
        commission: entryCommission + share,
      };
      this.closed.push(closed);
      this.tradeClosed(closed);
      trade.size = side * (size - part);
      left -= part;
    }
    this.open = this.open.filter((t) => Math.abs(t.size) > 1e-12);
    this.figures.commission += commission;
    this.dayFills++;
    if (this.open.length === 0) {
      // A position that closes takes its exit orders with it.
      this.exits.clear();
      this.brackets.clear();
    }
    if (!partOfEntry || mark) this.addFill(rt, price, sold * qty, false, name);
  }

  private tradeClosed(trade: Trade): void {
    const f = this.figures;
    f.netProfit += trade.profit;
    if (trade.profit > 0) {
      f.grossProfit += trade.profit;
      f.wins++;
    } else if (trade.profit < 0) {
      f.grossLoss += -trade.profit;
      f.losses++;
    } else {
      f.evens++;
    }
    this.equityByTrade.push(this.props.initialCapital + f.netProfit);
  }

  private addFill(rt: Runtime, price: number, qty: number, entry: boolean, name: string): void {
    this.fills.push({
      bar: rt.index,
      time: this.time,
      price,
      qty,
      entry,
      name,
      position: this.position,
    });
  }

  /** The strategy's own size for an order without qty, at the price it fills at. */
  defaultQty(rt: Runtime, price: number): number {
    const { qtyType, qtyValue } = this.props;
    if (qtyType === 'fixed') return qtyValue;
    if (!(price > 0)) return Number.NaN;
    const cash = qtyType === 'cash' ? qtyValue : (this.equityAt(price) * qtyValue) / 100;
    const units = cash / price;
    // Whole shares for stocks and funds; crypto to 8 decimals (provisional, docs/SPEC.md §11).
    const whole = rt.symbol.type === 'stock' || rt.symbol.type === 'fund';
    return whole ? Math.floor(units) : Math.floor(units * 1e8) / 1e8;
  }

  private commissionOf(qty: number, price: number): number {
    const { commissionType, commissionValue } = this.props;
    if (commissionValue === 0) return 0;
    if (commissionType === 'cash_per_order') return commissionValue;
    if (commissionType === 'cash_per_contract') return Math.abs(qty) * commissionValue;
    return (Math.abs(qty) * price * commissionValue) / 100;
  }

  // ---- figures, margin and risk ----

  /** The bar's run-up and drawdown, the trades' and the strategy's, from its high and low. */
  private barFigures(rt: Runtime): void {
    const bar = rt.bar;
    for (const trade of this.open) {
      const side = trade.size > 0 ? 1 : -1;
      const best = (side > 0 ? bar.high : bar.low) - trade.entryPrice;
      const worst = (side > 0 ? bar.low : bar.high) - trade.entryPrice;
      trade.maxRunup = Math.max(trade.maxRunup, best * trade.size);
      trade.maxDrawdown = Math.max(trade.maxDrawdown, -worst * trade.size);
    }
    const capital = this.props.initialCapital + this.figures.netProfit;
    let best = capital;
    let worst = capital;
    for (const trade of this.open) {
      const side = trade.size > 0 ? 1 : -1;
      best += ((side > 0 ? bar.high : bar.low) - trade.entryPrice) * trade.size;
      worst += ((side > 0 ? bar.low : bar.high) - trade.entryPrice) * trade.size;
    }
    const f = this.figures;
    if (!isNum(this.peak)) {
      this.peak = this.props.initialCapital;
      this.trough = this.props.initialCapital;
    }
    this.peak = Math.max(this.peak, best);
    const drawdown = this.peak - worst;
    if (drawdown > f.maxDrawdown) f.maxDrawdown = drawdown;
    if (this.peak > 0)
      f.maxDrawdownPercent = Math.max(f.maxDrawdownPercent, (drawdown / this.peak) * 100);
    this.trough = Math.min(this.trough, worst);
    const runup = best - this.trough;
    if (runup > f.maxRunup) f.maxRunup = runup;
    if (this.trough > 0)
      f.maxRunupPercent = Math.max(f.maxRunupPercent, (runup / this.trough) * 100);
  }

  /**
   * A margin call when the funds can't cover the position's loss at the bar's worst price: four
   * times what covers it is sold (the manual: Margin, with its TSLA example's arithmetic).
   */
  private marginCall(rt: Runtime): void {
    const position = this.position;
    if (position === 0) return;
    const ratio = (position > 0 ? this.props.marginLong : this.props.marginShort) / 100;
    if (ratio <= 0) return;
    const bar = rt.bar;
    const price = position > 0 ? bar.low : bar.high;
    const value = Math.abs(position) * price;
    const equity = this.equityAt(price);
    const available = equity - value * ratio;
    if (available >= 0) return;
    const lost = available / ratio;
    const cover = Math.trunc(lost / price);
    const qty = Math.min(Math.abs(position), Math.abs(cover * 4));
    if (qty <= 0) return;
    this.figures.marginCalls++;
    this.reduce(rt, qty, null, 'Margin call', 'Margin call', price, true);
  }

  private newDay(rt: Runtime): void {
    const day = new Date(rt.bar.time * 1000).toISOString().slice(0, 10);
    if (day === this.day) return;
    if (this.day !== '' && isNum(this.dayStartEquity)) {
      const equity = this.equityAt(this.lastClose);
      this.consLossDays = equity < this.dayStartEquity ? this.consLossDays + 1 : 0;
    }
    this.day = day;
    this.dayFills = 0;
    this.dayStartEquity = this.equityAt(isNum(this.lastClose) ? this.lastClose : rt.bar.open);
    if (this.haltedDay !== '' && this.haltedDay !== day) {
      this.halted = false;
      this.haltedDay = '';
    }
  }

  /** strategy.risk.*: past a limit, orders are cancelled, the position closed, trading halted. */
  private checkRisk(rt: Runtime): void {
    if (this.halted) return;
    const close = rt.bar.close;
    const equity = this.equityAt(close);
    let halt = false;
    let forDay = false;
    const dd = this.riskDrawdown;
    if (dd) {
      const drop = this.props.initialCapital - equity;
      halt ||= dd.percent ? (drop / this.props.initialCapital) * 100 >= dd.value : drop >= dd.value;
    }
    const intraday = this.riskIntradayLoss;
    if (intraday && isNum(this.dayStartEquity)) {
      const drop = this.dayStartEquity - equity;
      const hit = intraday.percent
        ? (drop / this.dayStartEquity) * 100 >= intraday.value
        : drop >= intraday.value;
      if (hit) {
        halt = true;
        forDay = true;
      }
    }
    if (isNum(this.riskIntradayFills) && this.dayFills > this.riskIntradayFills) {
      halt = true;
      forDay = true;
    }
    if (isNum(this.riskConsLossDays) && this.consLossDays >= this.riskConsLossDays) halt = true;
    if (!halt) return;
    this.orders = [];
    const all = Math.abs(this.position);
    if (all > 0) this.reduce(rt, all, null, 'Risk', 'Close position order', close, true);
    this.exits.clear();
    this.brackets.clear();
    this.halted = true;
    if (forDay) this.haltedDay = this.day;
  }

  // ---- state, for the live bar's rollback and for readers ----

  private capture(): unknown {
    return {
      open: this.open.map((t) => ({ ...t })),
      closed: this.closed.length,
      fills: this.fills.length,
      figures: { ...this.figures },
      orders: this.orders.map((o) => ({ ...o })),
      exits: new Map(this.exits),
      brackets: new Map(
        [...this.brackets].map(([id, held]) => [
          id,
          new Map([...held].map(([n, b]) => [n, { ...b }])),
        ]),
      ),
      tradeCount: this.tradeCount,
      exitCount: this.exitCount,
      peak: this.peak,
      trough: this.trough,
      equityByTrade: this.equityByTrade.length,
      allowed: this.allowed,
      maxPositionSize: this.maxPositionSize,
      halted: this.halted,
      haltedDay: this.haltedDay,
      dayFills: this.dayFills,
      day: this.day,
      dayStartEquity: this.dayStartEquity,
      consLossDays: this.consLossDays,
      lastBar: this.lastBar,
      lastTime: this.lastTime,
      lastClose: this.lastClose,
      firstBar: this.firstBar,
      firstTime: this.firstTime,
      firstClose: this.firstClose,
    };
  }

  private restore(saved: unknown): void {
    const s = saved as ReturnType<Broker['capture']> & Record<string, never>;
    const state = s as unknown as {
      open: Trade[];
      closed: number;
      fills: number;
      figures: StrategyFigures;
      orders: Order[];
      exits: Map<string, ExitRule>;
      brackets: Map<string, Map<number, Bracket>>;
      tradeCount: number;
      exitCount: number;
      peak: number;
      trough: number;
      equityByTrade: number;
      allowed: 'all' | 'long' | 'short';
      maxPositionSize: number;
      halted: boolean;
      haltedDay: string;
      dayFills: number;
      day: string;
      dayStartEquity: number;
      consLossDays: number;
      lastBar: number;
      lastTime: number;
      lastClose: number;
      firstBar: number;
      firstTime: number;
      firstClose: number;
    };
    this.open = state.open;
    this.closed.length = state.closed;
    this.fills.length = state.fills;
    this.figures = state.figures;
    this.orders = state.orders;
    this.exits = state.exits;
    this.brackets = state.brackets;
    this.tradeCount = state.tradeCount;
    this.exitCount = state.exitCount;
    this.peak = state.peak;
    this.trough = state.trough;
    this.equityByTrade.length = state.equityByTrade;
    this.allowed = state.allowed;
    this.maxPositionSize = state.maxPositionSize;
    this.halted = state.halted;
    this.haltedDay = state.haltedDay;
    this.dayFills = state.dayFills;
    this.day = state.day;
    this.dayStartEquity = state.dayStartEquity;
    this.consLossDays = state.consLossDays;
    this.lastBar = state.lastBar;
    this.lastTime = state.lastTime;
    this.lastClose = state.lastClose;
    this.firstBar = state.firstBar;
    this.firstTime = state.firstTime;
    this.firstClose = state.firstClose;
    this.version++;
  }

  /** A copy for the chart and the Strategy Tester. */
  state(): StrategyState {
    return {
      props: this.props,
      open: this.open.map((t) => ({ ...t })),
      closed: [...this.closed],
      fills: [...this.fills],
      figures: { ...this.figures },
      equityByTrade: [...this.equityByTrade],
      lastClose: this.lastClose,
      openProfit: isNum(this.lastClose) ? this.openProfitAt(this.lastClose) : 0,
      firstBar: this.firstBar,
      lastBar: this.lastBar,
      firstTime: this.firstTime,
      lastTime: this.lastTime,
      firstClose: this.firstClose,
      mintick: this.mintick,
    };
  }
}

const isMarket = (o: Order) =>
  o.kind === 'close' || o.kind === 'close_all' || (!isNum(o.limit) && !isNum(o.stop));

// ---- the strategy.* namespace ----

type Ev<T> = (rt: Runtime) => T;

/** Calls that place, change or cancel orders run only in a strategy. */
function needStrategy(c: Compiler, call: Call): void {
  if (!c.indicator?.strategy) {
    c.fail(
      `'${call.callee}' can only be used in a strategy: declare it with strategy()`,
      call.calleeSpan,
    );
  }
  // An order is a strategy's output: one that only trades needs no plot.
  c.otherOutputs++;
}

const voidCall = (span: Span, run: (rt: Runtime, broker: Broker) => void): Compiled =>
  series(
    'void',
    (rt) => {
      if (rt.broker) run(rt, rt.broker);
      return null;
    },
    span,
  );

/** An optional text argument, '' when not given or na. */
function textArg(args: Args, name: string): Ev<string> {
  const given = args.has(name) ? args.string(name) : undefined;
  if (!given) return () => '';
  const ev = given.ev;
  return (rt) => {
    const v = ev(rt);
    return typeof v === 'string' ? v : '';
  };
}

function numArg(args: Args, name: string): Ev<number> {
  const ev = args.has(name) ? args.number(name) : undefined;
  if (!ev) return () => Number.NaN;
  return (rt) => naNum(ev(rt));
}

/** v4's and v5's `when`: false skips the call (gone in v6: the v6 migration guide). */
function whenArg(args: Args): Ev<boolean> {
  const ev = args.knows('when') && args.has('when') ? args.bool('when') : undefined;
  if (!ev) return () => true;
  return (rt) => ev(rt) === true;
}

/** strategy.long or strategy.short (v4's bools true and false too). */
function directionArg(c: Compiler, args: Args, name: string): Ev<1 | -1> {
  const value = args.get(name) as Compiled;
  const ok =
    value.base === 'strategy_direction' || value.base === 'bool' || value.base === 'string';
  c.needType(value, ok, args.fn, name, 'series strategy_direction');
  const ev = value.ev;
  return (rt) => {
    const v = ev(rt);
    return v === 'short' || v === false ? -1 : 1;
  };
}

function ocaTypeArg(args: Args): Ev<OcaType> {
  const text = textArg(args, 'oca_type');
  return (rt) => {
    const v = text(rt);
    return v === 'cancel' || v === 'reduce' ? v : 'none';
  };
}

const ENTRY_V6 = [
  'id',
  'direction',
  'qty',
  'limit',
  'stop',
  'oca_name',
  'oca_type',
  'comment',
  'alert_message',
  'disable_alert',
];
const ENTRY_V5 = [
  'id',
  'direction',
  'qty',
  'limit',
  'stop',
  'oca_name',
  'oca_type',
  'comment',
  'when',
  'alert_message',
  'disable_alert',
];
const EXIT_V6 = [
  'id',
  'from_entry',
  'qty',
  'qty_percent',
  'profit',
  'limit',
  'loss',
  'stop',
  'trail_price',
  'trail_points',
  'trail_offset',
  'oca_name',
  'comment',
  'comment_profit',
  'comment_loss',
  'comment_trailing',
  'alert_message',
  'alert_profit',
  'alert_loss',
  'alert_trailing',
  'disable_alert',
];
const CLOSE_V6 = [
  'id',
  'comment',
  'qty',
  'qty_percent',
  'alert_message',
  'immediately',
  'disable_alert',
];
const CLOSE_V5 = [
  'id',
  'when',
  'comment',
  'qty',
  'qty_percent',
  'alert_message',
  'immediately',
  'disable_alert',
];
const CLOSE_ALL_V6 = ['comment', 'alert_message', 'immediately', 'disable_alert'];
const CLOSE_ALL_V5 = ['when', 'comment', 'alert_message', 'immediately', 'disable_alert'];

/** strategy.entry() and strategy.order(): the same parameters, different rules (the manual). */
const orderCall =
  (kind: 'entry' | 'order'): Handler =>
  (c, call, scope) => {
    needStrategy(c, call);
    const args = new Args(c, call, scope, c.version <= 5 ? ENTRY_V5 : ENTRY_V6, 2);
    const id = textArg(args, 'id');
    const side = directionArg(c, args, 'direction');
    const qty = numArg(args, 'qty');
    const limit = numArg(args, 'limit');
    const stop = numArg(args, 'stop');
    const ocaName = textArg(args, 'oca_name');
    const ocaType = ocaTypeArg(args);
    const comment = textArg(args, 'comment');
    const when = whenArg(args);
    args.get('alert_message');
    args.get('disable_alert');
    return voidCall(call.span, (rt, broker) => {
      if (!when(rt)) return;
      const q = qty(rt);
      broker.place(rt, {
        id: id(rt),
        kind,
        side: side(rt),
        qty: q > 0 ? q : Number.NaN,
        qtyPercent: 100,
        limit: limit(rt),
        stop: stop(rt),
        ocaName: ocaName(rt),
        ocaType: ocaType(rt),
        comment: comment(rt),
        immediately: false,
      });
    });
  };

const exitCall: Handler = (c, call, scope) => {
  needStrategy(c, call);
  const names = c.version <= 5 ? [...EXIT_V6, 'when'] : EXIT_V6;
  const args = new Args(c, call, scope, names, 1);
  const prices = ['profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points', 'trail_offset'];
  // v6: "strategy.exit() now must do something" (the v6 migration guide).
  if (c.version >= 6 && !prices.some((name) => args.has(name))) {
    c.fail(
      "'strategy.exit' needs at least one of profit, limit, loss, stop, trail_price, trail_points or trail_offset",
      call.calleeSpan,
    );
  }
  const id = textArg(args, 'id');
  const fromEntry = textArg(args, 'from_entry');
  const qty = numArg(args, 'qty');
  const qtyPercent = numArg(args, 'qty_percent');
  const [profit, limit, loss, stop, trailPrice, trailPoints, trailOffset] = prices.map((name) =>
    numArg(args, name),
  ) as Ev<number>[];
  const ocaName = textArg(args, 'oca_name');
  const comment = textArg(args, 'comment');
  const commentProfit = textArg(args, 'comment_profit');
  const commentLoss = textArg(args, 'comment_loss');
  const commentTrailing = textArg(args, 'comment_trailing');
  const when = whenArg(args);
  for (const name of [
    'alert_message',
    'alert_profit',
    'alert_loss',
    'alert_trailing',
    'disable_alert',
  ]) {
    args.get(name);
  }
  return voidCall(call.span, (rt, broker) => {
    if (!when(rt)) return;
    const q = qty(rt);
    const pct = qtyPercent(rt);
    broker.exit(rt, {
      id: id(rt),
      fromEntry: fromEntry(rt),
      qty: q > 0 ? q : Number.NaN,
      qtyPercent: isNum(pct) ? Math.max(0, Math.min(100, pct)) : 100,
      profit: (profit as Ev<number>)(rt),
      limit: (limit as Ev<number>)(rt),
      loss: (loss as Ev<number>)(rt),
      stop: (stop as Ev<number>)(rt),
      trailPrice: (trailPrice as Ev<number>)(rt),
      trailPoints: (trailPoints as Ev<number>)(rt),
      trailOffset: (trailOffset as Ev<number>)(rt),
      ocaName: ocaName(rt),
      comment: comment(rt),
      commentProfit: commentProfit(rt),
      commentLoss: commentLoss(rt),
      commentTrailing: commentTrailing(rt),
    });
  });
};

/**
 * v5's later reference dropped `when` from the front of strategy.close() and strategy.close_all(),
 * so a v5 script may pass its comment where `when` was: text there is the comment.
 */
function textAt(c: Compiler, call: Call, scope: Scope, position: number): boolean {
  const arg = call.args[position];
  if (!arg || arg.name !== null) return false;
  if (arg.value.kind === 'string') return true;
  if (arg.value.kind !== 'name') return false;
  return c.expr(arg.value, scope).base === 'string';
}

const closeCall: Handler = (c, call, scope) => {
  needStrategy(c, call);
  const v5 = c.version <= 5 && !textAt(c, call, scope, 1);
  const args = new Args(
    c,
    call,
    scope,
    v5 ? CLOSE_V5 : c.version <= 5 ? [...CLOSE_V6, 'when'] : CLOSE_V6,
    1,
  );
  const id = textArg(args, 'id');
  const comment = textArg(args, 'comment');
  const qty = numArg(args, 'qty');
  const qtyPercent = numArg(args, 'qty_percent');
  const immediately = args.has('immediately') ? args.bool('immediately') : undefined;
  const when = whenArg(args);
  args.get('alert_message');
  args.get('disable_alert');
  return voidCall(call.span, (rt, broker) => {
    if (!when(rt)) return;
    const q = qty(rt);
    const pct = qtyPercent(rt);
    broker.place(rt, {
      id: id(rt),
      kind: 'close',
      side: 1,
      qty: q > 0 ? q : Number.NaN,
      qtyPercent: isNum(pct) ? Math.max(0, Math.min(100, pct)) : 100,
      limit: Number.NaN,
      stop: Number.NaN,
      ocaName: '',
      ocaType: 'none',
      comment: comment(rt),
      immediately: immediately?.(rt) === true,
    });
  });
};

const closeAllCall: Handler = (c, call, scope) => {
  needStrategy(c, call);
  const v5 = c.version <= 5 && !textAt(c, call, scope, 0);
  const args = new Args(
    c,
    call,
    scope,
    v5 ? CLOSE_ALL_V5 : c.version <= 5 ? [...CLOSE_ALL_V6, 'when'] : CLOSE_ALL_V6,
    0,
  );
  const comment = textArg(args, 'comment');
  const immediately = args.has('immediately') ? args.bool('immediately') : undefined;
  const when = whenArg(args);
  args.get('alert_message');
  args.get('disable_alert');
  return voidCall(call.span, (rt, broker) => {
    if (!when(rt) || broker.position === 0) return;
    broker.place(rt, {
      id: '__close_all__',
      kind: 'close_all',
      side: 1,
      qty: Number.NaN,
      qtyPercent: 100,
      limit: Number.NaN,
      stop: Number.NaN,
      ocaName: '',
      ocaType: 'none',
      comment: comment(rt),
      immediately: immediately?.(rt) === true,
    });
  });
};

const cancelCall =
  (all: boolean): Handler =>
  (c, call, scope) => {
    needStrategy(c, call);
    const names = all ? (c.version <= 5 ? ['when'] : []) : c.version <= 5 ? ['id', 'when'] : ['id'];
    const args = new Args(c, call, scope, names, all ? 0 : 1);
    const id = all ? null : textArg(args, 'id');
    const when = whenArg(args);
    return voidCall(call.span, (rt, broker) => {
      if (when(rt)) broker.cancel(rt, id ? id(rt) : null);
    });
  };

const riskCall =
  (params: string[], apply: (broker: Broker, values: (Value | undefined)[]) => void): Handler =>
  (c, call, scope) => {
    needStrategy(c, call);
    const args = new Args(c, call, scope, params, 1);
    const evs = params.map((name) => (args.has(name) ? (args.get(name) as Compiled).ev : null));
    return voidCall(call.span, (rt, broker) =>
      broker.setRisk(rt, (b) =>
        apply(
          b,
          evs.map((ev) => (ev ? ev(rt) : null)),
        ),
      ),
    );
  };

/** A closed or open trade's value, by its number (na out of range: the reference). */
function tradeFn(
  open: boolean,
  base: 'float' | 'int' | 'string',
  read: (trade: Trade, rt: Runtime, broker: Broker) => Value,
): Handler {
  return (c, call, scope) => {
    needStrategy(c, call);
    const args = new Args(c, call, scope, ['trade_num'], 1);
    const n = args.int('trade_num') as Ev<number>;
    const na: Value = base === 'string' ? '' : Number.NaN;
    return series(
      base,
      (rt) => {
        const broker = rt.broker;
        const i = n(rt);
        if (!broker || !Number.isInteger(i) || i < 0) return na;
        const trade = (open ? broker.open : broker.closed)[i];
        return trade ? read(trade, rt, broker) : na;
      },
      call.span,
    );
  };
}

const costOf = (t: Trade) => Math.abs(t.size) * t.entryPrice;
const openProfitOf = (t: Trade, rt: Runtime) =>
  (rt.bar.close - t.entryPrice) * t.size - t.entryCommissionPerUnit * Math.abs(t.size);

function tradeCalls(): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const open of [false, true]) {
    const ns = open ? 'strategy.opentrades.' : 'strategy.closedtrades.';
    out[`${ns}entry_id`] = tradeFn(open, 'string', (t) => t.entryId);
    out[`${ns}entry_comment`] = tradeFn(open, 'string', (t) => t.entryComment);
    out[`${ns}entry_price`] = tradeFn(open, 'float', (t) => t.entryPrice);
    out[`${ns}entry_bar_index`] = tradeFn(open, 'int', (t) => t.entryBar);
    out[`${ns}entry_time`] = tradeFn(open, 'int', (t) => t.entryTime);
    out[`${ns}size`] = tradeFn(open, 'float', (t) => t.size);
    out[`${ns}commission`] = tradeFn(open, 'float', (t) =>
      open ? t.entryCommissionPerUnit * Math.abs(t.size) : t.commission,
    );
    out[`${ns}max_runup`] = tradeFn(open, 'float', (t) => t.maxRunup);
    out[`${ns}max_drawdown`] = tradeFn(open, 'float', (t) => t.maxDrawdown);
    out[`${ns}max_runup_percent`] = tradeFn(open, 'float', (t) => (t.maxRunup / costOf(t)) * 100);
    out[`${ns}max_drawdown_percent`] = tradeFn(
      open,
      'float',
      (t) => (t.maxDrawdown / costOf(t)) * 100,
    );
    out[`${ns}profit`] = tradeFn(open, 'float', (t, rt) => (open ? openProfitOf(t, rt) : t.profit));
    out[`${ns}profit_percent`] = tradeFn(
      open,
      'float',
      (t, rt) => ((open ? openProfitOf(t, rt) : t.profit) / costOf(t)) * 100,
    );
  }
  const closed = 'strategy.closedtrades.';
  out[`${closed}exit_id`] = tradeFn(false, 'string', (t) => t.exitId);
  out[`${closed}exit_comment`] = tradeFn(false, 'string', (t) => t.exitComment);
  out[`${closed}exit_price`] = tradeFn(false, 'float', (t) => t.exitPrice);
  out[`${closed}exit_bar_index`] = tradeFn(false, 'int', (t) => t.exitBar);
  out[`${closed}exit_time`] = tradeFn(false, 'int', (t) => t.exitTime);
  return out;
}

export function strategyCalls(): Record<string, Handler> {
  return {
    'strategy.entry': orderCall('entry'),
    'strategy.order': orderCall('order'),
    'strategy.exit': exitCall,
    'strategy.close': closeCall,
    'strategy.close_all': closeAllCall,
    'strategy.cancel': cancelCall(false),
    'strategy.cancel_all': cancelCall(true),
    'strategy.risk.allow_entry_in': riskCall(['value'], (b, [v]) => {
      b.allowed = v === 'long' || v === 'short' ? v : 'all';
    }),
    'strategy.risk.max_position_size': riskCall(['contracts'], (b, [v]) => {
      b.maxPositionSize = naNum(v);
    }),
    'strategy.risk.max_drawdown': riskCall(['value', 'type', 'alert_message'], (b, [v, t]) =>
      b.limitDrawdown(naNum(v), t === 'percent_of_equity'),
    ),
    'strategy.risk.max_intraday_loss': riskCall(['value', 'type', 'alert_message'], (b, [v, t]) =>
      b.limitIntradayLoss(naNum(v), t === 'percent_of_equity'),
    ),
    'strategy.risk.max_intraday_filled_orders': riskCall(['count', 'alert_message'], (b, [v]) =>
      b.limitIntradayFills(naNum(v)),
    ),
    'strategy.risk.max_cons_loss_days': riskCall(['count', 'alert_message'], (b, [v]) =>
      b.limitConsLossDays(naNum(v)),
    ),
    // One currency here: the account's is the chart's (other accounts: docs/SPEC.md §11).
    'strategy.convert_to_account': (c, call, scope) => {
      needStrategy(c, call);
      const value = new Args(c, call, scope, ['value'], 1).number('value') as Ev<number>;
      return series('float', (rt) => value(rt), call.span);
    },
    'strategy.convert_to_symbol': (c, call, scope) => {
      needStrategy(c, call);
      const value = new Args(c, call, scope, ['value'], 1).number('value') as Ev<number>;
      return series('float', (rt) => value(rt), call.span);
    },
    'strategy.default_entry_qty': (c, call, scope) => {
      needStrategy(c, call);
      const price = new Args(c, call, scope, ['fill_price'], 1).number('fill_price') as Ev<number>;
      return series('float', (rt) => rt.broker?.defaultQty(rt, price(rt)) ?? Number.NaN, call.span);
    },
    ...tradeCalls(),
  };
}

/** A strategy.* variable: the broker's, na outside a strategy's run. */
const figure = (span: Span, base: 'float' | 'int', read: (b: Broker, rt: Runtime) => number) =>
  series(base, (rt) => (rt.broker ? read(rt.broker, rt) : Number.NaN), span);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
const percentOfCapital = (b: Broker, x: number) => (x / b.props.initialCapital) * 100;

/** The strategy.* names: its constants and variables (the v6 reference). */
export function strategyName(
  c: Compiler,
  first: string,
  rest: string,
  span: Span,
): Compiled | null {
  // Names arrive split at their first dot: strategy.oca.cancel is "strategy" and "oca.cancel".
  const full = `${first}.${rest}`;
  if (!full.startsWith('strategy.')) return null;
  const dot = full.lastIndexOf('.');
  const space = full.slice(0, dot);
  const member = full.slice(dot + 1);
  if (space === 'strategy') {
    switch (member) {
      case 'long':
        // v4 and older: bools (true long, false short); since v5 their own type.
        return c.version <= 4
          ? constant('bool', true, span)
          : constant('strategy_direction', 'long', span);
      case 'short':
        return c.version <= 4
          ? constant('bool', false, span)
          : constant('strategy_direction', 'short', span);
      case 'fixed':
      case 'cash':
      case 'percent_of_equity':
        return constant('string', member, span);
      default:
        break;
    }
    const variable = strategyVariable(c, member, span);
    if (variable) return variable;
    return null;
  }
  if (
    space === 'strategy.oca' &&
    (member === 'cancel' || member === 'reduce' || member === 'none')
  ) {
    return constant('string', member, span);
  }
  if (
    space === 'strategy.direction' &&
    (member === 'all' || member === 'long' || member === 'short')
  ) {
    return constant('string', member, span);
  }
  if (
    space === 'strategy.commission' &&
    (member === 'percent' || member === 'cash_per_contract' || member === 'cash_per_order')
  ) {
    return constant('string', member, span);
  }
  if (space === 'strategy.opentrades' && member === 'capital_held') {
    return figure(span, 'float', (b) =>
      b.open.reduce((sum, t) => {
        const ratio = (t.size > 0 ? b.props.marginLong : b.props.marginShort) / 100;
        return sum + costOf(t) * (ratio > 0 ? ratio : 1);
      }, 0),
    );
  }
  if (space === 'strategy.closedtrades' && member === 'first_index') {
    return figure(span, 'int', () => 0);
  }
  return null;
}

function strategyVariable(c: Compiler, member: string, span: Span): Compiled | null {
  const f = (b: Broker) => b.figures;
  switch (member) {
    case 'position_size':
      return figure(span, 'float', (b) => b.position);
    case 'position_avg_price':
      return figure(span, 'float', (b) => b.avgPrice);
    case 'position_entry_name':
      return series('string', (rt) => rt.broker?.open[0]?.entryId ?? '', span);
    case 'openprofit':
      return figure(span, 'float', (b, rt) => b.openProfitAt(rt.bar.close));
    case 'openprofit_percent':
      return figure(span, 'float', (b, rt) => percentOfCapital(b, b.openProfitAt(rt.bar.close)));
    case 'equity':
      return figure(span, 'float', (b, rt) => b.equityAt(rt.bar.close));
    case 'initial_capital':
      return figure(span, 'float', (b) => b.props.initialCapital);
    case 'account_currency':
      return {
        base: 'string',
        qual: SIMPLE,
        ev: (rt) => rt.broker?.props.currency || rt.symbol.currency,
        span,
      };
    case 'netprofit':
      return figure(span, 'float', (b) => f(b).netProfit);
    case 'netprofit_percent':
      return figure(span, 'float', (b) => percentOfCapital(b, f(b).netProfit));
    case 'grossprofit':
      return figure(span, 'float', (b) => f(b).grossProfit);
    case 'grossprofit_percent':
      return figure(span, 'float', (b) => percentOfCapital(b, f(b).grossProfit));
    case 'grossloss':
      return figure(span, 'float', (b) => f(b).grossLoss);
    case 'grossloss_percent':
      return figure(span, 'float', (b) => percentOfCapital(b, f(b).grossLoss));
    case 'closedtrades':
      return figure(span, 'int', (b) => b.closed.length);
    case 'opentrades':
      return figure(span, 'int', (b) => b.open.length);
    case 'wintrades':
      return figure(span, 'int', (b) => f(b).wins);
    case 'losstrades':
      return figure(span, 'int', (b) => f(b).losses);
    case 'eventrades':
      return figure(span, 'int', (b) => f(b).evens);
    case 'avg_trade':
      return figure(span, 'float', (b) =>
        b.closed.length ? f(b).netProfit / b.closed.length : Number.NaN,
      );
    case 'avg_trade_percent':
      return figure(span, 'float', (b) => mean(b.closed.map((t) => (t.profit / costOf(t)) * 100)));
    case 'avg_winning_trade':
      return figure(span, 'float', (b) => (f(b).wins ? f(b).grossProfit / f(b).wins : Number.NaN));
    case 'avg_winning_trade_percent':
      return figure(span, 'float', (b) =>
        mean(b.closed.filter((t) => t.profit > 0).map((t) => (t.profit / costOf(t)) * 100)),
      );
    case 'avg_losing_trade':
      return figure(span, 'float', (b) =>
        f(b).losses ? f(b).grossLoss / f(b).losses : Number.NaN,
      );
    case 'avg_losing_trade_percent':
      return figure(span, 'float', (b) =>
        mean(b.closed.filter((t) => t.profit < 0).map((t) => (-t.profit / costOf(t)) * 100)),
      );
    case 'max_drawdown':
      return figure(span, 'float', (b) => f(b).maxDrawdown);
    case 'max_drawdown_percent':
      return figure(span, 'float', (b) => f(b).maxDrawdownPercent);
    case 'max_runup':
      return figure(span, 'float', (b) => f(b).maxRunup);
    case 'max_runup_percent':
      return figure(span, 'float', (b) => f(b).maxRunupPercent);
    case 'max_contracts_held_all':
      return figure(span, 'float', (b) => f(b).maxContractsAll);
    case 'max_contracts_held_long':
      return figure(span, 'float', (b) => f(b).maxContractsLong);
    case 'max_contracts_held_short':
      return figure(span, 'float', (b) => f(b).maxContractsShort);
    case 'margin_liquidation_price':
      return figure(span, 'float', (b) => liquidationPrice(b));
    default:
      void c;
      return null;
  }
}

/** Where a margin call would come: the price at which the funds no longer cover the margin. */
function liquidationPrice(b: Broker): number {
  const size = b.position;
  if (size === 0) return Number.NaN;
  const ratio = (size > 0 ? b.props.marginLong : b.props.marginShort) / 100;
  if (ratio <= 0) return Number.NaN;
  const capital = b.props.initialCapital + b.figures.netProfit;
  const avg = b.avgPrice;
  const q = Math.abs(size);
  if (size > 0) {
    if (ratio >= 1) return Number.NaN;
    const p = (avg * q - capital) / (q * (1 - ratio));
    return p > 0 ? p : Number.NaN;
  }
  return (avg * q + capital) / (q * (1 + ratio));
}

void CONST;
void SERIES;
