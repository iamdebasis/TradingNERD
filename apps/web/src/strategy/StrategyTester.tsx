import type { ScriptStrategy } from '@tradingnerd/chart';
import type { StrategyState, Trade } from '@tradingnerd/pine';
import { useMemo } from 'react';
import { CloseIcon } from '../toolbar/icons';
import {
  money,
  percent,
  plain,
  type StrategyReport,
  type SummaryColumn,
  strategyReport,
} from './report';
import styles from './StrategyTester.module.css';
import { strategyStore, type TesterTab, useStrategyTester } from './strategyStore';

/**
 * TradingView's Strategy Tester (Pine docs: Strategies, Strategy Tester): the chosen strategy's
 * Overview (its key figures and an equity curve with drawdown and buy & hold), Performance
 * Summary (All, Long and Short), List of Trades (newest first, Trade # reverses it) and
 * Properties. Its layout follows the manual's description and its look our other panels';
 * both are provisional until measured from screenshots (docs/SPEC.md §11).
 */

const TABS: readonly { id: TesterTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'summary', label: 'Performance Summary' },
  { id: 'trades', label: 'List of Trades' },
  { id: 'properties', label: 'Properties' },
];

export function StrategyTester({ onClose }: { onClose(): void }) {
  const state = useStrategyTester();
  const shown = strategyStore.current();
  const report = useMemo(() => (shown ? strategyReport(shown.state) : null), [shown]);
  return (
    <section className={styles.pane} aria-label="Strategy Tester" data-testid="strategy-tester">
      <header className={styles.top}>
        {state.strategies.length > 1 ? (
          <select
            className={styles.picker}
            aria-label="Strategy"
            value={shown?.id ?? ''}
            onChange={(event) => strategyStore.select(event.target.value)}
          >
            {state.strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.title}>{shown?.title ?? 'Strategy Tester'}</span>
        )}
        <div className={styles.tabs} role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={state.tab === tab.id}
              className={styles.tab}
              onClick={() => strategyStore.setTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.icon}
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div className={styles.body}>
        {!shown || !report ? (
          <p className={styles.empty}>Add a strategy to the chart to test it.</p>
        ) : shown.error ? (
          <p className={styles.empty}>{shown.error}</p>
        ) : state.tab === 'overview' ? (
          <Overview strategy={shown} report={report} />
        ) : state.tab === 'summary' ? (
          <Summary report={report} />
        ) : state.tab === 'trades' ? (
          <Trades state={shown.state} newestFirst={state.newestFirst} />
        ) : (
          <Properties state={shown.state} />
        )}
      </div>
    </section>
  );
}

const sign = (value: number) => (value > 0 ? styles.up : value < 0 ? styles.down : '');

