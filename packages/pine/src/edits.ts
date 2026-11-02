import type { Span } from './diagnostics.ts';

/** A change to a v5 script's code that keeps what it does in v6 (Convert code to v6). */
export interface ConversionEdit {
  /** Where, in the script's own code. */
  span: Span;
  /** Written before and after it, as bool( … ) around a number used as a condition. */
  before?: string;
  after?: string;
  /** What replaces it: "" to delete it. */
  replace?: string;
}

/** Where the compiler puts the changes it finds while it compiles a v5 script. */
export interface EditSink {
  add(edit: ConversionEdit): void;
}

/**
 * Deletes a call's repeated argument with the comma before it: "Remove the duplicate
 * parameters" (v6 guide).
 */
export function repeatedArg(args: readonly { span: Span }[], k: number): ConversionEdit {
  const arg = (args[k] as { span: Span }).span;
  const previous = args[k - 1]?.span;
  const next = args[k + 1]?.span;
  // The first argument goes with the comma after it.
  const span: Span = previous
    ? {
        line: previous.endLine,
        column: previous.endColumn,
        endLine: arg.endLine,
        endColumn: arg.endColumn,
      }
    : next
      ? { line: arg.line, column: arg.column, endLine: next.line, endColumn: next.column }
      : arg;
  return { span, replace: '' };
}

/** Reads a span's text from the code (lines split as the lexer splits them). */
export function spanText(source: string): (span: Span) => string {
  const lines = source.split(/\r?\n/);
  return (span) => {
    if (span.line === span.endLine) {
      return (lines[span.line - 1] ?? '').slice(span.column - 1, span.endColumn - 1);
    }
    const first = (lines[span.line - 1] ?? '').slice(span.column - 1);
    const middle = lines.slice(span.line, span.endLine - 1);
    const last = (lines[span.endLine - 1] ?? '').slice(0, span.endColumn - 1);
    return [first, ...middle, last].join('\n');
  };
}
