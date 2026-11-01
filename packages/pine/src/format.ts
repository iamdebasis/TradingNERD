import { precisionOf } from '@tradingnerd/core';
import { PineRuntimeError } from './diagnostics.ts';

/**
 * How Pine writes numbers (Pine v6 reference: str.tostring, str.format, format.*). Pine's
 * patterns are Java's DecimalFormat and MessageFormat ones ("#.##", "{0,number,percent}"), and
 * their rules are Java's where TradingView's reference is silent. The rest are the rules PineTS
 * measured on TradingView (third-party: PineTS 0.11.0's changelog and tests, 2026-10-01),
 * checked on our own examples in format.test.ts. docs/SPEC.md §4.17 has the sources, §11 the
 * provisional ones.
 */

/**
 * A number's decimal digits, without the sign: `0.d1 d2 d3 … × 10^point`, the digits holding
 * no leading or trailing zeros ("" for zero).
 */
interface Digits {
  digits: string;
  point: number;
}

/** The shortest digits that read back as `x` (JavaScript's own, as `String(x)` writes them). */
function shortest(x: number): Digits {
  if (x === 0) return { digits: '', point: 0 };
  const [mantissa = '', exponent = '0'] = Math.abs(x).toExponential().split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '');
  return { digits, point: Number(exponent) + 1 };
}

/** -1, 0 or 1: how |x| compares to the decimal `0.digits × 10^point`, exactly. */
function compareExact(x: number, { digits, point }: Digits): number {
  // |x| = m × 2^e exactly, m an integer below 2^53.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let m = bits & 0xfffffffffffffn;
  let e: number;
  if (biased === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = biased - 1075;
  }
  let left = m;
  let right = BigInt(digits || '0');
  const q = point - digits.length;
  if (e > 0) left <<= BigInt(e);
  else right <<= BigInt(-e);
  if (q > 0) right *= 10n ** BigInt(q);
  else left *= 10n ** BigInt(-q);
  return left === right ? 0 : left > right ? 1 : -1;
}

/**
 * How a tie at the last kept digit goes:
 * - `exact`, Java's way (str.format, and str.tostring without a format): the number's exact
 *   binary value decides, an exact tie goes to the even digit, and a number rounding to zero
 *   from its first digit stays zero (measured: `{0,number,#.###}` of 0.0005 is "0").
 * - `up`, half up from the digits as written (str.tostring with a format: "1.25" with "#.#"
 *   is "1.3", the reference's own example; 1.005 with "#.##" is "1.01").
 */
type Rounding = 'exact' | 'up';

/** `x`'s digits rounded to `fraction` decimals. */
function rounded(x: number, fraction: number, rounding: Rounding): Digits {
  const d = shortest(x);
  const keep = d.point + fraction;
  if (keep >= d.digits.length) return d;
  if (keep < 0) return { digits: '', point: 0 };
  const next = d.digits.charCodeAt(keep) - 48;
  const rest = d.digits.slice(keep + 1);
  let up: boolean;
  if (next !== 5 || rest !== '') up = next >= 5;
  else if (rounding === 'up') up = true;
  else if (keep === 0) up = false;
  else {
    const exact = compareExact(x, d);
    up = exact > 0 || (exact === 0 && (d.digits.charCodeAt(keep - 1) - 48) % 2 === 1);
  }
  let kept = d.digits.slice(0, keep);
  let point = d.point;
  if (up) {
    // Add one to the last kept digit, carrying: "1299" → "13", "999" → "1" one place up.
    let i = kept.length - 1;
    while (i >= 0 && kept[i] === '9') i--;
    if (i < 0) {
      kept = '1';
      point += 1;
    } else kept = kept.slice(0, i) + String.fromCharCode(kept.charCodeAt(i) + 1);
  }
  kept = kept.replace(/0+$/, '');
  return kept === '' ? { digits: '', point: 0 } : { digits: kept, point };
}

