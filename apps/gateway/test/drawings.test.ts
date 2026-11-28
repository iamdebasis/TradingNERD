import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Drawing, newDrawing, parseSymbolDrawings } from '@tradingnerd/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketError } from '../src/market/types.ts';
import { registerDrawingRoutes } from '../src/routes/drawings.ts';
import { DrawingsStore } from '../src/storage/DrawingsStore.ts';
import { JsonFile } from '../src/storage/jsonFile.ts';

/**
 * The user's drawings, kept by the gateway per symbol in data/drawings.json (docs/SPEC.md §5.27).
 */

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'tradingnerd-drawings-')), 'data');

const line = (id: string, price = 1.5): Drawing =>
  newDrawing(id, 'trend-line', [
    { time: 1_700_000_000, price },
    { time: 1_700_086_400, price: price + 0.2 },
  ]);

const fileOf = (dataDir: string) =>
  JSON.parse(readFileSync(join(dataDir, 'drawings.json'), 'utf8')) as {
    version: number;
    symbols: Record<string, Drawing[]>;
  };

describe('drawings, kept in data/drawings.json', () => {
  it('serves none for a symbol that has none, before any file exists', async () => {
    const store = new DrawingsStore(freshDir());
    expect(await store.get('BINANCE:XRPUSDT')).toEqual({ symbol: 'BINANCE:XRPUSDT', drawings: [] });
  });

  it('keeps a symbol’s drawings by its name, case aside, and serves them back', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    const saved = await store.put({ symbol: 'binance:xrpusdt', drawings: [line('a')] });
    expect(saved.symbol).toBe('BINANCE:XRPUSDT');
    expect(fileOf(dataDir)).toEqual({ version: 1, symbols: { 'BINANCE:XRPUSDT': [line('a')] } });
    // A fresh gateway reads the file.
    expect((await new DrawingsStore(dataDir).get('Binance:XRPUSDT')).drawings).toEqual([line('a')]);
  });

  it('keeps each drawing’s groups, a group’s drawings together where its frontmost is (D3c2)', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    const group = { id: 'g1', name: 'Levels' };
    const saved = await store.put({
      symbol: 'A:B',
      drawings: [{ ...line('a'), groups: [group] }, line('x'), { ...line('b'), groups: [group] }],
    });
    expect(saved.drawings.map((d) => [d.id, d.groups])).toEqual([
      ['x', []],
      ['a', [group]],
      ['b', [group]],
    ]);
    expect(fileOf(dataDir).symbols['A:B']?.map((d) => d.id)).toEqual(['x', 'a', 'b']);
    expect((await new DrawingsStore(dataDir).get('A:B')).drawings[2]?.groups).toEqual([group]);
  });

  it('drops a symbol from the file when its last drawing goes', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    await store.put({ symbol: 'A:B', drawings: [line('a')] });
    await store.put({ symbol: 'C:D', drawings: [line('b')] });
    await store.put({ symbol: 'A:B', drawings: [] });
    expect(Object.keys(fileOf(dataDir).symbols)).toEqual(['C:D']);
  });

  it('keeps both of two symbols saved at the same moment', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    await Promise.all([
      store.put({ symbol: 'A:B', drawings: [line('a')] }),
      store.put({ symbol: 'C:D', drawings: [line('b')] }),
      store.put({ symbol: 'E:F', drawings: [line('c')] }),
    ]);
    expect(Object.keys(fileOf(dataDir).symbols).sort()).toEqual(['A:B', 'C:D', 'E:F']);
    expect(Object.keys((await new DrawingsStore(dataDir).get('E:F')).drawings)).toHaveLength(1);
  });

  it('refuses drawings that aren’t valid, and leaves the file as it was', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    await store.put({ symbol: 'A:B', drawings: [line('a')] });
    const bad = { ...line('b'), points: [] };
    await expect(store.put({ symbol: 'A:B', drawings: [bad] })).rejects.toBeInstanceOf(MarketError);
    await expect(store.get('')).rejects.toBeInstanceOf(MarketError);
    expect(fileOf(dataDir).symbols['A:B']).toEqual([line('a')]);
  });

  it('serves the drawings as stored when a save can’t be written', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    await store.put({ symbol: 'A:B', drawings: [line('a')] });
    const write = vi
      .spyOn(JsonFile.prototype, 'write')
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    try {
      await expect(store.put({ symbol: 'A:B', drawings: [line('a'), line('b')] })).rejects.toThrow(
        'ENOSPC',
      );
    } finally {
      write.mockRestore();
    }
    expect((await store.get('A:B')).drawings).toEqual([line('a')]);
    // The next save builds on what's stored, not on the save that failed.
    await store.put({ symbol: 'C:D', drawings: [line('c')] });
    expect(fileOf(dataDir).symbols).toEqual({ 'A:B': [line('a')], 'C:D': [line('c')] });
  });

  it('moves an unreadable file aside, says so, and starts with none', async () => {
    const dataDir = freshDir();
    await new DrawingsStore(dataDir).put({ symbol: 'A:B', drawings: [line('a')] });
    writeFileSync(join(dataDir, 'drawings.json'), '{ broken');
    const warnings: string[] = [];
    const store = new DrawingsStore(dataDir, (message) => warnings.push(message));
    expect((await store.get('A:B')).drawings).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(readdirSync(dataDir).some((name) => name.startsWith('drawings.json.invalid-'))).toBe(
      true,
    );
  });
});

