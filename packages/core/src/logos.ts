/** Which CoinGecko API a key belongs to. */
export type CoinGeckoPlan = 'demo' | 'pro';

/** What the UI may know about coin logos: never the key itself, only its last 4 characters. */
export interface LogoStatus {
  key: {
    /** "••••3f9a" */
    masked: string;
    /** Null until an environment-provided key has been checked. */
    plan: CoinGeckoPlan | null;
    /** `env`: from COINGECKO_API_KEY, which the UI can't change. */
    source: 'file' | 'env';
  } | null;
  /** "Skip for now" was chosen on the first-launch prompt. */
  promptDismissed: boolean;
  /** When the logo list was last refreshed (epoch ms); null before the first sync. */
  syncedAt: number | null;
  syncing: boolean;
  /** Why the last refresh failed, in words, or null. */
  syncError: string | null;
}

/** Validates GET /api/logos/status output. */
export function parseLogoStatus(value: unknown): LogoStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  let key: LogoStatus['key'] = null;
  if (v.key !== null) {
    if (typeof v.key !== 'object' || v.key === undefined) return null;
    const k = v.key as Record<string, unknown>;
    if (typeof k.masked !== 'string') return null;
    if (k.plan !== null && k.plan !== 'demo' && k.plan !== 'pro') return null;
    if (k.source !== 'file' && k.source !== 'env') return null;
    key = { masked: k.masked, plan: k.plan, source: k.source };
  }
  if (typeof v.promptDismissed !== 'boolean' || typeof v.syncing !== 'boolean') return null;
  if (v.syncedAt !== null && (typeof v.syncedAt !== 'number' || !Number.isFinite(v.syncedAt))) {
    return null;
  }
  if (v.syncError !== null && typeof v.syncError !== 'string') return null;
  return {
    key,
    promptDismissed: v.promptDismissed,
    syncedAt: v.syncedAt,
    syncing: v.syncing,
    syncError: v.syncError,
  };
}
