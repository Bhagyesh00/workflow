/**
 * Public API LDAP (P6-12, L10), n8n's LDAP public controller: GET and PUT `/settings/ldap` (`ldap:manage`),
 * GET `/settings/ldap/sync` (the history) and POST `/settings/ldap/sync` (a run) (`ldap:sync`).
 * PUBLIC_LDAP_ROUTES is final and shaped as PUBLIC_ROLE_ROUTES (public-api.ts spreads it). The handlers call
 * the same `LdapService` as /rest/ldap; the history is paged with `limit` and `cursor`.
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import { syncRunDto } from '../services/sso/ldap';
import type { ApiRoute, PublicApiInput } from './public-api';
import { decodeCursor, encodeCursor } from './public-data-tables';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

/** the LDAP config fields (L10 owns the exact shape); a blank bind password keeps the stored one */
const configBody = z.record(z.string(), z.unknown());
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});
const syncBody = z.object({ type: z.enum(['live', 'dry']).default('live') });

export const publicLdapHandlers: Record<'getConfig' | 'saveConfig' | 'history' | 'sync', Handler> = {
  getConfig: async (ctx, { auth }) => ({ data: await ctx.ldap.getConfig(auth.tenant.id) }),
  saveConfig: async (ctx, { auth, body }) => ({
    data: await ctx.ldap.saveConfig(auth.tenant.id, body, auth.user.id),
  }),
  history: async (ctx, { auth, query }) => {
    const skip = decodeCursor(query.cursor);
    const page = await ctx.ldap.history(auth.tenant.id, { take: query.limit, skip });
    return {
      data: page.rows.map(syncRunDto),
      nextCursor: page.more ? encodeCursor(skip + page.rows.length) : null,
    };
  },
  sync: async (ctx, { auth, body }) => ({
    data: syncRunDto(await ctx.ldap.sync(auth.tenant.id, body.type, auth.user.id)),
  }),
};

const row = (name: keyof typeof publicLdapHandlers, fields: Omit<ApiRoute, 'handler' | 'tag'>): ApiRoute => ({
  ...fields,
  tag: 'LDAP',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicLdapHandlers[name](ctx, input),
});

export const PUBLIC_LDAP_ROUTES: ApiRoute[] = [
  row('getConfig', {
    method: 'GET',
    path: '/settings/ldap',
    summary: 'Get the LDAP config (the bind password blanked)',
    access: { scope: 'ldap:manage' },
    scope: 'ldap:manage',
    response: 'LdapConfig',
  }),
  row('saveConfig', {
    method: 'PUT',
    path: '/settings/ldap',
    summary: 'Save the LDAP config (a blank bind password keeps the stored one)',
    access: { scope: 'ldap:manage' },
    scope: 'ldap:manage',
    body: configBody,
    response: 'LdapConfig',
  }),
  row('history', {
    method: 'GET',
    path: '/settings/ldap/sync',
    summary: 'List the LDAP sync runs, newest first',
    access: { scope: 'ldap:sync' },
    scope: 'ldap:sync',
    query: historyQuery,
    response: 'LdapSyncRun',
    list: true,
  }),
  row('sync', {
    method: 'POST',
    path: '/settings/ldap/sync',
    summary: 'Run an LDAP sync (dry runs write nothing but the history row)',
    access: { scope: 'ldap:sync' },
    scope: 'ldap:sync',
    body: syncBody,
    response: 'LdapSyncRun',
  }),
];
