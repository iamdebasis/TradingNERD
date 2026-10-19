import { readFileSync } from 'node:fs';
import type { CatalogPair, CatalogSnapshot, CatalogSource } from '../../src/catalog/types.ts';

export const pair = (
  ticker: string,
  base: string,
  quote: string,
  quoteVolume = 0,
  last = 0,
): CatalogPair => ({ ticker, base, quote, quoteVolume, last });

/** A catalog source the test controls: what it lists, and whether it's down. */
export class FakeCatalogSource implements CatalogSource {
  readonly id: string;
  readonly name: string;
  snapshot: CatalogSnapshot;
  failing = false;
  calls = 0;

  constructor(id: string, name: string, pairs: CatalogPair[], names: Record<string, string> = {}) {
    this.id = id;
    this.name = name;
    this.snapshot = { pairs, names };
  }

  async fetchCatalog(): Promise<CatalogSnapshot> {
    this.calls++;
    if (this.failing) throw new Error(`${this.name} is down`);
    return structuredClone(this.snapshot);
  }
}

/** A recorded exchange response from test/fixtures/catalog/. */
export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/catalog/${name}.json`, import.meta.url), 'utf8'),
  );
}

/** A route's answer: a fixed body, or one made from the request's URL. */
export type Route = unknown | ((url: URL) => unknown);

/**
 * A fetch that answers each URL whose path contains a key with that route's body (the first
 * key that matches wins), and 404 otherwise.
 */
export function fixtureFetch(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const match = Object.entries(routes).find(([path]) => url.includes(path));
    if (!match) return new Response('{"error":"not found"}', { status: 404 });
    const body = typeof match[1] === 'function' ? match[1](new URL(url)) : match[1];
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchFn, requested };
}
