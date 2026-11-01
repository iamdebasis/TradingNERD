import { type Resolution, resolutionDurationMs } from '@tradingnerd/core';
import { Args, type Call, constant, type Handler, type NumEv, series, simple } from './args.ts';
import type { Compiler, Scope } from './compiler.ts';
import { PineRuntimeError, type Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import {
  type Calendar,
  calendarOf,
  formatDate,
  fromSeconds,
  ISO_FORMAT,
  parseDate,
  parseSession,
  secondsOf,
  sessionOpen,
  timeframeOf,
  timeOf,
  weekOfYear,
  type Zone,
  zoneOf,
} from './time.ts';
import { CONST, type Compiled, type FoldEnv, maxQual, SIMPLE } from './types.ts';
import type { Value } from './values.ts';

/**
 * Pine's time built-ins (Pine docs: Time, Sessions, Timeframes; the v6 reference): bar times,
 * calendar values in the exchange's time zone, timestamp(), time() and time_close() on other
 * timeframes and sessions, timeframe.*, session.* and str.format_time().
 */

const DAY = 86_400_000;

/** The opening time (ms) of the bar `k` bars back, NaN before this run's first. */
export function barTime(rt: Runtime, k: number): number {
  const bar = rt.barBack(k);
  return bar ? (bar.start ?? bar.time * 1000) : Number.NaN;
}

const resolutions = new Map<string, Resolution | null>();

/** The chart's interval. */
function chartResolution(rt: Runtime): Resolution {
  const text = rt.symbol.timeframe;
  let resolution = resolutions.get(text);
  if (resolution === undefined) {
    resolution = timeframeOf(text, { count: 1, unit: 'day' });
    resolutions.set(text, resolution);
  }
  return resolution ?? { count: 1, unit: 'day' };
}

const UTC: Zone = zoneOf('UTC') as Zone;

/** The exchange's time zone (syminfo.timezone). */
export function exchangeZone(rt: Runtime): Zone {
  return zoneOf(rt.symbol.timezone) ?? UTC;
}

function zoneArg(name: Value, rt: Runtime): Zone {
  if (name === null || name === '') return exchangeZone(rt);
  const zone = zoneOf(String(name));
  if (!zone) throw new PineRuntimeError(`Invalid timezone: "${String(name)}"`);
  return zone;
}

/** The closing time (ms) of the bar `k` bars back. */
export function barCloseTime(rt: Runtime, k: number): number {
  const open = barTime(rt, k);
  if (Number.isNaN(open)) return Number.NaN;
  const resolution = chartResolution(rt);
  if (resolution.unit === 'tick') {
    // A tick bar closes where the next opens; the live one's close isn't known (Pine docs).
    const next = rt.bars[rt.index - k + 1];
    return next ? (next.start ?? next.time * 1000) : Number.NaN;
  }
  return rt.symbol.clock.close(resolution, open);
}

// ---- calendar values ----

const CALENDAR: Readonly<Record<string, (c: Calendar) => number>> = {
  year: (c) => c.year,
  month: (c) => c.month,
  weekofyear: (c) => weekOfYear(c.year, c.month, c.day),
  dayofmonth: (c) => c.day,
  dayofweek: (c) => c.weekday,
  hour: (c) => c.hour,
  minute: (c) => c.minute,
  second: (c) => c.second,
};

export const isCalendarName = (name: string): boolean => name in CALENDAR;

/** A calendar variable `k` bars back: the bar's opening time in the exchange's time zone. */
export function calendarValue(name: string): ((rt: Runtime, k: number) => number) | null {
  const pick = CALENDAR[name];
  if (!pick) return null;
  return (rt, k) => {
    const t = barTime(rt, k);
    return Number.isNaN(t) ? Number.NaN : pick(calendarOf(t, exchangeZone(rt)));
  };
}

/** time, time_close, timenow …, and the dayofweek.*, session.* and syminfo time members. */
export function timeName(_c: Compiler, name: string, span: Span): Compiled | null {
  const calendar = calendarValue(name);
  if (calendar) return series('int', (rt) => calendar(rt, 0), span);
  switch (name) {
    case 'time_close':
      return series('int', (rt) => barCloseTime(rt, 0), span);
    case 'time_tradingday':
      return series('int', (rt) => tradingDay(rt), span);
    case 'timenow':
      return series('int', (rt) => rt.now, span);
    case 'last_bar_time':
      return series(
        'int',
        (rt) => {
          const bar = rt.bars[rt.bars.length - 1];
          return bar ? (bar.start ?? bar.time * 1000) : Number.NaN;
        },
        span,
      );
    case 'timeframe.main_period':
      return simple('string', (rt) => rt.symbol.timeframe, span);
    case 'syminfo.timezone':
      return simple('string', (rt) => rt.symbol.timezone, span);
    case 'syminfo.session':
      return simple('string', (rt) => rt.symbol.session, span);
    case 'session.regular':
      return constant('string', 'regular', span);
    case 'session.extended':
      return constant('string', 'extended', span);
    case 'session.ismarket':
      return series('bool', (rt) => marketPart(rt) === 'market', span);
    case 'session.ispremarket':
      return series('bool', (rt) => marketPart(rt) === 'pre', span);
    case 'session.ispostmarket':
      return series('bool', (rt) => marketPart(rt) === 'post', span);
    case 'session.isfirstbar':
      return series('bool', (rt) => firstOfSession(rt, rt.symbol.session), span);
    case 'session.islastbar':
      return series('bool', (rt) => lastOfSession(rt, rt.symbol.session), span);
    case 'session.isfirstbar_regular':
      return series('bool', (rt) => firstOfSession(rt, 'regular'), span);
    case 'session.islastbar_regular':
      return series('bool', (rt) => lastOfSession(rt, 'regular'), span);
    default:
      break;
  }
  if (name.startsWith('dayofweek.')) {
    const day = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ].indexOf(name.slice(10));
    if (day >= 0) return constant('int', day + 1, span);
  }
  return null;
}