describe('the drawings routes', () => {
  let app: FastifyInstance;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = freshDir();
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const code = error instanceof MarketError ? error.code : 'internal_error';
      reply.code(code === 'bad_request' ? 400 : 500).send({ error: code });
    });
    registerDrawingRoutes(app, new DrawingsStore(dataDir));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('saves a symbol’s drawings and serves them back by its name', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/drawings',
      payload: { symbol: 'BINANCE:XRPUSDT', drawings: [line('a')] },
    });
    expect(put.statusCode).toBe(200);
    expect(parseSymbolDrawings(put.json())).toEqual(put.json());
    const get = await app.inject({
      method: 'GET',
      url: `/api/drawings?symbol=${encodeURIComponent('BINANCE:XRPUSDT')}`,
    });
    expect(get.json()).toEqual({ symbol: 'BINANCE:XRPUSDT', drawings: [line('a')] });
  });

  it('answers 400 without a symbol or with drawings that aren’t valid', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/drawings' })).statusCode).toBe(400);
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/drawings',
      payload: { symbol: 'A:B', drawings: [{ id: 'x' }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('takes a symbol’s drawings past the usual 1 MiB body limit', async () => {
    const drawings = Array.from({ length: 2_500 }, (_, i) => {
      const drawing = line(`d${i}`, 1 + i / 1000);
      drawing.style.text.value = 'x'.repeat(400);
      return drawing;
    });
    const payload = JSON.stringify({ symbol: 'A:B', drawings });
    expect(payload.length).toBeGreaterThan(1024 * 1024);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/drawings',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(put.statusCode).toBe(200);
    expect(fileOf(dataDir).symbols['A:B']).toHaveLength(2_500);
  });
});

describe('dropping a removed indicator’s drawings from every symbol (item 159, D3c)', () => {
  const onPane = (id: string, pane: string): Drawing => ({ ...line(id), pane });

  it('drops them from every symbol, keeps the rest, and counts what went', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    await store.put({ symbol: 'A:B', drawings: [line('a'), onPane('r1', 'rsi-1')] });
    await store.put({ symbol: 'C:D', drawings: [onPane('r2', 'rsi-1'), onPane('m', 'macd-1')] });
    await store.put({ symbol: 'E:F', drawings: [onPane('r3', 'rsi-1')] });
    expect(await store.dropPanes({ panes: ['rsi-1'] })).toEqual({ removed: 3 });
    expect(fileOf(dataDir).symbols).toEqual({
      'A:B': [line('a')],
      'C:D': [onPane('m', 'macd-1')],
    });
  });

  it('writes nothing when there’s nothing to drop', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    await store.put({ symbol: 'A:B', drawings: [line('a')] });
    const write = vi.spyOn(JsonFile.prototype, 'write');
    try {
      expect(await store.dropPanes({ panes: ['rsi-1'] })).toEqual({ removed: 0 });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('runs after the save before it, so a drawing saved just before is dropped too', async () => {
    const dataDir = freshDir();
    const store = new DrawingsStore(dataDir);
    const saving = store.put({ symbol: 'A:B', drawings: [onPane('r1', 'rsi-1')] });
    const dropping = store.dropPanes({ panes: ['rsi-1'] });
    await Promise.all([saving, dropping]);
    expect(fileOf(dataDir).symbols).toEqual({});
  });

  it('refuses what isn’t a list of panes', async () => {
    const store = new DrawingsStore(freshDir());
    for (const bad of [
      null,
      {},
      { panes: [] },
      { panes: [''] },
      { panes: 'rsi-1' },
      { panes: [7] },
    ]) {
      await expect(store.dropPanes(bad)).rejects.toBeInstanceOf(MarketError);
    }
  });

  it('is offered as POST /api/drawings/drop-panes', async () => {
    const dataDir = freshDir();
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      reply.code(error instanceof MarketError ? 400 : 500).send({ error: 'x' });
    });
    const store = new DrawingsStore(dataDir);
    registerDrawingRoutes(app, store);
    await app.ready();
    try {
      await store.put({ symbol: 'A:B', drawings: [onPane('r1', 'rsi-1'), line('a')] });
      const ok = await app.inject({
        method: 'POST',
        url: '/api/drawings/drop-panes',
        payload: { panes: ['rsi-1'] },
      });
      expect([ok.statusCode, ok.json()]).toEqual([200, { removed: 1 }]);
      const bad = await app.inject({
        method: 'POST',
        url: '/api/drawings/drop-panes',
        payload: {},
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
