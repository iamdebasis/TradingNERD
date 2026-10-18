const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/** Wait before reconnect attempt `attempt` (0-based): 0.5 s, 1 s, 2 s, 4 s… capped at 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt), MAX_DELAY_MS);
}
