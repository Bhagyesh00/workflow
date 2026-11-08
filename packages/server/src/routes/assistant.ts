/**
 * /rest/assistant (P5-67, lane L1): threads, messages, status, chat, cancel and the SSE event stream.
 * Gates, rate limits and the chat body limit are final from C0. Every route is viewer (n8n's
 * `instanceAi:message` holds for every member). The gate: signed out 401, the Assistant off for this
 * workspace 404, then the role (403, `requireRole`). Threads are the caller's own: another user's or
 * another tenant's thread is 404. Nothing about a message or a body is logged.
 * `requireAssistant`, `assistantRouteOptions` and `ASSISTANT_CHAT_BODY_LIMIT` are shared with the
 * confirm and draft routes.
 *
 * Answers are `{ data }` as every `/rest` route; the thread list's `data` is the editor's
 * `AssistantThreadPage` (`{ data, nextCursor }`), since the editor reads it with `api.get`. The event
 * stream sends each event as JSON in a `data:` line, with `id:` for stored events and `event:` for its
 * type; a comment line keeps it alive every 15 s and re-checks access as routes/push.ts does.
 */
import type { AssistantEvent } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { type AuthContext, clientIp, requireAuth, requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { paginationQuery } from '../http/pagination';
import type { TenantSettings } from '../plans';
import { AI_ROUTE_RATE_LIMIT } from '../services/ai-builder/types';
import { effectiveAssistantSettings } from '../services/assistant/settings';
import type { EffectiveAssistantSettings } from '../services/assistant/types';

/** a chat body holds up to 10 files of 10 MB base64 and 16 MB in all, plus the message: 18 MB */
export const ASSISTANT_CHAT_BODY_LIMIT = 18 * 1024 * 1024;

/** reads are polled and reconnect (SSE): a wider window than writes */
export const ASSISTANT_READ_RATE_LIMIT = { max: 1000, timeWindow: 300_000 } as const;
/** sends, cancels, answers, accepts and settings changes: n8n's AI limit, 100 per 5 minutes per IP */
export const ASSISTANT_WRITE_RATE_LIMIT = AI_ROUTE_RATE_LIMIT;

/** route options of every `/rest/assistant/*` route: the rate limit per IP, by route name */
export function assistantRouteOptions(name: string, kind: 'read' | 'write') {
  const limit = kind === 'read' ? ASSISTANT_READ_RATE_LIMIT : ASSISTANT_WRITE_RATE_LIMIT;
  return {
    config: {
      rateLimit: {
        max: limit.max,
        timeWindow: limit.timeWindow,
        keyGenerator: (request: FastifyRequest) => `assistant:${name}:${request.ip}`,
      },
    },
  };
}

/**
 * The gate of the Assistant's thread, chat, confirm and draft routes: 401 signed out, 404 while the
 * Assistant is off for this workspace (`TenantSettings.assistant.enabled`, else `INSTANCE_AI_ENABLED`,
 * else on; `AI_ENABLED` plays no part), then `minimum` role (403). The settings come back for the handler.
 */
export function requireAssistant(
  request: FastifyRequest,
  ctx: ServerContext,
  minimum: Role,
): { auth: AuthContext; settings: EffectiveAssistantSettings } {
  const signedIn = requireAuth(request);
  const settings = effectiveAssistantSettings(ctx.config, signedIn.tenant.settings as TenantSettings);
  if (!settings.enabled) throw ApiError.notFound();
  const auth = requireRole(request, minimum);
  return { auth, settings };
}

/** the SSE keep-alive and authorization re-check interval */
export const ASSISTANT_PING_MS = 15_000;
/** the longest message text a chat takes */
export const ASSISTANT_MESSAGE_CHARS = 100_000;

const threadParams = z.object({ threadId: z.string().min(1).max(64) });
const createSchema = z.object({ title: z.string().max(200).optional() }).strict();
const renameSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();
const listSchema = z.object(paginationQuery);
const chatSchema = z
  .object({
    message: z.string().max(ASSISTANT_MESSAGE_CHARS),
    attachments: z
      .array(
        z
          .object({
            data: z.string(),
            mimeType: z.string().max(200),
            fileName: z.string().max(500),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict()
  .refine((body) => body.message.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'Write a message first',
  });
const cursorSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** the stream's cursor: `Last-Event-ID`, else `?lastEventId`, else the start */
function cursorOf(request: FastifyRequest): number {
  const header = request.headers['last-event-id'];
  const query = (request.query ?? {}) as Record<string, unknown>;
  const raw = (Array.isArray(header) ? header[0] : header) ?? query.lastEventId;
  if (raw === undefined || raw === '') return 0;
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) throw ApiError.badRequest('Invalid event id');
  return parsed.data;
}

/** one SSE frame: the event as JSON in `data:`, with its stored id when it has one */
function frame(event: AssistantEvent): string {
  const id = typeof event.id === 'number' ? `id: ${event.id}\n` : '';
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerAssistantRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  /** logout, an expired session, a switched workspace, a removed member or the Assistant turned off end a stream */
  const stillAuthorized = async (auth: AuthContext): Promise<boolean> => {
    if (auth.sessionId) {
      const session = await ctx.repos.sessions.get(auth.sessionId);
      if (session?.tenantId !== auth.tenant.id) return false;
    }
    if (!(await ctx.repos.memberships.get(auth.tenant.id, auth.user.id))) return false;
    const tenant = await ctx.repos.tenants.get(auth.tenant.id);
    if (!tenant) return false;
    return effectiveAssistantSettings(ctx.config, (tenant.settings ?? {}) as TenantSettings).enabled;
  };
  const open = new Set<() => void>();
  // streams never end on their own: close them so shutdown does not wait for clients to leave
  rest.addHook('preClose', async () => {
    for (const end of [...open]) end();
  });

  rest.post('/assistant/threads', assistantRouteOptions('threads-create', 'write'), async (request) => {
    const { auth } = requireAssistant(request, ctx, 'viewer');
    const body = parse(createSchema, request.body ?? {});
    return { data: await ctx.assistant.createThread(auth, body) };
  });

  rest.get('/assistant/threads', assistantRouteOptions('threads-list', 'read'), async (request) => {
    const { auth } = requireAssistant(request, ctx, 'viewer');
    const query = parse(listSchema, request.query ?? {});
    return { data: await ctx.assistant.listThreads(auth, query) };
  });

  rest.patch(
    '/assistant/threads/:threadId',
    assistantRouteOptions('threads-rename', 'write'),
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'viewer');
      const { threadId } = parse(threadParams, request.params);
      const body = parse(renameSchema, request.body ?? {});
      return { data: await ctx.assistant.renameThread(auth, threadId, body.title) };
    },
  );

  rest.delete(
    '/assistant/threads/:threadId',
    assistantRouteOptions('threads-delete', 'write'),
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'viewer');
      const { threadId } = parse(threadParams, request.params);
      await ctx.assistant.deleteThread(auth, threadId);
      return { data: { ok: true as const } };
    },
  );

  rest.get(
    '/assistant/threads/:threadId/messages',
    assistantRouteOptions('messages', 'read'),
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'viewer');
      const { threadId } = parse(threadParams, request.params);
      return { data: await ctx.assistant.messages(auth, threadId) };
    },
  );

  rest.get(
    '/assistant/threads/:threadId/status',
    assistantRouteOptions('status', 'read'),
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'viewer');
      const { threadId } = parse(threadParams, request.params);
      return { data: await ctx.assistant.status(auth, threadId) };
    },
  );

  rest.post(
    '/assistant/chat/:threadId',
    { ...assistantRouteOptions('chat', 'write'), bodyLimit: ASSISTANT_CHAT_BODY_LIMIT },
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'viewer');
      const { threadId } = parse(threadParams, request.params);
      const body = parse(chatSchema, request.body ?? {});
      const actor = { userId: auth.user.id, ip: clientIp(request) };
      return { data: await ctx.assistant.chat(auth, threadId, body, actor) };
    },
  );

  rest.post('/assistant/chat/:threadId/cancel', assistantRouteOptions('cancel', 'write'), async (request) => {
    const { auth } = requireAssistant(request, ctx, 'viewer');
    const { threadId } = parse(threadParams, request.params);
    await ctx.assistant.cancel(auth, threadId);
    return { data: { ok: true as const } };
  });

  // SSE as routes/push.ts: subscribe, replay after the cursor, then live; each ping re-checks access
  rest.get('/assistant/events/:threadId', assistantRouteOptions('events', 'read'), async (request, reply) => {
    const { auth } = requireAssistant(request, ctx, 'viewer');
    const { threadId } = parse(threadParams, request.params);
    const after = cursorOf(request);
    // a thread that is not the caller's is 404 before the stream opens
    await ctx.assistant.getThread(auth, threadId);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let unsubscribe: (() => void) | undefined;
    let ended = false;
    const ping = setInterval(() => {
      void stillAuthorized(auth)
        .then((ok) => {
          if (!ok) end();
          else if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
        })
        // a failed lookup keeps the stream: the next tick checks again
        .catch(() => {});
    }, ASSISTANT_PING_MS);
    ping.unref();
    const close = () => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      unsubscribe?.();
      open.delete(end);
    };
    const end = () => {
      close();
      if (!res.writableEnded) res.end();
    };
    open.add(end);
    request.raw.on('close', close);
    res.on('close', close);
    try {
      const off = await ctx.assistant.subscribe(auth, threadId, after, (event) => {
        if (!res.writableEnded) res.write(frame(event));
      });
      if (ended) off();
      else unsubscribe = off;
    } catch {
      end();
    }
  });
}
