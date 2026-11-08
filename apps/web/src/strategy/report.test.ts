import { DEFAULT_STRATEGY, type StrategyState, type Trade } from '@tradingnerd/pine';
import { describe, expect, it } from 'vitest';
import { money, percent, strategyReport } from './report';

/** The Strategy Tester's figures from a strategy's trades (Pine docs: Strategy Tester). */

const trade = (size: number, entry: number, exit: number, bars: number): Trade => ({
  num: 0,
  entryId: size > 0 ? 'Long' : 'Short',
  entryComment: '',
  entryOrderBar: 0,
  entryBar: 10,
  entryTime: Date.UTC(2026, 0, 1),
  entryPrice: entry,
  size,
  entryCommissionPerUnit: 0,
  maxRunup: 0,
  maxDrawdown: 0,
  exitId: 'Exit',
  exitComment: 'Exit',
  exitBar: 10 + bars,
  exitTime: Date.UTC(2026, 1, 1),
  exitPrice: exit,
  profit: (exit - entry) * size,
  commission: 0,
});

const state = (closed: Trade[]): StrategyState => ({
  props: { ...DEFAULT_STRATEGY, initialCapital: 10_000 },
  open: [],
  closed,
  fills: [],
  figures: {
    netProfit: closed.reduce((s, t) => s + t.profit, 0),
    grossProfit: 0,
    grossLoss: 0,
    commission: 0,
    wins: 0,
    losses: 0,
    evens: 0,
    maxContractsAll: 10,
    maxContractsLong: 10,
    maxContractsShort: 5,
    maxDrawdown: 300,
    maxDrawdownPercent: 3,
    maxRunup: 500,
    maxRunupPercent: 5,
    marginCalls: 0,
  },
  equityByTrade: [],
  lastClose: 120,
  openProfit: 0,
  firstBar: 0,
  lastBar: 100,
  firstTime: Date.UTC(2025, 11, 1),
  lastTime: Date.UTC(2026, 2, 1),
  firstClose: 100,
  mintick: 0.01,
});

describe('the Performance Summary', () => {
  const report = strategyReport(
    state([trade(10, 100, 110, 4), trade(-5, 110, 120, 2), trade(10, 100, 103, 6)]),
  );

  it('sums all trades, and the long and short ones apart', () => {
    // +100, −50, +30.
    expect(report.all).toMatchObject({
      netProfit: 80,
      grossProfit: 130,
      grossLoss: 50,
      closedTrades: 3,
      wins: 2,
      losses: 1,
      profitFactor: 2.6,
      avgBars: 4,
    });
    expect(report.all.percentProfitable).toBeCloseTo(66.667, 2);
    expect(report.long).toMatchObject({ netProfit: 130, closedTrades: 2, losses: 0 });
    expect(report.short).toMatchObject({ netProfit: -50, closedTrades: 1, wins: 0 });
    expect(report.all.largestWin).toBe(100);
    expect(report.all.largestLoss).toBe(50);
  });

  it('measures buy & hold as the initial capital held from the first close to the last', () => {
    // 10,000 at 100 is 100 units; at 120 they are worth 2,000 more (provisional).
    expect(report.buyHold).toBe(2000);
    expect(report.buyHoldPercent).toBe(20);
  });
});

describe('the tester’s numbers', () => {
  it('writes money with separators and a minus sign, and percentages to two decimals', () => {
    expect(money(-101422.814)).toBe('−101,422.81');
    expect(money(Number.NaN)).toBe('—');
    expect(percent(12.071)).toBe('12.07%');
  });
});
