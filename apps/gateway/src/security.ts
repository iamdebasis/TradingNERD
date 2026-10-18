const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * True when the Host header names this machine. Rejecting any other host blocks DNS-rebinding
 * attacks, where a website points its own domain at 127.0.0.1 to reach local services.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : (hostHeader.split(':')[0] ?? '');
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * True when a request may proceed based on its Origin header. Browsers always send Origin on
 * cross-site requests and WebSocket handshakes, so a foreign website is always rejected.
 * Requests without Origin (same-origin GETs, curl, tests) are allowed.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}
