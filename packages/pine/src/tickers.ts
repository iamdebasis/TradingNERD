import { Args, constant, type Handler } from './args.ts';
import type { Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import { type Compiled, type FoldEnv, maxQual, SIMPLE } from './types.ts';
import type { Value } from './values.ts';

/**
 * Ticker ids with settings (TradingView's Pine docs, Other timeframes and data: Custom contexts;
 * the v6 reference, ticker.*): a request asks for a symbol's extended hours, its prices adjusted
 * for dividends, or its Heikin Ashi bars by naming the symbol so.
 *
 * Such an id is written `={"session":"extended","symbol":"NASDAQ:AAPL"}`, the settings' names in
 * order: the form TradingView's own ids take, as far as scripts that print them show
 * (provisional, docs/SPEC.md §11); a symbol without settings is its plain "EXCHANGE:TICKER".
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
  /** A non-standard chart's bars: "heikinashi" (the others come with their chart types). */
  type?: string;
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
    return id;
  } catch {
    return { symbol: trimmed };
  }
}

/** Writes a ticker id: plain when it has no settings. */
export function formatTickerId(id: TickerId): string {
  const settings = SETTINGS.filter((name) => id[name] !== undefined && id[name] !== '');
  if (settings.length === 0) return id.symbol;
  const out: Record<string, string> = {};
  for (const name of [...settings, 'symbol'].sort()) {
    out[name] = name === 'symbol' ? id.symbol : (id[name as (typeof SETTINGS)[number]] as string);
  }
  return `=${JSON.stringify(out)}`;
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
        (_rt, [symbol]) => formatTickerId({ ...parseTickerId(symbol ?? ''), type: 'heikinashi' }),
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
    return constant('adjustment_style', member, span);
  }
  if (space === 'backadjustment' && ['on', 'off', 'inherit'].includes(member)) {
    return constant('backadjustment_style', member, span);
  }
  if (space === 'settlement_as_close' && ['on', 'off', 'inherit'].includes(member)) {
    return constant('settlement_style', member, span);
  }
  return null;
}
