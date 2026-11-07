import { recordArgs } from './args.ts';
import { builtinCallNames, DISPLAY, FORMATS, LINE_STYLES, PLOT_STYLES } from './builtins.ts';
import { KEYWORDS } from './lexer.ts';
import { LOCATIONS, SHAPES, SIZES } from './marks.ts';
import { compileScript } from './script.ts';
import { COLORS } from './values.ts';

/**
 * What the editor's help while typing knows of Pine (docs/SPEC.md §5.18): every built-in a script
 * can name, as our engine has it. Functions come from the engine's own table of calls, and their
 * parameters from the engine itself (`signatureOf`), so the help never promises what doesn't run.
 * The values are listed here, and a test compiles each one.
 */

export type CatalogKind = 'function' | 'variable' | 'constant' | 'namespace' | 'type' | 'keyword';

export interface CatalogEntry {
  /** As a script writes it: "ta.sma", "close", "color.red". */
  name: string;
  kind: CatalogKind;
}

/** A function's parameters as the engine reads them: their names, and how many must be given. */
export interface Signature {
  params: readonly string[];
  required: number;
}

/** Built-in variables without a namespace (the v6 reference's "Variables"). */
const VARIABLES = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
  'time',
  'time_close',
  'time_tradingday',
  'timenow',
  'bar_index',
  'last_bar_index',
  'last_bar_time',
  'year',
  'month',
  'weekofyear',
  'dayofmonth',
  'dayofweek',
  'hour',
  'minute',
  'second',
  'na',
];

/** Namespaces' variables (barstate.isfirst, syminfo.ticker …). */
const MEMBER_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  barstate: [
    'isfirst',
    'islast',
    'ishistory',
    'isrealtime',
    'isnew',
    'isconfirmed',
    'islastconfirmedhistory',
  ],
  syminfo: [
    'ticker',
    'tickerid',
    'description',
    'type',
    'basecurrency',
    'currency',
    'mintick',
    'pricescale',
    'minmove',
    'pointvalue',
    'prefix',
    'root',
    'main_tickerid',
    'timezone',
    'session',
    'volumetype',
  ],
  timeframe: [
    'period',
    'multiplier',
    'main_period',
    'isintraday',
    'isdaily',
    'isweekly',
    'ismonthly',
    'isdwm',
    'isseconds',
    'isticks',
    'isminutes',
  ],
  chart: [
    'bg_color',
    'fg_color',
    'is_standard',
    'is_heikinashi',
    'is_kagi',
    'is_linebreak',
    'is_pnf',
    'is_range',
    'is_renko',
    'left_visible_bar_time',
    'right_visible_bar_time',
  ],
  session: ['isfirstbar', 'isfirstbar_regular', 'islastbar', 'islastbar_regular', 'ismarket'],
  ta: ['tr', 'vwap', 'obv', 'accdist', 'iii', 'nvi', 'pvi', 'pvt', 'wad', 'wvad'],
};

/** Namespaces' constants (color.red, plot.style_line, display.none …). */
function memberConstants(): Record<string, readonly string[]> {
  return {
    color: Object.keys(COLORS),
    plot: [
      ...PLOT_STYLES.map((style) => `style_${style}`),
      ...LINE_STYLES.map((style) => `linestyle_${style}`),
    ],
    hline: LINE_STYLES.map((style) => `style_${style}`),
    display: Object.keys(DISPLAY),
    format: [...FORMATS],
    shape: [...SHAPES],
    location: [...LOCATIONS],
    size: [...SIZES],
    math: ['pi', 'e', 'phi', 'rphi'],
    order: ['ascending', 'descending'],
    scale: ['right', 'left', 'none'],
    alert: ['freq_all', 'freq_once_per_bar', 'freq_once_per_bar_close'],
    dayofweek: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    session: ['regular', 'extended'],
  };
}

/** Pine's types, as declarations and casts write them. */
const TYPES = ['int', 'float', 'bool', 'color', 'string', 'array', 'matrix', 'map'];

let built: readonly CatalogEntry[] | null = null;

/** Every built-in, keyword and type, sorted by name. */
export function catalog(): readonly CatalogEntry[] {
  if (built) return built;
  const entries = new Map<string, CatalogEntry>();
  const add = (name: string, kind: CatalogKind) => {
    if (!entries.has(name)) entries.set(name, { name, kind });
  };
  for (const name of builtinCallNames()) {
    if (name.startsWith('__')) continue;
    add(name, 'function');
    const dot = name.indexOf('.');
    if (dot > 0) add(name.slice(0, dot), 'namespace');
  }
  for (const name of VARIABLES) add(name, 'variable');
  for (const [space, members] of Object.entries(MEMBER_VARIABLES)) {
    add(space, 'namespace');
    for (const member of members) add(`${space}.${member}`, 'variable');
  }
  for (const [space, members] of Object.entries(memberConstants())) {
    add(space, 'namespace');
    for (const member of members) add(`${space}.${member}`, 'constant');
  }
  for (const name of ['true', 'false']) add(name, 'constant');
  for (const name of TYPES) add(name, 'type');
  for (const name of KEYWORDS) add(name, 'keyword');
  built = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  return built;
}

/** A built-in by its full name, or undefined. */
export function catalogEntry(name: string): CatalogEntry | undefined {
  return catalog().find((entry) => entry.name === name);
}

/** The members of a namespace ("ta" → ta.sma, ta.ema, ta.tr …). */
export function namespaceMembers(space: string): readonly CatalogEntry[] {
  const prefix = `${space}.`;
  return catalog().filter(
    (entry) => entry.name.startsWith(prefix) && !entry.name.slice(prefix.length).includes('.'),
  );
}

const signatures = new Map<string, readonly Signature[]>();

/**
 * A built-in function's parameters, as the engine itself reads them: the names its `Args` take,
 * caught while a call without arguments compiles (and fails). A function with overloads may show
 * one; none for one the engine doesn't take arguments of this way.
 */
export function signatureOf(name: string): readonly Signature[] {
  const known = signatures.get(name);
  if (known) return known;
  const found: Signature[] = [];
  recordArgs((callee, params, required) => {
    if (callee !== name) return;
    if (!found.some((item) => item.params.join() === params.join())) {
      found.push({ params: [...params], required });
    }
  });
  try {
    compileScript(`//@version=6\nindicator("x")\n${name}()\nplot(close)`);
  } finally {
    recordArgs(null);
  }
  signatures.set(name, found);
  return found;
}

/**
 * TradingView's reference page for a built-in (the v6 reference's anchors: `fun_`, `var_`,
 * `const_`, `type_`, `kw_`), for the help's "Reference" link. Opening it is the user's own
 * reading of TradingView's public page; the app never fetches it.
 */
export function referenceUrl(entry: CatalogEntry): string | null {
  const prefix: Partial<Record<CatalogKind, string>> = {
    function: 'fun_',
    variable: 'var_',
    constant: 'const_',
    type: 'type_',
    keyword: 'kw_',
  };
  const tag = prefix[entry.kind];
  return tag ? `https://www.tradingview.com/pine-script-reference/v6/#${tag}${entry.name}` : null;
}
