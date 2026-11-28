import {
  type Drawing,
  defaultDrawingStyle,
  MAX_DRAWINGS_PER_SYMBOL,
  newDrawing,
  recolorDrawing,
  type SymbolDrawings,
} from '@tradingnerd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOLBAR,
  DRAWING_TOOLBAR_KEY,
  DRAWINGS_CLIPBOARD_KEY,
  DRAWINGS_RETRY_MS,
  DrawingStore,
  sanitizeToolbar,
  UNDO_LIMIT,
} from './drawingStore';
import { ToolStyles } from './toolStyles';

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

  /** Panes dropped from every symbol (D3c), each call's; fails when told. */
  dropped: string[][] = [];
  failDrops = false;
  /** While set, a drop waits for it before it's answered. */
  dropGate: Promise<void> | null = null;
  dropPanes = async (panes: readonly string[]): Promise<void> => {
    if (this.dropGate) await this.dropGate;
    if (this.failDrops) throw new Error('The local gateway is not reachable');
    this.dropped.push([...panes]);
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

describe('several drawings at once (D3a)', () => {
  const ids = (store: DrawingStore) => store.get().drawings.map((d) => d.id);
  const FOUR_HOURS = { unit: 'minute', count: 240 } as const;

  it('changes several in one undo step', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a'), line('b'), line('c')]);
    store.updateMany(['a', 'c'], (d) => ({ ...d, locked: true }));
    expect(store.get().drawings.map((d) => d.locked)).toEqual([true, false, true]);
    store.undo();
    expect(store.get().drawings.map((d) => d.locked)).toEqual([false, false, false]);
  });

  it('shows several as a dialog has them, and keeps them as one step on Ok', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a'), line('b')]);
    const before = store.get().drawings;
    store.previewMany(before.map((d) => ({ ...d, hidden: true })));
    expect(store.get().drawings.map((d) => d.hidden)).toEqual([true, true]);
    store.finishPreview(before, true);
    store.undo();
    expect(store.get().drawings.map((d) => d.hidden)).toEqual([false, false]);
  });

  it('moves drawings in the visual order as one step, and makes none for a move that changes nothing', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a'), line('b'), line('c')]);
    store.reorder(['b'], 'send-to-back');
    expect(ids(store)).toEqual(['b', 'a', 'c']);
    expect(store.get().drawings[0]?.below).toBe(true);
    store.undo();
    expect(ids(store)).toEqual(['a', 'b', 'c']);
    store.redo();
    const steps = store.get();
    store.reorder(['c'], 'bring-to-front');
    expect(store.get()).toBe(steps);
  });

  it('sets the intervals drawings show on from the chart’s, as one step', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a'), line('b')]);
    store.setIntervals(['a', 'b'], 'current-only', FOUR_HOURS);
    expect(store.get().drawings.map((d) => d.visibility.hours)).toEqual([
      { on: true, from: 4, to: 4 },
      { on: true, from: 4, to: 4 },
    ]);
    expect(store.get().drawings[0]?.visibility.minutes.on).toBe(false);
    const after = store.get();
    store.setIntervals(['a', 'b'], 'current-only', FOUR_HOURS);
    expect(store.get()).toBe(after);
    store.undo();
    expect(store.get().drawings[0]?.visibility.minutes.on).toBe(true);
  });

  it('removes those not locked, and none while Lock all is on', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a'), { ...line('b'), locked: true }, line('c')]);
    store.removeUnlocked(['a', 'b']);
    expect(ids(store)).toEqual(['b', 'c']);
    store.setPrefs({ lockAll: true });
    store.removeUnlocked(['c']);
    expect(ids(store)).toEqual(['b', 'c']);
  });

  it('clones drawings where they are, over every other, unlocked, with ids of their own', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a'), { ...line('b'), locked: true, below: true }, line('c')]);
    const copies = store.clone(['b', 'a']);
    expect(copies).toHaveLength(2);
    expect(ids(store)).toEqual(['a', 'b', 'c', ...copies]);
    const [copyA, copyB] = store.get().drawings.slice(3);
    expect(copyA).toEqual({ ...line('a'), id: copies[0] });
    expect(copyB).toEqual({ ...line('b'), id: copies[1], locked: false, below: true });
    store.undo();
    expect(ids(store)).toEqual(['a', 'b', 'c']);
  });

  it('copies drawings in this browser and pastes them on another symbol, at their times and prices', async () => {
    const gateway = new FakeGateway();
    const store = storeOf(gateway);
    await ready(store);
    store.edit([line('a'), line('b')]);
    expect(store.copy(['b'])).toBe(true);
    expect(stored.has(DRAWINGS_CLIPBOARD_KEY)).toBe(true);
    await ready(store, 'BINANCE:ETHUSDT');
    const pasted = store.paste();
    expect(pasted).toHaveLength(1);
    expect(store.get().drawings).toEqual([{ ...line('b'), id: pasted[0] }]);
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:ETHUSDT')?.map((d) => d.id)).toEqual(pasted);
    // And again: each paste its own drawings.
    const again = store.paste();
    expect(again[0]).not.toBe(pasted[0]);
    expect(store.get().drawings).toHaveLength(2);
  });

  it('pastes a drawing from an indicator’s pane only while that indicator is on the chart', async () => {
    const store = storeOf(new FakeGateway(), () => new Set(['rsi-1']));
    await ready(store);
    store.edit([line('a'), line('r', 'rsi-1')]);
    store.copy(['a', 'r']);
    store.edit([line('m', 'macd-1')]);
    store.copy(['m']);
    expect(store.paste()).toEqual([]);
    store.copy(['m']);
    stored.set(
      DRAWINGS_CLIPBOARD_KEY,
      JSON.stringify({
        version: 1,
        drawings: [line('a'), line('r', 'rsi-1'), line('m', 'macd-1')],
      }),
    );
    const pasted = store.paste();
    expect(
      store
        .get()
        .drawings.filter((d) => pasted.includes(d.id))
        .map((d) => d.pane),
    ).toEqual([null, 'rsi-1']);
  });

  it('pastes from this page when this browser can’t keep the copy, and nothing when none was made', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    store.edit([line('a')]);
    expect(store.paste()).toEqual([]);
    stored.set(DRAWINGS_CLIPBOARD_KEY, 'not json');
    expect(store.paste()).toEqual([]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage is off');
        },
        removeItem: () => {},
      },
    });
    expect(store.copy(['a'])).toBe(true);
    expect(store.paste()).toHaveLength(1);
  });

  it('keeps a clone or a paste within a symbol’s limit', async () => {
    const store = storeOf(new FakeGateway());
    await ready(store);
    const many = Array.from({ length: MAX_DRAWINGS_PER_SYMBOL - 1 }, (_, i) => line(`d${i}`));
    store.edit(many);
    expect(store.clone(['d0', 'd1'])).toHaveLength(1);
    expect(store.clone(['d0'])).toEqual([]);
    expect(store.get().drawings).toHaveLength(MAX_DRAWINGS_PER_SYMBOL);
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

describe('templates, last styles and favorites (D3b)', () => {
  /** A ready store with a tool's last styles, on three drawings: two trend lines and a ray. */
  async function styled() {
    const gateway = new FakeGateway();
    const styles = new ToolStyles();
    const store = new DrawingStore(gateway, () => new Set(), new FakeLater().later, styles);
    await ready(store);
    const a = line('a');
    a.style.text.value = 'Breakout';
    const ray = newDrawing('r', 'ray', [
      { time: 1_700_000_000, price: 1 },
      { time: 1_700_003_600, price: 2 },
    ]);
    store.edit([a, line('b'), ray]);
    return { store, styles };
  }
  const red = () => ({ ...defaultDrawingStyle('trend-line'), color: '#F23645', width: 4 });

  it('applies a template to the drawings of its tool as one step, each keeping its text', async () => {
    const { store, styles } = await styled();
    const before = store.get().drawings;
    store.applyStyle(['a', 'b', 'r'], 'trend-line', red());
    const [a, b, r] = store.get().drawings;
    expect([a?.style.color, b?.style.color, r?.style.color]).toEqual([
      '#F23645',
      '#F23645',
      '#2962FF',
    ]);
    expect([a?.style.text.value, b?.style.text.value]).toEqual(['Breakout', '']);
    // The tool's next drawing starts in it.
    expect(styles.styleOf('trend-line')).toEqual(red());
    expect(styles.styleOf('ray')).toBeUndefined();
    store.undo();
    expect(store.get().drawings).toBe(before);
  });

  it('gives the tool its defaults back with Apply default, even on a drawing already in them', async () => {
    const { store, styles } = await styled();
    styles.set('trend-line', red());
    const before = store.get().drawings;
    store.applyStyle(['b'], 'trend-line', defaultDrawingStyle('trend-line'));
    // Nothing to change on the drawing: no undo step, but the next one starts from the defaults.
    expect(store.get().drawings).toBe(before);
    expect(store.get().canUndo).toBe(true);
    store.undo();
    expect(store.get().canUndo).toBe(false);
    expect(styles.styleOf('trend-line')).toEqual(defaultDrawingStyle('trend-line'));
  });

  it('remembers the style the floating toolbar gives, but not a lock or a move', async () => {
    const { store, styles } = await styled();
    store.updateMany(['a'], (drawing) => ({ ...drawing, locked: true }));
    store.edit(
      store
        .get()
        .drawings.map((drawing) =>
          drawing.id === 'b'
            ? { ...drawing, points: drawing.points.map((p) => ({ ...p, price: p.price + 1 })) }
            : drawing,
        ),
    );
    expect(styles.styleOf('trend-line')).toBeUndefined();
    store.updateMany(['b'], (drawing) => recolorDrawing(drawing, '#089981'));
    expect(styles.styleOf('trend-line')?.color).toBe('#089981');
  });

  it('remembers the style a settings dialog keeps on Ok, and not one put back on Cancel', async () => {
    const { store, styles } = await styled();
    const before = store.get().drawings;
    const b = before[1] as Drawing;
    store.preview({ ...b, style: { ...b.style, width: 3 } });
    store.finishPreview(before, false);
    expect(styles.styleOf('trend-line')).toBeUndefined();
    store.preview({ ...b, style: { ...b.style, width: 3 } });
    store.finishPreview(before, true);
    expect(styles.styleOf('trend-line')?.width).toBe(3);
  });

  it('stars tools in the order starred, kept in this browser', () => {
    const store = new DrawingStore(new FakeGateway());
    store.toggleFavorite('ray');
    store.toggleFavorite('pitchfork');
    store.toggleFavorite('trend-line');
    store.toggleFavorite('pitchfork');
    expect(store.get().prefs.favorites).toEqual(['ray', 'trend-line']);
    expect(new DrawingStore(new FakeGateway()).get().prefs.favorites).toEqual([
      'ray',
      'trend-line',
    ]);
    // What isn't a tool, and a tool twice, aren't kept.
    expect(
      sanitizeToolbar({ favorites: ['ray', 'brush', 'ray', 7, 'pitchfork'] }).favorites,
    ).toEqual(['ray', 'pitchfork']);
    expect(sanitizeToolbar({ favorites: 'ray' }).favorites).toEqual([]);
  });
});

describe('the Object tree (D3c)', () => {
  async function three() {
    const gateway = new FakeGateway();
    const later = new FakeLater();
    const store = storeOf(gateway, () => new Set(['rsi-1']), later);
    await ready(store);
    store.edit([line('a'), line('b'), line('r', 'rsi-1')]);
    return { store, gateway, later };
  }
  const order = (store: DrawingStore) =>
    store.get().drawings.map((d) => `${d.id}${d.below ? '↓' : ''}${d.hidden ? '·' : ''}`);

  it('hides and shows drawings, each as one undo step', async () => {
    const { store } = await three();
    store.setHidden(['a', 'b'], true);
    expect(order(store)).toEqual(['a·', 'b·', 'r']);
    store.setHidden(['a'], false);
    expect(order(store)).toEqual(['a', 'b·', 'r']);
    store.undo();
    expect(order(store)).toEqual(['a·', 'b·', 'r']);
  });

  it('renames a drawing, trimmed, as one undo step, and makes none for the same name', async () => {
    const { store } = await three();
    store.rename('a', '  Weekly   low ');
    expect(store.get().drawings[0]?.name).toBe('Weekly low');
    const before = store.get().drawings;
    store.rename('a', 'Weekly low');
    expect(store.get().drawings).toBe(before);
    store.undo();
    expect(store.get().drawings[0]?.name).toBe('');
  });

  it('moves drawings dragged in the tree, under the bars too, as one undo step', async () => {
    const { store } = await three();
    store.place(['b'], { pane: null, below: false, before: 'a' });
    expect(order(store)).toEqual(['b', 'a', 'r']);
    store.place(['a'], { pane: null, below: true, before: null });
    expect(order(store)).toEqual(['b', 'r', 'a↓']);
    store.undo();
    expect(order(store)).toEqual(['b', 'a', 'r']);
  });

  it('removes all but locked drawings, every one with the switch, none with Lock all', async () => {
    const { store } = await three();
    store.updateMany(['a'], (d) => ({ ...d, locked: true }));
    expect(store.removable().map((d) => d.id)).toEqual(['b', 'r']);
    store.setPrefs({ lockAll: true });
    expect(store.removable()).toEqual([]);
    store.setPrefs({ removeLocked: true });
    expect(store.removable().map((d) => d.id)).toEqual(['a', 'b', 'r']);
    store.setPrefs({ removeLocked: false, lockAll: false });
    store.removeAll();
    expect(order(store)).toEqual(['a']);
  });

  it('drops a removed indicator’s drawings from every symbol at the gateway, again after a failure', async () => {
    const { store, gateway, later } = await three();
    gateway.failDrops = true;
    store.dropPanes(['rsi-1']);
    expect(order(store)).toEqual(['a', 'b']);
    await settle();
    expect(gateway.dropped).toEqual([]);
    expect(later.waiting).toContain(DRAWINGS_RETRY_MS);
    gateway.failDrops = false;
    later.run();
    await settle();
    expect(gateway.dropped).toEqual([['rsi-1']]);
  });

  it('sends a pane dropped again while its drop is on its way once more', async () => {
    const { store, gateway } = await three();
    let open: () => void = () => {};
    gateway.dropGate = new Promise((resolve) => {
      open = resolve;
    });
    store.dropPanes(['rsi-1']);
    await settle();
    // The indicator came back and went again meanwhile: what was saved on it since goes too.
    store.dropPanes(['rsi-1']);
    gateway.dropGate = null;
    open();
    await settle();
    expect(gateway.dropped).toEqual([['rsi-1'], ['rsi-1']]);
  });

  it('takes a removed indicator’s drawings out of another symbol’s list not yet saved', async () => {
    const gateway = new FakeGateway();
    const later = new FakeLater();
    const store = storeOf(gateway, () => new Set(['rsi-1']), later);
    await ready(store, 'A:B');
    gateway.failSaves = true;
    store.edit([line('a'), line('r', 'rsi-1')]);
    await store.whenSaved();
    await ready(store, 'C:D');
    store.dropPanes(['rsi-1']);
    gateway.failSaves = false;
    later.run();
    await store.whenSaved();
    expect(gateway.held.get('A:B')?.map((d) => d.id)).toEqual(['a']);
  });
});

describe('groups of drawings (D3c2)', () => {
  async function four() {
    const gateway = new FakeGateway();
    const store = storeOf(gateway, () => new Set(['rsi-1']));
    await ready(store);
    store.edit([line('a'), line('x'), line('b'), line('c')]);
    return { store, gateway };
  }
  const shape = (store: DrawingStore) =>
    store
      .get()
      .drawings.map((d) =>
        d.groups.length ? `${d.id}(${d.groups.map((g) => g.name).join('/')})` : d.id,
      );
  const drawing = (...ids: string[]) => ids.map((id) => ({ kind: 'drawing' as const, id }));

  it('makes a group named "Group N" where the frontmost drawing is, as one undo step', async () => {
    const { store, gateway } = await four();
    const id = store.group(drawing('a', 'b'));
    expect(id).toMatch(/^g/);
    expect(shape(store)).toEqual(['x', 'a(Group 1)', 'b(Group 1)', 'c']);
    store.group(drawing('c'));
    expect(shape(store)).toEqual(['x', 'a(Group 1)', 'b(Group 1)', 'c(Group 2)']);
    await store.whenSaved();
    expect(gateway.held.get('BINANCE:XRPUSDT')?.[3]?.groups).toEqual([
      { id: expect.stringMatching(/^g/), name: 'Group 2' },
    ]);
    store.undo();
    store.undo();
    expect(shape(store)).toEqual(['a', 'x', 'b', 'c']);
  });

  it('refuses drawings of two panes', async () => {
    const { store } = await four();
    store.edit([...store.get().drawings, line('r', 'rsi-1')]);
    const before = store.get().drawings;
    expect(store.group(drawing('a', 'r'))).toBeNull();
    expect(store.get().drawings).toBe(before);
  });

  it('renames, hides, shows, locks and removes a group as one step each', async () => {
    const { store } = await four();
    const id = store.group(drawing('a', 'b')) ?? '';
    store.renameGroup(id, '  Levels ');
    expect(shape(store)).toEqual(['x', 'a(Levels)', 'b(Levels)', 'c']);
    store.setGroupHidden(id, true);
    expect(
      store
        .get()
        .drawings.filter((d) => d.hidden)
        .map((d) => d.id),
    ).toEqual(['a', 'b']);
    store.setGroupLocked(id, true);
    expect(
      store
        .get()
        .drawings.filter((d) => d.locked)
        .map((d) => d.id),
    ).toEqual(['a', 'b']);
    // Remove leaves the locked ones, as Remove does, unless the switch says otherwise.
    store.removeItems([{ kind: 'group', id }]);
    expect(store.get().drawings.map((d) => d.id)).toEqual(['x', 'a', 'b', 'c']);
    store.setGroupLocked(id, false);
    store.removeItems([{ kind: 'group', id }]);
    expect(shape(store)).toEqual(['x', 'c']);
    store.undo();
    expect(shape(store)).toEqual(['x', 'a(Levels)', 'b(Levels)', 'c']);
  });

  it('keeps groups picked in the tree while the chart’s selection is theirs', async () => {
    const { store } = await four();
    const id = store.group(drawing('a', 'b')) ?? '';
    store.pick([id], ['a', 'b']);
    store.setSelection(['b', 'a']);
    expect(store.get().picked).toEqual([id]);
    expect(store.pickedItems()).toEqual([{ kind: 'group', id }]);
    store.setSelection(['a']);
    expect(store.get().picked).toEqual([]);
    expect(store.pickedItems()).toEqual(drawing('a'));
  });

  it('puts a drawing made with the tool in the group picked when the tool was taken', async () => {
    const { store } = await four();
    const id = store.group(drawing('a', 'b')) ?? '';
    store.pick([id], ['a', 'b']);
    store.setSelection(['a', 'b']);
    store.setTool('trend-line');
    // The chart lets go of the selection as the drawing starts, and adds it at the end.
    store.setSelection([]);
    store.edit([...store.get().drawings, line('n')]);
    expect(shape(store)).toEqual(['x', 'a(Group 1)', 'b(Group 1)', 'n(Group 1)', 'c']);
    store.toolDone();
    store.setTool('trend-line');
    store.edit([...store.get().drawings, line('m')]);
    expect(shape(store).at(-1)).toBe('m');
  });

  it('clones a drawing of a group to that group’s front, and pastes into the group picked', async () => {
    const { store } = await four();
    store.group(drawing('a', 'b'));
    const [copy] = store.clone(['a']);
    expect(shape(store)).toEqual(['x', 'a(Group 1)', 'b(Group 1)', `${copy}(Group 1)`, 'c']);
    // A copy pasted with c selected joins no group, wherever it was copied from.
    store.copy(['b']);
    store.setSelection(['c']);
    const [pasted] = store.paste();
    expect(shape(store).at(-1)).toBe(pasted);
    // With a drawing of the group selected, it joins the group.
    store.setSelection(['a']);
    const [joined] = store.paste();
    expect(shape(store)).toContain(`${joined}(Group 1)`);
  });

  it('moves items dragged into a group, and a group as one in the visual order', async () => {
    const { store } = await four();
    const id = store.group(drawing('a', 'b')) ?? '';
    store.moveItems(drawing('c'), { pane: null, below: false, parent: id, before: null });
    expect(shape(store)).toEqual(['x', 'a(Group 1)', 'b(Group 1)', 'c(Group 1)']);
    store.reorderItems([{ kind: 'group', id }], 'send-to-back');
    expect(store.get().drawings.map((d) => `${d.id}${d.below ? '↓' : ''}`)).toEqual([
      'a↓',
      'b↓',
      'c↓',
      'x',
    ]);
    store.undo();
    store.undo();
    expect(shape(store)).toEqual(['x', 'a(Group 1)', 'b(Group 1)', 'c']);
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
