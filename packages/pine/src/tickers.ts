import { Args, constant, type Handler } from './args.ts';
import type { ChartTypeInputs } from './chartTypes.ts';
import type { Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import { type Compiled, type FoldEnv, maxQual, SIMPLE } from './types.ts';
import type { Value } from './values.ts';

/**
 * Ticker ids with settings (TradingView's Pine docs, Other timeframes and data: Custom contexts;
 * the v6 reference, ticker.*): a request asks for a symbol's extended hours, its prices adjusted
 * for dividends, or its Heikin Ashi, Renko, Line Break, Kagi or Point & Figure bars by naming
 * the symbol so.
 *
 * Such an id is written `={"session":"extended","symbol":"NASDAQ:AAPL"}`, the settings' names in
 * order: the form TradingView's own ids take, as far as scripts that print them show
 * (provisional, docs/SPEC.md §11); a symbol without settings is its plain "EXCHANGE:TICKER". A
 * non-standard type's settings are its `inputs`, as TradingView's ids carry them:
 * `={"inputs":{"param":10,"source":"Close","style":"ATR","wicks":false},"symbol":…,"type":"renko"}`
 * (the names are ours: TradingView's aren't documented).
 */

/** A ticker id read: the symbol and its settings. */
export interface TickerId {
  /** "EXCHANGE:TICKER", or a ticker alone. */
  symbol: string;
  /** "regular" or "extended" hours (intraday bars of markets that close). */
  session?: string;
  /** "none", "splits" or "dividends" (stocks' prices adjusted). */
  adjustment?: string;
  /** Futures' settings: kept, no effect on our symbols. */
  backadjustment?: string;
  settlement_as_close?: string;
  /** A non-standard chart's bars: "heikinashi", "renko", "linebreak", "kagi", "pointfigure". */
  type?: string;
  /** The non-standard type's settings (chartTypes.ts). */
  inputs?: ChartTypeInputs;
}

const SETTINGS = [
  'adjustment',
  'backadjustment',
  'session',
  'settlement_as_close',
  'type',
] as const;

/** Reads a ticker id: a plain symbol, or one written with its settings. */
export function parseTickerId(text: string): TickerId {
  const trimmed = text.trim();
  if (!trimmed.startsWith('={')) return { symbol: trimmed };
  try {
    const parsed = JSON.parse(trimmed.slice(1)) as Record<string, unknown>;
    const id: TickerId = { symbol: typeof parsed.symbol === 'string' ? parsed.symbol : '' };
    for (const name of SETTINGS) {
      const value = parsed[name];
      if (typeof value === 'string' && value !== '') id[name] = value;
    }
    const inputs = parsed.inputs;
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
      const kept: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(inputs as Record<string, unknown>)) {
        if (['string', 'number', 'boolean'].includes(typeof value)) {
          kept[name] = value as string | number | boolean;
        }
      }
      id.inputs = kept;
    }
    return id;
  } catch {
    return { symbol: trimmed };
  }
}

/** Writes a ticker id: plain when it has no settings. */
export function formatTickerId(id: TickerId): string {
  const settings: string[] = SETTINGS.filter((name) => id[name] !== undefined && id[name] !== '');
  if (id.inputs && id.type) settings.push('inputs');
  if (settings.length === 0) return id.symbol;
  const out: Record<string, unknown> = {};
  for (const name of [...settings, 'symbol'].sort()) {
    if (name === 'symbol') out[name] = id.symbol;
    else if (name === 'inputs') out[name] = sortedInputs(id.inputs as ChartTypeInputs);
    else out[name] = id[name as (typeof SETTINGS)[number]];
  }
  return `=${JSON.stringify(out)}`;
}

/** A type's settings with their names in order, so equal settings write the same id. */
export function sortedInputs(inputs: ChartTypeInputs): ChartTypeInputs {
  const out: Record<string, string | number | boolean> = {};
  for (const name of Object.keys(inputs).sort())
    out[name] = inputs[name] as string | number | boolean;
  return out;
}

/** The exchange of a ticker id ("NASDAQ" of "NASDAQ:AAPL"), "" when it has none. */
export const prefixOf = (text: string): string => {
  const symbol = parseTickerId(text).symbol;
  const colon = symbol.indexOf(':');
  return colon < 0 ? '' : symbol.slice(0, colon);
};

/** The ticker of a ticker id ("AAPL" of "NASDAQ:AAPL"). */
export const tickerOf = (text: string): string => {
  const symbol = parseTickerId(text).symbol;
  const colon = symbol.indexOf(':');
  return colon < 0 ? symbol : symbol.slice(colon + 1);
};