function Overview({ strategy, report }: { strategy: ScriptStrategy; report: StrategyReport }) {
  const all = report.all;
  const figures: { label: string; value: string; extra?: string; tone?: string }[] = [
    {
      label: 'Net Profit',
      value: money(all.netProfit),
      extra: percent(all.netProfitPercent),
      tone: sign(all.netProfit),
    },
    { label: 'Total Closed Trades', value: plain(all.closedTrades) },
    { label: 'Percent Profitable', value: percent(all.percentProfitable) },
    { label: 'Profit Factor', value: plain(all.profitFactor, 3) },
    {
      label: 'Max Drawdown',
      value: money(report.maxDrawdown),
      extra: percent(report.maxDrawdownPercent),
    },
    {
      label: 'Avg Trade',
      value: money(all.avgTrade),
      extra: percent(all.avgTradePercent),
      tone: sign(all.avgTrade),
    },
    { label: 'Avg # Bars in Trades', value: plain(all.avgBars) },
  ];
  return (
    <div className={styles.overview}>
      <dl className={styles.figures}>
        {figures.map((f) => (
          <div key={f.label} className={styles.figure}>
            <dt>{f.label}</dt>
            <dd className={f.tone}>
              {f.value}
              {f.extra && <span className={styles.extra}>{f.extra}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <EquityChart state={strategy.state} />
    </div>
  );
}

/** Equity across closed trades over the initial capital, drawdown below, and buy & hold. */
function EquityChart({ state }: { state: StrategyState }) {
  const W = 1000;
  const H = 180;
  const capital = state.props.initialCapital;
  const equity = [capital, ...state.equityByTrade];
  if (equity.length < 2) return <p className={styles.empty}>No closed trades yet.</p>;
  let peak = capital;
  const drawdowns = equity.map((e) => {
    peak = Math.max(peak, e);
    return peak - e;
  });
  const holdEnd =
    state.firstClose > 0
      ? capital + (capital / state.firstClose) * (state.lastClose - state.firstClose)
      : capital;
  const hold = equity.map((_, i) => capital + ((holdEnd - capital) * i) / (equity.length - 1));
  const lo = Math.min(...equity, ...hold);
  const hi = Math.max(...equity, ...hold);
  const y = (v: number) => (hi === lo ? H / 2 : H - 8 - ((v - lo) / (hi - lo)) * (H - 16));
  const x = (i: number) => (i / (equity.length - 1)) * W;
  const maxDd = Math.max(...drawdowns, 1e-9);
  const path = (vs: number[]) =>
    vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const base = y(capital);
  const barW = Math.max(1, W / equity.length - 1);
  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-label="Equity"
    >
      {/* The drawdown's columns hang from the top, one per closed trade (one path). */}
      <path
        className={styles.drawdown}
        d={drawdowns
          .map((d, i) =>
            d > 0
              ? `M${(x(i) - barW / 2).toFixed(1)},0h${barW.toFixed(1)}v${((d / maxDd) * H * 0.35).toFixed(1)}h${(-barW).toFixed(1)}z`
              : '',
          )
          .join('')}
      />
      <line className={styles.baseline} x1={0} x2={W} y1={base} y2={base} />
      <path className={styles.hold} d={path(hold)} />
      <path className={styles.equity} d={path(equity)} />
    </svg>
  );
}

const ROWS: readonly {
  label: string;
  value: (c: SummaryColumn) => string;
  tone?: (c: SummaryColumn) => number;
}[] = [
  {
    label: 'Net Profit',
    value: (c) => `${money(c.netProfit)}  ${percent(c.netProfitPercent)}`,
    tone: (c) => c.netProfit,
  },
  {
    label: 'Gross Profit',
    value: (c) => `${money(c.grossProfit)}  ${percent(c.grossProfitPercent)}`,
  },
  { label: 'Gross Loss', value: (c) => `${money(c.grossLoss)}  ${percent(c.grossLossPercent)}` },
  { label: 'Commission Paid', value: (c) => money(c.commission) },
  {
    label: 'Max Contracts Held',
    value: (c) => plain(c.maxContracts, Number.isInteger(c.maxContracts) ? 0 : 4),
  },
  { label: 'Total Closed Trades', value: (c) => plain(c.closedTrades) },
  { label: 'Total Open Trades', value: (c) => plain(c.openTrades) },
  { label: 'Number Winning Trades', value: (c) => plain(c.wins) },
  { label: 'Number Losing Trades', value: (c) => plain(c.losses) },
  { label: 'Percent Profitable', value: (c) => percent(c.percentProfitable) },
  {
    label: 'Avg P&L',
    value: (c) => `${money(c.avgTrade)}  ${percent(c.avgTradePercent)}`,
    tone: (c) => c.avgTrade,
  },
  { label: 'Avg Winning Trade', value: (c) => `${money(c.avgWin)}  ${percent(c.avgWinPercent)}` },
  { label: 'Avg Losing Trade', value: (c) => `${money(c.avgLoss)}  ${percent(c.avgLossPercent)}` },
  { label: 'Ratio Avg Win / Avg Loss', value: (c) => plain(c.ratioAvgWinLoss, 3) },
  {
    label: 'Largest Winning Trade',
    value: (c) => `${money(c.largestWin)}  ${percent(c.largestWinPercent)}`,
  },
  {
    label: 'Largest Losing Trade',
    value: (c) => `${money(c.largestLoss)}  ${percent(c.largestLossPercent)}`,
  },
  { label: 'Avg # Bars in Trades', value: (c) => plain(c.avgBars) },
  { label: 'Avg # Bars in Winning Trades', value: (c) => plain(c.avgBarsWins) },
  { label: 'Avg # Bars in Losing Trades', value: (c) => plain(c.avgBarsLosses) },
  { label: 'Profit Factor', value: (c) => plain(c.profitFactor, 3) },
];

function Summary({ report }: { report: StrategyReport }) {
  const columns = [
    ['all', report.all],
    ['long', report.long],
    ['short', report.short],
  ] as const;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">Title</th>
          <th scope="col">All</th>
          <th scope="col">Long</th>
          <th scope="col">Short</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            {columns.map(([name, c]) => (
              <td key={name} className={row.tone ? sign(row.tone(c)) : ''}>
                {row.value(c)}
              </td>
            ))}
          </tr>
        ))}
        <tr>
          <th scope="row">Open P&amp;L</th>
          <td className={sign(report.openProfit)}>
            {money(report.openProfit)} {percent(report.openProfitPercent)}
          </td>
          <td />
          <td />
        </tr>
        <tr>
          <th scope="row">Buy &amp; Hold Return</th>
          <td className={sign(report.buyHold)}>
            {money(report.buyHold)} {percent(report.buyHoldPercent)}
          </td>
          <td />
          <td />
        </tr>
        <tr>
          <th scope="row">Max Equity Run-up</th>
          <td>
            {money(report.maxRunup)} {percent(report.maxRunupPercent)}
          </td>
          <td />
          <td />
        </tr>
        <tr>
          <th scope="row">Max Equity Drawdown</th>
          <td>
            {money(report.maxDrawdown)} {percent(report.maxDrawdownPercent)}
          </td>
          <td />
          <td />
        </tr>
        <tr>
          <th scope="row">Sharpe Ratio</th>
          <td>{plain(report.sharpe, 3)}</td>
          <td />
          <td />
        </tr>
        <tr>
          <th scope="row">Sortino Ratio</th>
          <td>{plain(report.sortino, 3)}</td>
          <td />
          <td />
        </tr>
        <tr>
          <th scope="row">Margin Calls</th>
          <td>{plain(report.marginCalls)}</td>
          <td />
          <td />
        </tr>
      </tbody>
    </table>
  );
}

