import { type Drawing, newDrawing, type SymbolDrawings } from '@tradingnerd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOLBAR,
  DRAWING_TOOLBAR_KEY,
  DRAWINGS_RETRY_MS,
  DrawingStore,
  sanitizeToolbar,
  UNDO_LIMIT,
} from './drawingStore';

let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const line = (id: string, pane: string | null = null): Drawing =>
  newDrawing(
    id,
    'trend-line',
    [
      { time: 1_700_000_000, price: 1 },
      { time: 1_700_003_600, price: 2 },
    ],
    pane,
  );

/** A gateway in memory: what it holds per symbol, each save, and loads that answer when told. */
class FakeGateway {
  held = new Map<string, Drawing[]>();
  saves: SymbolDrawings[] = [];
  failLoads = false;
  failSaves = false;
  /** Loads wait for `answer()` when set. */
  hold = false;
  private waiting: (() => void)[] = [];
  /** Saves wait for `finishSave()` when set. */
  holdSaves = false;
  private saving: (() => void)[] = [];

  load = async (symbol: string, signal?: AbortSignal): Promise<SymbolDrawings> => {
    if (this.hold) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (signal?.aborted) throw new Error('aborted');
    if (this.failLoads) throw new Error('The local gateway is not reachable');
    return { symbol, drawings: this.held.get(symbol) ?? [] };
  };

  save = async (value: SymbolDrawings): Promise<SymbolDrawings> => {
    if (this.holdSaves) await new Promise<void>((resolve) => this.saving.push(resolve));
    if (this.failSaves) throw new Error('The local gateway is not reachable');
    this.saves.push({ symbol: value.symbol, drawings: value.drawings.slice() });
    this.held.set(value.symbol, value.drawings.slice());
    return value;
  };

  answer(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  finishSave(): void {
    this.saving.shift()?.();
  }
}

/** The store's retries, run when a test says rather than after their delay. */
class FakeLater {
  private tasks: { run: () => void; ms: number }[] = [];

  later = (run: () => void, ms: number): (() => void) => {
    const task = { run, ms };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((item) => item !== task);
    };
  };

  /** The delays of the retries waiting, in the order asked. */
  get waiting(): number[] {
    return this.tasks.map((task) => task.ms);
  }

  /** Runs the retries waiting now. */
  run(): void {
    for (const task of this.tasks.splice(0)) task.run();
  }
}

/** A store on a fake gateway whose retries wait for the test. */
const storeOf = (
  gateway: FakeGateway,
  panes: () => ReadonlySet<string> = () => new Set(),
  later = new FakeLater(),
) => new DrawingStore(gateway, panes, later.later);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function ready(store: DrawingStore, symbol = 'BINANCE:XRPUSDT'): Promise<void> {
  store.setSymbol(symbol);
  await settle();
  expect(store.get().status).toBe('ready');
}