type Part = (rt: Runtime) => string;

/** A string argument read as text ("" for na). */
const text = (c: Compiled | undefined): Part | null => {
  if (!c) return null;
  const ev = c.ev;
  return (rt) => String(ev(rt) ?? '');
};

/**
 * A function of ticker ids: simple when its arguments are, and worked out before the bars when
 * they're const or input (non-dynamic requests take them then).
 */
function tickerFunction(
  args: readonly (Compiled | undefined)[],
  make: (rt: Runtime | null, values: readonly string[]) => string,
  span: Span,
): Compiled {
  const given = args.filter((arg): arg is Compiled => arg !== undefined);
  const evs = args.map(text);
  const folds = args.map((arg) => arg?.fold);
  const known = given.every((arg) => arg.fold !== undefined);
  return {
    base: 'string',
    qual: maxQual(SIMPLE, ...given.map((arg) => arg.qual)),
    ev: (rt) =>
      make(
        rt,
        evs.map((ev) => (ev ? ev(rt) : '')),
      ),
    fold: known
      ? (env: FoldEnv) =>
          make(
            null,
            folds.map((fold) => (fold ? String((fold(env) as Value) ?? '') : '')),
          )
      : undefined,
    span,
  };
}

const settingsOf = (values: readonly string[], from: number): Partial<TickerId> => {
  const [session, adjustment, backadjustment, settlement] = values.slice(from);
  return {
    ...(session ? { session } : {}),
    ...(adjustment ? { adjustment } : {}),
    ...(backadjustment && backadjustment !== 'inherit' ? { backadjustment } : {}),
    ...(settlement && settlement !== 'inherit' ? { settlement_as_close: settlement } : {}),
  };
};

const SETTINGS_PARAMS = ['session', 'adjustment', 'backadjustment', 'settlement_as_close'] as const;

/** A ticker id of a non-standard type: the symbol's own settings kept, its type's replaced. */
const chartTypeId = (
  symbol: string | undefined,
  type: string,
  inputs: ChartTypeInputs | null,
): string => {
  const { inputs: _old, ...id } = parseTickerId(symbol ?? '');
  return formatTickerId({ ...id, type, ...(inputs ? { inputs } : {}) });
};

/**
 * A ticker function's arguments with their types checked: simple strings, but for the numbers
 * and bools named (the v6 reference's "simple int/float", "simple bool").
 */
function typed(
  c: Parameters<Handler>[0],
  call: Parameters<Handler>[1],
  scope: Parameters<Handler>[2],
  names: readonly string[],
  required: number,
  kinds: Readonly<Record<string, 'number' | 'int' | 'bool'>>,
): Args {
  const args = new Args(c, call, scope, names, required);
  for (const name of names) {
    const kind = kinds[name];
    if (kind === 'number') args.number(name, SIMPLE);
    else if (kind === 'int') args.int(name, SIMPLE);
    else if (kind === 'bool') args.bool(name, SIMPLE);
    else args.string(name, SIMPLE);
  }
  return args;
}

