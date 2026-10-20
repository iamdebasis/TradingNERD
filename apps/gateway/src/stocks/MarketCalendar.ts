import { join } from 'node:path';
import {
  dateOf,
  dayOf,
  type Hours,
  MarketSchedule,
  type MarketScheduleData,
  parseMarketSchedule,
  weekdayOf,
} from '@tradingnerd/core';
import { JsonFile } from '../storage/jsonFile.ts';
import type { AlpacaCalendarDay } from './alpaca.ts';

/** US stock hours in New York: 09:30–16:00, and 04:00–20:00 with pre- and post-market. */
export const US_TIMEZONE = 'America/New_York';
export const US_REGULAR: Hours = [570, 960];
export const US_EXTENDED: Hours = [240, 1200];
/** The calendar's span: a year before Alpaca's data begins, to as far ahead as Alpaca lists. */
export const CALENDAR_FROM = '2015-01-01';
/** How often the calendar is fetched again (exchanges publish holidays years ahead). */
export const CALENDAR_REFRESH_MS = 30 * 86_400_000;

/**
 * Until Alpaca's calendar is in (it needs the key, as all stock data does): every weekday
 * trades at the usual hours. Nothing is charted with it, since no bars come without a key.
 */
export const FALLBACK_SCHEDULE: MarketScheduleData = {
  timezone: US_TIMEZONE,
  regular: US_REGULAR,
  extended: US_EXTENDED,
  from: '1970-01-01',
  to: '1970-01-01',
  holidays: [],
  special: {},
};

const minutesOf = (clock: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * Alpaca's trading days as a schedule: the weekdays it leaves out are holidays, and days with
 * other hours (the 13:00 closes) are special.
 */
export function scheduleFromCalendar(days: readonly AlpacaCalendarDay[]): MarketScheduleData {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) throw new Error("Alpaca's calendar is empty");
  const trading = new Set(sorted.map((day) => day.date));
  const holidays: string[] = [];
  for (let day = dayOf(first.date); day <= dayOf(last.date); day++) {
    const weekday = weekdayOf(day);
    if (weekday !== 0 && weekday !== 6 && !trading.has(dateOf(day))) holidays.push(dateOf(day));
  }
  const special: Record<string, Hours> = {};
  for (const day of sorted) {
    const open = minutesOf(day.open);
    const close = minutesOf(day.close);
    if (open === null || close === null || open >= close) continue;
    if (open !== US_REGULAR[0] || close !== US_REGULAR[1]) special[day.date] = [open, close];
  }
  return {
    timezone: US_TIMEZONE,
    regular: US_REGULAR,
    extended: US_EXTENDED,
    from: first.date,
    to: last.date,
    holidays,
    special,
  };
}

interface StoredCalendar {
  fetchedAt: number;
  schedule: MarketScheduleData;
}

function parseStored(value: unknown): StoredCalendar | null {
  if (typeof value !== 'object' || value === null) return null;
  const { fetchedAt, schedule } = value as Record<string, unknown>;
  const parsed = parseMarketSchedule(schedule);
  return typeof fetchedAt === 'number' && parsed ? { fetchedAt, schedule: parsed } : null;
}

export interface MarketCalendarOptions {
  dataDir: string;
  /** Alpaca's calendar from one date to another (needs the key). */
  fetchDays: (from: string, to: string) => Promise<AlpacaCalendarDay[]>;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/**
 * The US market's trading calendar, from Alpaca, kept in data/us-calendar.json and refreshed
 * monthly; holidays and early closes for the bar clock and the chart.
 */
export class MarketCalendar {
  private readonly file: JsonFile<StoredCalendar>;
  private readonly fetchDays: (from: string, to: string) => Promise<AlpacaCalendarDay[]>;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private current: { fetchedAt: number; schedule: MarketSchedule } | null = null;
  private fallback = new MarketSchedule(FALLBACK_SCHEDULE);
  private loading: Promise<void> | null = null;

  constructor(options: MarketCalendarOptions) {
    this.file = new JsonFile(join(options.dataDir, 'us-calendar.json'), parseStored);
    this.fetchDays = options.fetchDays;
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Alpaca's calendar once loaded; until then every weekday at the usual hours. */
  schedule(): MarketSchedule {
    return this.current?.schedule ?? this.fallback;
  }

  /** Whether the real calendar is in. */
  isKnown(): boolean {
    return this.current !== null;
  }

  /**
   * Loads the saved calendar, and fetches it when missing or a month old. Rejects only if
   * there's none at all (e.g. no key yet); a failed refresh keeps the saved one.
   */
  ensure(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    if (!this.current) {
      try {
        const stored = await this.file.read();
        if (stored) this.current = { ...stored, schedule: new MarketSchedule(stored.schedule) };
      } catch (error) {
        this.warn(`Couldn't read the saved US calendar (${String(error)})`);
      }
    }
    if (this.current && this.now() - this.current.fetchedAt < CALENDAR_REFRESH_MS) return;
    try {
      const year = new Date(this.now()).getUTCFullYear();
      const days = await this.fetchDays(CALENDAR_FROM, `${year + 3}-12-31`);
      const schedule = scheduleFromCalendar(days);
      const fetchedAt = this.now();
      this.current = { fetchedAt, schedule: new MarketSchedule(schedule) };
      await this.file.write({ fetchedAt, schedule }).catch((error: unknown) => {
        this.warn(`Couldn't save the US calendar (${String(error)})`);
      });
    } catch (error) {
      if (!this.current) throw error;
      this.warn(`Couldn't refresh the US calendar; keeping the saved one (${String(error)})`);
    }
  }
}
