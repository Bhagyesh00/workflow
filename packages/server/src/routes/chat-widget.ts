/**
 * The built chat widget (P5-56): `GET /chat-widget/chat.js` and `/chat-widget/chat.css` from
 * `config.chatWidgetDist` (CHAT_WIDGET_DIST, default packages/chat-widget/dist), outside `/rest` (no session,
 * no CSRF), fixed URLs with a one hour cache and an ETag, and `cross-origin-resource-policy: cross-origin`
 * so the sandboxed hosted page (opaque origin) and embeds on other sites can load them. `/chat-widget` is
 * RESERVED in system.ts, so the SPA fallback never answers it.
 *
 * Each file is read once and kept in memory. A file that is missing (the widget is not built) is looked
 * for again on the next request, so building after the server started needs no restart.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { errorBody } from '../http/errors';

const FILES: Record<string, string> = {
  'chat.js': 'application/javascript; charset=utf-8',
  'chat.css': 'text/css; charset=utf-8',
};

interface WidgetFile {
  body: Buffer;
  etag: string;
  contentType: string;
}

const notFound = () => errorBody('not_found', 'The chat widget is not available');

export async function registerChatWidgetRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const cache = new Map<string, WidgetFile>();

  const load = async (name: string): Promise<WidgetFile | undefined> => {
    const cached = cache.get(name);
    if (cached) return cached;
    const contentType = FILES[name];
    if (!contentType) return undefined;
    let body: Buffer;
    try {
      body = await readFile(path.join(ctx.config.chatWidgetDist, name));
    } catch {
      return undefined;
    }
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    const file = { body, etag, contentType };
    cache.set(name, file);
    return file;
  };

  app.get('/chat-widget/*', async (request, reply) => {
    const name = (request.params as { '*'?: string })['*'] ?? '';
    const file = Object.hasOwn(FILES, name) ? await load(name) : undefined;
    if (!file) return reply.status(404).send(notFound());
    reply
      .header('cache-control', 'public, max-age=3600')
      .header('etag', file.etag)
      .header('access-control-allow-origin', '*')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('x-content-type-options', 'nosniff');
    const match = request.headers['if-none-match'];
    if (typeof match === 'string' && match.split(',').some((tag) => tag.trim() === file.etag)) {
      return reply.status(304).send();
    }
    return reply.header('content-type', file.contentType).send(file.body);
  });
}