/**
 * time_tradingday: 00:00 UTC of the trading day the bar's session belongs to (Pine docs, Time:
 * time_tradingday); for markets around the clock, the bar's own day in the exchange's zone.
 * Provisional for overnight sessions, which our markets don't have (docs/SPEC.md §11).
 */
function tradingDay(rt: Runtime): number {
  const close = barCloseTime(rt, 0);
  if (Number.isNaN(close)) return Number.NaN;
  const schedule = rt.symbol.schedule;
  if (schedule) return schedule.sessionAtOrBefore(close - 1, 'regular').day * DAY;
  const c = calendarOf(close - 1, exchangeZone(rt));
  return Date.UTC(c.year, c.month - 1, c.day);
}

/** Where the bar opens: in the regular hours, before them or after (session.ismarket …). */
function marketPart(rt: Runtime): 'market' | 'pre' | 'post' {
  const schedule = rt.symbol.schedule;
  const resolution = chartResolution(rt);
  const intraday = resolution.unit === 'minute' || resolution.unit === 'second';
  if (!schedule || !intraday) return 'market';
  const t = barTime(rt, 0);
  const session = schedule.sessionAtOrBefore(t, 'regular');
  if (t >= session.open && t < session.close) return 'market';
  // Outside the regular hours: the evening of a session's day is post-market, else pre-market.
  const zone = exchangeZone(rt);
  return Math.floor((t + zone.offset(t)) / DAY) === session.day ? 'post' : 'pre';
}

/** The day of the session a bar belongs to, for session.isfirstbar and islastbar. */
function sessionDay(rt: Runtime, t: number, hours: string): number {
  const schedule = rt.symbol.schedule;
  if (schedule)
    return schedule.sessionAtOrBefore(t, hours === 'extended' ? 'extended' : 'regular').day;
  const c = calendarOf(t, exchangeZone(rt));
  return Date.UTC(c.year, c.month - 1, c.day) / DAY;
}

/** The session the current bar belongs to, as a day number (ta.vwap starts afresh with each). */
export function sessionOf(rt: Runtime): number {
  return sessionDay(rt, barTime(rt, 0), rt.symbol.session);
}

