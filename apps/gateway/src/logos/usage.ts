import { join } from 'node:path';
import { JsonFile } from '../storage/jsonFile.ts';

/** CoinGecko's free (Demo) plan allows 10,000 calls a calendar month. */
export const MONTHLY_CALLS = 10_000;
/** Past this many calls in a month, market caps are fetched less often. */
export const SLOW_AFTER = 8_000;
/** Past this many, only what's needed to keep going is fetched. */
export const STOP_AFTER = 9_500;
/** How long a count waits before it's written, so a burst of calls is one write. */
const SAVE_DELAY_MS = 5_000;

interface Stored {
  /** "2026-10", UTC. */
  month: string;
  calls: number;
}

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null;
  const { month, calls } = value as Record<string, unknown>;
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
  if (typeof calls !== 'number' || !Number.isInteger(calls) || calls < 0) return null;
  return { month, calls };
}

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/**
 * The gateway's CoinGecko calls this month (logos and market caps together), kept in
 * data/coingecko-usage.json, so the free plan's allowance isn't used up unawares.
 */
export class CoinGeckoUsage {
  private readonly file: JsonFile<Stored>;
  private readonly now: () => number;
  private stored: Stored;
  private loaded: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.file = new JsonFile(join(dataDir, 'coingecko-usage.json'), parseStored);
    this.now = now;
    this.stored = { month: monthOf(now()), calls: 0 };
  }

  /** Reads the saved count once; calls counted before that are added to it. */
  load(): Promise<void> {
    this.loaded ??= this.file.read().then(
      (saved) => {
        if (saved && saved.month === this.stored.month) this.stored.calls += saved.calls;
      },
      () => {},
    );
    return this.loaded;
  }

  record(): void {
    const month = monthOf(this.now());
    if (month !== this.stored.month) this.stored = { month, calls: 0 };
    this.stored.calls++;
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.load().then(() => this.file.write({ ...this.stored }).catch(() => {}));
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Calls made this month so far. */
  used(): number {
    return monthOf(this.now()) === this.stored.month ? this.stored.calls : 0;
  }

  /** "ok"; "slow" past SLOW_AFTER calls; "stop" past STOP_AFTER. */
  level(): 'ok' | 'slow' | 'stop' {
    const used = this.used();
    if (used >= STOP_AFTER) return 'stop';
    return used >= SLOW_AFTER ? 'slow' : 'ok';
  }

  /** Writes a pending count now (on shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.load();
    await this.file.write({ ...this.stored }).catch(() => {});
  }
}
