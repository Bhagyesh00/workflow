/**
 * GET /rest/push: Server-Sent Events for the editor. A connection only ever receives events of
 * the tenant of its session; a `ping` keeps proxies from closing idle streams. Each ping tick also
 * re-checks the session and the membership, and ends the stream once either is gone.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { type AuthContext, requireAuth } from '../http/auth';

export const PING_INTERVAL_MS = 25_000;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export function registerPushRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** logout, an expired session, a switched workspace or a removed member revoke the stream */
  const stillAuthorized = async (auth: AuthContext): Promise<boolean> => {
    if (auth.sessionId) {
      const session = await ctx.repos.sessions.get(auth.sessionId);
      if (session?.tenantId !== auth.tenant.id) return false;
    }
    return Boolean(await ctx.repos.memberships.get(auth.tenant.id, auth.user.id));
  };
  const open = new Set<() => void>();
  // streams never end on their own: close them so shutdown does not wait for editors to leave
  app.addHook('preClose', async () => {
    for (const end of [...open]) end();
  });

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
      void stillAuthorized(auth)
        .then((ok) => {
          if (!ok) end();
          else if (!res.writableEnded) res.write(frame('ping', { time: Date.now() }));
        })
        // a failed lookup keeps the stream: the next tick checks again
        .catch(() => {});
    }, PING_INTERVAL_MS);
    ping.unref();

    const close = () => {
      clearInterval(ping);
      unsubscribe();
      open.delete(end);
    };
    const end = () => {
      close();
      if (!res.writableEnded) res.end();
    };
    open.add(end);
    request.raw.on('close', close);
    res.on('close', close);
  });
}