describe('the drawings of the chart’s symbol', () => {
  it('load when the symbol changes, under its key', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('a')]);
    const store = storeOf(gateway);
    await ready(store, 'binance:xrpusdt');
    expect(store.get().symbol).toBe('BINANCE:XRPUSDT');
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a']);
  });

  it('leave out a drawing on the pane of an indicator no longer on the chart, and save without it', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('a'), line('b', 'rsi-1'), line('c', 'macd-1')]);
    const store = storeOf(gateway, () => new Set(['rsi-1']));
    await ready(store);
    await store.whenSaved();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a', 'b']);
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('save each edit, and undo and redo it', async () => {
    const gateway = new FakeGateway();
    const store = storeOf(gateway);
    await ready(store);
    store.edit([line('a')]);
    store.edit([line('a'), line('b')]);
    expect(store.get()).toMatchObject({ canUndo: true, canRedo: false });
    store.undo();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a']);
    expect(store.get()).toMatchObject({ canUndo: true, canRedo: true });
    store.redo();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a', 'b']);
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('forget what was undone once a new edit comes', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a')]);
    store.undo();
    store.edit([line('b')]);
    expect(store.get().canRedo).toBe(false);
  });

  it(`keep at most ${UNDO_LIMIT} undo steps`, async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    for (let i = 0; i < UNDO_LIMIT + 5; i++) store.edit([line(`d${i}`)]);
    let undone = 0;
    while (store.get().canUndo) {
      store.undo();
      undone++;
    }
    expect(undone).toBe(UNDO_LIMIT);
  });

  it('save one at a time, the latest list of each symbol, the last symbol’s too', async () => {
    const gateway = new FakeGateway();
    const store = storeOf(gateway);
    await ready(store);
    gateway.holdSaves = true;
    store.edit([line('a')]);
    store.edit([line('a'), line('b')]);
    store.edit([line('a'), line('b'), line('c')]);
    await settle();
    // The first save is under way; the two after it wait, and only the latest is sent.
    gateway.holdSaves = false;
    gateway.finishSave();
    await store.whenSaved();
    expect(gateway.saves.map((save) => save.drawings.length)).toEqual([1, 3]);
  });

  it('keep a save of the symbol left behind when the chart moves on', async () => {
    const gateway = new FakeGateway();
    const store = storeOf(gateway);
    await ready(store, 'BINANCE:XRPUSDT');
    gateway.holdSaves = true;
    store.edit([line('a')]);
    store.edit([line('a'), line('b')]);
    store.setSymbol('BINANCE:BTCUSDT');
    gateway.holdSaves = false;
    gateway.finishSave();
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a', 'b']);
    expect(store.get().drawings).toEqual([]);
    expect(store.get().canUndo).toBe(false);
  });

  it('send a save asked for just as the one before it ends', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:BTCUSDT', [line('kept'), line('orphan', 'gone-1')]);
    const store = storeOf(gateway);
    await ready(store, 'BINANCE:XRPUSDT');
    gateway.holdSaves = true;
    store.edit([line('a')]);
    gateway.hold = true;
    store.setSymbol('BINANCE:BTCUSDT');
    await settle();
    // The save ends and the load answers at the same moment; the load leaves out the drawing on
    // a pane that's gone, and saves what's left.
    gateway.holdSaves = false;
    gateway.finishSave();
    gateway.answer();
    await settle();
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:BTCUSDT')?.map((d) => d.id)).toEqual(['kept']);
  });

  it('save nothing while the symbol’s drawings couldn’t load, and keep edits for when they do', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('a')]);
    gateway.failLoads = true;
    const store = storeOf(gateway);
    store.setSymbol('BINANCE:XRPUSDT');
    await settle();
    expect(store.get().status).toBe('failed');
    gateway.failLoads = false;
    // An edit tries the load again; the stored drawing comes first, the new one on top.
    store.edit([line('b')]);
    await settle();
    await store.whenSaved();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a', 'b']);
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a', 'b']);
    // Undo can't take the stored drawings away with the steps taken before they came.
    expect(store.get().canUndo).toBe(false);
  });

  it('never write over a symbol’s stored drawings it couldn’t load, whatever changes meanwhile', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('stored')]);
    gateway.failLoads = true;
    const store = storeOf(gateway, () => new Set(['rsi-1']));
    store.setSymbol('BINANCE:XRPUSDT');
    await settle();
    store.edit([line('a'), line('b', 'rsi-1')]);
    await settle();
    // Its indicator leaves while the stored drawings are still out of reach.
    store.dropPanes(['rsi-1']);
    await store.whenSaved();
    expect(gateway.saves).toEqual([]);
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['stored']);
  });

  it('keep edits made before the drawings came on top of them', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('a')]);
    gateway.hold = true;
    const store = storeOf(gateway);
    store.setSymbol('BINANCE:XRPUSDT');
    store.edit([line('b')]);
    expect(gateway.saves).toEqual([]);
    gateway.answer();
    await settle();
    await store.whenSaved();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a', 'b']);
    expect(gateway.saves).toHaveLength(1);
  });

  it('show a settings dialog’s changes at once and keep them as one step on Ok, or put them back on Cancel', async () => {
    const gateway = new FakeGateway();
    const store = storeOf(gateway);
    await ready(store);
    store.edit([line('a')]);
    await store.whenSaved();
    const saves = gateway.saves.length;
    const before = store.get().drawings;
    const red = { ...line('a'), style: { ...line('a').style, color: '#F23645' } };
    store.preview(red);
    expect(store.get().drawings[0]?.style.color).toBe('#F23645');
    store.finishPreview(before, false);
    expect(store.get().drawings).toBe(before);
    await store.whenSaved();
    expect(gateway.saves).toHaveLength(saves);
    store.preview(red);
    store.finishPreview(before, true);
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.[0]?.style.color).toBe('#F23645');
    store.undo();
    expect(store.get().drawings).toBe(before);
  });

  it('drop the drawings on a removed indicator’s pane, from the undo steps too', async () => {
    const gateway = new FakeGateway();
    const store = storeOf(gateway, () => new Set(['rsi-1']));
    await ready(store);
    store.edit([line('a'), line('b', 'rsi-1')]);
    store.edit([line('a'), line('b', 'rsi-1'), line('c', 'rsi-1')]);
    store.dropPanes(['rsi-1']);
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a']);
    store.undo();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a']);
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a']);
  });
});

