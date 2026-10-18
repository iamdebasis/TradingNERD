/**
 * Wire protocol between the UI and the local gateway.
 * Bump PROTOCOL_VERSION on any breaking change so a stale UI can tell it needs a reload.
 */
export const PROTOCOL_VERSION = 1;

/** Body of GET /api/health. */
export interface HealthResponse {
  status: 'ok';
  protocolVersion: number;
  uptimeSec: number;
  /** Gateway clock in epoch ms; later used to keep bar countdowns exact. */
  serverTime: number;
}

/** Messages the gateway sends over the WebSocket. */
export type ServerMessage =
  | { type: 'hello'; protocolVersion: number; serverTime: number }
  | { type: 'pong'; t: number };

/** Messages the UI sends over the WebSocket. */
export type ClientMessage = { type: 'ping'; t: number };

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parses a gateway → UI message. Returns null for anything malformed or unknown. */
export function parseServerMessage(raw: string): ServerMessage | null {
  const msg = parseObject(raw);
  if (
    msg?.type === 'hello' &&
    typeof msg.protocolVersion === 'number' &&
    typeof msg.serverTime === 'number'
  ) {
    return { type: 'hello', protocolVersion: msg.protocolVersion, serverTime: msg.serverTime };
  }
  if (msg?.type === 'pong' && typeof msg.t === 'number') {
    return { type: 'pong', t: msg.t };
  }
  return null;
}

/** Parses a UI → gateway message. Returns null for anything malformed or unknown. */
export function parseClientMessage(raw: string): ClientMessage | null {
  const msg = parseObject(raw);
  if (msg?.type === 'ping' && typeof msg.t === 'number') {
    return { type: 'ping', t: msg.t };
  }
  return null;
}
