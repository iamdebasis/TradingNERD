import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonFile } from '../storage/jsonFile.ts';

/**
 * One perpetual's open interest over time, as its exchange recorded it: points on a 5-minute
 * grid (Binance's and Bybit's finest step, OKX's too), kept by month in data/oi/ so history the
 * exchanges no longer serve stays ours (docs/SPEC.md §6.18). Coarser points (OKX's hours and
 * days, Bybit's days) sit on the same grid with nothing between them.
 */

export const STEP_MS = 5 * 60_000;

/** A point: the open interest at `time` (UTC ms), in the exchange's own unit. */
export interface OiPoint {
  time: number;
  value: number;
}

interface MonthFile {
  v: 1;
  /** "2026-11" */
  month: string;
  step: number;
  /** One per grid step from the month's first instant; null where there's none. */
  values: (number | null)[];
}

const MONTH = /^(\d{4})-(\d{2})$/;

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

function monthStart(month: string): number {
  const match = MONTH.exec(month);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
}

function slotsIn(month: string): number {
  const start = monthStart(month);
  const date = new Date(start);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return (next - start) / STEP_MS;
}

function parseMonth(value: unknown): MonthFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as Partial<MonthFile>;
  if (file.v !== 1 || typeof file.month !== 'string' || !MONTH.test(file.month)) return null;
  if (file.step !== STEP_MS || !Array.isArray(file.values)) return null;
  if (file.values.length !== slotsIn(file.month)) return null;
  const ok = file.values.every(
    (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0),
  );
  return ok ? (file as MonthFile) : null;
}

export class OiSeries {
  private readonly dir: string;
  private readonly onWarning: (message: string) => void;
  /** By month: one value per grid step, NaN for none. */
  private readonly months = new Map<string, Float64Array>();
  private readonly dirty = new Set<string>();
  private firstMs = Number.POSITIVE_INFINITY;
  private lastMs = Number.NEGATIVE_INFINITY;

  constructor(dir: string, onWarning: (message: string) => void = () => {}) {
    this.dir = dir;
    this.onWarning = onWarning;
  }

  /** The months kept on disk. One that can't be read is moved aside (JsonFile). */
  async load(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names.filter((n) => /^\d{4}-\d{2}\.json$/.test(n)).sort()) {
      const month = name.slice(0, 7);
      const file = await this.file(month).read();
      if (!file || file.month !== month) continue;
      const values = new Float64Array(file.values.length).fill(Number.NaN);
      file.values.forEach((v, i) => {
        if (v !== null) values[i] = v;
      });
      this.months.set(month, values);
      this.extend(month, values);
    }
  }

  /** Puts points in; one off the grid goes on the step it falls in. */
  put(points: readonly OiPoint[]): void {
    for (const { time, value } of points) {
      if (!Number.isFinite(time) || !Number.isFinite(value) || value < 0) continue;
      const at = Math.floor(time / STEP_MS) * STEP_MS;
      const month = monthOf(at);
      let values = this.months.get(month);
      if (!values) {
        values = new Float64Array(slotsIn(month)).fill(Number.NaN);
        this.months.set(month, values);
      }
      const slot = (at - monthStart(month)) / STEP_MS;
      if (values[slot] === value) continue;
      values[slot] = value;
      this.dirty.add(month);
      if (at < this.firstMs) this.firstMs = at;
      if (at > this.lastMs) this.lastMs = at;
    }
  }

  /** The first and last points' times; null when there are none. */
  first(): number | null {
    return Number.isFinite(this.firstMs) ? this.firstMs : null;
  }

  last(): number | null {
    return Number.isFinite(this.lastMs) ? this.lastMs : null;
  }

  /** Each point in [fromMs, toMs], in time order. */
  each(fromMs: number, toMs: number, fn: (time: number, value: number) => void): void {
    const from = Math.max(fromMs, this.firstMs);
    const to = Math.min(toMs, this.lastMs);
    if (!(from <= to)) return;
    let month = monthOf(from);
    for (;;) {
      const start = monthStart(month);
      if (start > to) return;
      const values = this.months.get(month);
      if (values) {
        const lo = Math.max(0, Math.ceil((from - start) / STEP_MS));
        const hi = Math.min(values.length - 1, Math.floor((to - start) / STEP_MS));
        for (let i = lo; i <= hi; i++) {
          const v = values[i] as number;
          if (!Number.isNaN(v)) fn(start + i * STEP_MS, v);
        }
      }
      const date = new Date(start);
      month = monthOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    }
  }

  /** Writes the months that changed, each file whole. */
  async save(): Promise<void> {
    const months = [...this.dirty];
    this.dirty.clear();
    for (const month of months) {
      const values = this.months.get(month);
      if (!values) continue;
      const file: MonthFile = {
        v: 1,
        month,
        step: STEP_MS,
        values: Array.from(values, (v) => (Number.isNaN(v) ? null : v)),
      };
      try {
        await this.file(month).write(file);
      } catch (error) {
        this.dirty.add(month);
        this.onWarning(`Couldn't save open interest for ${month} (${String(error)})`);
      }
    }
  }

  private extend(month: string, values: Float64Array): void {
    const start = monthStart(month);
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(values[i] as number)) continue;
      this.firstMs = Math.min(this.firstMs, start + i * STEP_MS);
      break;
    }
    for (let i = values.length - 1; i >= 0; i--) {
      if (Number.isNaN(values[i] as number)) continue;
      this.lastMs = Math.max(this.lastMs, start + i * STEP_MS);
      break;
    }
  }

  private file(month: string): JsonFile<MonthFile> {
    return new JsonFile(join(this.dir, `${month}.json`), parseMonth, {
      indent: 0,
      onInvalid: (aside) =>
        this.onWarning(`An unreadable open interest file was moved to ${aside}`),
    });
  }
}

/** What a series remembers besides its points: which of Binance's archive days are in. */
export interface OiMeta {
  v: 1;
  /** The archive's first day for this perpetual ("2020-09-01"), once found. */
  archiveFirst: string | null;
  /** Days fetched from the archive (or found missing there), as ranges of days. */
  archiveDays: [string, string][];
}

function parseMeta(value: unknown): OiMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const meta = value as Partial<OiMeta>;
  const day = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (meta.v !== 1 || !(meta.archiveFirst === null || day(meta.archiveFirst))) return null;
  if (!Array.isArray(meta.archiveDays)) return null;
  const ranges = meta.archiveDays.every(
    (r) => Array.isArray(r) && r.length === 2 && day(r[0]) && day(r[1]),
  );
  return ranges ? (meta as OiMeta) : null;
}

export function metaFile(dir: string, onWarning: (message: string) => void): JsonFile<OiMeta> {
  return new JsonFile(join(dir, 'meta.json'), parseMeta, {
    onInvalid: (aside) => onWarning(`An unreadable open interest file was moved to ${aside}`),
  });
}

/** Days as ranges, for the meta file: ["2020-09-01", "2026-11-05"]. */
export function dayRanges(days: Iterable<string>): [string, string][] {
  const sorted = [...days].sort();
  const out: [string, string][] = [];
  for (const day of sorted) {
    const last = out.at(-1);
    if (last && nextDay(last[1]) === day) last[1] = day;
    else out.push([day, day]);
  }
  return out;
}

export function daysOf(ranges: readonly [string, string][]): Set<string> {
  const out = new Set<string>();
  for (const [from, to] of ranges) {
    for (let day = from; day <= to; day = nextDay(day)) out.add(day);
  }
  return out;
}

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const nextDay = (day: string): string => dayOf(dayStart(day) + 86_400_000);
