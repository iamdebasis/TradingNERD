/** A price range, low to high, as Lightweight Charts' price scale reports it. */
export interface PriceRange {
  from: number;
  to: number;
}

/**
 * Stretches a price range by `factor` around `anchor`, a price that keeps its place on screen.
 * Above 1 zooms in (taller candles), below 1 zooms out. The price scale maps its range linearly
 * onto the pane (inside the margins), so keeping the anchor's share of the range keeps its y.
 */
export function scalePriceRange(range: PriceRange, factor: number, anchor: number): PriceRange {
  return {
    from: anchor - (anchor - range.from) / factor,
    to: anchor + (range.to - anchor) / factor,
  };
}
