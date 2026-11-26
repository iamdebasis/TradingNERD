import type { Drawing } from './drawings.ts';

/**
 * Visual order (docs/SPEC.md §5.27, D3a): a drawing's place among the others, as TradingView's
 * right-click menu sets it (Help Center, How can I change the visual order/layer of indicators,
 * drawings & candles?; the Charting Library's Chart.Source.VisualOrder: BringToFront,
 * BringForward, SendBackward, SendToBack). A symbol's drawings are listed in paint order, the
 * last on top; those `below` the chart's bars paint under them, in the same order.
 */
export const VISUAL_ORDER_MOVES = [
  'bring-to-front',
  'bring-forward',
  'send-backward',
  'send-to-back',
] as const;
export type VisualOrderMove = (typeof VISUAL_ORDER_MOVES)[number];

/** Their words, provisional until measured from a screenshot of the menu (§11). */
export const VISUAL_ORDER_NAMES: Record<VisualOrderMove, string> = {
  'bring-to-front': 'Bring to front',
  'bring-forward': 'Bring forward',
  'send-backward': 'Send backward',
  'send-to-back': 'Send to back',
};

/** The chart's bars in the stack: the drawings under them before it, the rest after. */
const BARS = Symbol('bars');
type Token = Drawing | typeof BARS;

/** A vertical line and a crossline cross every pane (the engine draws them there). */
const crosses = (drawing: Drawing) =>
  drawing.tool === 'vertical-line' || drawing.tool === 'cross-line';

/** What a drawing stepping forward or backward can pass: the bars, and what it's drawn with. */
const meets = (token: Token, drawing: Drawing) =>
  token === BARS || token.pane === drawing.pane || crosses(token) || crosses(drawing);

/**
 * The drawings after a visual order move of those in `ids`: "Bring to front" puts them over every
 * other drawing, "Send to back" under every other and under the bars; "Bring forward" and "Send
 * backward" move each past the next drawing it's drawn with, or across the bars (provisional,
 * §11). Several move together, keeping their order. The same list comes back when nothing moves.
 */
export function reorderDrawings(
  drawings: readonly Drawing[],
  ids: readonly string[],
  move: VisualOrderMove,
): readonly Drawing[] {
  const chosen = new Set(ids);
  if (!drawings.some((drawing) => chosen.has(drawing.id))) return drawings;
  const picked = (token: Token | undefined): token is Drawing =>
    token !== undefined && token !== BARS && chosen.has(token.id);
  // The stack, bottom first: the drawings under the bars in their order, the bars, the rest.
  const stack: Token[] = [
    ...drawings.filter((drawing) => drawing.below),
    BARS,
    ...drawings.filter((drawing) => !drawing.below),
  ];
  let tokens = stack.slice();
  switch (move) {
    case 'bring-to-front':
      tokens = [...tokens.filter((token) => !picked(token)), ...tokens.filter(picked)];
      break;
    case 'send-to-back':
      tokens = [...tokens.filter(picked), ...tokens.filter((token) => !picked(token))];
      break;
    case 'bring-forward':
      // From the top down, each past the nearest one above it that it meets.
      for (let i = tokens.length - 2; i >= 0; i--) {
        const token = tokens[i];
        if (!picked(token)) continue;
        const j = tokens.findIndex((other, k) => k > i && !picked(other) && meets(other, token));
        if (j < 0) continue;
        tokens.splice(i, 1);
        tokens.splice(j, 0, token);
      }
      break;
    case 'send-backward':
      // From the bottom up, each past the nearest one under it that it meets.
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (!picked(token)) continue;
        let j = -1;
        for (let k = i - 1; k >= 0; k--) {
          const other = tokens[k] as Token;
          if (!picked(other) && meets(other, token)) {
            j = k;
            break;
          }
        }
        if (j < 0) continue;
        tokens.splice(i, 1);
        tokens.splice(j, 0, token);
      }
      break;
  }
  if (tokens.every((token, i) => token === stack[i])) return drawings;
  const bars = tokens.indexOf(BARS);
  return tokens.flatMap((token, i) => {
    if (token === BARS) return [];
    const below = i < bars;
    return [token.below === below ? token : { ...token, below }];
  });
}
