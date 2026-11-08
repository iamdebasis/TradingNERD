import type { StrategyState, Trade } from '@tradingnerd/pine';

/**
 * The Strategy Tester's figures from a strategy's trades (Pine docs: Strategies, Strategy Tester:
 * Overview, Performance Summary, List of Trades). The figures are TradingView's names; how a few
 * are worked out isn't documented and is provisional (docs/SPEC.md §11): the Sharpe and Sortino
 * ratios from the monthly changes of closed-trade equity against the risk-free rate's twelfth,
 * and buy & hold as the initial capital held from the first close to the last.
 */

/** One column of the Performance Summary: all trades, the long ones or the short ones. */
export interface SummaryColumn {
  netProfit: number;
  netProfitPercent: number;
  grossProfit: number;
  grossProfitPercent: number;
  grossLoss: number;
  grossLossPercent: number;
  commission: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  percentProfitable: number;
  avgTrade: number;
  avgTradePercent: number;
  avgWin: number;
  avgWinPercent: number;
  avgLoss: number;
  avgLossPercent: number;
  ratioAvgWinLoss: number;
  largestWin: number;
  largestWinPercent: number;
  largestLoss: number;
  largestLossPercent: number;
  avgBars: number;
  avgBarsWins: number;
  avgBarsLosses: number;
  profitFactor: number;
  maxContracts: number;
}

export interface StrategyReport {
  all: SummaryColumn;
  long: SummaryColumn;
  short: SummaryColumn;
  openProfit: number;
  openProfitPercent: number;
  buyHold: number;
  buyHoldPercent: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  maxRunup: number;
  maxRunupPercent: number;
  sharpe: number;
  sortino: number;
  marginCalls: number;
}

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const costOf = (t: Trade) => Math.abs(t.size) * t.entryPrice;
const percentOf = (t: Trade) => (t.profit / costOf(t)) * 100;
const barsOf = (t: Trade) => t.exitBar - t.entryBar;

function column(
  closed: readonly Trade[],
  open: readonly Trade[],
  capital: number,
  maxContracts: number,
): SummaryColumn {
  const wins = closed.filter((t) => t.profit > 0);
  const losses = closed.filter((t) => t.profit < 0);
  const grossProfit = sum(wins.map((t) => t.profit));
  const grossLoss = -sum(losses.map((t) => t.profit));
  const netProfit = sum(closed.map((t) => t.profit));
  const largestWin = wins.reduce<Trade | null>((m, t) => (!m || t.profit > m.profit ? t : m), null);
  const largestLoss = losses.reduce<Trade | null>(
    (m, t) => (!m || t.profit < m.profit ? t : m),
    null,
  );
  const avgWin = wins.length ? grossProfit / wins.length : Number.NaN;
  const avgLoss = losses.length ? grossLoss / losses.length : Number.NaN;
  return {
    netProfit,
    netProfitPercent: (netProfit / capital) * 100,
    grossProfit,
    grossProfitPercent: (grossProfit / capital) * 100,
    grossLoss,
    grossLossPercent: (grossLoss / capital) * 100,
    commission: sum(closed.map((t) => t.commission)) + sum(open.map((t) => t.commission)),
    closedTrades: closed.length,
    openTrades: open.length,
    wins: wins.length,
    losses: losses.length,
    percentProfitable: closed.length ? (wins.length / closed.length) * 100 : Number.NaN,
    avgTrade: closed.length ? netProfit / closed.length : Number.NaN,
    avgTradePercent: mean(closed.map(percentOf)),
    avgWin,
    avgWinPercent: mean(wins.map(percentOf)),
    avgLoss,
    avgLossPercent: mean(losses.map((t) => -percentOf(t))),
    ratioAvgWinLoss: avgWin / avgLoss,
    largestWin: largestWin?.profit ?? Number.NaN,
    largestWinPercent: largestWin ? percentOf(largestWin) : Number.NaN,
    largestLoss: largestLoss ? -largestLoss.profit : Number.NaN,
    largestLossPercent: largestLoss ? -percentOf(largestLoss) : Number.NaN,
    avgBars: mean(closed.map(barsOf)),
    avgBarsWins: mean(wins.map(barsOf)),
    avgBarsLosses: mean(losses.map(barsOf)),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Number.NaN,
    maxContracts,
  };
}

/** Equity at each month's end, from closed trades: the ratios' monthly changes. */
function monthlyReturns(state: StrategyState): number[] {
  const capital = state.props.initialCapital;
  const ends = new Map<string, number>();
  let equity = capital;
  const months: string[] = [];
  const key = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  if (Number.isFinite(state.firstTime)) {
    const first = key(state.firstTime);
    months.push(first);
    ends.set(first, capital);
  }
  for (const trade of state.closed) {
    equity += trade.profit;
    const month = key(trade.exitTime);
    if (!ends.has(month)) months.push(month);
    ends.set(month, equity);
  }
  const returns: number[] = [];
  let before = capital;
  for (const month of months) {
    const after = ends.get(month) as number;
    if (month !== months[0]) returns.push((after - before) / before);
    before = after;
  }
  return returns;
}

export function strategyReport(state: StrategyState): StrategyReport {
  const capital = state.props.initialCapital;
  const longs = (ts: readonly Trade[]) => ts.filter((t) => t.size > 0);
  const shorts = (ts: readonly Trade[]) => ts.filter((t) => t.size < 0);
  const f = state.figures;
  const returns = monthlyReturns(state);
  const rf = state.props.riskFreeRate / 100 / 12;
  const avg = mean(returns);
  const sd = Math.sqrt(mean(returns.map((r) => (r - avg) ** 2)));
  const down = Math.sqrt(mean(returns.map((r) => Math.min(0, r - rf) ** 2)));
  const buyHold =
    state.firstClose > 0 ? (capital / state.firstClose) * (state.lastClose - state.firstClose) : 0;
  return {
    all: column(state.closed, state.open, capital, f.maxContractsAll),
    long: column(longs(state.closed), longs(state.open), capital, f.maxContractsLong),
    short: column(shorts(state.closed), shorts(state.open), capital, f.maxContractsShort),
    openProfit: state.openProfit,
    openProfitPercent: (state.openProfit / capital) * 100,
    buyHold,
    buyHoldPercent: (buyHold / capital) * 100,
    maxDrawdown: f.maxDrawdown,
    maxDrawdownPercent: f.maxDrawdownPercent,
    maxRunup: f.maxRunup,
    maxRunupPercent: f.maxRunupPercent,
    sharpe: returns.length > 1 && sd > 0 ? (avg - rf) / sd : Number.NaN,
    sortino: returns.length > 1 && down > 0 ? (avg - rf) / down : Number.NaN,
    marginCalls: f.marginCalls,
  };
}

/** A money figure as the tester writes it: thousands separated, two decimals, a minus sign. */
export function money(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const text = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `−${text}` : text;
}

export function percent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const text = Math.abs(value).toFixed(2);
  return `${value < 0 ? '−' : ''}${text}%`;
}

/** A plain number (a count, a ratio) to `digits` decimals. */
export function plain(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
