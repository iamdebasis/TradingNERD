import type { AggTrade } from '@tradingnerd/core';
import type { TickSource } from '../../src/market/types.ts';

/**
 * `count` aggregate trades with ids `firstAggId` … and contiguous trade ids from `firstTradeId`,
 * each 1–5 trades at a price that wanders around 1.3, 250 ms apart.
 */
export function makeAggTrades(count: number, firstAggId = 0, firstTradeId = 0): AggTrade[] {
  const trades: AggTrade[] = [];
  let tradeId = firstTradeId;
  for (let i = 0; i < count; i++) {
    const size = 1 + ((i * 7) % 5);
    const id = firstAggId + i;
    trades.push({
      id,
      firstId: tradeId,
      lastId: tradeId + size - 1,
      price: Math.round((1.3 + Math.sin(i / 9) * 0.01) * 10_000) / 10_000,
      quantity: size * 10,
      time: 1_792_300_000_000 + i * 250,
    });
    tradeId += size;
  }
  return trades;
}

/** A trade history held in memory, paged like Binance's aggregate trades. */
export class FakeTickSource implements TickSource {
  readonly maxPerRequest: number;
  trades: AggTrade[];
  readonly pageCalls: { fromId: number | null; limit: number }[] = [];
  readonly containingCalls: number[] = [];

  constructor(trades: AggTrade[], maxPerRequest = 1_000) {
    this.trades = trades;
    this.maxPerRequest = maxPerRequest;
  }

  async aggTrades(_ticker: string, fromId: number | null, limit: number): Promise<AggTrade[]> {
    this.pageCalls.push({ fromId, limit });
    const capped = Math.min(limit, this.maxPerRequest);
    if (fromId === null) return this.trades.slice(-capped).map((trade) => ({ ...trade }));
    // Like Binance: from the requested id, or from the oldest one it still has.
    const start = this.trades.findIndex((trade) => trade.id >= fromId);
    if (start < 0) return [];
    return this.trades.slice(start, start + capped).map((trade) => ({ ...trade }));
  }

  async aggTradeContaining(_ticker: string, tradeId: number): Promise<AggTrade | null> {
    this.containingCalls.push(tradeId);
    const trade = this.trades.find((agg) => agg.firstId <= tradeId && tradeId <= agg.lastId);
    return trade ? { ...trade } : null;
  }
}
