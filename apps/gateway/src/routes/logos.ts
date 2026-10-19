import { API_PREFIX } from '@tradingnerd/core';
import type { FastifyInstance } from 'fastify';
import type { LogoService } from '../logos/LogoService.ts';

export function registerLogoRoutes(app: FastifyInstance, logos: LogoService): void {
  app.get(`${API_PREFIX}/logos/status`, () => logos.status());

  app.put(`${API_PREFIX}/logos/key`, (request) => {
    const key = (request.body as { key?: unknown } | null)?.key;
    return logos.saveKey(typeof key === 'string' ? key : '');
  });

  app.delete(`${API_PREFIX}/logos/key`, () => logos.removeKey());

  app.post(`${API_PREFIX}/logos/prompt-dismissed`, () => logos.dismissPrompt());

  // No logo is a 204, not a 404: an <img> falls back to its letter avatar either way, but the
  // browser logs no error for every coin without one.
  app.get(`${API_PREFIX}/logos/coin/:exchange/:base`, async (request, reply) => {
    const { exchange, base } = request.params as { exchange: string; base: string };
    const image = await logos.logo(exchange.toUpperCase(), base.toUpperCase());
    if (!image) return reply.code(204).send();
    return reply
      .header('content-type', image.contentType)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .send(image.bytes);
  });
}
