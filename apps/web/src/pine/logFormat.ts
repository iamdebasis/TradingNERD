import type { TimeZone } from '@tradingnerd/core';
import type { LogEntry } from '@tradingnerd/pine';

/** The Pine Logs pane's own words and rules (Pine docs, Debugging: Pine Logs). */

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The wall clock of `ms` in a time zone, as UTC fields of a shifted date. */
const wallClock = (ms: number, zone: TimeZone) => new Date(ms + zone.offset(ms));

/**
 * An entry's timestamp as TradingView's pane writes it, in the exchange's time with its offset:
 * "2008-01-03T18:00:00.000-05:00" (COMEX, Figure 347), "2024-02-13T21:06:00.000-00:00" for UTC
 * (Kraken, Figure 348): UTC is written -00:00.
 */
export function logTime(ms: number, zone: TimeZone): string {
  if (!Number.isFinite(ms)) return '';
  const offset = zone.offset(ms);
  const local = wallClock(ms, zone);
  const minutes = Math.round(Math.abs(offset) / 60_000);
  const sign = offset > 0 ? '+' : '-';
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
  );
}

/** The start date's tag above the entries: "February 13, 2024 at 00:00" (Figure 357). */
export function startLabel(ms: number, zone: TimeZone): string {
  const local = wallClock(ms, zone);
  return (
    `${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()}, ${local.getUTCFullYear()} at ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/** The start date dialog's button: "Set Feb 13, 00:00" (Figure 356). */
export function setStartLabel(ms: number, zone: TimeZone): string {
  const local = wallClock(ms, zone);
  const month = (MONTHS[local.getUTCMonth()] ?? '').slice(0, 3);
  return `Set ${month} ${local.getUTCDate()}, ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** The instant a date ("2024-02-13") and a time ("00:00") name in a time zone; null if invalid. */
export function zonedInstant(date: string, time: string, zone: TimeZone): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!day || !clock) return null;
  const naive = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  if (Number.isNaN(naive)) return null;
  const minutes = Number(clock[1]) * 60 + Number(clock[2]);
  if (minutes >= 24 * 60) return null;
  return zone.utc(Math.floor(naive / 86_400_000), minutes);
}

/** The search's text and options (Figure 354: Match case, Whole Word, Regex). */
export interface LogQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** Where a message matches the search: [start, end) ranges, highlighted in blue (Figure 353). */
export type LogMatcher = (message: string) => [number, number][] | null;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The search as a matcher; null with no text, 'invalid' for a regex that doesn't compile. */
export function logMatcher(query: LogQuery): LogMatcher | null | 'invalid' {
  if (!query.text) return null;
  let source = query.regex ? query.text : escapeRegExp(query.text);
  if (query.wholeWord) source = `\\b(?:${source})\\b`;
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, query.matchCase ? 'g' : 'gi');
  } catch {
    return 'invalid';
  }
  return (message) => {
    const ranges: [number, number][] = [];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(message); match; match = pattern.exec(message)) {
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges.length > 0 ? ranges : null;
  };
}

/** The levels the pane shows (Figure 358's Filter levels). */
export type LogLevels = Readonly<Record<LogEntry['level'], boolean>>;

/** The entries the pane lists: at its levels, from its start date, matching its search. */
export function shownLogs(
  logs: readonly LogEntry[],
  levels: LogLevels,
  start: number | null,
  matcher: LogMatcher | null,
): { entry: LogEntry; index: number; matches: [number, number][] | null }[] {
  const out: { entry: LogEntry; index: number; matches: [number, number][] | null }[] = [];
  logs.forEach((entry, index) => {
    if (!levels[entry.level]) return;
    if (start !== null && !(entry.time >= start)) return;
    const matches = matcher ? matcher(entry.message) : null;
    if (matcher && !matches) return;
    out.push({ entry, index, matches });
  });
  return out;
}
