/**
 * CRYPTOCAP's older market caps (docs/SPEC.md §5.13): TOTAL, TOTAL2, TOTAL3 and BTC.D before our
 * own history begins, from Live Coin Watch with the user's free key.
 */

/** Body of GET /api/older-caps, and of the key's PUT and DELETE. */
export interface OlderCapsStatus {
  /** The Live Coin Watch key: set in the app, or by LIVECOINWATCH_API_KEY; masked. */
  key: { masked: string; source: 'file' | 'env' } | null;
  /** The download: not started, under way, done, or stopped by something it says. */
  state: 'none' | 'loading' | 'done' | 'error';
  /** How much of it is in, 0 to 1. */
  progress: number;
  /** The first and last day it covers (YYYY-MM-DD), once any is in. */
  from: string | null;
  until: string | null;
  /** What stopped it, or what it waits for. */
  message: string | null;
}

const STATES: readonly OlderCapsStatus['state'][] = ['none', 'loading', 'done', 'error'];
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function parseOlderCapsStatus(value: unknown): OlderCapsStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const { key, state, progress, from, until, message } = value as Record<string, unknown>;
  let parsedKey: OlderCapsStatus['key'] = null;
  if (key !== null) {
    if (typeof key !== 'object') return null;
    const { masked, source } = key as Record<string, unknown>;
    if (typeof masked !== 'string' || (source !== 'file' && source !== 'env')) return null;
    parsedKey = { masked, source };
  }
  if (!STATES.includes(state as OlderCapsStatus['state'])) return null;
  if (typeof progress !== 'number' || !(progress >= 0 && progress <= 1)) return null;
  if ((from !== null && !isDay(from)) || (until !== null && !isDay(until))) return null;
  if (message !== null && typeof message !== 'string') return null;
  return {
    key: parsedKey,
    state: state as OlderCapsStatus['state'],
    progress,
    from,
    until,
    message,
  };
}
