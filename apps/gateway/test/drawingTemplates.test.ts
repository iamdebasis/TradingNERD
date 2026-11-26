import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DrawingStyle,
  type DrawingTemplate,
  defaultDrawingStyle,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATES_PER_TOOL,
  parseToolTemplates,
} from '@tradingnerd/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketError } from '../src/market/types.ts';
import { registerDrawingTemplateRoutes } from '../src/routes/drawingTemplates.ts';
import { DrawingTemplatesStore } from '../src/storage/DrawingTemplatesStore.ts';
import { JsonFile } from '../src/storage/jsonFile.ts';

/**
 * The user's drawing templates, kept by the gateway per tool in data/drawing-templates.json
 * (docs/SPEC.md §5.27, D3b).
 */

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'tradingnerd-templates-')), 'data');

/** A trend line style in a color, at a width. */
const styleOf = (color: string, width = 2): DrawingStyle => ({
  ...defaultDrawingStyle('trend-line'),
  color,
  width,
});

const template = (name: string, color = '#F23645'): DrawingTemplate => ({
  name,
  style: styleOf(color),
});

const fileOf = (dataDir: string) =>
  JSON.parse(readFileSync(join(dataDir, 'drawing-templates.json'), 'utf8')) as {
    version: number;
    tools: Record<string, DrawingTemplate[]>;
  };

describe('drawing templates, kept in data/drawing-templates.json', () => {
  it('serves none before any file exists', async () => {
    expect(await new DrawingTemplatesStore(freshDir()).get()).toEqual({ tools: {} });
  });

  it('keeps a tool’s templates as given, without their text, and serves them back', async () => {
    const dataDir = freshDir();
    const store = new DrawingTemplatesStore(dataDir);
    const red = template('  Red  ');
    red.style.text.value = 'not kept';
    const saved = await store.put({ tool: 'trend-line', templates: [red, template('Blue')] });
    expect(saved).toEqual({ tool: 'trend-line', templates: [template('Red'), template('Blue')] });
    expect(fileOf(dataDir)).toEqual({
      version: 1,
      tools: { 'trend-line': [template('Red'), template('Blue')] },
    });
    // A fresh gateway reads the file.
    expect(await new DrawingTemplatesStore(dataDir).get()).toEqual({
      tools: { 'trend-line': [template('Red'), template('Blue')] },
    });
  });

  it('drops a tool from the file when its last template goes', async () => {
    const dataDir = freshDir();
    const store = new DrawingTemplatesStore(dataDir);
    await store.put({ tool: 'trend-line', templates: [template('Red')] });
    await store.put({ tool: 'ray', templates: [template('Blue')] });
    await store.put({ tool: 'trend-line', templates: [] });
    expect(Object.keys(fileOf(dataDir).tools)).toEqual(['ray']);
  });

  it('keeps every tool saved at the same moment', async () => {
    const dataDir = freshDir();
    const store = new DrawingTemplatesStore(dataDir);
    await Promise.all([
      store.put({ tool: 'trend-line', templates: [template('A')] }),
      store.put({ tool: 'ray', templates: [template('B')] }),
      store.put({ tool: 'pitchfork', templates: [template('C')] }),
    ]);
    expect(Object.keys(fileOf(dataDir).tools).sort()).toEqual(['pitchfork', 'ray', 'trend-line']);
  });

  it('refuses templates that aren’t valid, and leaves the file as it was', async () => {
    const dataDir = freshDir();
    const store = new DrawingTemplatesStore(dataDir);
    await store.put({ tool: 'trend-line', templates: [template('Red')] });
    const bad = [
      { tool: 'brush', templates: [template('Red')] },
      { tool: 'trend-line', templates: [template('Red'), template(' Red ')] },
      { tool: 'trend-line', templates: [{ name: '', style: styleOf('#000000') }] },
      { tool: 'trend-line' },
    ];
    for (const value of bad) {
      await expect(store.put(value)).rejects.toBeInstanceOf(MarketError);
    }
    expect(fileOf(dataDir).tools).toEqual({ 'trend-line': [template('Red')] });
  });

  it('serves the templates as stored when a save can’t be written', async () => {
    const dataDir = freshDir();
    const store = new DrawingTemplatesStore(dataDir);
    await store.put({ tool: 'trend-line', templates: [template('Red')] });
    const write = vi
      .spyOn(JsonFile.prototype, 'write')
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    try {
      await expect(
        store.put({ tool: 'trend-line', templates: [template('Red'), template('Blue')] }),
      ).rejects.toThrow('ENOSPC');
    } finally {
      write.mockRestore();
    }
    expect(await store.get()).toEqual({ tools: { 'trend-line': [template('Red')] } });
    // The next save builds on what's stored, not on the save that failed.
    await store.put({ tool: 'ray', templates: [template('Blue')] });
    expect(fileOf(dataDir).tools).toEqual({
      'trend-line': [template('Red')],
      ray: [template('Blue')],
    });
  });

  it('moves an unreadable file aside, says so, and starts with none', async () => {
    const dataDir = freshDir();
    await new DrawingTemplatesStore(dataDir).put({ tool: 'ray', templates: [template('Red')] });
    writeFileSync(join(dataDir, 'drawing-templates.json'), '{ broken');
    const warnings: string[] = [];
    const store = new DrawingTemplatesStore(dataDir, (message) => warnings.push(message));
    expect(await store.get()).toEqual({ tools: {} });
    expect(warnings).toHaveLength(1);
    expect(
      readdirSync(dataDir).some((name) => name.startsWith('drawing-templates.json.invalid-')),
    ).toBe(true);
  });
});

describe('the drawing templates routes', () => {
  let app: FastifyInstance;
  let dataDir: string;
  beforeEach(async () => {
    dataDir = freshDir();
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const code = error instanceof MarketError ? error.code : 'internal_error';
      reply.code(code === 'bad_request' ? 400 : 500).send({ error: code });
    });
    registerDrawingTemplateRoutes(app, new DrawingTemplatesStore(dataDir));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('saves a tool’s templates and serves every tool’s back', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/drawing-templates',
      payload: { tool: 'trend-line', templates: [template('Red')] },
    });
    expect(put.statusCode).toBe(200);
    expect(parseToolTemplates(put.json())).toEqual(put.json());
    const get = await app.inject({ method: 'GET', url: '/api/drawing-templates' });
    expect(get.json()).toEqual({ tools: { 'trend-line': [template('Red')] } });
  });

  it('answers 400 for templates that aren’t valid', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/drawing-templates',
      payload: { tool: 'trend-line', templates: [{ name: 'Red' }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('takes a tool’s most templates, the longest names, within the usual body limit', async () => {
    const templates = Array.from({ length: MAX_TEMPLATES_PER_TOOL }, (_, i) => ({
      name: `${i}`.padStart(MAX_TEMPLATE_NAME, 'x'),
      style: defaultDrawingStyle('pitchfork'),
    }));
    const payload = JSON.stringify({ tool: 'pitchfork', templates });
    // 333 kB (measured 2026-11-26), well under Fastify's 1 MiB.
    expect(payload.length).toBeLessThan(400 * 1024);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/drawing-templates',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(put.statusCode).toBe(200);
    expect(fileOf(dataDir).tools.pitchfork).toHaveLength(MAX_TEMPLATES_PER_TOOL);
  });
});
