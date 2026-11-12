/**
 * Public API log streaming (P6-06, L3): n8n's 7 rows under `/settings/log-streaming`: GET `/event-types` and GET
 * `/destinations` (`eventBusDestination:list`), GET `/destinations/:id` (`:read`), POST `/destinations` (`:create`),
 * PUT `/destinations/:id` (`:update`), DELETE `/destinations/:id` (`:delete`), POST `/destinations/:id/test`
 * (`:test`), through `ctx.logStreaming` as REST. Each row's user scope and key scope are the same name.
 * PUBLIC_LOG_STREAMING_ROUTES is shaped as PUBLIC_SOURCE_CONTROL_ROUTES (public-api.ts spreads it).
 * stub (L3): the rows and gates are final; the handlers throw until L3.
 */
import { idParams } from '../http/schemas';
import { logDestinationBodySchema } from './log-streaming';
import type { ApiRoute } from './public-api';

const TAG = 'LogStreaming';

export const PUBLIC_LOG_STREAMING_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/settings/log-streaming/event-types',
    summary: 'List the event names a destination can subscribe to',
    tag: TAG,
    access: { scope: 'eventBusDestination:list' },
    scope: 'eventBusDestination:list',
    response: 'LogStreamingEventTypes',
    handler: async () => {
      // stub (L3)
      throw new Error('not implemented (L3)');
    },
  },
  {
    method: 'GET',
    path: '/settings/log-streaming/destinations',
    summary: 'List the log streaming destinations',
    tag: TAG,
    access: { scope: 'eventBusDestination:list' },
    scope: 'eventBusDestination:list',
    response: 'LogStreamingDestination',
    list: true,
    handler: async (ctx, { auth }) => ({ data: await ctx.logStreaming.list(auth) }),
  },
  {
    method: 'GET',
    path: '/settings/log-streaming/destinations/:id',
    summary: 'Get a log streaming destination',
    tag: TAG,
    access: { scope: 'eventBusDestination:read' },
    scope: 'eventBusDestination:read',
    params: idParams,
    response: 'LogStreamingDestination',
    handler: async (ctx, { auth, params }) => ({ data: await ctx.logStreaming.get(auth, params.id) }),
  },
  {
    method: 'POST',
    path: '/settings/log-streaming/destinations',
    summary: 'Create a log streaming destination',
    tag: TAG,
    access: { scope: 'eventBusDestination:create' },
    scope: 'eventBusDestination:create',
    body: logDestinationBodySchema.omit({ id: true }),
    response: 'LogStreamingDestination',
    handler: async (ctx, { auth, body }) => ({ data: await ctx.logStreaming.save(auth, body) }),
  },
  {
    method: 'PUT',
    path: '/settings/log-streaming/destinations/:id',
    summary: 'Replace a log streaming destination',
    tag: TAG,
    access: { scope: 'eventBusDestination:update' },
    scope: 'eventBusDestination:update',
    params: idParams,
    body: logDestinationBodySchema.omit({ id: true }),
    response: 'LogStreamingDestination',
    handler: async (ctx, { auth, params, body }) => ({
      data: await ctx.logStreaming.save(auth, { ...body, id: params.id }),
    }),
  },
  {
    method: 'DELETE',
    path: '/settings/log-streaming/destinations/:id',
    summary: 'Delete a log streaming destination',
    tag: TAG,
    access: { scope: 'eventBusDestination:delete' },
    scope: 'eventBusDestination:delete',
    params: idParams,
    response: 'Ok',
    handler: async (ctx, { auth, params }) => {
      await ctx.logStreaming.remove(auth, params.id);
      return { data: { ok: true } };
    },
  },
  {
    method: 'POST',
    path: '/settings/log-streaming/destinations/:id/test',
    summary: 'Send a test message to a log streaming destination',
    tag: TAG,
    access: { scope: 'eventBusDestination:test' },
    scope: 'eventBusDestination:test',
    params: idParams,
    response: 'LogStreamingTestResult',
    handler: async (ctx, { auth, params }) => ({ data: await ctx.logStreaming.test(auth, params.id) }),
  },
];
