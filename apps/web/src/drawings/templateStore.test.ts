import {
  type DrawingStyle,
  type DrawingTemplates,
  defaultDrawingStyle,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATES_PER_TOOL,
  type ToolTemplates,
} from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { TEMPLATES_RETRY_MS, TemplateStore } from './templateStore';

const styleOf = (color: string): DrawingStyle => ({
  ...defaultDrawingStyle('trend-line'),
  color,
});

/** A gateway in memory: what it holds, each save, and loads or saves that fail when told. */
class FakeGateway {
  held: DrawingTemplates = { tools: {} };
  saves: ToolTemplates[] = [];
  loads = 0;
  failLoads = false;
  failSaves = false;

  load = async (): Promise<DrawingTemplates> => {
    this.loads++;
    if (this.failLoads) throw new Error('The local gateway is not reachable');
    return this.held;
  };

  save = async (value: ToolTemplates): Promise<ToolTemplates> => {
    if (this.failSaves) throw new Error('The local gateway is not reachable');
    this.saves.push(value);
    this.held = { tools: { ...this.held.tools, [value.tool]: value.templates } };
    return value;
  };
}

/** The store's retries, run when a test says. */
class FakeLater {
  waiting: { run: () => void; ms: number }[] = [];
  later = (run: () => void, ms: number) => {
    const task = { run, ms };
    this.waiting.push(task);
    return () => {
      this.waiting = this.waiting.filter((item) => item !== task);
    };
  };
  run(): void {
    for (const task of this.waiting.splice(0)) task.run();
  }
}

async function readyStore(gateway = new FakeGateway(), later = new FakeLater()) {
  const store = new TemplateStore(gateway, later.later);
  await store.load();
  expect(store.get().status).toBe('ready');
  return { store, gateway, later };
}

describe('drawing templates in the app (D3b)', () => {
  it('load once, and list a tool’s by name', async () => {
    const gateway = new FakeGateway();
    gateway.held = {
      tools: {
        'trend-line': [
          { name: 'red', style: styleOf('#F23645') },
          { name: 'Blue', style: styleOf('#2962FF') },
        ],
      },
    };
    const { store } = await readyStore(gateway);
    await store.load();
    expect(gateway.loads).toBe(1);
    expect(store.templatesOf('trend-line').map((item) => item.name)).toEqual(['Blue', 'red']);
    expect(store.templatesOf('ray')).toEqual([]);
  });

  it('save a style under a name, its text left out, and the tool’s whole list with it', async () => {
    const { store, gateway } = await readyStore();
    const style = styleOf('#F23645');
    style.text.value = 'not kept';
    expect(store.save('trend-line', '  Red   line ', style)).toBe(true);
    await store.whenSaved();
    const kept = { ...styleOf('#F23645'), text: { ...style.text, value: '' } };
    expect(gateway.saves).toEqual([
      { tool: 'trend-line', templates: [{ name: 'Red line', style: kept }] },
    ]);
    expect(store.find('trend-line', 'Red line')?.style).toEqual(kept);
  });

  it('replace a template of the same name in its place, and remove one', async () => {
    const { store, gateway } = await readyStore();
    store.save('trend-line', 'A', styleOf('#F23645'));
    store.save('trend-line', 'B', styleOf('#089981'));
    store.save('trend-line', 'A', styleOf('#000000'));
    await store.whenSaved();
    const names = (value: ToolTemplates | undefined) => value?.templates.map((item) => item.name);
    expect(names(gateway.saves.at(-1))).toEqual(['A', 'B']);
    expect(store.find('trend-line', 'A')?.style.color).toBe('#000000');
    store.remove('trend-line', 'A');
    await store.whenSaved();
    expect(names(gateway.saves.at(-1))).toEqual(['B']);
    // The last one gone, the tool has none.
    store.remove('trend-line', 'B');
    await store.whenSaved();
    expect(gateway.saves.at(-1)).toEqual({ tool: 'trend-line', templates: [] });
    expect(store.get().tools).toEqual({});
  });

  it('save one at a time, the latest list of each tool', async () => {
    const { store, gateway } = await readyStore();
    store.save('trend-line', 'A', styleOf('#F23645'));
    store.save('trend-line', 'B', styleOf('#F23645'));
    store.save('ray', 'C', styleOf('#F23645'));
    await store.whenSaved();
    expect(gateway.saves.map((save) => [save.tool, save.templates.length])).toEqual([
      ['trend-line', 1],
      ['trend-line', 2],
      ['ray', 1],
    ]);
    expect(Object.keys(gateway.held.tools).sort()).toEqual(['ray', 'trend-line']);
  });

  it('save nothing until the stored templates are in, a failed load tried again every 3 s', async () => {
    const gateway = new FakeGateway();
    gateway.failLoads = true;
    gateway.held = { tools: { ray: [{ name: 'Kept', style: styleOf('#F23645') }] } };
    const later = new FakeLater();
    const store = new TemplateStore(gateway, later.later);
    expect(store.save('ray', 'New', styleOf('#000000'))).toBe(false);
    await store.load();
    expect(store.get().status).toBe('failed');
    expect(store.get().loadError).toContain('not reachable');
    expect(store.save('ray', 'New', styleOf('#000000'))).toBe(false);
    expect(gateway.saves).toEqual([]);
    expect(later.waiting.map((task) => task.ms)).toEqual([TEMPLATES_RETRY_MS]);
    gateway.failLoads = false;
    later.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get().status).toBe('ready');
    // Saved on top of the stored one, never over it.
    expect(store.save('ray', 'New', styleOf('#000000'))).toBe(true);
    await store.whenSaved();
    expect(gateway.saves.at(-1)?.templates.map((item) => item.name)).toEqual(['Kept', 'New']);
  });

  it('try a failed save again every 3 s, saying so, the newest list taking its place', async () => {
    const { store, gateway, later } = await readyStore();
    gateway.failSaves = true;
    store.save('trend-line', 'A', styleOf('#F23645'));
    await store.whenSaved();
    expect(store.get().saveError).toContain('not reachable');
    expect(later.waiting.map((task) => task.ms)).toEqual([TEMPLATES_RETRY_MS]);
    store.save('trend-line', 'B', styleOf('#F23645'));
    await store.whenSaved();
    gateway.failSaves = false;
    later.run();
    await store.whenSaved();
    expect(gateway.saves.map((save) => save.templates.map((item) => item.name))).toEqual([
      ['A', 'B'],
    ]);
    expect(store.get().saveError).toBeNull();
  });

  it('take no empty or overlong name, and no new one past a tool’s limit, but a replacement', async () => {
    const { store } = await readyStore();
    const style = styleOf('#F23645');
    expect(store.canSave('ray', '   ')).toBe(false);
    expect(store.canSave('ray', 'x'.repeat(MAX_TEMPLATE_NAME + 1))).toBe(false);
    for (let i = 0; i < MAX_TEMPLATES_PER_TOOL; i++) store.save('ray', `T${i}`, style);
    await store.whenSaved();
    expect(store.save('ray', 'One more', style)).toBe(false);
    expect(store.save('ray', 'T7', styleOf('#000000'))).toBe(true);
    expect(store.templatesOf('ray')).toHaveLength(MAX_TEMPLATES_PER_TOOL);
  });
});