const when = (ms: number) =>
  Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';

/** Decimals of the symbol's price step: 0.0001 → 4. */
const decimalsOf = (mintick: number) =>
  mintick > 0 ? Math.max(0, Math.min(10, Math.round(-Math.log10(mintick)))) : 2;

function Trades({ state, newestFirst }: { state: StrategyState; newestFirst: boolean }) {
  const digits = decimalsOf(state.mintick);
  const rows: { num: number; trade: Trade; open: boolean; cum: number }[] = [];
  let cum = 0;
  state.closed.forEach((trade, i) => {
    cum += trade.profit;
    rows.push({ num: i + 1, trade, open: false, cum });
  });
  state.open.forEach((trade, i) => {
    rows.push({ num: state.closed.length + i + 1, trade, open: true, cum });
  });
  if (newestFirst) rows.reverse();
  return (
    <table className={`${styles.table} ${styles.trades}`}>
      <thead>
        <tr>
          <th scope="col">
            <button
              type="button"
              className={styles.sort}
              onClick={() => strategyStore.toggleOrder()}
            >
              Trade # {newestFirst ? '↓' : '↑'}
            </button>
          </th>
          <th scope="col">Type</th>
          <th scope="col">Signal</th>
          <th scope="col">Date/Time</th>
          <th scope="col">Price</th>
          <th scope="col">Contracts</th>
          <th scope="col">Profit</th>
          <th scope="col">Cum. Profit</th>
          <th scope="col">Run-up</th>
          <th scope="col">Drawdown</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ num, trade, open, cum }) => {
          const side = trade.size > 0 ? 'Long' : 'Short';
          const profit = open
            ? (state.lastClose - trade.entryPrice) * trade.size - trade.commission
            : trade.profit;
          return (
            <tr key={`${open ? 'o' : 'c'}${num}`} data-trade={num}>
              <td>{num}</td>
              <td>
                <div>Exit {side}</div>
                <div>Entry {side}</div>
              </td>
              <td>
                <div>{open ? 'Open' : trade.exitComment || trade.exitId}</div>
                <div>{trade.entryComment || trade.entryId}</div>
              </td>
              <td>
                <div>{open ? '—' : when(trade.exitTime)}</div>
                <div>{when(trade.entryTime)}</div>
              </td>
              <td>
                <div>{open ? '—' : plain(trade.exitPrice, digits)}</div>
                <div>{plain(trade.entryPrice, digits)}</div>
              </td>
              <td>{plain(Math.abs(trade.size), Number.isInteger(trade.size) ? 0 : 4)}</td>
              <td className={sign(profit)}>{money(profit)}</td>
              <td className={sign(cum)}>{money(cum)}</td>
              <td>{money(trade.maxRunup)}</td>
              <td>{money(trade.maxDrawdown)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Properties({ state }: { state: StrategyState }) {
  const p = state.props;
  const size =
    p.qtyType === 'fixed'
      ? `${p.qtyValue} contracts`
      : p.qtyType === 'cash'
        ? `${money(p.qtyValue)} cash`
        : `${p.qtyValue}% of equity`;
  const commission =
    p.commissionType === 'percent'
      ? `${p.commissionValue}%`
      : p.commissionType === 'cash_per_contract'
        ? `${p.commissionValue} per contract`
        : `${p.commissionValue} per order`;
  const rows: [string, string][] = [
    [
      'Trading range',
      `${when(state.closed[0]?.entryTime ?? state.firstTime)} — ${when(state.lastTime)}`,
    ],
    ['Backtesting range', `${when(state.firstTime)} — ${when(state.lastTime)}`],
    ['Initial capital', money(p.initialCapital)],
    ['Base currency', p.currency || 'Default'],
    ['Order size', size],
    ['Pyramiding', `${Math.max(1, p.pyramiding)} orders`],
    ['Commission', commission],
    ['Slippage', `${p.slippage} ticks`],
    ['Margin for long positions', `${p.marginLong}%`],
    ['Margin for short positions', `${p.marginShort}%`],
    ['Recalculate after order is filled', p.calcOnOrderFills ? 'On' : 'Off'],
    ['Recalculate on every tick', p.calcOnEveryTick ? 'On' : 'Off'],
    ['Fill orders on bar close', p.processOrdersOnClose ? 'On' : 'Off'],
    ['Verify price for limit orders', `${p.fillLimitsAssumption} ticks`],
    ['Close entries rule', p.closeEntriesRule],
  ];
  return (
    <table className={styles.table}>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
