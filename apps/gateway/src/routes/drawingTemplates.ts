import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { DrawingTemplatesStore } from '../storage/DrawingTemplatesStore.ts';

/**
 * The user's drawing templates (docs/SPEC.md §5.27, D3b): every tool's served at once, a tool's
 * saved at a time. A tool's most (200 pitchfork templates with the longest names: 333 kB,
 * measured 2026-11-26) fit Fastify's 1 MiB.
 */
export function registerDrawingTemplateRoutes(
  app: FastifyInstance,
  store: DrawingTemplatesStore,
): void {
  app.get(`${API_PREFIX}/drawing-templates`, () => store.get());
  app.put(`${API_PREFIX}/drawing-templates`, (request) => store.put(request.body));
}