export function firstOfSession(rt: Runtime, hours: string): boolean {
  const t = barTime(rt, 0);
  const before = barTime(rt, 1);
  if (hours === 'regular' && marketPart(rt) !== 'market') return false;
  // The data's first bar starts a session only if it opens at the session's start.
  if (Number.isNaN(before)) return t === sessionStart(rt, t, hours);
  if (hours === 'regular' && rt.symbol.schedule) {
    // The first regular bar: the bar before it is another day's, or outside the regular hours.
    const session = rt.symbol.schedule.sessionAtOrBefore(t, 'regular');
    return before < session.open;
  }
  return sessionDay(rt, t, hours) !== sessionDay(rt, before, hours);
}

/** When the session holding `t` opened: its open, or midnight for a market around the clock. */
function sessionStart(rt: Runtime, t: number, hours: string): number {
  const schedule = rt.symbol.schedule;
  if (schedule)
    return schedule.sessionAtOrBefore(t, hours === 'extended' ? 'extended' : 'regular').open;
  const c = calendarOf(t, exchangeZone(rt));
  return timeOf(exchangeZone(rt), c.year, c.month, c.day);
}

function lastOfSession(rt: Runtime, hours: string): boolean {
  const t = barTime(rt, 0);
  const close = barCloseTime(rt, 0);
  if (Number.isNaN(close)) return false;
  const schedule = rt.symbol.schedule;
  if (schedule) {
    if (hours === 'regular' && marketPart(rt) !== 'market') return false;
    const session = schedule.sessionAtOrBefore(t, hours === 'extended' ? 'extended' : 'regular');
    return close >= session.close;
  }
  const c = calendarOf(t, exchangeZone(rt));
  const zone = exchangeZone(rt);
  const nextMidnight = timeOf(zone, c.year, c.month, c.day + 1);
  return close >= nextMidnight;
}

// ---- calls ----

/** year(time, timezone) …: a calendar value of any UNIX time. */
function calendarCall(name: string): Handler {
  const pick = CALENDAR[name] as (c: Calendar) => number;
  return (c, call, scope) => {
    const args = new Args(c, call, scope, ['time', 'timezone'], 1);
    const time = args.int('time') as NumEv;
    const zone = args.string('timezone');
    const zoneEv = zone?.ev;
    return series(
      'int',
      (rt) => {
        const t = time(rt);
        if (Number.isNaN(t)) return Number.NaN;
        return pick(calendarOf(t, zoneEv ? zoneArg(zoneEv(rt), rt) : exchangeZone(rt)));
      },
      call.span,
    );
  };
}

/**
 * timestamp(dateString), timestamp(year, month, day, hour, minute, second) and
 * timestamp(timezone, year, month, day, hour, minute, second) (the v6 reference).
 */