export function tickerCalls(): Record<string, Handler> {
  return {
    'ticker.new': (c, call, scope) => {
      const args = new Args(c, call, scope, ['prefix', 'ticker', ...SETTINGS_PARAMS], 2);
      const parts = ['prefix', 'ticker', ...SETTINGS_PARAMS].map((name) => args.get(name));
      return tickerFunction(
        parts,
        (rt, [prefix, ticker, ...rest]) => {
          const settings = settingsOf(['', '', ...rest], 2);
          // No session given: the chart's (the v6 reference).
          if (!settings.session && rt?.symbol.session === 'extended') settings.session = 'extended';
          return formatTickerId({
            symbol: prefix ? `${prefix}:${ticker}` : String(ticker),
            ...settings,
          });
        },
        call.span,
      );
    },
    'ticker.modify': (c, call, scope) => {
      const args = new Args(c, call, scope, ['tickerid', ...SETTINGS_PARAMS], 1);
      const parts = ['tickerid', ...SETTINGS_PARAMS].map((name) => args.get(name));
      return tickerFunction(
        parts,
        (_rt, [tickerid, ...rest]) =>
          formatTickerId({ ...parseTickerId(tickerid ?? ''), ...settingsOf(['', ...rest], 1) }),
        call.span,
      );
    },
    'ticker.standard': (c, call, scope) => {
      const args = new Args(c, call, scope, ['symbol'], 0);
      const symbol = args.get('symbol');
      return tickerFunction(
        [symbol],
        (rt, [given]) => {
          const id = given || (rt ? (rt.main ?? rt.symbol).tickerid : '');
          return parseTickerId(id).symbol;
        },
        call.span,
      );
    },
    'ticker.inherit': (c, call, scope) => {
      const args = new Args(c, call, scope, ['from_tickerid', 'symbol'], 2);
      return tickerFunction(
        [args.get('from_tickerid'), args.get('symbol')],
        (_rt, [from, symbol]) => {
          const { symbol: _own, ...settings } = parseTickerId(from ?? '');
          return formatTickerId({ ...settings, symbol: parseTickerId(symbol ?? '').symbol });
        },
        call.span,
      );
    },
    'ticker.heikinashi': (c, call, scope) => {
      const args = new Args(c, call, scope, ['symbol'], 1);
      return tickerFunction(
        [args.get('symbol')],
        (_rt, [symbol]) => chartTypeId(symbol, 'heikinashi', null),
        call.span,
      );
    },
    // The other non-standard types (the v6 reference): their settings ride in the id, and the
    // request makes the bars from the symbol's own (chartTypes.ts).
    'ticker.renko': (c, call, scope) => {
      const names = ['symbol', 'style', 'param', 'request_wicks', 'source'];
      const args = typed(c, call, scope, names, 3, { request_wicks: 'bool', param: 'number' });
      return tickerFunction(
        names.map((name) => args.get(name)),
        (_rt, [symbol, style, param, wicks, source]) =>
          chartTypeId(symbol, 'renko', {
            style: style ?? '',
            param: Number(param),
            wicks: wicks === 'true',
            source: source || 'Close',
          }),
        call.span,
      );
    },
    'ticker.linebreak': (c, call, scope) => {
      const names = ['symbol', 'number_of_lines'];
      const args = typed(c, call, scope, names, 2, { number_of_lines: 'int' });
      return tickerFunction(
        names.map((name) => args.get(name)),
        (_rt, [symbol, lines]) =>
          chartTypeId(symbol, 'linebreak', { lines: Math.floor(Number(lines)) }),
        call.span,
      );
    },
    'ticker.kagi': (c, call, scope) => {
      // Two forms: a reversal in price, or a param with its style ("ATR", "PercentageLTP").
      const styled =
        call.args.length > 2 || call.args.some((a) => a.name === 'param' || a.name === 'style');
      const names = styled ? ['symbol', 'param', 'style'] : ['symbol', 'reversal'];
      const args = typed(c, call, scope, names, 2, { param: 'number', reversal: 'number' });
      return tickerFunction(
        names.map((name) => args.get(name)),
        (_rt, [symbol, param, style]) =>
          chartTypeId(symbol, 'kagi', {
            style: styled ? style || 'Traditional' : 'Traditional',
            param: Number(param),
          }),
        call.span,
      );
    },
    'ticker.pointfigure': (c, call, scope) => {
      const names = ['symbol', 'source', 'style', 'param', 'reversal'];
      const args = typed(c, call, scope, names, 5, { param: 'number', reversal: 'int' });
      return tickerFunction(
        names.map((name) => args.get(name)),
        (_rt, [symbol, source, style, param, reversal]) =>
          chartTypeId(symbol, 'pointfigure', {
            source: source ?? '',
            style: style ?? '',
            param: Number(param),
            reversal: Math.floor(Number(reversal)),
          }),
        call.span,
      );
    },
    // v6's functions of a ticker id (the v6 reference, syminfo.prefix() and syminfo.ticker()).
    'syminfo.prefix': (c, call, scope) => {
      const args = new Args(c, call, scope, ['symbol'], 1);
      return tickerFunction([args.get('symbol')], (_rt, [s]) => prefixOf(s ?? ''), call.span);
    },
    'syminfo.ticker': (c, call, scope) => {
      const args = new Args(c, call, scope, ['symbol'], 1);
      return tickerFunction([args.get('symbol')], (_rt, [s]) => tickerOf(s ?? ''), call.span);
    },
  };
}

/** adjustment.*, backadjustment.* and settlement_as_close.* (the v6 reference). */
export function tickerConstant(space: string, member: string, span: Span): Compiled | null {
  if (space === 'adjustment' && ['none', 'splits', 'dividends'].includes(member)) {
    // A plain "const string" in the v6 reference, as are currency.*, session.* and the rest.
    return constant('string', member, span);
  }
  if (space === 'backadjustment' && ['on', 'off', 'inherit'].includes(member)) {
    return constant('backadjustment_style', member, span);
  }
  if (space === 'settlement_as_close' && ['on', 'off', 'inherit'].includes(member)) {
    return constant('settlement_style', member, span);
  }
  return null;
}
