/**
 * The built chat widget (P5-56): `GET /chat-widget/chat.js` and `/chat-widget/chat.css` from
 * `config.chatWidgetDist` (CHAT_WIDGET_DIST, default packages/chat-widget/dist), outside `/rest` (no session,
 * no CSRF), fixed URLs with a one hour cache and an ETag, and `cross-origin-resource-policy: cross-origin`
 * so the sandboxed hosted page (opaque origin) and embeds on other sites can load them. `/chat-widget` is
 * RESERVED in system.ts, so the SPA fallback never answers it.
 *
 * C0 STUB: lane L2 writes the route. Until then every `/chat-widget/*` request answers 404.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { errorBody } from '../http/errors';

export async function registerChatWidgetRoutes(app: FastifyInstance, _ctx: ServerContext): Promise<void> {
  app.get('/chat-widget/*', async (_request, reply) =>
    reply.status(404).send(errorBody('not_found', 'The chat widget is not available: not implemented (L2)')),
  );
}
