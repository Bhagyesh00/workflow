/**
 * GET /rest/push: Server-Sent Events for the editor. A connection only ever receives events of
 * the tenant of its session; a `ping` keeps proxies from closing idle streams. Each ping tick also
 * re-checks the session and the membership, and ends the stream once either is gone.
 *
 * P6-25: every event is filtered per stream by the workflow on its envelope (`PushEvent.workflowId`): it is
 * written only when the user holds `execution:read` on that workflow. An event that names no workflow (a run
 * with no workflow) needs the global scope, so it reaches owner and admin only; `workflowReviewChanged` stays
 * for the whole workspace. The answers are cached per stream until the next ping tick, so a lost project, a
 * removed relation or a narrowed role takes effect within one ping. A failed lookup sends nothing.
 */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { type AuthContext, requireAuth } from '../http/auth';
import { ApiError } from '../http/errors';
import type { PushEvent } from '../services/bus';

export const PING_INTERVAL_MS = 25_000;

/** what a stream needs on an event's workflow: reading its runs */
const READ_SCOPE: Scope = 'execution:read';
/** events for the whole workspace on purpose (they name no workflow the user must read) */
const WORKSPACE_EVENTS: ReadonlySet<string> = new Set(['workflowReviewChanged']);
/** the cache key of the global check (workflow keys are uuids) */
const GLOBAL = 'global';

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

/** P6-25: one stream's access check, with a cache that `reset()` clears at each ping tick */
function createEventFilter(ctx: ServerContext, auth: AuthContext) {
  const tenantId = auth.tenant.id;
  const userId = auth.user.id;
  let cache = new Map<string, Promise<boolean>>();

  // the membership is read again (not `auth.role`): a narrowed role counts from the next tick on
  const globalRead = async (): Promise<boolean> => {
    const membership = await ctx.repos.memberships.get(tenantId, userId);
    if (!membership) return false;
    return (await ctx.access.globalScopes(tenantId, membership.role)).has(READ_SCOPE);
  };
  const workflowRead = async (workflowId: string): Promise<boolean> => {
    try {
      return (await ctx.access.scopesFor(tenantId, userId, { workflowId })).has(READ_SCOPE);
    } catch (error) {
      // a workflow that is gone (or never saved) is like a run with no workflow: owner and admin only
      if (error instanceof ApiError && error.statusCode === 404) return allowed(GLOBAL);
      throw error;
    }
  };
  const allowed = (key: string): Promise<boolean> => {
    let hit = cache.get(key);
    if (!hit) {
      // fail closed: a lookup that throws sends nothing
      hit = (key === GLOBAL ? globalRead() : workflowRead(key)).catch(() => false);
      cache.set(key, hit);
    }
    return hit;
  };

  return {
    allows(event: PushEvent): Promise<boolean> {
      if (WORKSPACE_EVENTS.has(event.type)) return Promise.resolve(true);
      return allowed(event.workflowId || GLOBAL);
    },
    reset(): void {
      cache = new Map();
    },
  };
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

    const filter = createEventFilter(ctx, auth);
    // one check after the other, so the stream keeps the order the events were sent in
    let delivery: Promise<void> = Promise.resolve();
    const unsubscribe = await ctx.push.subscribe(auth.tenant.id, (event) => {
      delivery = delivery
        .then(async () => {
          if (res.writableEnded || !(await filter.allows(event))) return;
          if (!res.writableEnded) res.write(frame(event.type, event.data));
        })
        .catch(() => {});
    });
    const ping = setInterval(() => {
      // the access cache ends here: the next event is checked again
      filter.reset();
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