function timestampCall(c: Compiler, call: Call, scope: Scope): Compiled {
  const positional = call.args.filter((arg) => arg.name === null);
  const named = new Set(call.args.map((arg) => arg.name));
  const first = positional[0] ? c.expr(positional[0].value, scope) : null;
  if (named.has('dateString') || (call.args.length === 1 && first?.base === 'string')) {
    const args = new Args(c, call, scope, ['dateString'], 1);
    const text = args.string('dateString') as Compiled;
    const read = (value: Value): number => {
      const ms = parseDate(String(value ?? ''));
      if (Number.isNaN(ms)) {
        throw new PineRuntimeError(
          `Invalid date string "${String(value)}": it must be like "2020-02-20", "2020-02-20T15:30:00+0300" or "20 Feb 2020 15:30:00 GMT+3"`,
          call.span,
        );
      }
      return ms;
    };
    if (text.fold && text.qual === CONST) {
      // A literal date is read now, so a mistake shows in the editor.
      let value: number;
      try {
        value = read(text.fold({ inputs: [] }));
      } catch (error) {
        return c.fail((error as Error).message, text.span);
      }
      return { ...constant('int', value, call.span), literal: false };
    }
    const ev = text.ev;
    return {
      base: 'int',
      qual: text.qual,
      ev: (rt) => read(ev(rt)),
      fold: text.fold && ((env) => read((text.fold as (env: FoldEnv) => Value)(env))),
      span: call.span,
    };
  }
  const withZone = named.has('timezone') || first?.base === 'string';
  const names = withZone
    ? ['timezone', 'year', 'month', 'day', 'hour', 'minute', 'second']
    : ['year', 'month', 'day', 'hour', 'minute', 'second'];
  const args = new Args(c, call, scope, names, withZone ? 4 : 3);
  const parts = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((name) => {
    const value = args.get(name);
    if (value) args.int(name);
    return value;
  });
  const zone = withZone ? (args.string('timezone') as Compiled) : null;
  const evs = parts.map((part) => (part?.ev ?? (() => 0)) as NumEv);
  const make = (zoneValue: Zone, values: number[]) =>
    timeOf(
      zoneValue,
      values[0] as number,
      values[1] as number,
      values[2] as number,
      values[3] as number,
      values[4] as number,
      values[5] as number,
    );
  const compiled = [...parts, zone].filter((p): p is Compiled => p !== undefined && p !== null);
  // Without a time zone it's the exchange's, known once the script runs: "simple" at least.
  const qual = maxQual(withZone ? CONST : SIMPLE, ...compiled.map((p) => p.qual));
  const folds = parts.map((part) => part?.fold ?? (() => 0));
  const zoneFold = zone?.fold;
  const canFold = zoneFold !== undefined && compiled.every((p) => p.fold);
  const zoneEv = zone?.ev;
  return {
    base: 'int',
    qual,
    ev: (rt) =>
      make(
        zoneEv ? zoneArg(zoneEv(rt), rt) : exchangeZone(rt),
        evs.map((ev) => ev(rt)),
      ),
    fold: canFold
      ? (env) => {
          const name = (zoneFold as (env: FoldEnv) => Value)(env);
          const z = zoneOf(String(name ?? ''));
          return z
            ? make(
                z,
                folds.map((fold) => fold(env) as number),
              )
            : Number.NaN;
        }
      : undefined,
    span: call.span,
  };
}

/**
 * time() and time_close() (the v6 reference): the opening or closing time of the bar on another
 * timeframe holding the chart's bar, na when the bar is outside the session given. The second
 * argument is a session when it's a string, `bars_back` when it's an int.
 */
function timeCall(close: boolean): Handler {
  return (c, call, scope) => {
    const strings = ['timeframe', 'session', 'timezone'];
    const ints = ['bars_back', 'timeframe_bars_back'];
    const names: string[] = [];
    let s = 0;
    let n = 0;
    for (const arg of call.args) {
      if (arg.name !== null) break;
      // A number is `bars_back`, then `timeframe_bars_back`; a string the next of the three.
      const base = c.expr(arg.value, scope).base;
      const numeric = base === 'int' || base === 'float';
      names.push((numeric ? ints[n++] : strings[s++]) ?? `extra${names.length}`);
    }
    for (const name of [...strings, ...ints]) if (!names.includes(name)) names.push(name);
    const args = new Args(c, call, scope, names, 0);
    const timeframe = args.string('timeframe');
    const session = args.string('session');
    const zone = args.string('timezone');
    const barsBack = args.int('bars_back');
    const tfBack = args.int('timeframe_bars_back');
    const tfEv = timeframe?.ev;
    const sessionEv = session?.ev;
    const zoneEv = zone?.ev;
    return series(
      'int',
      (rt) =>
        timeOn(
          rt,
          String(tfEv?.(rt) ?? ''),
          sessionEv ? String(sessionEv(rt) ?? '') : '',
          zoneEv ? zoneEv(rt) : null,
          barsBack ? barsBack(rt) : 0,
          tfBack ? tfBack(rt) : 0,
          close,
        ),
      call.span,
    );
  };
}

