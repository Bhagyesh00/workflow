/**
 * /rest/assistant (P5-67, lane L1): threads, messages, status, chat, cancel and the SSE event stream.
 * Gates, rate limits and the chat body limit are final from C0; the handlers are L1's. Every route is
 * viewer (n8n's `instanceAi:message` holds for every member). The gate: signed out 401, the Assistant
 * off for this workspace 404, then the role (403). Nothing about a message or a body is logged.
 * `requireAssistant`, `assistantRouteOptions` and `ASSISTANT_CHAT_BODY_LIMIT` are shared with the
 * confirm and draft routes.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { type AuthContext, requireAuth } from '../http/auth';
import { ApiError } from '../http/errors';
import type { TenantSettings } from '../plans';
import { AI_ROUTE_RATE_LIMIT } from '../services/ai-builder/types';
import { effectiveAssistantSettings } from '../services/assistant/settings';
import type { EffectiveAssistantSettings } from '../services/assistant/types';
import { hasRole } from '../services/auth';

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
  const auth = requireAuth(request);
  const settings = effectiveAssistantSettings(ctx.config, auth.tenant.settings as TenantSettings);
  if (!settings.enabled) throw ApiError.notFound();
  if (!hasRole(auth.role, minimum)) throw ApiError.forbidden();
  return { auth, settings };
}

function notImplemented(): never {
  throw new Error('not implemented (L1)');
}

export function registerAssistantRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.post('/assistant/threads', assistantRouteOptions('threads-create', 'write'), async (request) => {
    requireAssistant(request, ctx, 'viewer');
    return notImplemented();
  });

  rest.get('/assistant/threads', assistantRouteOptions('threads-list', 'read'), async (request) => {
    requireAssistant(request, ctx, 'viewer');
    return notImplemented();
  });

  rest.patch(
    '/assistant/threads/:threadId',
    assistantRouteOptions('threads-rename', 'write'),
    async (request) => {
      requireAssistant(request, ctx, 'viewer');
      return notImplemented();
    },
  );

  rest.delete(
    '/assistant/threads/:threadId',
    assistantRouteOptions('threads-delete', 'write'),
    async (request) => {
      requireAssistant(request, ctx, 'viewer');
      return notImplemented();
    },
  );

  rest.get(
    '/assistant/threads/:threadId/messages',
    assistantRouteOptions('messages', 'read'),
    async (request) => {
      requireAssistant(request, ctx, 'viewer');
      return notImplemented();
    },
  );

  rest.get(
    '/assistant/threads/:threadId/status',
    assistantRouteOptions('status', 'read'),
    async (request) => {
      requireAssistant(request, ctx, 'viewer');
      return notImplemented();
    },
  );

  rest.post(
    '/assistant/chat/:threadId',
    { ...assistantRouteOptions('chat', 'write'), bodyLimit: ASSISTANT_CHAT_BODY_LIMIT },
    async (request) => {
      requireAssistant(request, ctx, 'viewer');
      return notImplemented();
    },
  );

  rest.post('/assistant/chat/:threadId/cancel', assistantRouteOptions('cancel', 'write'), async (request) => {
    requireAssistant(request, ctx, 'viewer');
    return notImplemented();
  });

  // SSE: L1 answers through `reply.hijack()` as routes/push.ts, cursor from Last-Event-ID or ?lastEventId
  rest.get('/assistant/events/:threadId', assistantRouteOptions('events', 'read'), async (request) => {
    requireAssistant(request, ctx, 'viewer');
    return notImplemented();
  });
}
