/**
 * The Displacement tab of several drawings' settings (docs/SPEC.md §5.27, D3c2), as TradingView
 * has it (its Help Center, How to move multiple drawing objects at the same time?, and its image:
 * "Use special math signs to displace selected drawings: +,-,/,* for price and +,- for bar
 * index."; its blog, 21 September 2022: "If you enter just a number without a sign, then all
 * drawing objects will be shifted to the value of the specified coordinate"). Each point of each
 * drawing changes by the same expression.
 */

export type DisplacementAxis = 'price' | 'bar';

/** What an expression does to a coordinate: add, subtract, multiply, divide, or set it. */
export interface Displacement {
  op: '+' | '-' | '*' | '/' | '=';
  value: number;
}

const EXPRESSION = /^([+\-*/])?\s*(\d+(?:\.\d*)?|\.\d+)$/;

/**
 * An expression as typed ("+5", "-1", "/2", "*1.5", or a bare number), or null when it isn't one:
 * a bar index takes only + and − and whole bars (TradingView's hint), and nothing divides by 0.
 */
export function parseDisplacement(text: string, axis: DisplacementAxis): Displacement | null {
  const match = EXPRESSION.exec(text.trim());
  if (!match) return null;
  const op = (match[1] ?? '=') as Displacement['op'];
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return null;
  if (axis === 'bar' && (op === '*' || op === '/' || !Number.isInteger(value))) return null;
  if (op === '/' && value === 0) return null;
  return { op, value };
}

/** A coordinate after an expression. */
export function displace(coordinate: number, by: Displacement): number {
  switch (by.op) {
    case '+':
      return coordinate + by.value;
    case '-':
      return coordinate - by.value;
    case '*':
      return coordinate * by.value;
    case '/':
      return coordinate / by.value;
    case '=':
      return by.value;
  }
}
