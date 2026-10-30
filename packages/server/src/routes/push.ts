/**
 * GET /rest/push: Server-Sent Events for the editor. A connection only ever receives events of
 * the tenant of its session; a `ping` keeps proxies from closing idle streams.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';

export const PING_INTERVAL_MS = 25_000;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export function registerPushRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/push', async (request, reply) => {
    const auth = requireAuth(request);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n${frame('connected', { tenantId: auth.tenant.id })}`);

    const unsubscribe = await ctx.push.subscribe(auth.tenant.id, (event) => {
      if (!res.writableEnded) res.write(frame(event.type, event.data));
    });
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(frame('ping', { time: Date.now() }));
    }, PING_INTERVAL_MS);
    ping.unref();

    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    request.raw.on('close', close);
    res.on('close', close);
  });
}