/** The integer and fraction digits of `d`, as strings ("" for none). */
function parts({ digits, point }: Digits): { int: string; frac: string } {
  if (digits === '') return { int: '', frac: '' };
  if (point <= 0) return { int: '', frac: '0'.repeat(-point) + digits };
  if (point >= digits.length) return { int: digits + '0'.repeat(point - digits.length), frac: '' };
  return { int: digits.slice(0, point), frac: digits.slice(point) };
}

/** A DecimalFormat pattern, as far as Pine's scripts use them. */
interface NumberPattern {
  prefix: string;
  suffix: string;
  minInt: number;
  minFrac: number;
  maxFrac: number;
  /** Digits per group ("#,##0" → 3); 0 for none. */
  grouping: number;
  /** ×100 for %, ×1000 for ‰. */
  multiplier: number;
  /** Scientific: the exponent's minimum digits ("0.##E0" → 1); 0 for none. */
  exponent: number;
  /** The pattern has digit placeholders; one without is a literal prefix (Java's rule). */
  digits: boolean;
}

const patterns = new Map<string, NumberPattern>();

/** Reads a DecimalFormat pattern (its positive part: Pine writes negatives with "-"). */
export function numberPattern(text: string): NumberPattern {
  let pattern = patterns.get(text);
  if (pattern) return pattern;
  let prefix = '';
  let suffix = '';
  // Asserted, not inferred: `literal` below moves it to 'suffix' from inside a closure.
  let phase = 'prefix' as 'prefix' | 'int' | 'frac' | 'exp' | 'suffix';
  let minInt = 0;
  let minFrac = 0;
  let maxFrac = 0;
  let grouping = 0;
  let sinceComma = -1;
  let multiplier = 1;
  let exponent = 0;
  let digits = false;
  const literal = (ch: string) => {
    if (phase === 'prefix') prefix += ch;
    else {
      phase = 'suffix';
      suffix += ch;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === ';') break;
    if (ch === "'") {
      // '' is a quote; '…' is literal text.
      if (text[i + 1] === "'") {
        literal("'");
        i++;
        continue;
      }
      const end = text.indexOf("'", i + 1);
      const quoted = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      for (const q of quoted) literal(q);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (phase !== 'suffix' && (ch === '#' || ch === '0')) {
      digits = true;
      if (phase === 'prefix') phase = 'int';
      if (phase === 'int') {
        if (ch === '0') minInt++;
        if (sinceComma >= 0) sinceComma++;
      } else if (phase === 'frac') {
        maxFrac++;
        if (ch === '0') minFrac = maxFrac;
      } else if (phase === 'exp' && ch === '0') exponent++;
      continue;
    }
    if (phase !== 'suffix' && phase !== 'exp' && ch === ',') {
      if (phase === 'prefix') phase = 'int';
      if (phase === 'int') {
        sinceComma = 0;
        continue;
      }
    }
    if ((phase === 'int' || phase === 'prefix') && ch === '.') {
      phase = 'frac';
      digits = true;
      continue;
    }
    if ((phase === 'int' || phase === 'frac') && ch === 'E') {
      phase = 'exp';
      continue;
    }
    if (ch === '%') multiplier = 100;
    else if (ch === '‰') multiplier = 1000;
    literal(ch);
  }
  if (sinceComma > 0) grouping = sinceComma;
  pattern = {
    prefix,
    suffix,
    minInt,
    minFrac,
    maxFrac,
    grouping,
    multiplier,
    exponent,
    digits,
  };
  patterns.set(text, pattern);
  return pattern;
}

const group = (int: string, size: number) => {
  if (size <= 0 || int.length <= size) return int;
  const head = int.length % size || size;
  let out = int.slice(0, head);
  for (let i = head; i < int.length; i += size) out += `,${int.slice(i, i + size)}`;
  return out;
};

/**
 * `x` written with a DecimalFormat pattern. `keepZeroSign`: str.format writes −0.001 with "#"
 * as "-0", str.tostring as "0" (measured).
 */
export function formatPattern(
  x: number,
  pattern: NumberPattern,
  rounding: Rounding,
  keepZeroSign: boolean,
): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return `${x < 0 ? '-' : ''}${pattern.prefix}∞${pattern.suffix}`;
  const negative = x < 0 || Object.is(x, -0);
  const value = Math.abs(x) * pattern.multiplier;
  if (!pattern.digits) {
    // No digit placeholders: the pattern is a prefix to the number rounded to a whole one.
    const { int } = parts(rounded(value, 0, rounding));
    return `${negative && (x !== 0 || keepZeroSign) ? '-' : ''}${pattern.prefix}${int || '0'}`;
  }
  let body: string;
  if (pattern.exponent > 0) {
    const d = shortest(value);
    const exp = d.digits === '' ? 0 : d.point - Math.max(1, pattern.minInt);
    const scaled = rounded(value / 10 ** exp, pattern.maxFrac, rounding);
    const { int, frac } = parts(scaled);
    const fraction = frac.padEnd(pattern.minFrac, '0');
    body = `${(int || '0').padStart(pattern.minInt, '0')}${fraction ? `.${fraction}` : ''}E${exp < 0 ? '-' : ''}${String(Math.abs(exp)).padStart(pattern.exponent, '0')}`;
  } else {
    const { int, frac } = parts(rounded(value, pattern.maxFrac, rounding));
    // A leading zero always: TradingView writes 0.13 with "#.##", where Java writes .13.
    const intText = group(int.padStart(Math.max(1, pattern.minInt), '0'), pattern.grouping);
    const fraction = frac.padEnd(pattern.minFrac, '0');
    body = fraction ? `${intText}.${fraction}` : intText;
    if (!keepZeroSign && /^[0.,]*$/.test(body)) return `${pattern.prefix}${body}${pattern.suffix}`;
  }
  return `${negative ? '-' : ''}${pattern.prefix}${body}${pattern.suffix}`;
}

