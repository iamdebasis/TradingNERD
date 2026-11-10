import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson, RECONNECT_DELAYS_MS } from '../src/catalog/http.ts';

/**
 * The exchanges' requests (catalog/http.ts): a dropped connection is asked again, twice, before
 * the exchange counts as unreachable, so a passing network hiccup doesn't put an error on a chart
 * (the Mac's live run of 2026-11-10: Kraken and Bitstamp failed once each). A timeout and any
 * answer go straight back as they are.
 */

const dropped = () => new TypeError('fetch failed');
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that gives each call's outcome in turn: a thrown error, or an answer. */
function fetchOf(outcomes: (Error | Response)[]) {
  const calls: number[] = [];
  const fetchFn = (async () => {
    calls.push(Date.now());
    const next = outcomes.shift();
    if (!next) throw new Error('no more outcomes');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a request to an exchange', () => {
  it('is asked again after a dropped connection, and the answer that comes counts', async () => {
    const { fetchFn, calls } = fetchOf([dropped(), dropped(), json({ ok: 1 })]);
    await expect(
      getJson('https://x.test/a', 'Kraken', { fetch: fetchFn, retryDelaysMs: [0, 0] }),
    ).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });

  it('counts the exchange unreachable after its connection drops three times', async () => {
    const { fetchFn, calls } = fetchOf([dropped(), dropped(), dropped()]);
    await expect(
      getJson('https://x.test/a', 'Kraken', { fetch: fetchFn, retryDelaysMs: [0, 0] }),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Kraken is unreachable (fetch failed)',
    });
    expect(calls).toHaveLength(3);
  });

  it('waits half a second, then a second and a half, before asking again', async () => {
    expect(RECONNECT_DELAYS_MS).toEqual([500, 1_500]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { fetchFn, calls } = fetchOf([dropped(), dropped(), json([])]);
    const start = Date.now();
    const answer = getJson('https://x.test/a', 'Bitstamp', { fetch: fetchFn });
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual([]);
    expect(calls.map((at) => at - start)).toEqual([0, 500, 2_000]);
  });

  it('is not asked again after a timeout, nor after an answer, an error one included', async () => {
    const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    for (const [outcome, code] of [
      [timedOut, 'upstream_error'],
      [json({}, 500), 'upstream_error'],
      [json({}, 429), 'rate_limited'],
    ] as const) {
      const { fetchFn, calls } = fetchOf([outcome, json({ ok: 1 })]);
      await expect(
        getJson('https://x.test/a', 'OKX', { fetch: fetchFn, retryDelaysMs: [0, 0] }),
      ).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(1);
    }
  });
});