function timeOn(
  rt: Runtime,
  timeframe: string,
  session: string,
  zoneName: Value,
  barsBack: number,
  timeframeBack: number,
  close: boolean,
): number {
  const chart = chartResolution(rt);
  const resolution = timeframeOf(timeframe, chart);
  if (!resolution) throw new PineRuntimeError(`Invalid timeframe "${timeframe}"`);
  let t: number;
  if (barsBack >= 0) t = barTime(rt, Math.floor(barsBack));
  else {
    // A future bar's expected time, up to 500 bars ahead (the v6 reference).
    t = barTime(rt, 0);
    if (chart.unit === 'tick') return Number.NaN;
    for (let i = 0; i < Math.min(500, -barsBack) && !Number.isNaN(t); i++)
      t = rt.symbol.clock.next(chart, t);
  }
  if (Number.isNaN(t)) return Number.NaN;
  if (resolution.unit === 'tick') return close ? barCloseTime(rt, Math.max(0, barsBack)) : t;
  const clock = rt.symbol.clock;
  if (session !== '') {
    const periods = parseSession(session);
    if (!periods) throw new PineRuntimeError(`Invalid session "${session}"`);
    const zone = zoneArg(zoneName, rt);
    const open = sessionOpen(periods, t, zone);
    if (Number.isNaN(open)) return Number.NaN;
    const step = resolutionDurationMs(resolution);
    if (step !== null && step < DAY) {
      // Intraday bars of a session start at its open (09:30, 10:30 … for an hour).
      const bar = open + Math.floor((t - open) / step) * step;
      return close ? bar + step : bar;
    }
  }
  let open = clock.open(resolution, t);
  for (let i = 0; i < Math.floor(timeframeBack); i++) open = clock.open(resolution, open - 1);
  for (let i = 0; i < -Math.floor(timeframeBack); i++) open = clock.next(resolution, open);
  return close ? clock.close(resolution, open) : open;
}

export function timeCalls(): Record<string, Handler> {
  const calls: Record<string, Handler> = {
    timestamp: timestampCall,
    time: timeCall(false),
    time_close: timeCall(true),
    'timeframe.change': (c, call, scope) => {
      const args = new Args(c, call, scope, ['timeframe'], 1);
      const tf = args.string('timeframe') as Compiled;
      const ev = tf.ev;
      return series(
        'bool',
        (rt) => {
          const text = String(ev(rt) ?? '');
          const now = timeOn(rt, text, '', null, 0, 0, false);
          const before = timeOn(rt, text, '', null, 1, 0, false);
          // The first bar starts a timeframe bar too (provisional, docs/SPEC.md §11).
          return Number.isNaN(before) || now !== before;
        },
        call.span,
      );
    },
    'timeframe.in_seconds': (c, call, scope) => {
      const args = new Args(c, call, scope, ['timeframe'], 0);
      const tf = args.string('timeframe');
      const ev = tf?.ev;
      const seconds = (rt: Runtime, text: string) => {
        const resolution = timeframeOf(text, chartResolution(rt));
        if (!resolution) throw new PineRuntimeError(`Invalid timeframe "${text}"`);
        return secondsOf(resolution);
      };
      return {
        base: 'int',
        qual: maxQual(SIMPLE, tf?.qual ?? SIMPLE),
        ev: (rt) => seconds(rt, String(ev?.(rt) ?? '')),
        span: call.span,
      };
    },
    'timeframe.from_seconds': (c, call, scope) => {
      const args = new Args(c, call, scope, ['seconds'], 1);
      const seconds = args.get('seconds') as Compiled;
      args.number('seconds');
      const ev = seconds.ev as NumEv;
      return {
        base: 'string',
        qual: seconds.qual,
        ev: (rt) => fromSeconds(ev(rt)),
        fold:
          seconds.fold &&
          ((env) => fromSeconds((seconds.fold as (env: FoldEnv) => Value)(env) as number)),
        span: call.span,
      };
    },
    'str.format_time': (c, call, scope) => {
      const args = new Args(c, call, scope, ['time', 'format', 'timezone'], 1);
      const time = args.int('time') as NumEv;
      const format = args.string('format')?.ev;
      const zone = args.string('timezone')?.ev;
      return series(
        'string',
        (rt) =>
          formatDate(
            time(rt),
            format ? String(format(rt) ?? '') || ISO_FORMAT : ISO_FORMAT,
            zone ? zoneArg(zone(rt), rt) : exchangeZone(rt),
          ),
        call.span,
      );
    },
  };
  for (const name of Object.keys(CALENDAR)) calls[name] = calendarCall(name);
  return calls;
}

/** A UNIX time as str.format()'s {0,date} and {0,time} write it: in UTC (Pine docs, Time). */
export const formatUtc = (ms: number, pattern: string): string => formatDate(ms, pattern, UTC);
