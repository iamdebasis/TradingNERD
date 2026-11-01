import {
  type CatalogEntry,
  COLORS,
  catalog,
  catalogEntry,
  KEYWORDS,
  namespaceMembers,
  referenceUrl,
  signatureOf,
  unpackColor,
} from '@tradingnerd/pine';
import type * as Monaco from 'monaco-editor';

/**
 * Help while typing in the Pine Editor (docs/SPEC.md §5.18), as TradingView's editor gives it
 * (its blog, "Pine Script® has a new VSC-style editor"): suggestions as you type, a function's
 * parameters inside its parentheses, a description on hover with a link to TradingView's
 * reference, and a swatch beside every color with a picker. What it knows is our engine's own
 * catalog, so it never suggests what doesn't run here.
 */

/** Where the cursor is for suggestions: after "ns." (a namespace's members) or a bare word. */
export interface CompletionContext {
  namespace: string | null;
  prefix: string;
}

/** The text before the cursor on its line → what to suggest. */
export function completionContext(before: string): CompletionContext {
  const match = /([A-Za-z_][\w.]*)?$/.exec(before);
  const word = match?.[1] ?? '';
  const dot = word.lastIndexOf('.');
  if (dot < 0) return { namespace: null, prefix: word };
  return { namespace: word.slice(0, dot), prefix: word.slice(dot + 1) };
}

/** A suggestion: a built-in, or a name the script itself declares. */
export interface Suggestion {
  /** What's inserted: the member's name after a namespace, else the whole name. */
  label: string;
  name: string;
  kind: CatalogEntry['kind'] | 'declared';
}

/** The names a script declares (variables, functions, types), for suggestions. */
export function declaredNames(text: string): string[] {
  const names = new Set<string>();
  // A variable (`x =`, `var float x =`), or a function (`f(x) =>`), at a line's start.
  const declared =
    /^[ \t]*(?:export[ \t]+)?(?:(?:var|varip|const|method)[ \t]+)?(?:[\w.<>[\], ]+?[ \t]+)?([A-Za-z_]\w*)[ \t]*(?:=(?!=)|:=|\([^)\n]*\)[ \t]*=>)/gm;
  // A type or an enum.
  const types = /^[ \t]*(?:export[ \t]+)?(?:type|enum)[ \t]+([A-Za-z_]\w*)/gm;
  for (const pattern of [declared, types]) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name && !KEYWORDS.has(name)) names.add(name);
    }
  }
  return [...names];
}

/** What to suggest at the cursor: a namespace's members, or every top-level name. */
export function suggestions(context: CompletionContext, text: string): Suggestion[] {
  if (context.namespace !== null) {
    return namespaceMembers(context.namespace).map((entry) => ({
      label: entry.name.slice(context.namespace?.length ? context.namespace.length + 1 : 0),
      name: entry.name,
      kind: entry.kind,
    }));
  }
  const top: Suggestion[] = catalog()
    .filter((entry) => !entry.name.includes('.'))
    .map((entry) => ({ label: entry.name, name: entry.name, kind: entry.kind }));
  const known = new Set(top.map((item) => item.name));
  for (const name of declaredNames(text)) {
    if (!known.has(name)) top.push({ label: name, name, kind: 'declared' });
  }
  return top;
}

/** The call the cursor is inside: its function, and which argument (by place or by name). */
export interface CallAt {
  callee: string;
  argument: number;
  named: string | null;
}

/** The innermost call still open before the cursor (strings and nested brackets skipped). */
export function callAt(before: string): CallAt | null {
  let depth = 0;
  let commas = 0;
  let quote: string | null = null;
  let argStart = before.length;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i] as string;
    if (quote) {
      if (ch === quote && before[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ')' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch === '[') return null;
      const callee = /([A-Za-z_][\w.]*)\s*$/.exec(before.slice(0, i))?.[1];
      if (!callee) return null;
      const current = before.slice(argStart === before.length ? i + 1 : argStart);
      const named = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(current)?.[1] ?? null;
      return { callee, argument: commas, named };
    } else if (ch === ',' && depth === 0) {
      if (commas === 0) argStart = i + 1;
      commas++;
    }
  }
  return null;
}

