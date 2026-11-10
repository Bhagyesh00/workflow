/**
 * /rest/ldap/* (P6-12, L10): GET and PUT `/ldap/config`, POST `/ldap/test-connection` (`ldap:manage`),
 * GET `/ldap/sync` (the history, newest first, `limit` and `cursor`) and POST `/ldap/sync` (a run, body
 * `{ type: 'live' | 'dry' }`) (`ldap:sync`). Answers are `{ data }`; the bind password is blank on read.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';
import { syncRunDto } from '../services/sso/ldap';
import { decodeCursor, encodeCursor } from './public-data-tables';

const configBody = z.record(z.string(), z.unknown());
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});
const syncBody = z.object({ type: z.enum(['live', 'dry']).default('live') });

export function registerLdapRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/ldap/config', async (request) => {
    const auth = await requireScope(request, 'ldap:manage');
    return { data: await ctx.ldap.getConfig(auth.tenant.id) };
  });

  app.put('/ldap/config', async (request) => {
    const auth = await requireScope(request, 'ldap:manage');
    const body = parse(configBody, request.body ?? {});
    return { data: await ctx.ldap.saveConfig(auth.tenant.id, body as never, auth.user.id) };
  });

  app.post('/ldap/test-connection', async (request) => {
    const auth = await requireScope(request, 'ldap:manage');
    return { data: await ctx.ldap.testConnection(auth.tenant.id) };
  });

  app.get('/ldap/sync', async (request) => {
    const auth = await requireScope(request, 'ldap:sync');
    const query = parse(historyQuery, request.query ?? {});
    const skip = decodeCursor(query.cursor);
    const page = await ctx.ldap.history(auth.tenant.id, { take: query.limit, skip });
    return {
      data: page.rows.map(syncRunDto),
      nextCursor: page.more ? encodeCursor(skip + page.rows.length) : null,
    };
  });

  app.post('/ldap/sync', async (request) => {
    const auth = await requireScope(request, 'ldap:sync');
    const body = parse(syncBody, request.body ?? {});
    return { data: syncRunDto(await ctx.ldap.sync(auth.tenant.id, body.type, auth.user.id)) };
  });
}
