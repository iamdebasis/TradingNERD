/**
 * US stocks and ETFs (M7): their data comes from Alpaca with the user's own key, which only
 * the gateway keeps (docs/SPEC.md §5.7).
 */

/** How the user's Alpaca plan serves the whole US market (the SIP feed). */
export type SipAccess = 'realtime' | 'delayed';

/** How far behind Alpaca's free plan serves the whole market: 15 minutes. */
export const DELAYED_SIP_MS = 15 * 60_000;

/** Body of GET /api/stocks/key: whether a key is set, never the key itself. */
export interface StockKeyStatus {
  configured: boolean;
  /** Set in the app, or by APCA_API_KEY_ID and APCA_API_SECRET_KEY. */
  source: 'file' | 'env' | null;
  /** The key id's last four characters: "••••3F9A". */
  keyId: string | null;
  /** Null until checked against Alpaca. */
  sip: SipAccess | null;
}

export const isSipAccess = (value: unknown): value is SipAccess =>
  value === 'realtime' || value === 'delayed';

export function parseStockKeyStatus(value: unknown): StockKeyStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const { configured, source, keyId, sip } = value as Record<string, unknown>;
  if (typeof configured !== 'boolean') return null;
  if (source !== null && source !== 'file' && source !== 'env') return null;
  if (keyId !== null && typeof keyId !== 'string') return null;
  if (sip !== null && !isSipAccess(sip)) return null;
  return { configured, source, keyId, sip };
}