/** The dotted name under the cursor ("ta.sma"), the part up to the hovered word. */
export function nameAt(
  line: string,
  column: number,
): { name: string; start: number; end: number } | null {
  const index = column - 1;
  const word = /[A-Za-z_][\w.]*/g;
  for (const match of line.matchAll(word)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (index < start || index > end) continue;
    // Up to the end of the hovered part: hovering "ta" in "ta.sma" is the namespace.
    const after = line.slice(index).search(/[^\w]/);
    const stop = after < 0 ? end : Math.min(end, index + after);
    const name = line.slice(start, stop).replace(/\.$/, '');
    return name ? { name, start: start + 1, end: stop + 1 } : null;
  }
  return null;
}

/** A built-in's one-line description: its signature or kind. */
export function describe(entry: CatalogEntry): string {
  if (entry.kind === 'function') {
    const signature = signatureOf(entry.name)[0];
    return signature ? `${entry.name}(${signature.params.join(', ')})` : `${entry.name}()`;
  }
  return entry.name;
}

/** A color written in the code, with where it is (0-based offsets) and its RGBA. */
export interface ColorAt {
  start: number;
  end: number;
  red: number;
  green: number;
  blue: number;
  /** 0 (clear) to 1 (opaque). */
  alpha: number;
  /** How it's written, so an edit keeps the kind (provisional, §11). */
  form: 'hex' | 'constant' | 'new' | 'rgb';
}

const NUMBER = String.raw`\s*(-?\d+(?:\.\d+)?)\s*`;