/**
 * str.tostring() of a float: at most 10 decimals, no trailing zeros, Java's "1.5E300" at and
 * above 1e21 (measured: 1/3 is "0.3333333333", 1e-7 "0.0000001", 1e21 "1E21").
 */
export function floatToString(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x < 0 ? '-∞' : '∞';
  if (Math.abs(x) >= 1e21) return javaScientific(x, 10);
  const { int, frac } = parts(rounded(x, 10, 'exact'));
  const text = frac ? `${int || '0'}.${frac}` : int || '0';
  return x < 0 && text !== '0' ? `-${text}` : text;
}

/** "1.2345678901E29": Java's scientific form, up to `fraction` decimals. */
function javaScientific(x: number, fraction: number): string {
  const d = shortest(x);
  const exp = d.point - 1;
  const mantissa = rounded(Math.abs(x) / 10 ** exp, fraction, 'exact');
  const { int, frac } = parts(mantissa);
  return `${x < 0 ? '-' : ''}${int || '0'}${frac ? `.${frac}` : ''}E${exp}`;
}

/**
 * Java's Double.toString, which array.join() uses for floats (measured: "5.0", "1.0E8",
 * "1.0E-7", "1.2345678912345679E8").
 */
export function javaDouble(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x < 0 ? '-Infinity' : 'Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(x);
  const sign = x < 0 ? '-' : '';
  const d = shortest(x);
  if (abs >= 1e-3 && abs < 1e7) {
    const { int, frac } = parts(d);
    return `${sign}${int || '0'}.${frac || '0'}`;
  }
  const rest = d.digits.slice(1);
  return `${sign}${d.digits[0]}.${rest || '0'}E${d.point - 1}`;
}

/** Pine's format.* values, which str.tostring() takes as its format. */
export const FORMAT_NAMES = new Set(['inherit', 'price', 'volume', 'percent', 'mintick']);