describe('when the gateway can’t be reached', () => {
  it('tries a failed save again every 3 s, saying why meanwhile, until it’s made', async () => {
    const gateway = new FakeGateway();
    const later = new FakeLater();
    const store = storeOf(gateway, undefined, later);
    await ready(store);
    gateway.failSaves = true;
    store.edit([line('a')]);
    await store.whenSaved();
    expect(store.get().saveError).toBe('The local gateway is not reachable');
    expect(later.waiting).toEqual([DRAWINGS_RETRY_MS]);
    later.run();
    await store.whenSaved();
    // Still out of reach: tried again later.
    expect(gateway.held.has('BINANCE:XRPUSDT')).toBe(false);
    expect(later.waiting).toEqual([DRAWINGS_RETRY_MS]);
    gateway.failSaves = false;
    later.run();
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a']);
    expect(store.get().saveError).toBeNull();
    expect(later.waiting).toEqual([]);
  });

  it('tries a failed load again every 3 s, saying why, and saves nothing until the drawings are in', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('a')]);
    gateway.failLoads = true;
    const later = new FakeLater();
    const store = storeOf(gateway, undefined, later);
    store.setSymbol('BINANCE:XRPUSDT');
    await settle();
    expect(store.get()).toMatchObject({
      status: 'failed',
      loadError: 'The local gateway is not reachable',
    });
    expect(later.waiting).toEqual([DRAWINGS_RETRY_MS]);
    later.run();
    await settle();
    expect(store.get().status).toBe('failed');
    gateway.failLoads = false;
    later.run();
    await settle();
    expect(store.get()).toMatchObject({ status: 'ready', loadError: null, saveError: null });
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a']);
    expect(gateway.saves).toEqual([]);
    expect(later.waiting).toEqual([]);
  });

  it('shows a symbol’s newest drawings, not the gateway’s older ones, when the chart comes back to it before they could be saved', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('a')]);
    const later = new FakeLater();
    const store = storeOf(gateway, undefined, later);
    await ready(store, 'BINANCE:XRPUSDT');
    gateway.failSaves = true;
    store.edit([line('a'), line('b')]);
    await store.whenSaved();
    store.setSymbol('BINANCE:BTCUSDT');
    await settle();
    expect(store.get().saveError).toBeNull();
    store.setSymbol('BINANCE:XRPUSDT');
    await settle();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a', 'b']);
    expect(store.get().saveError).toBe('The local gateway is not reachable');
    gateway.failSaves = false;
    later.run();
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a', 'b']);
    expect(store.get().saveError).toBeNull();
  });

  it('shows the drawings on their way to the gateway when the chart comes back to their symbol meanwhile', async () => {
    const gateway = new FakeGateway();
    gateway.held.set('BINANCE:XRPUSDT', [line('a')]);
    const store = storeOf(gateway);
    await ready(store, 'BINANCE:XRPUSDT');
    gateway.holdSaves = true;
    store.edit([line('a'), line('b')]);
    store.setSymbol('BINANCE:BTCUSDT');
    await settle();
    store.setSymbol('BINANCE:XRPUSDT');
    await settle();
    expect(store.get().drawings.map((d) => d.id)).toEqual(['a', 'b']);
    gateway.holdSaves = false;
    gateway.finishSave();
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('the left toolbar’s state', () => {
  it('remembers the last line tool chosen and the modes, in this browser', () => {
    const store = new DrawingStore(new FakeGateway());
    store.setTool('horizontal-ray');
    store.setPrefs({ magnetOn: true, magnet: 'strong', keepDrawing: true });
    const again = new DrawingStore(new FakeGateway());
    expect(again.get().prefs).toMatchObject({
      lineTool: 'horizontal-ray',
      magnetOn: true,
      magnet: 'strong',
      keepDrawing: true,
    });
    expect(again.get().tool).toBeNull();
  });

  it('remembers a channel or a pitchfork as the trend line tools’ last choice too', () => {
    const store = new DrawingStore(new FakeGateway());
    store.setTool('parallel-channel');
    expect(new DrawingStore(new FakeGateway()).get().prefs.lineTool).toBe('parallel-channel');
    store.setTool('inside-pitchfork');
    expect(new DrawingStore(new FakeGateway()).get().prefs.lineTool).toBe('inside-pitchfork');
    expect(sanitizeToolbar({ lineTool: 'regression-trend' }).lineTool).toBe('regression-trend');
  });

  it('puts the tool down when a cursor is chosen, or when a drawing is done', () => {
    const store = new DrawingStore(new FakeGateway());
    store.setTool('ray');
    store.setPrefs({ cursor: 'dot' });
    expect(store.get().tool).toBeNull();
    store.setTool('ray');
    store.toolDone();
    expect(store.get().tool).toBeNull();
  });

  it('starts from the defaults when what was kept is unreadable', () => {
    stored.set(DRAWING_TOOLBAR_KEY, '{"cursor":"laser","magnet":7,"lineTool":"fib"}');
    expect(new DrawingStore(new FakeGateway()).get().prefs).toEqual(DEFAULT_TOOLBAR);
    expect(sanitizeToolbar(null)).toEqual(DEFAULT_TOOLBAR);
  });
});
