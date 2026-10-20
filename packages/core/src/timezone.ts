/**
 * Local time in an exchange's time zone, for markets that keep office hours (US stocks open at
 * 09:30 New York time, whatever UTC says). Offsets come from the platform's own time-zone data
 * (Intl), so daylight saving follows the official rules, and change only at its transitions:
 * each year's are found once, and every later lookup is a search among them.
 */

const MINUTE = 60_000;
export const DAY_MS = 86_400_000;

/** A local calendar date as days since 1970-01-01: the date's UTC midnight divided by a day. */
export type DayNumber = number;

/** Where an instant falls in local time. */
export interface LocalTime {
  /** The local date. */
  day: DayNumber;
  /** Minutes after local midnight. */
  minutes: number;
}

interface Segment {
  /** First instant (ms) with this offset. */
  start: number;
  /** Milliseconds to add to UTC for local time. */
  offset: number;
}

/** "2026-10-19" → its day number. */
export function dayOf(date: string): DayNumber {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`"${date}" is not a date like 2026-10-19`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

/** A day number → "2026-10-19". */
export function dateOf(day: DayNumber): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 0 for Sunday … 6 for Saturday (1970-01-01 was a Thursday). */
export function weekdayOf(day: DayNumber): number {
  return (((day + 4) % 7) + 7) % 7;
}

export class TimeZone {
  readonly name: string;
  private readonly format: Intl.DateTimeFormat;
  /** Each UTC year's offsets, from its first instant on. */
  private readonly years = new Map<number, Segment[]>();

  constructor(name: string) {
    this.name = name;
    this.format = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  /** Milliseconds to add to UTC at `ms` for local time (-4 h for New York in summer). */
  offset(ms: number): number {
    const segments = this.segmentsOf(new Date(ms).getUTCFullYear());
    let offset = segments[0]?.offset ?? 0;
    for (const segment of segments) {
      if (segment.start > ms) break;
      offset = segment.offset;
    }
    return offset;
  }

  local(ms: number): LocalTime {
    const local = ms + this.offset(ms);
    const day = Math.floor(local / DAY_MS);
    return { day, minutes: Math.floor((local - day * DAY_MS) / MINUTE) };
  }

  /** The instant of `minutes` after local midnight on `day` (never a time skipped by DST). */
  utc(day: DayNumber, minutes: number): number {
    const local = day * DAY_MS + minutes * MINUTE;
    return local - this.offset(local - this.offset(local));
  }

  private segmentsOf(year: number): Segment[] {
    let segments = this.years.get(year);
    if (!segments) {
      segments = this.findSegments(year);
      this.years.set(year, segments);
    }
    return segments;
  }

  /** The year's offsets: sampled twice a month, each change pinned to its minute. */
  private findSegments(year: number): Segment[] {
    const first = Date.UTC(year, 0, 1);
    const segments: Segment[] = [{ start: first, offset: this.rawOffset(first) }];
    let before = first;
    let offset = segments[0]?.offset ?? 0;
    for (let half = 1; half <= 24; half++) {
      const sample = Date.UTC(year, Math.floor(half / 2), half % 2 === 0 ? 1 : 16);
      const sampled = this.rawOffset(sample);
      if (sampled !== offset) {
        let low = before;
        let high = sample;
        while (high - low > MINUTE) {
          const middle = low + Math.floor((high - low) / MINUTE / 2) * MINUTE;
          if (this.rawOffset(middle) === offset) low = middle;
          else high = middle;
        }
        segments.push({ start: high, offset: sampled });
        offset = sampled;
      }
      before = sample;
    }
    return segments;
  }

  /** The offset at `ms`, straight from Intl. */
  private rawOffset(ms: number): number {
    const parts = this.format.formatToParts(new Date(ms));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    const local = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour'),
      part('minute'),
      part('second'),
    );
    return local - (ms - (((ms % 1000) + 1000) % 1000));
  }
}

const zones = new Map<string, TimeZone>();

/** One shared TimeZone per name, so the transitions are found once. */
export function timeZone(name: string): TimeZone {
  let zone = zones.get(name);
  if (!zone) {
    zone = new TimeZone(name);
    zones.set(name, zone);
  }
  return zone;
}
