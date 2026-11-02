import type { CompileOptions } from './compiler.ts';
import type { PineDiagnostic } from './diagnostics.ts';
import type { ConversionEdit } from './edits.ts';
import { versionIn } from './lexer.ts';
import { compileScript } from './script.ts';

/**
 * Convert code to v6, as the Pine Editor's script menu has it (v6 migration guide, Converting v5
 * to v6 using the Pine Editor): only v5 code that compiles converts, and the result is checked
 * as v6, its errors shown in the editor if any remain ("In rare cases, converting the script
 * automatically can result in a v6 script with compilation errors").
 *
 * The changes are the guide's own fixes that keep what a script does: bool() around a number
 * used as a condition, int() around a division of two const ints, a repeated argument removed,
 * [] removed from a literal, and transp joined to its color with color.new(). TradingView's
 * converter drops transp instead; we write its guide's fix, so the script draws the same
 * (docs/SPEC.md §3). What the guide leaves to the author (lazy and/or, na bools, "D" against
 * "1D", a for loop's end) is left as it is.
 */
export type ConvertResult =
  | { ok: true; source: string; changes: number; errors: PineDiagnostic[] }
  | { ok: false; reason: 'not-v5' | 'does-not-compile'; errors: PineDiagnostic[] };

export function convertToV6(source: string, options: CompileOptions = {}): ConvertResult {
  if (versionIn(source) !== 5) return { ok: false, reason: 'not-v5', errors: [] };
  const found = new Map<string, ConversionEdit>();
  const compiled = compileScript(source, {
    ...options,
    edits: {
      add: (edit) => {
        const { span } = edit;
        const key = `${span.line}:${span.column}:${span.endLine}:${span.endColumn}:${edit.before ?? ''}:${edit.replace ?? ''}`;
        if (!found.has(key)) found.set(key, edit);
      },
    },
  });
  if (!compiled.ok) return { ok: false, reason: 'does-not-compile', errors: compiled.errors };
  const edited = applyEdits(source, [...found.values()]);
  const converted = edited.replace(/^(\s*\/\/\s*@version\s*=\s*)5\b/m, '$16');
  const check = compileScript(converted, options);
  return {
    ok: true,
    source: converted,
    changes: found.size,
    errors: check.ok ? [] : check.errors,
  };
}

/** Where each line starts in the code, so a span's line and column find their offset. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

interface Operation {
  at: number;
  /** A replacement's end; an insertion's is its own place. */
  end: number;
  text: string;
  /** Insertions at one place: closing ones first in the text, then opening ones, the outer
   * opening first and the inner closing first. */
  order: number;
}

/**
 * Applies the changes from the end of the code back, so earlier places stay where they are.
 * A wrap inside a part another change replaces goes with it.
 */
export function applyEdits(source: string, edits: readonly ConversionEdit[]): string {
  const starts = lineStarts(source);
  const offset = (line: number, column: number) => (starts[line - 1] ?? source.length) + column - 1;
  const replaced = edits
    .filter((edit) => edit.replace !== undefined)
    .map((edit) => ({
      at: offset(edit.span.line, edit.span.column),
      end: offset(edit.span.endLine, edit.span.endColumn),
      text: edit.replace as string,
    }));
  const inside = (at: number, end: number) =>
    replaced.some((r) => at >= r.at && end <= r.end && !(at === r.at && end === r.end));
  const operations: Operation[] = [];
  for (const r of replaced) {
    if (!inside(r.at, r.end)) operations.push({ ...r, order: 0 });
  }
  for (const edit of edits) {
    if (edit.replace !== undefined) continue;
    const at = offset(edit.span.line, edit.span.column);
    const end = offset(edit.span.endLine, edit.span.endColumn);
    if (inside(at, end)) continue;
    const length = end - at;
    if (edit.after) operations.push({ at: end, end, text: edit.after, order: length });
    if (edit.before) {
      operations.push({ at, end: at, text: edit.before, order: 1_000_000_000 - length });
    }
  }
  // From the end back; at one place, a replacement first, then the insertions in the reverse of
  // their order in the text (each one lands in front of those already put there).
  operations.sort(
    (a, b) => b.at - a.at || Number(b.end > b.at) - Number(a.end > a.at) || b.order - a.order,
  );
  let out = source;
  for (const op of operations) out = out.slice(0, op.at) + op.text + out.slice(op.end);
  return out;
}
