/** Where something is in a script: 1-based lines and columns, the end exclusive. */
export interface Span {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * A compiler message, as the Pine Editor shows them: errors stop the script, warnings don't
 * (TradingView's Pine docs, Errors; red and orange underlines).
 */
export interface PineDiagnostic extends Span {
  severity: 'error' | 'warning';
  message: string;
}

/** A compile error that stops compiling at once. */
export class PineCompileError extends Error {
  readonly span: Span;

  constructor(message: string, span: Span) {
    super(message);
    this.name = 'PineCompileError';
    this.span = span;
  }
}

/** An error while the script runs on a bar: the script stops, as Pine's runtime errors do. */
export class PineRuntimeError extends Error {
  readonly span: Span | null;

  constructor(message: string, span: Span | null = null) {
    super(message);
    this.name = 'PineRuntimeError';
    this.span = span;
  }
}

export const spanOf = (from: Span, to: Span = from): Span => ({
  line: from.line,
  column: from.column,
  endLine: to.endLine,
  endColumn: to.endColumn,
});