/** format.volume: K, M, B, T with three decimals, below a thousand a whole number (measured). */
function formatVolume(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  const abs = Math.abs(x);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const text = formatPattern(abs / size, numberPattern('0.###'), 'up', false);
      return `${x < 0 ? '-' : ''}${text}${unit}`;
    }
  }
  return formatPattern(x, numberPattern('0'), 'up', false);
}

/**
 * str.tostring(value, format): a format.* value or a DecimalFormat pattern. format.percent adds
 * "%" with two decimals; format.mintick rounds to the symbol's tick with its decimals (both
 * half up, measured).
 */
export function formatNumber(x: number, format: string, mintick: number): string {
  switch (format) {
    case 'volume':
      return formatVolume(x);
    case 'percent':
      return `${formatPattern(x, numberPattern('0.00'), 'up', false)}%`;
    case 'mintick': {
      const decimals = precisionOf(mintick);
      const pattern = numberPattern(decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0');
      // A tick of 0.01 rounds at the decimals, from the digits as written (0.015 is 0.02); a
      // tick like 0.25 to its nearest multiple first.
      const steps = mintick * 10 ** decimals;
      const value =
        Math.abs(steps - Math.round(steps)) < 1e-9 && Math.round(steps) === 1
          ? x
          : Math.round(x / mintick) * mintick;
      return formatPattern(value, pattern, 'up', false);
    }
    default:
      return formatPattern(x, numberPattern(format), 'up', false);
  }
}

/** str.tonumber(): plain decimal numbers only, spaces around allowed (measured). */
export function parseNumber(text: string): number {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

// ---- str.format(): Java's MessageFormat ----

/** A value str.format() places, as the compiled call gives it. */
export interface FormatArg {
  value: unknown;
  /** The argument's type: "int", "float", "bool", "string", "array<float>" … */
  type: string;
}

/** A placeholder's own formatting: its type keyword and style, as written. */
interface Placeholder {
  index: number;
  type: '' | 'number' | 'date' | 'time' | 'choice';
  style: string;
}

type Segment = string | Placeholder;

const messages = new Map<string, Segment[]>();

/**
 * Reads a str.format() pattern as Java's MessageFormat does: '' is a quote, '…' literal text,
 * {index[,type[,style]]} a placeholder (the type's case and spaces don't matter, the style's
 * do: "{0, number, #.##}" writes a space first, measured).
 */
function parseMessage(pattern: string): Segment[] {
  const cached = messages.get(pattern);
  if (cached) return cached;
  const segments: Segment[] = [];
  let raw = '';
  let part = 0;
  const fields = ['', '', ''];
  let braces = 0;
  let quoted = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (part === 0) {
      if (ch === "'") {
        if (pattern[i + 1] === "'") {
          raw += "'";
          i++;
        } else quoted = !quoted;
      } else if (ch === '{' && !quoted) {
        part = 1;
        fields[0] = '';
        fields[1] = '';
        fields[2] = '';
      } else raw += ch;
      continue;
    }
    if (quoted) {
      fields[part - 1] += ch;
      if (ch === "'") quoted = false;
      continue;
    }
    switch (ch) {
      case ',':
        if (part < 3) part++;
        else fields[2] += ch;
        break;
      case '{':
        braces++;
        fields[part - 1] += ch;
        break;
      case '}':
        if (braces === 0) {
          part = 0;
          if (raw) segments.push(raw);
          raw = '';
          segments.push(placeholder(fields[0] as string, fields[1] as string, fields[2] as string));
        } else {
          braces--;
          fields[part - 1] += ch;
        }
        break;
      case ' ':
        // Spaces before the type are skipped; everywhere else they count.
        if (part !== 2 || (fields[1] as string).length > 0) fields[part - 1] += ch;
        break;
      case "'":
        quoted = true;
        fields[part - 1] += ch;
        break;
      default:
        fields[part - 1] += ch;
    }
  }
  if (part !== 0) throw new PineRuntimeError('Unmatched braces in the pattern.');
  if (raw) segments.push(raw);
  messages.set(pattern, segments);
  return segments;
}

function placeholder(indexText: string, typeText: string, style: string): Placeholder {
  if (!/^\d+$/.test(indexText)) {
    throw new PineRuntimeError(`can't parse argument number: ${indexText}`);
  }
  const type = typeText.trim().toLowerCase();
  if (type !== '' && type !== 'number' && type !== 'date' && type !== 'time' && type !== 'choice')
    throw new PineRuntimeError(`unknown format type: ${typeText}`);
  return { index: Number(indexText), type, style };
}

/**
 * What str.format() needs of the time functions (time.ts), given by the caller: a UNIX time (ms)
 * in UTC with a SimpleDateFormat pattern, as {0,time,HH:mm} has it.
 */
export type DateWriter = (ms: number, pattern: string) => string;

const DATE_STYLES: Record<string, { date: string; time: string }> = {
  '': { date: 'MMM d, yyyy', time: 'h:mm:ss a' },
  short: { date: 'M/d/yy', time: 'h:mm a' },
  medium: { date: 'MMM d, yyyy', time: 'h:mm:ss a' },
  long: { date: 'MMMM d, yyyy', time: 'h:mm:ss a z' },
  full: { date: 'EEEE, MMMM d, yyyy', time: 'h:mm:ss a zzzz' },
};

/** A number with str.format()'s default and keyword formats (Java's en-US ones). */
function formatMessageNumber(x: number, style: string): string {
  switch (style.trim().toLowerCase()) {
    case '':
      return formatPattern(x, numberPattern('#,##0.###'), 'exact', true);
    case 'integer':
      return formatPattern(x, numberPattern('#,##0'), 'exact', true);
    case 'percent':
      return formatPattern(x, numberPattern('#,##0%'), 'exact', true);
    case 'currency':
      return formatPattern(x, numberPattern('$#,##0.00'), 'exact', true);
    default:
      return formatPattern(x, numberPattern(style), 'exact', true);
  }
}

/** How str.format() writes an argument with no format of its own. */
function plain(arg: FormatArg): string {
  const { value, type } = arg;
  if (value === null || value === undefined) return type === 'string' ? '' : 'NaN';
  if (typeof value === 'number') {
    return formatMessageNumber(value, type === 'int' ? 'integer' : '');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const elem = type.startsWith('array<') ? type.slice(6, -1) : '';
    return `[${value
      .map((v) =>
        typeof v === 'number'
          ? elem === 'int'
            ? Number.isNaN(v)
              ? 'NaN'
              : String(v)
            : javaDouble(v)
          : v === null
            ? ''
            : String(v),
      )
      .join(', ')}]`;
  }
  return String(value);
}

/** str.format(pattern, args…) and log.info(pattern, args…). */
export function formatMessage(
  pattern: string,
  args: readonly FormatArg[],
  dates: DateWriter,
): string {
  let out = '';
  for (const segment of parseMessage(pattern)) {
    if (typeof segment === 'string') {
      out += segment;
      continue;
    }
    const arg = args[segment.index];
    if (!arg) {
      // Java keeps a placeholder without an argument as written.
      out += `{${segment.index}}`;
      continue;
    }
    const { value } = arg;
    switch (segment.type) {
      case '':
        out += plain(arg);
        break;
      case 'number':
        out += typeof value === 'number' ? formatMessageNumber(value, segment.style) : plain(arg);
        break;
      case 'date':
      case 'time': {
        const ms = typeof value === 'number' ? value : Number.NaN;
        const named = DATE_STYLES[segment.style.trim().toLowerCase()];
        const style = named ? named[segment.type] : segment.style;
        out += dates(Number.isNaN(ms) ? 0 : ms, style);
        break;
      }
      case 'choice':
        out += plain(arg);
        break;
    }
  }
  return out;
}
