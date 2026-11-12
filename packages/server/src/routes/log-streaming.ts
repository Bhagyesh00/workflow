/**
 * /rest/eventbus (P6-06, L3), at n8n's paths: GET `/eventbus/eventnames` (`eventBusDestination:list`), GET
 * `/eventbus/destination` (`:list`, or `:read` with `?id=`), POST `/eventbus/destination` (`:create`, or `:update`
 * when the body has an id), DELETE `/eventbus/destination?id=` (`:delete`) and POST `/eventbus/testmessage?id=`
 * (`:test`; n8n uses GET, ours POST because it sends). GET and POST `/eventbus/destination` pass `requireAnyScope`
 * first, then check the exact scope. Secrets are blank in every answer. `GET ?id=` answers the one destination.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAnyScope, requireScope } from '../http/auth';
import { parse } from '../http/errors';

const idQuery = z.object({ id: z.uuid() });
const optionalIdQuery = z.object({ id: z.uuid().optional() });

/** the destination body; the type's own settings are checked by its registered `validate` (the manager checks the rest) */
export const logDestinationBodySchema = z
  .object({
    id: z.uuid().optional(),
    type: z.enum(['webhook', 'syslog', 'sentry']),
    label: z.string().trim().min(1).max(255).optional(),
    enabled: z.boolean().optional(),
    subscribedEvents: z.array(z.string().max(255)).max(500).optional(),
    anonymizeAuditMessages: z.boolean().optional(),
    credentialId: z.uuid().nullable().optional(),
    circuitBreaker: z
      .object({
        maxFailures: z.number().int().min(1).max(1000),
        failureWindowMs: z.number().int().min(1000).max(3_600_000),
      })
      .optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export function registerLogStreamingRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/eventbus/eventnames', async (request) => {
    await requireScope(request, 'eventBusDestination:list');
    return { data: ctx.logStreaming.eventNames() };
  });

  app.get('/eventbus/destination', async (request) => {
    const auth = await requireAnyScope(request, ['eventBusDestination:list', 'eventBusDestination:read']);
    const { id } = parse(optionalIdQuery, request.query ?? {});
    if (id) {
      await requireScope(request, 'eventBusDestination:read');
      return { data: await ctx.logStreaming.get(auth, id) };
    }
    await requireScope(request, 'eventBusDestination:list');
    return { data: await ctx.logStreaming.list(auth) };
  });

  app.post('/eventbus/destination', async (request) => {
    const auth = await requireAnyScope(request, ['eventBusDestination:create', 'eventBusDestination:update']);
    const body = parse(logDestinationBodySchema, request.body ?? {});
    await requireScope(request, body.id ? 'eventBusDestination:update' : 'eventBusDestination:create');
    return { data: await ctx.logStreaming.save(auth, body) };
  });

  app.delete('/eventbus/destination', async (request) => {
    const auth = await requireScope(request, 'eventBusDestination:delete');
    const { id } = parse(idQuery, request.query ?? {});
    await ctx.logStreaming.remove(auth, id);
    return { data: { ok: true } };
  });

  app.post('/eventbus/testmessage', async (request) => {
    const auth = await requireScope(request, 'eventBusDestination:test');
    const { id } = parse(idQuery, request.query ?? {});
    return { data: await ctx.logStreaming.test(auth, id) };
  });
}