/** Every color the code writes: #RRGGBB(AA), color.<name>, color.new(…) and color.rgb(…). */
export function colorsIn(text: string): ColorAt[] {
  const found: ColorAt[] = [];
  const taken = (start: number, end: number) =>
    found.some((item) => start < item.end && end > item.start);
  const constantOf = (name: string) => {
    const packed = COLORS[name];
    return packed === undefined ? null : unpackColor(packed);
  };
  const newColor = new RegExp(
    String.raw`color\.new\(\s*(?:color\.(\w+)|#([0-9a-fA-F]{6}))\s*,${NUMBER}\)`,
    'g',
  );
  for (const match of text.matchAll(newColor)) {
    const start = match.index ?? 0;
    const base = match[1]
      ? constantOf(match[1])
      : match[2]
        ? { r: hex(match[2], 0), g: hex(match[2], 2), b: hex(match[2], 4) }
        : null;
    if (!base) continue;
    const t = Math.min(100, Math.max(0, Number(match[3])));
    found.push({
      start,
      end: start + match[0].length,
      red: base.r,
      green: base.g,
      blue: base.b,
      alpha: 1 - t / 100,
      form: 'new',
    });
  }
  const rgb = new RegExp(
    String.raw`color\.rgb\(${NUMBER},${NUMBER},${NUMBER}(?:,${NUMBER})?\)`,
    'g',
  );
  for (const match of text.matchAll(rgb)) {
    const start = match.index ?? 0;
    const channel = (k: number) => Math.min(255, Math.max(0, Math.round(Number(match[k]))));
    const t = match[4] === undefined ? 0 : Math.min(100, Math.max(0, Number(match[4])));
    found.push({
      start,
      end: start + match[0].length,
      red: channel(1),
      green: channel(2),
      blue: channel(3),
      alpha: 1 - t / 100,
      form: 'rgb',
    });
  }
  for (const match of text.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const digits = match[1] as string;
    if (taken(start, end)) continue;
    found.push({
      start,
      end,
      red: hex(digits, 0),
      green: hex(digits, 2),
      blue: hex(digits, 4),
      alpha: digits.length === 8 ? hex(digits, 6) / 255 : 1,
      form: 'hex',
    });
  }
  for (const match of text.matchAll(/\bcolor\.(\w+)\b(?!\s*\()/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const value = constantOf(match[1] as string);
    if (!value || taken(start, end)) continue;
    found.push({
      start,
      end,
      red: value.r,
      green: value.g,
      blue: value.b,
      alpha: 1 - value.t / 100,
      form: 'constant',
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

const hex = (digits: string, at: number) => Number.parseInt(digits.slice(at, at + 2), 16);
const two = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();

/**
 * A picked color as code: color.rgb() for one written that way or with color.new(), else
 * #RRGGBB, with AA when it isn't opaque (provisional: TradingView's own isn't documented).
 */
export function colorText(color: Omit<ColorAt, 'start' | 'end'>): string {
  const transparency = Math.round((1 - color.alpha) * 100);
  if (color.form === 'rgb' || color.form === 'new') {
    const rgb = `${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}`;
    return transparency === 0 ? `color.rgb(${rgb})` : `color.rgb(${rgb}, ${transparency})`;
  }
  const alpha = color.alpha >= 1 ? '' : two(color.alpha * 255);
  return `#${two(color.red)}${two(color.green)}${two(color.blue)}${alpha}`;
}

/** Registers the help with Monaco for Pine (once, with the language). */
export function registerPineHelp(monaco: typeof Monaco, language: string): void {
  const { languages } = monaco;
  const kinds: Record<Suggestion['kind'], Monaco.languages.CompletionItemKind> = {
    function: languages.CompletionItemKind.Function,
    variable: languages.CompletionItemKind.Variable,
    constant: languages.CompletionItemKind.Constant,
    namespace: languages.CompletionItemKind.Module,
    type: languages.CompletionItemKind.Class,
    keyword: languages.CompletionItemKind.Keyword,
    declared: languages.CompletionItemKind.Variable,
  };
  const documentation = (entry: CatalogEntry): Monaco.IMarkdownString | undefined => {
    const url = referenceUrl(entry);
    return url ? { value: `[Reference](${url})`, isTrusted: false } : undefined;
  };

  languages.registerCompletionItemProvider(language, {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const context = completionContext(before);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - context.prefix.length,
        endColumn: position.column,
      };
      return {
        suggestions: suggestions(context, model.getValue()).map((item) => ({
          label: item.label,
          kind: kinds[item.kind],
          insertText: item.label,
          range,
          // The full name lets resolve find the built-in.
          detail: item.kind === 'declared' ? 'declared in this script' : item.kind,
          sortText: `${item.kind === 'keyword' ? 1 : 0}${item.label}`,
          filterText: item.label,
          data: item.name,
        })),
      };
    },
    resolveCompletionItem(item) {
      const name = (item as Monaco.languages.CompletionItem & { data?: string }).data;
      const entry = name ? catalogEntry(name) : undefined;
      if (!entry) return item;
      return { ...item, detail: describe(entry), documentation: documentation(entry) };
    },
  });

  languages.registerHoverProvider(language, {
    provideHover(model, position) {
      const at = nameAt(model.getLineContent(position.lineNumber), position.column);
      const entry = at ? catalogEntry(at.name) : undefined;
      if (!at || !entry) return null;
      const contents: Monaco.IMarkdownString[] = [
        { value: `\`\`\`pine\n${describe(entry)}\n\`\`\`` },
        { value: `Built-in ${entry.kind}` },
      ];
      const link = documentation(entry);
      if (link) contents.push(link);
      return {
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: at.start,
          endColumn: at.end,
        },
        contents,
      };
    },
  });

  languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const before = model.getValueInRange({
        startLineNumber: Math.max(1, position.lineNumber - 20),
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const call = callAt(before);
      const entry = call ? catalogEntry(call.callee) : undefined;
      if (!call || entry?.kind !== 'function') return null;
      const signatures = signatureOf(entry.name);
      if (signatures.length === 0) return null;
      return {
        value: {
          signatures: signatures.map((signature) => ({
            label: `${entry.name}(${signature.params.join(', ')})`,
            parameters: signature.params.map((param) => ({ label: param })),
          })),
          activeSignature: 0,
          activeParameter: call.named
            ? Math.max(0, signatures[0]?.params.indexOf(call.named) ?? 0)
            : call.argument,
        },
        dispose() {},
      };
    },
  });

  languages.registerColorProvider(language, {
    provideDocumentColors(model) {
      return colorsIn(model.getValue()).map((color) => {
        const start = model.getPositionAt(color.start);
        const end = model.getPositionAt(color.end);
        return {
          color: {
            red: color.red / 255,
            green: color.green / 255,
            blue: color.blue / 255,
            alpha: color.alpha,
          },
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
        };
      });
    },
    provideColorPresentations(model, info) {
      const written = model.getValueInRange(info.range);
      const form: ColorAt['form'] = written.startsWith('color.rgb')
        ? 'rgb'
        : written.startsWith('color.new')
          ? 'new'
          : written.startsWith('#')
            ? 'hex'
            : 'constant';
      const label = colorText({
        red: info.color.red * 255,
        green: info.color.green * 255,
        blue: info.color.blue * 255,
        alpha: info.color.alpha,
        form,
      });
      return [{ label, textEdit: { range: info.range, text: label } }];
    },
  });
}
